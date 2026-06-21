set dotenv-load := true
set shell := ["bash", "--login", "-e", "-o", "pipefail", "-c"]

obs_port := env_var_or_default("OBS_PORT", "43190")
obs_token := env_var_or_default("OBS_AUTH_TOKEN", "devtoken")
obs_url := env_var_or_default("OBS_SERVER_URL", "http://127.0.0.1:" + obs_port)

# Root of the agy hook source the hooks.json commands point at.
#
# Defaults to the pi-installed BpdataIT clone — the SAME path `pi install
# git:github.com/BpdataIT/pi-agent-observability@main` updates — so one `pi
# install` refreshes both the pi extension AND the agy hooks. Override with
# AGY_HOOKS_SRC=... (e.g. your working repo $PWD) to point elsewhere.
agy_hooks_src := env_var_or_default("AGY_HOOKS_SRC", "~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability")
droid_hooks_src := env_var_or_default("DROID_HOOKS_SRC", "~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability")
steelman_port := env_var_or_default("STEELMAN_PORT", "45210")
steelman_web_port := env_var_or_default("STEELMAN_WEB_PORT", "51730")
steelman_api_target := env_var_or_default("STEELMAN_API_TARGET", "http://127.0.0.1:" + steelman_port)
agent_pool := env_var_or_default("OBS_POOL", "manual-agent")
agent_tag := env_var_or_default("OBS_TAG", "just-agent")
agent_name := env_var_or_default("OBS_NAME", "just-agent")

# List available project commands
default:
  @just --list

# Clear a listener from a pinned project port (private helper used by the services)
_clear-port port name:
  @pids="$(lsof -tiTCP:{{port}} -sTCP:LISTEN 2>/dev/null || true)"; \
  if [ -n "$pids" ]; then \
    echo "Clearing {{name}} port {{port}}: $pids"; \
    kill -TERM $pids 2>/dev/null || true; \
    for _ in $(seq 1 30); do \
      sleep 0.1; \
      pids="$(lsof -tiTCP:{{port}} -sTCP:LISTEN 2>/dev/null || true)"; \
      [ -z "$pids" ] && exit 0; \
    done; \
    echo "Force-clearing {{name}} port {{port}}: $pids"; \
    kill -KILL $pids 2>/dev/null || true; \
  fi

# ═══════════════════════════════════════════════════════════════════════════
#  OBSERVABILITY  —  the telemetry server (+ full-stack launcher)
# ═══════════════════════════════════════════════════════════════════════════

# Boot the observability server only
obs:
  @just _clear-port "{{obs_port}}" observability
  @cd apps/observability && OBS_AUTH_TOKEN="{{obs_token}}" OBS_PORT="{{obs_port}}" bun server.ts

# Boot observability + Steelman backend + Steelman web together. Pass `watch` to auto-restart the backend on save.
all watch="0":
  #!/usr/bin/env bash
  set -euo pipefail
  obs_port="${OBS_PORT:-43190}"
  obs_token="${OBS_AUTH_TOKEN:-devtoken}"
  obs_url="${OBS_SERVER_URL:-http://127.0.0.1:${obs_port}}"
  app_port="${STEELMAN_PORT:-45210}"
  web_port="${STEELMAN_WEB_PORT:-51730}"
  api_target="${STEELMAN_API_TARGET:-http://127.0.0.1:${app_port}}"
  watch_flag=""
  case "{{watch}}" in 1|true|watch|--watch|-w) watch_flag="--watch" ;; esac

  clear_port() {
    local port="$1" name="$2" pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "Clearing ${name} port ${port}: ${pids}"
      kill -TERM $pids 2>/dev/null || true
      for _ in $(seq 1 30); do
        sleep 0.1
        pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
        [[ -z "$pids" ]] && return 0
      done
      echo "Force-clearing ${name} port ${port}: ${pids}"
      kill -KILL $pids 2>/dev/null || true
    fi
  }

  wait_for_url() {
    local url="$1" name="$2"
    for _ in $(seq 1 100); do
      if curl -sf "$url" >/dev/null 2>&1; then
        echo "✓ ${name}: ${url}"
        return 0
      fi
      sleep 0.2
    done
    echo "✗ timed out waiting for ${name}: ${url}" >&2
    return 1
  }

  cleanup() {
    echo
    echo "Shutting down services started by just all..."
    kill "${web_pid:-}" "${app_pid:-}" "${obs_pid:-}" 2>/dev/null || true
    wait "${web_pid:-}" "${app_pid:-}" "${obs_pid:-}" 2>/dev/null || true
  }
  stop_cleanly() {
    trap - EXIT INT TERM
    cleanup
    exit 0
  }
  trap cleanup EXIT
  trap stop_cleanly INT TERM

  clear_port "$obs_port" "observability"
  clear_port "$app_port" "steelman backend"
  clear_port "$web_port" "steelman web"

  echo "Starting observability on http://127.0.0.1:${obs_port}"
  (cd apps/observability && exec env OBS_AUTH_TOKEN="$obs_token" OBS_PORT="$obs_port" bun server.ts) &
  obs_pid=$!
  wait_for_url "http://127.0.0.1:${obs_port}/health" "observability"

  echo "Starting Steelman backend in real Pi mode${watch_flag:+ (watch)} on http://127.0.0.1:${app_port}"
  (cd apps/steelman/server && exec env OBS_AUTH_TOKEN="$obs_token" OBS_SERVER_URL="$obs_url" STEELMAN_PORT="$app_port" bun $watch_flag src/server.ts) &
  app_pid=$!
  wait_for_url "http://127.0.0.1:${app_port}/health" "steelman backend"

  echo "Starting Steelman web on http://127.0.0.1:${web_port}"
  (cd apps/steelman/web && { [ -d node_modules ] || bun install; } && exec env STEELMAN_API_TARGET="$api_target" bunx vite --host 127.0.0.1 --port "$web_port" --strictPort) &
  web_pid=$!
  wait_for_url "http://127.0.0.1:${web_port}" "steelman web"

  echo
  echo "All services are up:"
  echo "  observability: http://127.0.0.1:${obs_port}/?token=${obs_token}"
  echo "  steelman web:  http://127.0.0.1:${web_port}"
  echo "  steelman API:  http://127.0.0.1:${app_port}"
  echo
  echo "Press Ctrl-C to stop only these service PIDs: ${obs_pid}, ${app_pid}, ${web_pid}"
  while true; do
    for pid in "$obs_pid" "$app_pid" "$web_pid"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        echo "Service PID ${pid} exited; stopping the remaining services." >&2
        exit 1
      fi
    done
    sleep 1
  done

# ═══════════════════════════════════════════════════════════════════════════
#  STEELMAN  —  the product app services (backend + web)
# ═══════════════════════════════════════════════════════════════════════════

# Boot the Steelman backend only in real Pi RPC mode
steelman-server:
  @just _clear-port "{{steelman_port}}" steelman-api
  @cd apps/steelman/server && OBS_AUTH_TOKEN="{{obs_token}}" OBS_SERVER_URL="{{obs_url}}" STEELMAN_PORT="{{steelman_port}}" bun src/server.ts

# Boot the Steelman backend in real Pi RPC mode with auto-restart on file changes
steelman-server-watch:
  @just _clear-port "{{steelman_port}}" steelman-api
  @cd apps/steelman/server && OBS_AUTH_TOKEN="{{obs_token}}" OBS_SERVER_URL="{{obs_url}}" STEELMAN_PORT="{{steelman_port}}" bun --watch src/server.ts

# Boot the Steelman Vite frontend only
steelman-web:
  @just _clear-port "{{steelman_web_port}}" steelman-web
  @cd apps/steelman/web && { [ -d node_modules ] || bun install; } && STEELMAN_API_TARGET="{{steelman_api_target}}" bunx vite --host 127.0.0.1 --port "{{steelman_web_port}}" --strictPort

# ═══════════════════════════════════════════════════════════════════════════
#  AGENTS  —  launch Pi agents
# ═══════════════════════════════════════════════════════════════════════════

# Boot an interactive Pi coding agent with the observability extension. Start `just all` or `just obs` first.
agent:
  @OBS_AUTH_TOKEN="{{obs_token}}" OBS_SERVER_URL="{{obs_url}}" pi -e "$PWD/extension/pi-observability.ts" --o-pool "{{agent_pool}}" --o-tag "{{agent_tag}}" --o-name "{{agent_name}}"

# Generate specs for Steelman artifacts via the /spec skill
specagent:
  pi "/spec prompts/steelman1.txt" --o-name specagent

# Generate HTML specs for Steelman artifacts via the /htmlspec skill
htmlagent:
  pi "/htmlspec prompts/steelman1.txt" --o-name htmlagent

# Generate HTML specs for Steelman artifacts via the /htmlspec skill (alt entry point)
htmlvspec:
  pi "/htmlspec prompts/steelman1.txt" --o-name htmlvspec

# Ping the /spec slash command with a trivial prompt (smoke test for the spec skill)
specping:
  pi "ping" --o-name md-plan

# Ping the /htmlspec slash command with a trivial prompt (smoke test for the htmlspec skill)
htmlping:
  pi "ping" --o-name html-plan

# Ping the /vspec slash command with a trivial prompt (smoke test for the vspec skill)
htmlvping:
  pi "ping" --o-name v-plan

# ═══════════════════════════════════════════════════════════════════════════
#  CLAUDE CODE BRIDGE  —  print hooks block for .claude/settings.json
# ═══════════════════════════════════════════════════════════════════════════

# Print the Claude Code hooks block with the current OBS_AUTH_TOKEN / OBS_SERVER_URL filled in.
# Paste the output into ~/.claude/settings.json or <project>/.claude/settings.json.
cc-hooks-print:
  #!/usr/bin/env bash
  set -euo pipefail
  abs_path="$PWD"
  echo "# Add the following block to ~/.claude/settings.json or <project>/.claude/settings.json"
  echo "# Current OBS_AUTH_TOKEN: {{obs_token}}"
  echo "# Current OBS_SERVER_URL: {{obs_url}}"
  echo ""
  sed "s|/ABS/PATH|${abs_path}|g; /_instructions/d" "${abs_path}/integrations/claude-code/settings.template.json"

# Print the Antigravity (agy) hooks.json with the resolved hook source path filled in.
agy-hooks-print:
  #!/usr/bin/env bash
  set -euo pipefail
  # Resolve AGY_HOOKS_SRC (default = pi-installed BpdataIT clone) so the printed
  # hooks point at the same path `pi install git:github.com/BpdataIT/...@main`
  # updates. Expand ~ via bash, then realpath so the command is absolute.
  src="{{agy_hooks_src}}"
  abs_path="$(eval echo "${src}")"
  if [ ! -d "${abs_path}" ]; then
    echo "✗ AGY_HOOKS_SRC does not resolve to a directory: ${abs_path}" >&2
    echo "  Set AGY_HOOKS_SRC to your pi-agent-observability clone" >&2
    echo "  (default ~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability)" >&2
    exit 1
  fi
  echo "# Install to ~/.gemini/config/hooks.json (NOT ~/.gemini/antigravity-cli/hooks.json)"
  echo "# agy hook source: ${abs_path}"
  echo "# Current OBS_AUTH_TOKEN: {{obs_token}}  OBS_SERVER_URL: {{obs_url}}"
  echo ""
  sed "s|/ABS/PATH|${abs_path}|g; /_instructions/d" "${abs_path}/integrations/antigravity/hooks.template.json"

# Install the Antigravity bridge hooks to ~/.gemini/config/hooks.json (the backend-synced path).
#
# Points the hooks at the path `pi install git:github.com/BpdataIT/...@main`
# updates (AGY_HOOKS_SRC, default the pi-installed BpdataIT clone) so a single
# `pi install` refreshes both the extension and the agy hooks. Override with
# AGY_HOOKS_SRC=<path> (e.g. your working repo) to point elsewhere.
# Refuses to clobber an existing hooks.json — back it up / merge by hand first.
agy-install:
  #!/usr/bin/env bash
  set -euo pipefail
  src="{{agy_hooks_src}}"
  abs_path="$(eval echo "${src}")"
  if [ ! -d "${abs_path}" ]; then
    echo "✗ AGY_HOOKS_SRC does not resolve to a directory: ${abs_path}" >&2
    echo "  Set AGY_HOOKS_SRC to your pi-agent-observability clone" >&2
    echo "  (default ~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability)" >&2
    exit 1
  fi
  dest="$HOME/.gemini/config/hooks.json"
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ]; then
    echo "✗ $dest already exists — refusing to overwrite."
    echo "  Back it up or merge the 5 event entries from integrations/antigravity/hooks.template.json by hand."
    echo "  (Preview with: just agy-hooks-print)"
    exit 1
  fi
  sed "s|/ABS/PATH|${abs_path}|g; /_instructions/d" "${abs_path}/integrations/antigravity/hooks.template.json" > "$dest"
  echo "✓ Installed agy hooks → $dest"
  echo "  hook source: ${abs_path}"
  echo "  Now run agy with OBS_AUTH_TOKEN / OBS_SERVER_URL exported (or in .env)."

# Remove the Antigravity bridge hooks from ~/.gemini/config/hooks.json.
# Only removes the file if it points at this bridge's obs-hook.ts (won't delete
# unrelated hooks), regardless of which clone path it references.
agy-uninstall:
  #!/usr/bin/env bash
  set -euo pipefail
  dest="$HOME/.gemini/config/hooks.json"
  if [ ! -e "$dest" ]; then echo "Nothing to remove ($dest absent)."; exit 0; fi
  if grep -q "integrations/antigravity/obs-hook.ts" "$dest"; then
    rm -f "$dest"
    echo "✓ Removed $dest"
  else
    echo "✗ $dest does not reference this bridge — leaving it untouched."
    exit 1
  fi

# Run the agy gen_metadata usage decoder across every conversation .db and
# report coverage, input-field monotonicity, output-vs-text correlation, and
# model/effort variance. GATE for confirming GEN_METADATA_FIELD_MAP before
# trusting it in the live hook. Findings: integrations/antigravity/usage-decoder.md
agy-usage-validate:
  bun scripts/agy-usage-validate.ts

# Print the Factory Droid hooks.json with the resolved hook source path filled in.
droid-hooks-print:
  #!/usr/bin/env bash
  set -euo pipefail
  src="{{droid_hooks_src}}"
  abs_path="$(eval echo "${src}")"
  if [ ! -d "${abs_path}" ]; then
    echo "✗ DROID_HOOKS_SRC does not resolve to a directory: ${abs_path}" >&2
    echo "  Set DROID_HOOKS_SRC to your pi-agent-observability clone" >&2
    echo "  (default ~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability)" >&2
    exit 1
  fi
  bun_bin="$(command -v bun)"
  if [ -z "${bun_bin}" ]; then
    echo "✗ bun not found on PATH" >&2
    exit 1
  fi
  echo "# Install to ~/.factory/hooks.json (global) or <project>/.factory/hooks.json"
  echo "# droid hook source: ${abs_path}"
  echo "# bun: ${bun_bin}"
  echo "# Current OBS_AUTH_TOKEN: {{obs_token}}  OBS_SERVER_URL: {{obs_url}}"
  echo ""
  sed "s|/ABS/PATH|${abs_path}|g; s|bun /|${bun_bin} /|g; /_instructions/d" "${abs_path}/integrations/droid/hooks.template.json"

# Install the Factory Droid bridge hooks into ~/.factory/settings.json (required)
# and ~/.factory/hooks.json (reference copy).
droid-install:
  #!/usr/bin/env bash
  set -euo pipefail
  src="{{droid_hooks_src}}"
  abs_path="$(eval echo "${src}")"
  if [ ! -d "${abs_path}" ]; then
    echo "✗ DROID_HOOKS_SRC does not resolve to a directory: ${abs_path}" >&2
    echo "  Set DROID_HOOKS_SRC to your pi-agent-observability clone" >&2
    echo "  (default ~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability)" >&2
    exit 1
  fi
  bun_bin="$(command -v bun)"
  if [ -z "${bun_bin}" ]; then
    echo "✗ bun not found on PATH" >&2
    exit 1
  fi
  hooks_json="$(sed "s|/ABS/PATH|${abs_path}|g; s|bun /|${bun_bin} /|g; /_instructions/d" "${abs_path}/integrations/droid/hooks.template.json")"
  settings="$HOME/.factory/settings.json"
  hooks_file="$HOME/.factory/hooks.json"
  mkdir -p "$(dirname "$settings")"
  if ! command -v jq >/dev/null 2>&1; then
    echo "✗ jq not found on PATH (required for droid-install)" >&2
    exit 1
  fi
  hooks_only="$(printf '%s' "$hooks_json" | jq '.hooks')"
  if [ -f "$settings" ]; then
    jq --argjson hooks "$hooks_only" '.hooksDisabled = false | .hooks = $hooks' "$settings" > "${settings}.tmp"
  else
    jq -n --argjson hooks "$hooks_only" '{hooksDisabled: false, hooks: $hooks}' > "${settings}.tmp"
  fi
  mv "${settings}.tmp" "$settings"
  printf '%s\n' "$hooks_json" | jq '.' > "$hooks_file"
  echo "✓ Installed droid hooks → $settings (hooks key)"
  echo "✓ Wrote reference copy → $hooks_file"
  echo "  hook source: ${abs_path}"
  echo "  Restart droid after install. Auth loads from repo .env if present."

# Remove the Factory Droid bridge hooks from ~/.factory/settings.json.
droid-uninstall:
  #!/usr/bin/env bash
  set -euo pipefail
  settings="$HOME/.factory/settings.json"
  hooks_file="$HOME/.factory/hooks.json"
  removed=0
  if [ -f "$settings" ] && grep -q "integrations/droid/obs-hook.ts" "$settings"; then
    if ! command -v jq >/dev/null 2>&1; then
      echo "✗ jq not found on PATH (required for droid-uninstall)" >&2
      exit 1
    fi
    jq 'del(.hooks)' "$settings" > "${settings}.tmp"
    mv "${settings}.tmp" "$settings"
    echo "✓ Removed hooks from $settings"
    removed=1
  fi
  if [ -f "$hooks_file" ] && grep -q "integrations/droid/obs-hook.ts" "$hooks_file"; then
    rm -f "$hooks_file"
    echo "✓ Removed $hooks_file"
    removed=1
  fi
  if [ "$removed" -eq 0 ]; then
    echo "✗ No droid bridge hooks found in ~/.factory/settings.json or hooks.json"
    exit 1
  fi

# Lossy-normalizer self-test for shared/model-metadata.ts (Stories 2.2 + 3.3).
# Pins the known-lossy label↔id pairs (e.g. "Gemini 3.5 Flash (High)" vs
# gemini-3-flash-a both → 1M) and the pre-migration cost snapshots. GATE for
# Phases 2/3 (a normalization bug flipping 1M → 128k fails this).
model-metadata-selftest:
  bun scripts/model-metadata-selftest.ts

# Drift gate for shared/model-metadata.ts. Cross-checks the shared table against
# the models.dev registry (offline → WARNING + skip, exit 0) and against the
# distinct model set in db/obs.db, and runs the lossy-pair self-test inline.
# Exit non-zero only on a self-test failure. See shared/model-metadata.md.
model-metadata-validate:
  bun scripts/model-metadata-validate.ts

# ═══════════════════════════════════════════════════════════════════════════
#  EXTRA  —  build, validate, backup
# ═══════════════════════════════════════════════════════════════════════════

# Build the Steelman frontend
build-steelman-web:
  @cd apps/steelman/web && { [ -d node_modules ] || bun install; } && bun run build

# Run validation for the Steelman real backend
validate-steelman:
  @STEELMAN_PORT="{{steelman_port}}" bun apps/steelman/scripts/validate-steelman.ts

# Create a timestamped backup of the active SQLite database
backup:
  #!/usr/bin/env bash
  set -euo pipefail
  mkdir -p backups
  if [ ! -f db/obs.db ]; then
    echo "✗ No active database 'db/obs.db' found to back up." >&2
    exit 1
  fi
  ts=$(date +"%Y%m%d_%H%M%S")
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 db/obs.db ".backup 'backups/obs_backup_${ts}.db'"
    echo "✓ Safe database backup created: backups/obs_backup_${ts}.db"
  else
    cp db/obs.db "backups/obs_backup_${ts}.db"
    echo "✓ Database backup created via file copy: backups/obs_backup_${ts}.db"
  fi
