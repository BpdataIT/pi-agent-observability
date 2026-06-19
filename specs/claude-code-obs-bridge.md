# Implementation Plan: Claude Code → Pi Observability Bridge

## Metadata

**ID:** feature-cc0bs1
**Created:** 2026-06-02
**Total Stories:** 12
**Estimated Phases:** 4

## Feature Description

Add a "slot-in" integration so that **Claude Code** (Anthropic's CLI coding agent)
reports its lifecycle telemetry into the SAME observability server and dashboard
that the existing **Pi** agent extension uses. It must use the same `POST /events`
ingestion endpoint, the same `ObsEvent` envelope schema (`shared/types.ts`), the
same SQLite store (`apps/observability/db.ts`), and the same SSE dashboard
(single / swimlane / race views). The deliverable is the Claude Code equivalent of
`extension/pi-observability.ts`, implemented against Claude Code's **hooks** system
rather than Pi's long-lived extension process.

**Mechanism difference that drives the whole design:** Pi loads one long-lived
extension process that keeps `seqCounter`, the `EventQueue`, and timing Maps in
memory across the entire session. Claude Code instead fires a **separate
short-lived process per lifecycle event** (a shell command registered in
`.claude/settings.json`, receiving a JSON object on **stdin**). Every piece of
cross-event state Pi keeps in memory — the monotonic `seq`, tool-call pairing,
per-turn timing, the "boot snapshot already emitted" gate, transcript read offset —
must instead be **persisted to disk** in a per-session state file and reloaded on
each hook invocation.

## Server / Dashboard changes required

**None.** Verified by reading `apps/observability/server.ts` and
`apps/observability/db.ts`:

- `POST /events` (server.ts:266) accepts any envelope with an `event_id` and
  `type`; it normalizes `pool`/`tags`/`seq`/`cwd` defaults and is completely
  source-agnostic. There is no "pi only" branch.
- Idempotency is `INSERT OR IGNORE` on the `UNIQUE(session_id, seq)` index
  (db.ts:42, 73-78). Any client that supplies a stable `session_id` and a
  monotonic `seq` participates correctly.
- Cost / token rollups (`getSessionStats`, db.ts:182-191) read **only**
  `json_extract(payload_json, '$.usage.total_tokens' | '$.usage.input' |
  '$.usage.output' | '$.usage.cost_total')` from rows where `type =
  'assistant_message'`. Context-utilization (`getSessionContext`, db.ts:213-225)
  reads `$.usage.input + $.usage.cache_read + $.usage.cache_write` from the latest
  `assistant_message`. So as long as the bridge emits `assistant_message` events
  whose `payload.usage` matches `UsageSummary`, the dashboard cost/token/context
  numbers populate identically to Pi with zero server changes.
- Sessions list / swimlane / race lanes key off `session_id`, `pool`, `tags`,
  `agent_name`, `provider`, `model` (db.ts `sessions` table + `listSessions`).
  A Claude Code session that sets `agent_name: "claude-code"` and a `pool`/`tags`
  appears as its own lane automatically.

**If implementation discovers any gap** (e.g. a payload field the dashboard
hard-requires that the transcript cannot supply), it MUST be flagged in the PR and
the default approach is to emit a schema-valid zero/empty value rather than change
the server. The one explicitly allowed server-adjacent change: none anticipated.

## Users

### Primary User
- **Persona:** Engineer running Claude Code who already runs the Pi observability server (`just obs`).
- **Goal:** See their Claude Code sessions — prompts, tool calls, token usage, and **cost** — live in the same dashboard alongside Pi agents, with no bespoke tooling.
- **Context:** They add a hooks block to `.claude/settings.json` (project or `~/.claude/settings.json`), set `OBS_AUTH_TOKEN` to match the server, and run `claude` as usual.

### Secondary Users
- **Fleet / multi-agent operator:** Runs several Claude Code (and Pi) agents into one `pool` and watches the swimlane / race views to compare cost and throughput across agents.
- **Maintainer of this repo:** Wants the bridge to mirror Pi's truncation / backoff / queue-cap behavior and config surface so the two integrations are mentally interchangeable.

## User Journey

The operator boots `just obs` (server prints a pinned `OBS_AUTH_TOKEN` and a
UI URL). They drop the provided hooks block into `.claude/settings.json` and export
`OBS_AUTH_TOKEN`, `OBS_SERVER_URL`, optionally `OBS_POOL` / `OBS_TAG` / `OBS_NAME`.
They run `claude`. On the first hook (`SessionStart`) the bridge emits
`session_start`; as they prompt and the agent works, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse` hooks stream `user_message` / `agent_start` /
`tool_call` / `tool_result`. On `Stop`, the bridge tails the `transcript_path`
JSONL, extracts the newest assistant turn(s) with their token usage + model,
computes cost from a model→price table, and emits `assistant_message` events with a
fully-populated `UsageSummary`. The session shows up as its own lane in the
swimlane/race views with correct cumulative cost and token totals — exactly like a
Pi session.

## User Stories

### Phase 1: Envelope, persistent seq, basic hook mapping, POST

**Delivers:** A single Bun/TS hook handler that, given Claude Code hook stdin,
emits schema-valid `ObsEvent` envelopes for session/prompt/tool lifecycle and POSTs
them to `/events` with the correct auth. Sessions appear in the dashboard with
correct ordering; cost/tokens not yet populated.
**Prerequisites:** Running obs server; `shared/types.ts` importable from the bridge.

#### Story 1.1: Hook handler skeleton + dispatch on `hook_event_name`
**As an** operator
**I want to** register one script that handles every Claude Code lifecycle hook
**So that** I don't maintain a separate command per event.

**Acceptance Criteria:**
- [ ] `integrations/claude-code/obs-hook.ts` reads the full JSON object from stdin, parses `hook_event_name`, and dispatches to a per-event handler.
- [ ] Unknown / unmapped `hook_event_name` values map to a `custom` event (`CustomPayload.custom_type = hook_event_name`) instead of crashing.
- [ ] The script never throws to stdout/stderr in a way that blocks Claude Code; all errors are caught and (optionally) logged to a debug file under the state dir. It always exits 0.
- [ ] Respects `OBS_DISABLE=true` (and `--obs-disable`-equivalent): exits 0 immediately, emitting nothing.

**Complexity:** M
**Dependencies:** None

#### Story 1.2: Config parity (env surface) + token pinning
**As an** operator
**I want** the bridge to read the same env vars as the Pi extension
**So that** it slots into my existing setup unchanged.

**Acceptance Criteria:**
- [ ] Reads `OBS_SERVER_URL` (default `http://127.0.0.1:43190`), `OBS_AUTH_TOKEN`, `OBS_POOL` (default `default`), `OBS_TAG` (comma-split), `OBS_NAME`, `OBS_DISABLE`.
- [ ] `agent_name` defaults to `"claude-code"` when `OBS_NAME` is unset.
- [ ] Loads `.env` / `.env.local` from `cwd` (mirroring `loadEnv` in pi-observability.ts:37) without overwriting shell-set vars.
- [ ] When `OBS_AUTH_TOKEN` is empty, the bridge still runs but writes a single warning line to the debug log noting the server will 401.

**Complexity:** S
**Dependencies:** 1.1

#### Story 1.3: Persistent monotonic `seq` per session across processes
**As the** dashboard
**I want** every event from a Claude Code session to carry a strictly increasing `seq`
**So that** event ordering, pagination, and `UNIQUE(session_id, seq)` idempotency work exactly as they do for Pi.

**Acceptance Criteria:**
- [ ] A per-session counter is persisted (see Technical Context → seq strategy) and incremented atomically per emitted envelope, surviving across the separate hook processes.
- [ ] `session_start` carries `seq: 0` (matches Pi resetting `seqCounter = 0`).
- [ ] Concurrent hook processes (e.g. parallel `PostToolUse`) never silently lose events: the design uses an atomic file operation and tolerates rare collisions via the server's `INSERT OR IGNORE` (collisions surface as a `rejected` entry, not data loss of a *different* event).
- [ ] A reset of the same `session_id` (Claude Code `clear`) starts a fresh state file / counter.

**Complexity:** L
**Dependencies:** 1.1

#### Story 1.4: SessionStart / SessionEnd / PreCompact mapping
**As an** operator
**I want** session boundaries and compaction recorded
**So that** the session lane has correct start/end and shows compaction events.

**Acceptance Criteria:**
- [ ] `SessionStart` → `session_start`; map `source` field: `startup`→`startup`, `resume`→`resume`, `clear`→`new`, `compact`→`startup` (compact-source restart). (`SessionStartPayload.reason` union is `startup|reload|new|resume|fork` — pick the closest legal value; document the mapping.)
- [ ] `SessionEnd` → `session_shutdown`; map `reason` to the legal `SessionShutdownPayload.reason` union (`quit|reload|new|resume|fork`), defaulting to `quit`.
- [ ] `PreCompact` → `compaction` with `reason: trigger === "manual" ? "manual" : "auto"`, `tokens_before: 0` (not available; document), `first_kept_entry_id: ""`, `summary_preview: ""`.
- [ ] `session_start` populates `cwd` from hook `cwd`, `session_file` from `transcript_path`, plus `pool`/`tags`/`agent_name`.

**Complexity:** M
**Dependencies:** 1.1, 1.2, 1.3

#### Story 1.5: UserPromptSubmit / PreToolUse / PostToolUse mapping
**As an** operator
**I want** my prompts and the agent's tool calls/results streamed
**So that** the transcript view matches what Pi produces.

**Acceptance Criteria:**
- [ ] `UserPromptSubmit` → `user_message` (`text` = `prompt`, truncated to `MAX_TEXT_FIELD`, `images_count: 0`) **and** a sibling `agent_start` (`AgentStartPayload.prompt` = same prompt, `images_count: 0`). Each gets its own `seq`.
- [ ] `PreToolUse` → `tool_call` with `tool_name` from `tool_name`, `args` from `tool_input` (deep-truncated to `MAX_ARGS_BYTES` via the same walk as `truncateArgs` in pi-observability.ts:81), `args_truncated` set accordingly.
- [ ] `PostToolUse` → `tool_result`: `content_text` derived from `tool_response` (stringify/extract text, truncate to `MAX_RESULT_BYTES`), `is_error` inferred from `tool_response` shape, `details_summary` carrying `exit_code`/`cancelled`/`truncated` when present.
- [ ] `PreToolUse` and `PostToolUse` for the same tool invocation share a `tool_call_id` (see Story 2.1).

**Complexity:** L
**Dependencies:** 1.1, 1.2, 1.3

#### Story 1.6: POST transport (per-hook synchronous, schema-valid)
**As the** server
**I want** the bridge to POST conformant envelopes with correct auth and limits
**So that** ingestion behaves identically to the Pi extension.

**Acceptance Criteria:**
- [ ] POSTs to `${OBS_SERVER_URL}/events` with `Authorization: Bearer <token>` and `Content-Type: application/json`, body = JSON array of envelopes (server accepts array or single — server.ts:281).
- [ ] Envelopes conform exactly to `ObsEventEnvelope<P>`: client-generated `event_id` (uuid v4), ISO-8601 `ts` with ms, `session_id`, `cwd`, `pool`, `tags` (never undefined), `payload`, monotonic `seq`; `agent_name`/`provider`/`model`/`session_file` set when known.
- [ ] Request body stays under `MAX_REQUEST_BYTES` (4 MB); oversize bodies are split or the offending field further truncated.
- [ ] A short timeout + bounded retry/backoff is applied so a dead server never stalls the hook (see Technical Context → transport).

**Complexity:** M
**Dependencies:** 1.1, 1.2, 1.3

---

### Phase 2: Transcript parsing for usage / cost / model (the key requirement)

**Delivers:** On `Stop` / `SubagentStop`, the bridge tails the transcript, extracts
the newest assistant turn(s) with token usage + model, computes cost, and emits
`assistant_message` events whose `payload.usage` matches `UsageSummary` — so the
dashboard's cost / token / context numbers populate exactly like Pi.
**Prerequisites:** Phase 1.

#### Story 2.1: Deterministic `tool_call_id` pairing
**As the** dashboard
**I want** `tool_call` and `tool_result` for one invocation to share an id
**So that** call/result link in the UI even though Claude Code hooks don't pass a shared id.

**Acceptance Criteria:**
- [ ] `tool_call_id` is derived deterministically: `cc-<short_sha256(tool_name + " " + canonicalJSON(tool_input))>` so `PreToolUse` and `PostToolUse` (which both carry identical `tool_name` + `tool_input`) compute the same id.
- [ ] If the transcript contains the real Anthropic `tool_use.id` and it is cheaply available at hook time, prefer it; otherwise use the derived id. (Implementation MUST check the actual hook payload / transcript for a `tool_use_id`-style field and document the finding — assumption: PostToolUse does not include the upstream id, to be verified.)
- [ ] The collision edge case (two in-flight tool calls with byte-identical `tool_name`+`tool_input`) is documented as a known limitation; a per-session monotonic salt from the state file MAY be appended when a `PreToolUse` for an already-open derived id is observed.

**Complexity:** M
**Dependencies:** 1.5

#### Story 2.2: Incremental transcript tail parsing
**As the** bridge
**I want** to consume only NEW transcript lines since the last `Stop`
**So that** each `Stop` emits only new assistant turns, not the whole transcript repeatedly.

**Acceptance Criteria:**
- [ ] The per-session state file records the last consumed byte offset (and/or last line index) of `transcript_path`.
- [ ] On `Stop`/`SubagentStop`, the bridge reads from the stored offset to EOF, parses each JSONL line, and advances the stored offset only after successful emit.
- [ ] If the file shrank or the offset is past EOF (transcript rotated / new file), parsing restarts from 0 and the anomaly is logged.
- [ ] Malformed / partial trailing lines are skipped without aborting the batch (transcript may be mid-write).

**Complexity:** L
**Dependencies:** 1.3, 1.6

#### Story 2.3: Usage + model extraction and `assistant_message` emit
**As the** dashboard
**I want** `assistant_message` events with a fully populated `UsageSummary`
**So that** cost / token / context rollups light up identically to Pi.

**Acceptance Criteria:**
- [ ] Assistant turns are **deduped by `.message.id`** before any usage is counted (see VERIFIED fact #2: each turn spans multiple JSONL lines repeating the same usage — summing per-line overcounts cost/tokens 3–4×). All lines sharing a `message.id` are merged into one logical turn (concatenate text, concatenate thinking, collect tool_use blocks) and `usage` is taken once.
- [ ] For each deduped assistant turn, the bridge extracts the merged text, any thinking, the tool_use ids, the `stop_reason`, and `usage` (mapped per VERIFIED fact #3: `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`).
- [ ] `UsageSummary` is built as: `input` ← input tokens, `output` ← output tokens, `cache_read` ← cache-read tokens, `cache_write` ← cache-creation tokens, `total_tokens` ← `input + output + cache_read + cache_write` (computed if the transcript lacks an explicit total), `cost_total` ← computed (Story 2.4).
- [ ] `provider` set to `"anthropic"` (or derived from the model id), `model` set to the transcript's model id; these are also placed on the envelope so `sessions.provider/model` populate.
- [ ] Emits one `assistant_message` per assistant turn (mirrors Pi emitting per `message_end`); a sibling `thinking` event is emitted when a thinking block exists (mirrors pi-observability.ts:706).
- [ ] `agent_end` is emitted on `Stop` with `message_count` = number of new assistant turns consumed (best-effort).

**Complexity:** L
**Dependencies:** 2.2

#### Story 2.4: Model→price table + cost computation
**As the** operator
**I want** correct `cost_total` even though the transcript may not include cost
**So that** the dashboard cost column is accurate.

**Acceptance Criteria:**
- [ ] If the transcript already carries a per-turn cost field, use it directly (verify during implementation; assumption: it does NOT, only token counts + model id).
- [ ] Otherwise compute `cost_total` from a `model→price` table: `(input * in_price + output * out_price + cache_read * cache_read_price + cache_write * cache_write_price) / 1e6` (prices per million tokens).
- [ ] The price table is a standalone data file (`integrations/claude-code/model-prices.ts`) keyed by model id, with a documented fallback (unknown model → cost 0 + a `custom`/debug note, never a crash).
- [ ] Timing fields: `latency_ms`/`prefill_ms`/`generation_ms`/`output_tps` are emitted **only if** the transcript exposes per-turn timestamps that allow them; otherwise omitted (they are optional in `AssistantMessagePayload`). The plan flags these as likely-not-derivable from hooks/transcript and recommends omission rather than fabrication.

**Complexity:** M
**Dependencies:** 2.3

---

### Phase 3: settings.json registration, config parity polish, docs

**Delivers:** A copy-paste `.claude/settings.json` block, a README mirroring the Pi
extension README, and a wrapper so the hook resolves `shared/types.ts`.
**Prerequisites:** Phases 1-2.

#### Story 3.1: `.claude/settings.json` hook registration template
**As an** operator
**I want** a ready-to-paste hooks block
**So that** I can enable the bridge in seconds.

**Acceptance Criteria:**
- [ ] `integrations/claude-code/settings.template.json` contains the exact hooks block (see "Exact settings.json" below) registering `obs-hook.ts` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`, and `Notification`.
- [ ] The command invokes the script with `bun` and an absolute path placeholder the README explains how to fill in.
- [ ] Matchers use `"*"` for tool hooks so every tool is observed.

**Complexity:** S
**Dependencies:** 1.1

#### Story 3.2: README + ENV docs (parity with extension/README.md)
**As an** operator
**I want** docs that mirror the Pi extension README
**So that** the two integrations feel the same.

**Acceptance Criteria:**
- [ ] `integrations/claude-code/README.md` documents install, the env-var table (same vars as extension/README.md:47-55), the hook→event mapping table, and the known limitations.
- [ ] The repo root `README.md` gains a short "Claude Code bridge" pointer.
- [ ] Docs state explicitly that NO server/dashboard change is required.

**Complexity:** S
**Dependencies:** 3.1, all of Phase 2

#### Story 3.3: `justfile` recipe (optional convenience)
**As a** maintainer
**I want** a `just` recipe to print/install the hooks block with the pinned token
**So that** local testing matches the Pi `just agent` ergonomics.

**Acceptance Criteria:**
- [ ] A `claude-agent` (or `cc-hooks-print`) recipe echoes the resolved settings block with `OBS_AUTH_TOKEN`/`OBS_SERVER_URL` from the justfile vars.
- [ ] Does not clobber an existing `.claude/settings.json` automatically (print, or merge behind an explicit flag).

**Complexity:** S
**Dependencies:** 3.1

---

### Phase 4: Testing / verification

**Delivers:** Confidence that a real Claude Code session lands in the dashboard with
correct cost/tokens, plus regression smoke tests.
**Prerequisites:** Phases 1-3.

#### Story 4.1: Synthetic hook-stdin fixtures + unit tests
**As a** maintainer
**I want** fixtures of each Claude Code hook payload
**So that** envelope mapping is tested without running Claude Code.

**Acceptance Criteria:**
- [ ] Fixture JSON for each `hook_event_name` plus a sample transcript JSONL lives under `integrations/claude-code/fixtures/`.
- [ ] A test pipes each fixture to `obs-hook.ts` and asserts the emitted envelope(s) validate against the `shared/types.ts` shapes (event_id/ts/seq/payload present, usage shape on `assistant_message`).
- [ ] A seq-monotonicity test fires many hooks (incl. concurrently) for one session and asserts no two distinct events share `(session_id, seq)`.

**Complexity:** M
**Dependencies:** Phases 1-2

#### Story 4.2: Live end-to-end against a running server
**As an** operator
**I want** a documented manual verification
**So that** I can confirm a Claude Code session appears as its own lane with correct totals.

**Acceptance Criteria:**
- [ ] Documented flow: `OBS_AUTH_TOKEN=dev just obs`, then `OBS_AUTH_TOKEN=dev bash scripts/smoke-server.sh` still passes (no regression), then run `claude` with the hooks block and verify via `GET /sessions?pool=...` and `GET /sessions/<id>/stats` that `total_cost`/`total_tokens` are non-zero.
- [ ] **A Claude Code session appears as its own lane in swimlane/race views with correct cost and token totals.**
- [ ] A pinned `OBS_AUTH_TOKEN` is used end-to-end (never the server's random default).

**Complexity:** M
**Dependencies:** 4.1, Phase 3

## Technical Context

### Existing Patterns to follow
- `extension/pi-observability.ts:215` `createEventEnvelope` — exact envelope field set; mirror it.
- `extension/pi-observability.ts:81` `truncateArgs` (deep walk + `truncateToBytes`) — reuse verbatim for `tool_input`.
- `shared/types.ts:312-334` `MAX_TEXT_FIELD`/`MAX_ARGS_BYTES`/`MAX_RESULT_BYTES`/`MAX_REQUEST_BYTES` + `truncateToBytes` — import and reuse, do not redefine.
- `extension/pi-observability.ts:37` `loadEnv` — reuse for `.env` loading.
- `extension/pi-observability.ts:625-712` `message_end` handler — the reference for how an `assistant_message` payload (text/thinking/tool_call_ids/stop_reason/usage/timing) is assembled; the transcript parser reproduces this from JSONL instead of live events.
- `apps/observability/db.ts:182-225` — the exact JSON paths the dashboard reads; the `usage` object must match `$.usage.input/output/cache_read/cache_write/total_tokens/cost_total`.

### New Components / Files
| Path | Purpose | New/Touched |
|---|---|---|
| `integrations/claude-code/obs-hook.ts` | The hook handler. Reads stdin JSON, dispatches on `hook_event_name`, builds + POSTs envelopes. The Claude Code equivalent of `pi-observability.ts`. | New |
| `integrations/claude-code/transcript.ts` | Incremental JSONL tail parser: read from stored offset, parse assistant turns, extract usage + model + text + thinking + tool_use ids + stop_reason. | New |
| `integrations/claude-code/model-prices.ts` | `model→price` table (per-million in/out/cache-read/cache-write) + `computeCost(usage, model)`; unknown-model fallback. | New |
| `integrations/claude-code/state.ts` | Per-session state: load/save `{ seq, transcriptOffset, openToolIds, bootSnapshotEmitted }`; atomic `nextSeq()`. | New |
| `integrations/claude-code/env.ts` | Config resolution (env + `.env` load), shared with the hook. (May be folded into obs-hook.ts.) | New (optional) |
| `integrations/claude-code/settings.template.json` | Copy-paste `.claude/settings.json` hooks block. | New |
| `integrations/claude-code/README.md` | Docs mirroring `extension/README.md`. | New |
| `integrations/claude-code/fixtures/*.json` + `transcript.sample.jsonl` | Test fixtures. | New |
| `integrations/claude-code/obs-hook.test.ts` | Unit tests (Story 4.1). | New |
| `shared/types.ts` | Imported only (no edits expected). | Read-only |
| `README.md` (root) | Add a pointer to the bridge. | Touched |
| `justfile` | Optional `claude-agent` recipe. | Touched (optional) |

### Persistent `seq` strategy (Story 1.3 — hard problem #1)
- State dir: `${TMPDIR or /tmp}/pi-obs-cc/<session_id>/state.json` (session_id from hook stdin; stable for the session's life).
- `nextSeq()`: open the per-session state file, read `seq`, increment, write back, return the pre-increment value. To survive concurrent hook processes (Claude Code can run `PostToolUse` hooks in parallel), use one of:
  - **Recommended:** an OS-atomic counter file via `O_APPEND` write of a single byte per allocation, where `seq = fileSize - 1` after append (append is atomic on local FS up to PIPE_BUF; each event appends exactly one byte, so the resulting offset is a unique monotonic integer). Simpler and lock-free.
  - Alternative: `proper-lockfile`-style advisory lock around a read-modify-write of `state.json` (a lock dep already exists in the repo tree).
- `session_start` forces `seq = 0` by (re)creating the counter file.
- Rare collisions (two processes computing the same seq under a race the chosen scheme failed to prevent) are tolerated by the server's `INSERT OR IGNORE` on `UNIQUE(session_id, seq)` — the loser is reported in `rejected[]`. This means a true collision drops ONE event, never corrupts ordering; the append-byte scheme is chosen specifically to make this essentially never happen. Document this tradeoff.
- `clear` source on `SessionStart`: wipe the session state dir before re-init.

### `tool_call_id` pairing (Story 2.1 — hard problem #2)
- Derive `tool_call_id = "cc-" + sha256(tool_name + " " + stableStringify(tool_input)).slice(0,16)`. `PreToolUse` and `PostToolUse` carry identical `tool_name` + `tool_input`, so both compute the same id and the dashboard links them.
- `stableStringify` = JSON with sorted keys so key-order jitter doesn't break pairing.
- **Better option to check during implementation:** inspect the actual `PostToolUse` stdin and the transcript line for a native `tool_use.id` (Anthropic assigns `toolu_…` ids). If present at hook time, prefer it. Assumption (to verify): hooks do NOT pass it, transcript DOES (so `assistant_message.tool_call_ids` can use the native ids while `tool_call`/`tool_result` use the derived ids — acceptable mismatch, or reconcile in Story 2.3).
- **Collision edge case:** two concurrent tool calls with byte-identical `tool_name`+`tool_input` collide on the derived id. Mitigation: the state file tracks `openToolIds` (derived ids seen at `PreToolUse` without a matching `PostToolUse`); if a second identical `PreToolUse` arrives while one is open, append a per-session salt (`#2`, `#3`). Documented as a known limitation since the matching `PostToolUse` cannot know which instance it pairs with — falls back to FIFO.

### Transcript parsing for usage/cost (Stories 2.2-2.4 — hard problem #3 / key requirement)
- `transcript_path` (from hook stdin) is a JSONL file; each line is a transcript entry. **Assumption to verify against a real transcript:** assistant entries look approximately like
  `{"type":"assistant","message":{"role":"assistant","model":"claude-...","content":[{"type":"text",...},{"type":"thinking",...},{"type":"tool_use","id":"toolu_...",...}],"stop_reason":"...","usage":{"input_tokens":N,"output_tokens":N,"cache_read_input_tokens":N,"cache_creation_input_tokens":N}}}`.
  The exact key names (`input_tokens` vs `input`, `cache_creation_input_tokens` vs `cache_write`) MUST be confirmed against an actual `~/.claude/projects/.../*.jsonl` during implementation; the parser maps whatever the real keys are onto `UsageSummary`.
- Incremental consumption: store `transcriptOffset` (byte offset) in the state file; on each `Stop`, `fs` read from offset → EOF, split on `\n`, parse each complete line, advance offset to the last fully-parsed newline. Skip the trailing partial line (mid-write). Reset to 0 if file shrank.
- `total_tokens` computed as `input + output + cache_read + cache_write` when no explicit total exists (matches what `getSessionStats` sums and the context bar reads).
- `cost_total` from `model-prices.ts` unless the transcript carries cost (verify; Claude Code stores a `costUSD`-style field on some entry types — if so, prefer it). The price table is the authoritative fallback.
- Timing fields (`latency_ms`/`prefill_ms`/`generation_ms`/`output_tps`): **flagged not reliably derivable** from hooks (no streaming deltas) and likely not from transcript either (no first-token timestamp). Recommendation: **omit** them (they are optional). If transcript entries carry per-entry `timestamp`s, `latency_ms` MAY be approximated as (assistant_entry_ts − preceding_user_entry_ts); document as approximate. `prefill_ms`/`output_tps` should remain omitted.

### ✅ VERIFIED transcript & hook facts (supersedes the assumptions above)

Confirmed by inspecting real transcripts under
`~/.claude/projects/<proj-slug>/<session-uuid>.jsonl` on this machine (current
Claude Code, model `claude-opus-4-8`). The parser in `transcript.ts` MUST be built
against these facts, not the earlier guesses:

1. **Transcript filename = `session_id`.** Each line is one JSON entry with a
   top-level `.type` in `{assistant, user, system, attachment,
   file-history-snapshot, ai-title, last-prompt, mode, permission-mode}`. Only
   `assistant` and `user` carry conversation/usage data; ignore the rest (or map to
   `custom` if desired). Every conversational entry has `.timestamp` (ISO-8601 ms),
   `.uuid`, `.parentUuid`, `.sessionId`, `.cwd`, `.gitBranch`, `.version`,
   `.requestId`.

2. **🔴 CRITICAL — one assistant turn spans MULTIPLE JSONL lines.** Claude Code
   writes **one `assistant` line per content block** (a `thinking` line, a `text`
   line, one `tool_use` line per tool call) and **every one of those lines repeats
   the identical `.message.usage` object and the same `.message.id` /
   `.requestId`.** Naively summing `usage` across assistant lines overcounts cost
   and tokens by the number of content blocks (commonly 3–4×). The parser **MUST
   dedupe assistant turns by `.message.id`** (equivalently `.requestId`) and count
   `usage` exactly once per unique id. Reconstruct one logical turn by grouping all
   `assistant` lines sharing a `message.id`: concatenate their `text` blocks, their
   `thinking` blocks, and collect their `tool_use` blocks.

3. **Usage shape (real keys):** `.message.usage = { input_tokens,
   output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
   cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens},
   server_tool_use, service_tier, iterations:[...], speed }`. Map to `UsageSummary`:
   `input ← input_tokens`, `output ← output_tokens`,
   `cache_read ← cache_read_input_tokens`, `cache_write ← cache_creation_input_tokens`,
   `total_tokens ← input + output + cache_read + cache_write`.

4. **🔴 No cost field anywhere.** `grep` for `cost` across the transcript returns
   nothing; usage has only token counts. `cost_total` MUST be computed from
   `model-prices.ts` (Story 2.4 is mandatory, not optional). `.message.model`
   (e.g. `"claude-opus-4-8"`) is the price-table key; set envelope `provider:
   "anthropic"`, `model: .message.model`.

5. **Native tool ids exist in the transcript.** Assistant `tool_use` blocks =
   `{type:"tool_use", id:"toolu_…", name, input}`. Tool results live in a **`user`**
   entry that has a top-level `.toolUseResult` object (structured) AND
   `.message.content[] = {type:"tool_result", tool_use_id:"toolu_…", is_error (often
   null), content (string | array)}`. So real `toolu_…` ids pair call↔result in the
   transcript — see the updated `tool_call_id` section for how this interacts with
   hook-time ids.

6. **Plain user prompt vs tool result:** a real user prompt entry has
   `.message.content` as a **string** and no `.toolUseResult`; a tool-result entry
   has `.toolUseResult` and `.message.content` as an array of `tool_result` blocks.
   Use the presence of `.toolUseResult` to distinguish them when parsing `user`
   lines (only relevant if sourcing tool results from the transcript).

7. **`stop_reason`** observed value: `"tool_use"`. Map Anthropic→`ObsEvent`
   stop_reason: `tool_use`→`toolUse`, `end_turn`/`null`→`stop`, `max_tokens`→`length`,
   `stop_sequence`→`stop`, else pass through.

8. **Timing:** entries carry `.timestamp` only (no first-token time). `latency_ms`
   may be approximated as (assistant turn's last `.timestamp` − the triggering
   `user` entry's `.timestamp`); `prefill_ms`/`generation_ms`/`output_tps` are NOT
   derivable → omit.

9. **Still to confirm at implementation time (log real hook stdin once):** the exact
   `hook_event_name` field name and per-event field names on hook **stdin**
   (`source`, `prompt`, `tool_name`, `tool_input`, `tool_response`, `trigger`,
   `reason`, `transcript_path`), and whether `PreToolUse`/`PostToolUse` stdin
   includes a `tool_use_id`. Everything in 1–8 above is confirmed from the transcript.

### Transport (Story 1.6 — per-process model)
- **Recommendation: POST synchronously per hook**, not a long-lived batch queue. Rationale: each hook is its own short-lived process, so Pi's in-memory 50/batch `EventQueue` (pi-observability.ts:249) cannot span events. Per-hook synchronous POST is simplest and correct.
  - Within a single hook a small batch IS possible (e.g. `Stop` emits N `assistant_message` + `thinking` + `agent_end` in one array POST — already array-friendly per server.ts:281).
  - Apply a short fetch timeout (~3s, like `probeServer` pi-observability.ts:68) and at most 1-2 retries with the same 250ms→5s backoff constants Pi uses (pi-observability.ts:253-254); on final failure, optionally spool the JSON array to `${stateDir}/spool/<ts>.json` for a best-effort flush on the next hook. Recommend the **spool fallback** (cheap, bounds data loss when the server blips) but keep it optional/off by default to match Pi's "drop on overflow" pragmatism. Cap spool size to mirror the 10k queue cap (e.g. delete oldest spool files beyond a budget).
- Keep each POST body < `MAX_REQUEST_BYTES` (4 MB); the truncation limits already bound per-field size, but if a `Stop` batch is large, chunk the array.

### Builder Notes
- The bridge MUST import limits/`truncateToBytes` from `shared/types.ts` (relative path `../../shared/types.ts` from `integrations/claude-code/`) so wire limits stay in lockstep.
- Run with `bun` (repo standard; server + scripts are Bun/TS). The hook command is `bun /abs/path/obs-hook.ts`.
- Everything is fire-and-forget and MUST exit 0 even on internal error so Claude Code is never blocked or failed by telemetry.
- Provider/model on the envelope drive `sessions.provider/model` (db.ts upsert COALESCE) — set them on `assistant_message` (and ideally `session_start`) so the lane shows the model.

## Exact `.claude/settings.json` hook registration

Replace `/ABS/PATH` with the absolute repo path. `$CLAUDE_PROJECT_DIR` may be used
by Claude Code to avoid hardcoding, but an absolute path is the most robust.

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "SubagentStop": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "PreCompact": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "SessionEnd": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ],
    "Notification": [
      { "hooks": [
        { "type": "command", "command": "bun /ABS/PATH/integrations/claude-code/obs-hook.ts" }
      ] }
    ]
  }
}
```

The script reads `OBS_*` from the environment (and `.env`/`.env.local` in `cwd`),
so no secrets go in `settings.json`. The `hook_event_name` field on stdin tells the
single script which lifecycle event fired.

## Hook → ObsEvent mapping (summary table)

| Claude Code hook | stdin fields used | ObsEvent(s) emitted | Notes |
|---|---|---|---|
| `SessionStart` | `source`, `cwd`, `session_id`, `transcript_path` | `session_start` | map `source`→`reason`; `seq` reset to 0 |
| `UserPromptSubmit` | `prompt` | `user_message` + `agent_start` | text truncated to `MAX_TEXT_FIELD` |
| `PreToolUse` | `tool_name`, `tool_input` | `tool_call` | derived `tool_call_id`; args deep-truncated |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` | `tool_result` | same derived id; `content_text` truncated |
| `Stop` / `SubagentStop` | `transcript_path` | `assistant_message`(+`thinking`) + `agent_end` | transcript tail → usage/cost/model |
| `PreCompact` | `trigger` | `compaction` | `reason` from `trigger`; counts unavailable → 0/"" |
| `SessionEnd` | `reason` | `session_shutdown` | map `reason` to legal union |
| `Notification` / other | (raw) | `custom` | `custom_type = hook_event_name` |

## Truncation / limits / backoff parity notes

- **Text fields:** `MAX_TEXT_FIELD` (32 KB) via `truncateToBytes` — prompts, assistant text, thinking.
- **Tool args:** `MAX_ARGS_BYTES` (16 KB) via the deep-walk truncation (`truncateArgs`).
- **Tool results:** `MAX_RESULT_BYTES` (32 KB).
- **Request body:** `MAX_REQUEST_BYTES` (4 MB) — chunk large `Stop` batches.
- **Backoff:** reuse Pi's 250 ms → 5 s exponential constants for the bounded retry inside one hook.
- **Queue cap analog:** Pi's 10k in-memory cap (drop-oldest) maps to a bounded on-disk spool (drop-oldest spool files) since there is no long-lived queue. Recommended approach: per-hook synchronous POST + optional small spool; classic cross-event batching is NOT viable in the per-process hook model and is explicitly not attempted.

## Testing / Verification Plan

1. **Unit (Story 4.1):** pipe each fixture in `integrations/claude-code/fixtures/` to `obs-hook.ts` (`bun obs-hook.ts < fixture.json`) against a mock `OBS_SERVER_URL`; assert emitted envelopes validate against `shared/types.ts` and that `assistant_message.usage` carries all six `UsageSummary` fields. Include a concurrency test for seq uniqueness.
2. **Transcript parser test:** feed `transcript.sample.jsonl`, assert correct `UsageSummary` + `cost_total` from `model-prices.ts`, and that a second `Stop` over an unchanged file emits nothing (incremental offset works).
3. **No-regression smoke:** `OBS_AUTH_TOKEN=dev just obs` then `OBS_AUTH_TOKEN=dev bash scripts/smoke-server.sh` must still pass (the bridge changes nothing server-side). `scripts/spawn-fleet.sh` (Pi) continues to work unchanged.
4. **Live E2E (Story 4.2):** with the server running on a pinned `OBS_AUTH_TOKEN`, install the hooks block, run `claude` and do a couple of tool-using prompts. Verify:
   - `curl -H "Authorization: Bearer <tok>" "$URL/sessions?pool=<pool>"` lists the Claude Code session with `agent_name=claude-code`, `provider`, `model`.
   - `curl ... "$URL/sessions/<id>/stats"` returns non-zero `total_tokens` and `total_cost`.
   - The UI swimlane/race views show the session as its own lane with correct cost/token totals next to any Pi sessions.
5. **Manual transcript-format confirmation:** before trusting the parser, `cat` a real `~/.claude/projects/<proj>/<uuid>.jsonl`, confirm the assistant-entry shape and usage key names, and adjust the `transcript.ts` field mapping. This is the single highest-risk assumption.

## Known Limitations & Edge Cases

- **Timing fields** (`prefill_ms`, `generation_ms`, `output_tps`) are not derivable from hooks (no streaming deltas); omitted. `latency_ms` only approximable from transcript timestamps, if present.
- **Per-process model:** no true cross-event batching; chosen design is per-hook synchronous POST (+ optional spool). A brief server outage spanning a hook can drop that hook's events unless the spool fallback is enabled.
- **`tool_call_id` collisions:** byte-identical concurrent tool calls share a derived id; mitigated with an open-id salt but pairing falls back to FIFO and is documented as best-effort.
- **`seq` races:** the append-byte counter makes collisions near-impossible; any true collision drops exactly one event via `INSERT OR IGNORE` (reported in `rejected[]`), never corrupting order.
- **Transcript format drift:** Anthropic may change JSONL keys/structure; the parser isolates field mapping in `transcript.ts` and fails soft (skips unparseable entries, emits nothing rather than crashing).
- **Subagent sessions:** `SubagentStop` and subagent transcripts may use a different `session_id`/`transcript_path`; if so they appear as their own lane (acceptable) — verify whether subagents share the parent `session_id` and document.
- **Compaction counts:** `tokens_before` / `first_kept_entry_id` are not provided to `PreCompact`; emitted as 0/"".
- **Cost accuracy:** depends on `model-prices.ts` being current; unknown models yield `cost_total: 0` (never a crash) and a debug note.
- **Assumptions to verify in implementation:** exact hook stdin field names, presence/absence of a native `tool_use.id` at hook time, transcript assistant-entry shape and usage key names, and whether the transcript carries a precomputed cost field.

## Definition of Done

- [ ] All acceptance criteria pass for each story.
- [ ] A real Claude Code session appears as its own swimlane/race lane with correct cost and token totals, with ZERO server/dashboard changes.
- [ ] `scripts/smoke-server.sh` still passes (no server regression).
- [ ] Envelopes validate against `shared/types.ts`; `assistant_message.usage` matches `UsageSummary` exactly.
- [ ] Code reuses `shared/types.ts` limits/`truncateToBytes` and mirrors Pi's truncation/backoff constants.
- [ ] Hook handler always exits 0 and never blocks Claude Code.
```
