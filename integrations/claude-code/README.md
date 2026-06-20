# Claude Code → Pi Observability Bridge

A Bun/TypeScript hook handler that translates Claude Code lifecycle hooks into
the same `ObsEvent` envelopes the Pi extension uses, and POSTs them to the
same `POST /events` server. Claude Code sessions appear in the **same
dashboard** as Pi agents — with correct token totals and cost.

**NO server or dashboard changes are required.**

---

## How it works

Claude Code fires a separate short-lived process per lifecycle event (a shell
command registered in `.claude/settings.json`). This bridge is that command: it
reads a JSON payload from stdin, maps it to an `ObsEventEnvelope`, and POSTs it
to `${OBS_SERVER_URL}/events` — exactly what the Pi extension does over its
long-lived queue.

Cross-event state that Pi keeps in memory (monotonic `seq`, transcript byte
offset, open tool ids) is persisted to disk at
`${TMPDIR}/pi-obs-cc/<session_id>/` so it survives the short-lived process
boundary.

---

## Install

### Prerequisites

- [`bun`](https://bun.sh) >= 1.1
- `pi-agent-observability` server running (`just obs`)
- An `OBS_AUTH_TOKEN` that matches the server

### 1. Set environment variables

```bash
export OBS_AUTH_TOKEN=your-token      # must match the server
export OBS_SERVER_URL=http://127.0.0.1:43190   # default
export OBS_POOL=my-pool               # optional
export OBS_TAG=tag1,tag2              # optional
export OBS_NAME=my-claude-session     # optional, default "claude-code"
```

You can also put these in `.env` or `.env.local` in your project root; the
bridge loads them automatically (same logic as the Pi extension).

### 2. Register the hooks

Copy the hooks block from `settings.template.json` into your
`~/.claude/settings.json` (global) or `<project>/.claude/settings.json`
(per-project). Replace `/ABS/PATH` with the absolute path to this repo:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "SubagentStop": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "PreCompact": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "SessionEnd": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ],
    "Notification": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ]}
    ]
  }
}
```

### 3. Run Claude Code

```bash
claude
```

Your session appears in the dashboard as its own lane, alongside any Pi
sessions in the same pool.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OBS_SERVER_URL` | `http://127.0.0.1:43190` | Observability server URL |
| `OBS_AUTH_TOKEN` | *(empty)* | Bearer token — must match `OBS_AUTH_TOKEN` on the server |
| `OBS_POOL` | `default` | Logical pool name (groups sessions in swimlane/race views) |
| `OBS_TAG` | *(empty)* | Comma-separated tag list |
| `OBS_NAME` | `claude-code` | Human-friendly agent name |
| `OBS_DISABLE` | *(unset)* | Set to `true` to disable the bridge entirely |

---

## Cursor hooks and Pi delegation

Global Claude Code hooks (`~/.claude/settings.json`) also fire when **Cursor IDE**
runs agents through its SDK — including when **pi** delegates work to Cursor
(`provider=cursor`). Those hooks use camelCase event names (`sessionStart`,
`beforeSubmitPrompt`, `stop`, `sessionEnd`) and include a `cursor_version` field.

The pi extension (`extension/pi-observability.ts`) already emits the full event
stream for pi+cursor sessions. To avoid duplicate swimlane lanes, the bridge
applies **three skip rules** in `cursor-detect.ts` (all global — no per-project
hook scoping required):

| Rule | When | Why |
|------|------|-----|
| **1. Always skip Cursor `sessionStart`** | `cursor_version` present + `hook_event_name === "sessionStart"` | Fires before pi harness text is available; a lone `sessionStart` was the event that spawned empty phantom swimlane columns via auto-add |
| **2. Skip pi-delegated prompts** | `beforeSubmitPrompt` contains `"System instructions from pi"` or `"operating inside pi"` | Confirms Cursor is running inside pi; sets `piDelegated` in session state |
| **3. Skip subsequent hooks** | `piDelegated: true` in `${TMPDIR}/pi-obs-cc/<session_id>/state.json` | Covers `preToolUse`, `postToolUse`, `stop`, `sessionEnd`, etc. when prompt text is absent |

Skipped hooks are logged to `${TMPDIR}/pi-obs-cc/<session_id>/debug.log` under
`skip_cursor_pi_delegated`.

Implementation: `integrations/claude-code/cursor-detect.ts`,
`integrations/claude-code/state.ts` (`piDelegated` field).

### Tradeoffs (global hooks, bridge-level dedup)

These are intentional compromises so you can keep **one global**
`~/.claude/settings.json` install without polluting native pi sessions.

#### What you gain

- **Pi + Cursor (`provider=cursor`)**: one swimlane, one session UUID, full event
  stream from `extension/pi-observability.ts` — no phantom `agent-*` lanes.
- **Claude Code CLI**: unchanged. PascalCase hooks (`SessionStart`, `UserPromptSubmit`,
  …) still map to full `ObsEvent` envelopes with tokens and cost.
- **Global install**: no need to duplicate hooks per project or maintain separate
  `~/.claude` vs project-level configs.

#### What you give up or change

| Area | Tradeoff | Detail |
|------|----------|--------|
| **Standalone Cursor `sessionStart`** | Not emitted | Cursor IDE sessions (not running through pi) no longer produce a `custom` / `sessionStart` event. The lane appears on the first `beforeSubmitPrompt` instead. Session metadata that only existed on `sessionStart` (e.g. `workspace_roots`, `cursor_version`) is absent unless a later hook carries it. |
| **Standalone Cursor lifecycle** | Partial stream only | Hooks the bridge does not map (most camelCase Cursor events) still become `custom` events if not pi-delegated. There is no full Cursor→ObsEvent mapping like Claude Code CLI — by design, to avoid duplicating pi extension semantics. |
| **Pi harness coupling** | String markers | Pi-delegation detection depends on pi injecting `"System instructions from pi"` and `"operating inside pi"` into the Cursor prompt. If pi renames or removes these phrases, delegation skip may fail until markers are updated in `cursor-detect.ts`. |
| **False-positive risk (low)** | Standalone Cursor prompt mentions pi | A standalone Cursor user prompt that literally contains both marker phrases would be suppressed. Markers are multi-word harness phrases, not bare `"pi"`, to keep this rare. |
| **False-negative risk (low)** | Harness not in first prompt | If pi ever stops prepending harness text before the first `beforeSubmitPrompt`, rule 2 would not fire; rule 1 still prevents the phantom `sessionStart` lane. Remaining hooks might leak until markers appear or `piDelegated` is set. |
| **Skipped-hook visibility** | Debug log only | Suppressed Cursor hooks are not POSTed to the dashboard. Inspect `${TMPDIR}/pi-obs-cc/<session_id>/debug.log` for `skip_cursor_pi_delegated` entries. Pi extension events remain the source of truth for pi+cursor runs. |
| **Historical phantom sessions** | Still in DB | Sessions created before this fix remain in SQLite and may still appear if lanes were restored from URL state. New pi+cursor runs should not add new phantoms. |
| **No server/schema changes** | Bridge-only fix | Deliberately avoids `/events` API or dashboard changes. Optional future hardening: swimlane auto-add guard, or `GET /sessions` cwd correlation at hook time (adds latency per hook). |

#### Alternatives considered (not chosen)

| Approach | Why not |
|----------|---------|
| **Per-project hook scoping** | Works but conflicts with global install requirement. |
| **Map Cursor hooks → full ObsEvents in CC bridge** | Would duplicate pi extension events and create parallel semantic streams. |
| **Disable global hooks when using pi** | Manual, error-prone; defeats unified observability goal. |
| **Blanket suppress all `cursor_version` hooks** | Would hide legitimate standalone Cursor IDE sessions entirely. |

#### Recommended mental model

- **Claude Code CLI** → CC bridge is the telemetry source (mapped events, cost, tokens).
- **Pi (any provider)** → pi extension is the telemetry source.
- **Pi + Cursor** → pi extension only; CC bridge is a no-op for Cursor hooks.
- **Standalone Cursor IDE** → CC bridge emits sparse `custom` events from
  `beforeSubmitPrompt` onward; not a full agent lifecycle mirror.

---

## Hook → ObsEvent mapping

| Claude Code hook | ObsEvent(s) emitted | Notes |
|---|---|---|
| `SessionStart` | `session_start` | `source` mapped to `reason`; seq reset to 0 |
| `UserPromptSubmit` | `user_message` + `agent_start` | Text truncated to `MAX_TEXT_FIELD` (32 KB) |
| `PreToolUse` | `tool_call` | Derived `tool_call_id`; args deep-truncated to 16 KB |
| `PostToolUse` | `tool_result` | Same derived id; `content_text` truncated to 32 KB |
| `Stop` / `SubagentStop` | `assistant_message` (+ `thinking`) + `agent_end` | Transcript tail parsed for usage/cost/model |
| `PreCompact` | `compaction` | `reason` from `trigger`; counts unavailable → 0/"" |
| `SessionEnd` | `session_shutdown` | `reason` mapped to legal union |
| `Notification` / other | `custom` | `custom_type = hook_event_name` |

### SessionStart `source` → `reason` mapping

| Claude Code `source` | `SessionStartPayload.reason` |
|---|---|
| `startup` | `startup` |
| `resume` | `resume` |
| `clear` | `new` |
| `compact` | `startup` |
| *(other)* | `startup` |

### `tool_call_id` derivation

Claude Code's `PreToolUse` and `PostToolUse` hooks do not expose a native
`tool_use_id` from the Anthropic API. A deterministic id is derived instead:

```
tool_call_id = "cc-" + sha256(tool_name + " " + stableJSON(tool_input))[0:16]
```

`stableJSON` = `JSON.stringify` with sorted keys, so key-order jitter does not
break pairing. The native `toolu_...` ids appear in the transcript and are used
as `tool_call_ids` in `assistant_message` payloads. These two id spaces do not
collide because the `PostToolUse` hook does not expose the native id.

**Known limitation:** two concurrent tool calls with byte-identical
`tool_name + tool_input` share a derived id. The open-id counter in the state
file tracks this; pairing falls back to FIFO. Documented as a known limitation.

---

## Cost computation

The transcript does not carry a `cost` field — only token counts and a model
id. The bridge computes `cost_total` from `model-prices.ts`:

```
cost_total = (input * in_price + output * out_price
           + cache_read * cr_price + cache_write * cw_price) / 1_000_000
```

Prices are in USD per million tokens. The table in `model-prices.ts` covers:

| Model | Input $/M | Output $/M | Cache read $/M | Cache write $/M |
|---|---|---|---|---|
| claude-opus-4-8 | $15.00 | $75.00 | $1.50 | $18.75 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.30 | $3.75 |
| claude-haiku-4-5 | $0.80 | $4.00 | $0.08 | $1.00 |

Unknown models yield `cost_total: 0` (never a crash) and a note in the debug
log. Update `model-prices.ts` when Anthropic changes pricing.

---

## Persistent state

State is stored under `${TMPDIR}/pi-obs-cc/<session_id>/`:

| File | Purpose |
|---|---|
| `seq` | Append-byte atomic counter; fileSize = next seq value |
| `state.json` | `transcriptOffset`, `openToolIds`, `firstRunLogged`, `piDelegated` |
| `debug.log` | Error and diagnostic log (first hook payload, unknown models, etc.) |
| `spool/*.json` | Events spooled when the server was unreachable (auto-pruned) |

The `seq` file uses O_APPEND writes (one byte per allocation) which are atomic
on local filesystems, making collisions essentially impossible even when Claude
Code fires concurrent `PostToolUse` hooks. The server's
`INSERT OR IGNORE ON UNIQUE(session_id, seq)` is a safety net, not the primary
mechanism.

---

## Live E2E verification (manual)

Once you have the server running and hooks registered:

```bash
# 1. Start the observability server
OBS_AUTH_TOKEN=mytoken just obs

# 2. Run Claude Code (prompts/tool calls will stream to the dashboard)
OBS_AUTH_TOKEN=mytoken OBS_POOL=cc-test claude

# 3. After a Stop event, check token/cost totals
curl -H "Authorization: Bearer mytoken" \
     "http://127.0.0.1:43190/sessions?pool=cc-test"

curl -H "Authorization: Bearer mytoken" \
     "http://127.0.0.1:43190/sessions/<session_id>/stats"

# 4. Open the dashboard and find the session in swimlane/race view
open "http://127.0.0.1:43190/?token=mytoken"
```

Expected: the session appears with `agent_name=claude-code`, non-zero
`total_tokens`, and non-zero `total_cost`.

---

## Known limitations

- **Timing fields** (`prefill_ms`, `generation_ms`, `output_tps`): not
  derivable from hooks (no streaming deltas). `latency_ms` is approximated
  from transcript timestamps (assistant last-line ts minus preceding user ts).
- **`tokens_before` on `compaction`**: not provided to `PreCompact`; emitted
  as 0.
- **Duplicate tool ids**: byte-identical concurrent tool calls share a derived
  id; pairing is best-effort FIFO.
- **Subagent sessions**: `SubagentStop` uses the parent `session_id` and
  `transcript_path` from the hook stdin; if Claude Code subagents carry a
  different `session_id`, they appear as their own lane (acceptable).
- **Cost accuracy**: depends on `model-prices.ts` being current; update the
  table at `integrations/claude-code/model-prices.ts` when prices change.
- **No retroactive backfill**: if the bridge was disabled during a run, those
  events are lost (same as the Pi extension).
- **Cursor + pi dedup**: see [Cursor hooks and Pi delegation](#cursor-hooks-and-pi-delegation)
  for tradeoffs when global hooks are installed (skipped `sessionStart`, harness
  markers, standalone Cursor partial stream).

---

## Running tests

```bash
bun test integrations/claude-code/obs-hook.test.ts
```

All 42 tests cover: transcript deduplication (the key requirement), usage
mapping, cost computation, seq counter atomicity, state round-trips, tool_call_id
determinism, truncation limits, envelope shape validation, and Cursor/pi
delegation skip behavior.
