# Factory Droid → Pi Observability Bridge

A Bun/TypeScript hook handler that translates Factory **Droid** CLI lifecycle
hooks into the same `ObsEvent` envelopes the Pi extension uses, and POSTs them
to `POST /events`. Droid sessions appear in the **same dashboard** as Pi,
Claude Code, and Antigravity sessions — with correct session token totals and
USD cost.

**NO server or dashboard changes are required.**

---

## How it works

Droid fires a separate short-lived process per lifecycle event (a shell command
registered in `~/.factory/settings.json` under the `hooks` key). Droid 0.153+
loads hooks from settings; `hooks.json` alone is not enough on this version.
This bridge reads a JSON payload from stdin, maps it to `ObsEventEnvelope`s,
and POSTs them to the observability server.

Cross-event state (monotonic `seq`, transcript byte offset, open tool ids,
cumulative usage snapshot) is persisted to `${TMPDIR}/pi-obs-droid/<session_id>/`.

**Droid-specific:** the transcript JSONL has no per-message token usage. Cumulative
totals live in a sidecar `<session-uuid>.settings.json`. On each `Stop`, the
bridge computes a **delta** vs the last snapshot and attributes it to new
assistant turns (full delta on the last turn when multiple turns arrive in one
Stop — session totals remain accurate; per-turn splits are approximate).

---

## Install

### Prerequisites

- [`bun`](https://bun.sh) >= 1.1
- Observability server running (`just obs`)
- `OBS_AUTH_TOKEN` matching the server
- Factory Droid installed (`~/.factory/` present)

### 1. Set environment variables

```bash
export OBS_AUTH_TOKEN=your-token
export OBS_SERVER_URL=http://127.0.0.1:43190
export OBS_POOL=my-pool               # optional
export OBS_TAG=tag1,tag2              # optional
export OBS_NAME=droid                 # optional, default "droid"
```

The bridge auto-loads `.env` / `.env.local` from cwd, the repo root, and
`~/.env` (hook subprocesses do not inherit your shell exports).

### 2. Register the hooks

`just droid-install` merges the hooks block into:

- **Required:** `~/.factory/settings.json` → `"hooks"` key + `"hooksDisabled": false`
- **Reference copy:** `~/.factory/hooks.json`

Or copy manually from `hooks.template.json` (replace `/ABS/PATH`, use full
`bun` path e.g. `/opt/homebrew/bin/bun`). Project-level:
`<project>/.factory/settings.json`.

Ensure `hooksDisabled` is `false` in `/hooks` or `/settings`.

Unlike Claude Code, Droid keeps hooks in `settings.json` (with optional
`hooks.json` mirror), not `.claude/settings.json`.

### 3. Run Droid

```bash
droid                    # interactive
droid exec "say hi"      # headless smoke
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OBS_SERVER_URL` | `http://127.0.0.1:43190` | Observability server URL |
| `OBS_AUTH_TOKEN` | *(empty)* | Bearer token |
| `OBS_POOL` | `default` | Pool name for swimlane/race views |
| `OBS_TAG` | *(empty)* | Comma-separated tags |
| `OBS_NAME` | `droid` | Agent name in the dashboard |
| `OBS_DISABLE` | *(unset)* | Set to `true` to disable |
| `OBS_DEBUG` | *(unset)* | Set to `1` to log sidecar timing diagnostics |

---

## Droid paths

| Artifact | Location |
|---|---|
| Hooks config | `~/.factory/hooks.json` or `<project>/.factory/hooks.json` |
| Transcript | `~/.factory/sessions/<slugified-cwd>/<uuid>.jsonl` |
| Usage sidecar | same path with `.settings.json` instead of `.jsonl` |
| Bridge state | `${TMPDIR}/pi-obs-droid/<session_id>/` |

---

## Hook → ObsEvent mapping

| Droid hook | ObsEvent(s) | Notes |
|---|---|---|
| `SessionStart` | `session_start` | `source` → `reason`; seq reset |
| `UserPromptSubmit` | `user_message` + `agent_start` | Prompt truncated to 32 KB |
| `PreToolUse` | `tool_call` | Derived `droid-<sha256>` id |
| `PostToolUse` | `tool_result` | Same derived id |
| `Stop` / `SubagentStop` | `assistant_message` (+ `thinking`) + `agent_end` | Transcript + sidecar delta |
| `PreCompact` | `compaction` | `tokens_before` = 0 until enriched |
| `SessionEnd` | `session_shutdown` | `reason` mapped to legal union |
| `Notification` | `custom` | `custom_type = "Notification"` |

### `tool_call_id` derivation

```
tool_call_id = "droid-" + sha256(tool_name + " " + stableJSON(tool_input))[0:16]
```

Native `chatcmpl-tool-*` ids from the transcript appear in `assistant_message.tool_call_ids`.

---

## Cost & context window

Window, cost, and provider resolve from [`shared/model-metadata.ts`](../../shared/model-metadata.ts).
Per-turn `modelId` from the transcript drives provider and cost; the sidecar's
top-level `model` field is **not** used for attribution (sessions can mix models).

**`factoryCredits` ≠ USD.** Cost is always computed from token deltas × the
shared price table. `factoryCredits` is read from the sidecar but not converted
to dollars.

### `tokenUsage` vs `inclusiveTokenUsage`

The session lane uses **`tokenUsage`** (session-scoped totals). Subagent
inclusive totals (`inclusiveTokenUsage`, `childInclusiveTokenUsageBySessionId`)
are deferred — `SubagentStop` uses the parent `session_id` and transcript path.

---

## Sidecar delta attribution

On each `Stop`:

1. Parse new assistant turns from the transcript (byte offset).
2. Read cumulative `tokenUsage` from `.settings.json`.
3. `delta = cumulative - lastCumulativeUsage` (per field, negatives clamped to 0).
4. If multiple turns: **full delta on the last turn**; prior turns get zero usage.
5. `cost_total = computeCost(delta, turn.modelId)`.
6. Persist offset + cumulative snapshot.

Session totals (sum of emitted usage) match the sidecar delta sum. Per-turn
splits are approximate when multiple assistant lines arrive between Stops.

---

## Sidecar timing

Droid may flush `.settings.json` slightly after the transcript line but
generally before `Stop` fires. The bridge uses a short bounded retry
(`readCumulativeUsageWithRetry`) when totals are unchanged and the sidecar mtime
is very recent. Set `OBS_DEBUG=1` to log sidecar `mtime` vs hook timestamp on
each Stop.

If you see systematic stale reads on first install, capture stdin with a debug
hook:

```bash
# One-liner to dump first hook stdin (remove after validation)
echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh -c \"cat > /tmp/droid-hook-debug.json\""}]}]}}' 
```

---

## Persistent state

| File | Purpose |
|---|---|
| `seq` | Atomic append-byte seq counter |
| `state.json` | `transcriptOffset`, `openToolIds`, `firstRunLogged`, `lastCumulativeUsage` |
| `debug.log` | Diagnostics (first payload, unknown models, sidecar errors) |
| `spool/*.json` | Failed POST recovery (pruned to 20 files) |

---

## Live E2E verification

```bash
OBS_AUTH_TOKEN=mytoken just obs
OBS_AUTH_TOKEN=mytoken OBS_POOL=droid-test droid exec "say hi"
curl -H "Authorization: Bearer mytoken" \
     "http://127.0.0.1:43190/sessions?pool=droid-test"
```

Expected: session with `agent_name=droid`, non-zero `total_tokens` after at
least one assistant turn, `session_file` ending in `.jsonl`.

Confirm on first install:

- `transcript_path` is absolute and ends in `.jsonl`
- `hook_event_name` is PascalCase (`Stop`, not `stop`)
- `permission_mode` values match your Droid config

---

## Known limitations

- **`stop_reason`**: not in the Droid transcript; inferred as `toolUse` when the
  last content block is `tool_use`, else `stop`. No `max_tokens` signal.
- **Per-turn usage**: approximate when multiple turns arrive in one Stop (delta
  on last turn only).
- **`latency_ms`**: approximate (assistant timestamp minus preceding user message).
- **`generation_ms`**: sum of `thinking.durationMs` when present.
- **`tokens_before` on compaction**: not available from `PreCompact` hook (0).
- **Subagent lanes**: parent session lane only; child inclusive usage deferred.
- **Entire.io**: unconfirmed prior art — no code dependency.

---

## Running tests

```bash
bun test integrations/droid/obs-hook.test.ts
```

Or from repo root:

```bash
just droid-hooks-print   # preview install config
```
