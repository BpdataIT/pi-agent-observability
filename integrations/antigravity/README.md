# Antigravity (agy) → Pi Observability Bridge

A Bun/TypeScript hook handler that translates **Google Antigravity CLI** (`agy`)
lifecycle hooks into the same `ObsEvent` envelopes the Pi extension uses, and
POSTs them to the same `POST /events` server. agy sessions appear in the **same
dashboard** as Pi and Claude Code agents.

**NO server or dashboard changes are required.**

> 💡 **Cost & tokens ARE available** (new turns). agy exposes no token usage
> via hooks or its JSONL transcript, so the bridge decodes the per-turn counts
> from the protobuf `gen_metadata` table in the conversation SQLite db
> (`~/.gemini/antigravity-cli/conversations/<id>.db`) and stamps real
> `usage.input` / `output` / `cost_total` / `context_window` onto each
> `assistant_message`. The context bar, cost, and token columns populate for
> new turns. **Legacy agy sessions recorded before the decoder shipped stay
> zero** (no retroactive decode unless you run the optional backfill — see
> [Backfill](#optional-backfill-for-legacy-agy-sessions)). See
> [Known limitations](#known-limitations) and
> [`usage-decoder.md`](./usage-decoder.md) for the reverse-engineered-protobuf
> caveats.

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

**Per-turn token usage** is decoded from the conversation's `gen_metadata`
SQLite table (no hooks/transcript carry it) by [`usage-decoder.ts`](./usage-decoder.ts).
Each `PostInvocation`/`Stop`, the bridge opens the `.db` read-only, decodes the
newest `gen_metadata` rows past a persisted `usageIdxOffset`, pairs them to the
drained assistant turns, and stamps `usage` + `context_window` (cost via
[`model-prices.ts`](./model-prices.ts)). All `.db` access is read-only and
never throws — a locked/corrupt/missing db degrades to zero usage for that
turn and the hook still exits 0.

Cross-event state (monotonic `seq`, transcript byte offset, `usageIdxOffset`,
"session_start emitted" flag, learned model label) is persisted to
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
just agy-install        # writes ~/.gemini/config/hooks.json pointing at the hook source
just agy-uninstall      # removes it
```

**Single source of truth.** The hook commands point at the path
`pi install git:github.com/BpdataIT/pi-agent-observability@main` updates
(`AGY_HOOKS_SRC`, default
`~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability` — the pi-installed
BpdataIT clone), so **one `pi install` refreshes both the pi extension and the
agy hooks**. The legacy `github.com/disler` clone is no longer referenced.

To point the hooks at a different clone (e.g. your working repo during
development), override the source:

```bash
AGY_HOOKS_SRC="$PWD/pi-agent-observability" just agy-install   # → working tree
AGY_HOOKS_SRC="$PWD/pi-agent-observability" just agy-hooks-print  # preview first
```

> **Uncommitted work note.** New agy bridge code (the `context_window` stamp
> via `model-context.ts`, and the `gen_metadata` usage decoder) lives in the
> working tree and only reaches the installed hook path once committed, pushed,
> and pulled by `pi install`. To exercise that new code locally before
> committing, set `AGY_HOOKS_SRC` to your working repo as above.

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
|---||
| `seq` | Append-byte atomic counter; fileSize = next seq value |
| `state.json` | `transcriptOffset`, `usageIdxOffset`, `bootEmitted`, `model`, `firstRunLogged` |
| `debug.log` | First hook payload, model-learning, usage decode errors/mismatches, errors |
| `spool/*.json` | Events spooled when the server was unreachable (auto-pruned to 20) |

`usageIdxOffset` is the `gen_metadata` idx to decode from on the next hook —
the incremental analog of `transcriptOffset`. Only rows with `idx >=
usageIdxOffset` are decoded, so the per-turn protobuf is read once. It resets
to 0 if the `.db` shrank (conversation reset), mirroring `transcriptOffset`'s
resilience.

## Decoding token usage (`gen_metadata`)

agy records per-call token counts only in the protobuf `gen_metadata` table of
`~/.gemini/antigravity-cli/conversations/<id>.db` — no `.proto` ships with agy,
so [`usage-decoder.ts`](./usage-decoder.ts) reverse-engineers the field map.
The confirmed map (verified across the live corpus, agy 1.0.10):

| field | meaning |
|---|---|
| `f1.f4.f5` | prompt / **input** tokens (context prefix) |
| `f1.f4.f10` | candidates / **output** tokens (response) |
| `f1.f4.f9` | thoughts / thinking tokens (decoded, not billed) |
| `f1.f4.f3` | total generated = `f9 + f10` (invariant: holds on 100% of rows) |
| `f1.f21` | human model label (e.g. `Gemini 3.5 Flash (High)`) |

The invariant `f3 == f9 + f10` (total = thinking + candidates) holds on 100% of
2 226 corpus rows, which pins the output/thinking split. See
[`usage-decoder.md`](./usage-decoder.md) for the full derivation, the Gemini
sub-trajectory monotonicity caveat, and the open-db strategy.

### Re-validating after an agy bump

```bash
just agy-usage-validate   # sweeps all conversation .db files; checks the
                           # f3==f9+f10 invariant + input/output field map
```

If the `VERDICT` refutes the map, dump one row's field tree with
`bun integrations/antigravity/usage-decoder.ts <db> --idx 0` and re-derive
`GEN_METADATA_FIELD_MAP`, then update `usage-decoder.md`.

### Debug CLI

```bash
bun integrations/antigravity/usage-decoder.ts <db-or-uuid>              # dump every row
bun integrations/antigravity/usage-decoder.ts <db-or-uuid> --idx 5       # one row
bun integrations/antigravity/usage-decoder.ts <db-or-uuid> --match-content  # pair with transcript text
bun integrations/antigravity/usage-decoder.ts <db-or-uuid> --json        # machine-readable
```

## Cost & context window (shared model-metadata table)

Window and cost both resolve from the **single source of truth** at
[`shared/model-metadata.ts`](../../shared/model-metadata.ts) (see
[`shared/model-metadata.md`](../../shared/model-metadata.md)). The local
[`model-context.ts`](./model-context.ts) (`contextWindowForLabel`) and
[`model-prices.ts`](./model-prices.ts) (`getModelPrice` / `computeCost`) are
**thin wrappers** preserved for signature compatibility — their bodies delegate
to the shared module, so `transcript.ts` / `obs-hook.ts` / the `scripts/agy-*`
helper scripts import them unchanged. Edit the **shared** table when a provider
ships a new window or price; `just model-metadata-validate` checks it against
the models.dev registry.

agy exposes the model as a human display label (e.g. `Gemini 3.5 Flash (High)`),
which the shared normalizer collapses to the same canonical key the
canonical-id integrations produce. Prices per-million tokens are sourced from
the Google AI for Developers + Anthropic pricing pages (consulted 2026-06-20).
Unknown labels yield `cost_total: 0` + a debug log (never throw). **Note:**
thinking tokens (`f9`) are decoded but intentionally not billed, so cost is a
conservative lower bound for Gemini High-effort turns — see
[`usage-decoder.md`](./usage-decoder.md).

> The **pi extension** is intentionally NOT a consumer of the shared context
> table — it reads the real window from `ctx.getContextUsage()` at runtime
> (strictly more accurate). The shared table is the fallback for the
> out-of-process integrations + the UI legacy path.

---

## Known limitations

- **Reverse-engineered protobuf usage.** Token counts come from decoding agy's
  `gen_metadata` SQLite blobs (no `.proto` ships with agy). The field map is
  empirical — verified against the live corpus as of agy 1.0.10 (`just
  agy-usage-validate`) — and may need re-derivation after an agy version bump.
  Decode failures degrade to zero usage (never throw). See
  [`usage-decoder.md`](./usage-decoder.md).
- **Legacy sessions stay zero by default.** agy sessions recorded in the
  dashboard before the decoder shipped keep zero usage (no retroactive decode).
  New turns populate. Optional retroactive decode: see
  [Backfill](#optional-backfill-for-legacy-agy-sessions).
- **Thinking tokens not billed.** Gemini thinking (`f1.f4.f9`) is decoded but
  excluded from `output`/cost (conservative lower bound for High-effort turns).
- **Timing columns mostly empty.** `latency_ms` / `prefill_ms` / `generation_ms`
  / `output_tps` are omitted unless derivable — agy's `executor_metadata`/
  `steps` carry no per-turn timestamps, so they are not fabricated.
- **cache_read / cache_write are 0.** agy reports the whole prefix as one input
  number (`f5`); it does not split cached vs uncached. The context-bar
  numerator (`input + cache_read + cache_write`) still equals the real prefix.
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

The `gen_metadata` protobuf schema (input `f1.f4.f5`, output `f1.f4.f10`,
thinking `f1.f4.f9`, total `f1.f4.f3`, label `f1.f21`) was also verified
against agy 1.0.10 across 48 conversation `.db` files — see
[`usage-decoder.md`](./usage-decoder.md) and `just agy-usage-validate`.

---

## Optional: backfill for legacy agy sessions

Legacy agy sessions already in the dashboard (recorded before the usage
decoder shipped) keep zero usage by default. The optional backfill script
re-decodes each conversation's `gen_metadata` and writes the corrected
`assistant_message.usage` into `db/obs.db`:

```bash
# Stop the server first, then:  (opt-in; legacy sessions otherwise stay zero)
bun scripts/agy-backfill-usage.ts --session <conversationId> --confirm
bun scripts/agy-backfill-usage.ts --all --confirm                # every agy session
```

It is **idempotent** (skips turns whose `usage.total_tokens > 0`) and gated
behind `--confirm`. This is intentionally not run automatically — it writes
directly to `db/obs.db`, so stop the observability server first to avoid a
write conflict.
