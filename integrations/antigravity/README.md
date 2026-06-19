# Antigravity (agy) → Pi Observability Bridge

A Bun/TypeScript hook handler that translates **Google Antigravity CLI** (`agy`)
lifecycle hooks into the same `ObsEvent` envelopes the Pi extension uses, and
POSTs them to the same `POST /events` server. agy sessions appear in the **same
dashboard** as Pi and Claude Code agents.

**NO server or dashboard changes are required.**

> ⚠️ **Cost & tokens are not available.** agy exposes no token usage or cost in
> its hook payloads *or* its JSONL transcript (verified by inspecting the binary
> and live payloads). `assistant_message.usage` is therefore emitted as zeros —
> the session lane, prompts, thinking, tool calls and results all populate, but
> the cost/token columns read 0. See [Known limitations](#known-limitations).

---

## How it works

agy fires a separate short-lived process per lifecycle event (a shell command
registered in `hooks.json`). This bridge is that command: it reads a JSON
payload from stdin, maps it to `ObsEventEnvelope`s, and POSTs them to
`${OBS_SERVER_URL}/events`.

Two things differ from the [Claude Code bridge](../claude-code/README.md):

1. **agy does not pass the event name on stdin.** The `hooks.json` command
   passes it as the first CLI argument: `bun obs-hook.ts PreToolUse`.
2. **agy has only 5 hook events** — `PreToolUse`, `PostToolUse`, `PreInvocation`,
   `PostInvocation`, `Stop` — and **no `SessionStart` / `UserPromptSubmit` /
   `SessionEnd`**. So:
   - `session_start` is synthesized lazily on the first hook for a conversation.
   - prompts / assistant text / thinking are read from the JSONL transcript
     (`transcriptPath`) rather than from a dedicated hook.

Cross-event state (monotonic `seq`, transcript byte offset, "session_start
emitted" flag, learned model label) is persisted to
`${TMPDIR}/pi-obs-agy/<conversationId>/` so it survives the per-hook process
boundary. The `seq` counter uses the same atomic append-byte scheme as the
Claude Code bridge.

---

## Install

### Prerequisites

- [`bun`](https://bun.sh) >= 1.1
- `agy` (Antigravity CLI)
- `pi-agent-observability` server running (`just obs`)
- An `OBS_AUTH_TOKEN` that matches the server

### 1. Install the hooks config

🔴 **The path matters.** agy's backend executes hooks from **`~/.gemini/config/hooks.json`**.
The sibling `~/.gemini/antigravity-cli/hooks.json` is read by the TUI for
display only — hooks placed there show up in `/hooks` but **never execute**.

Copy `hooks.template.json` to `~/.gemini/config/hooks.json`, replace `/ABS/PATH`
with the absolute path to this repo, and remove the `_instructions` key. Or use
the justfile helper:

```bash
just agy-install        # writes ~/.gemini/config/hooks.json pointing at this repo
just agy-uninstall      # removes it
```

If you already have hooks in `~/.gemini/config/hooks.json`, merge the five
event entries by hand rather than overwriting.

### 2. Set environment variables

> **The bridge is inert until you set `OBS_AUTH_TOKEN`.** Because the hook is
> installed globally (`~/.gemini/config/hooks.json`) it runs on every agy
> session; with no token it exits immediately (no POST, no disk writes), so
> your normal agy usage is not taxed. Export the token to activate telemetry
> for a session.

agy hooks inherit the environment of the `agy` process, so export these in the
shell you launch `agy` from (or put them in `.env` / `.env.local` in your
workspace — the bridge loads those automatically):

```bash
export OBS_AUTH_TOKEN=your-token              # must match the server
export OBS_SERVER_URL=http://127.0.0.1:43190  # default
export OBS_POOL=my-pool                        # optional
export OBS_TAG=tag1,tag2                        # optional
export OBS_NAME=my-agy-session                  # optional, default "antigravity"
```

### 3. Run agy

```bash
agy
```

Your session appears in the dashboard as its own lane, alongside any Pi /
Claude Code sessions in the same pool.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OBS_SERVER_URL` | `http://127.0.0.1:43190` | Observability server URL |
| `OBS_AUTH_TOKEN` | *(empty)* | Bearer token — must match the server |
| `OBS_POOL` | `default` | Logical pool name (groups sessions in swimlane/race views) |
| `OBS_TAG` | *(empty)* | Comma-separated tag list |
| `OBS_NAME` | `antigravity` | Human-friendly agent name |
| `OBS_DISABLE` | *(unset)* | Set to `true` to disable the bridge entirely |

---

## Hook → ObsEvent mapping

| agy hook | stdin fields used | ObsEvent(s) emitted | Notes |
|---|---|---|---|
| *(first hook seen)* | `conversationId`, `workspacePaths` | `session_start` | synthesized once, `seq` 0, `reason: startup` |
| `PreToolUse` | `toolCall {name, args}` | `tool_call` | derived `tool_call_id`; args deep-truncated to 16 KB |
| `PostToolUse` | `toolCall`, `error`, `stepIdx` | `tool_result` | same derived id; `is_error` from `error`; output text pulled best-effort from the transcript |
| `PreInvocation` / `PostInvocation` | `transcriptPath` | `user_message` + `agent_start`, `assistant_message` (+ `thinking`) | drains new transcript entries |
| `Stop` | `transcriptPath`, `terminationReason` | *(drain)* + `agent_end` + `session_shutdown` | `reason` mapped to `quit` |
| *(any other)* | (raw) | `custom` | `custom_type = <event name>` |

### `tool_call_id` derivation

agy hooks expose no native tool id, and the same call appears in two places
(the `PreToolUse`/`PostToolUse` hook and the transcript's `PLANNER_RESPONSE`)
with slightly different args (the transcript adds UI keys like `toolAction`,
`toolSummary`, and the hook adds `WaitMsBeforeAsync`). The bridge strips those
noise keys, then derives:

```
tool_call_id = "agy-" + sha256(tool_name + " " + stableJSON(normalizedArgs))[0:16]
```

so `tool_call`, `tool_result`, and `assistant_message.tool_call_ids` all link
in the dashboard. Verified: ids match across hook and transcript.

---

## Persistent state

State lives under `${TMPDIR}/pi-obs-agy/<conversationId>/`:

| File | Purpose |
|---|---|
| `seq` | Append-byte atomic counter; fileSize = next seq value |
| `state.json` | `transcriptOffset`, `bootEmitted`, `model`, `firstRunLogged` |
| `debug.log` | First hook payload, model-learning, errors |
| `spool/*.json` | Events spooled when the server was unreachable (auto-pruned to 20) |

---

## Known limitations

- **No cost or tokens.** Neither the hook payloads nor `transcript_full.jsonl`
  carry usage. `assistant_message.usage` is all zeros and the dashboard
  cost/token columns read 0. The only place per-turn tokens live is the
  protobuf-encoded SQLite at `~/.gemini/antigravity-cli/conversations/<id>.db`;
  decoding that is out of scope for this bridge (future work).
- **Model id is a human label.** agy never emits a model identifier to hooks;
  the bridge scrapes the label (e.g. `Gemini 3.5 Flash (High)`) from the
  transcript's `USER_SETTINGS_CHANGE` block when present, else leaves it unset.
- **`session_start` carries no model.** It is emitted before the transcript is
  read; later events carry the model and the server upserts it.
- **Tool result text is best-effort.** `PostToolUse` has no output text; the
  bridge surfaces the newest tool-output entry from the transcript. Parallel
  tool calls can mismatch result text (ids still pair correctly).
- **No `session_start`/`user prompt` hook.** Both are reconstructed (synthetic
  start; prompt from the transcript's `USER_INPUT`).
- **hooks.json path.** Must be `~/.gemini/config/hooks.json`; the TUI-only
  `~/.gemini/antigravity-cli/hooks.json` parses but never executes.
- **Fail-closed hooks.** A throwing `PreToolUse` hook blocks the tool call, so
  the handler always exits 0 and never throws to agy.

---

## Verified hook surface (agy 1.0.10)

Hook events: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`,
`Stop`. Stdin keys (captured live):

- `PreToolUse` / `PostToolUse`: `conversationId, stepIdx, toolCall {name, args},
  transcriptPath, artifactDirectoryPath, workspacePaths` (+ `error` on Post).
- `PreInvocation` / `PostInvocation`: `conversationId, invocationNum,
  initialNumSteps, transcriptPath, artifactDirectoryPath, workspacePaths`.
- `Stop`: `conversationId, executionNum, fullyIdle, terminationReason, error,
  transcriptPath, workspacePaths`.
