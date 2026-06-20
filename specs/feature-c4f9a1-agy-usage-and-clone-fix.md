# Implementation Plan: agy Usage Decoder + Stale-Clone Fix (Option C)

## Metadata

**ID:** feature-c4f9a1
**Created:** 2026-06-20
**Total Stories:** 9
**Estimated Phases:** 5

## Feature Description

Option C for the Antigravity (`agy`) observability integration, in two parts:

**A — Stale-clone fix (quick win).** The pi extension and the agy hooks currently
run from two different clones: the pi extension is installed at
`~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability/` (remote `github.com/BpdataIT`,
updated to `007fa21`), while `~/.gemini/config/hooks.json` points the agy hook commands at
`~/.pi/agent/git/github.com/disler/pi-agent-observability/integrations/antigravity/obs-hook.ts`
(remote `github.com/disler`, frozen at `3e70edd` from Jun 1). So `pi install
git:github.com/BpdataIT/pi-agent-observability@main` never reaches the running agy hooks,
and shipped fixes (notably `integrations/antigravity/model-context.ts`, which stamps
`context_window` on agy `assistant_message` events) are invisible to agy. This plan unifies
both on the BpdataIT clone so one `pi install` updates both.

**B — Protobuf usage decoder (real work).** agy's hook payloads and JSONL transcript carry
**no token usage, cost, or timing**. The bridge emits `assistant_message.usage` as all zeros
(`transcript.ts:zeroUsage()`), so the dashboard's tps, prefill_ms, generation_ms, cache r/w,
input, output, and cost columns all read 0 for agy sessions, and the context-utilization bar's
numerator (which `db.ts:getSessionContext` computes as `usage.input + usage.cache_read +
usage.cache_write`) is 0 — the bar shows only the denominator (`context_window`). The only
place per-turn tokens live is the protobuf-encoded SQLite at
`~/.gemini/antigravity-cli/conversations/<conversationId>.db`, table `gen_metadata(idx, data blob, size)`.
This plan specs a standalone, testable protobuf decoder for that table that extracts per-turn
input/output/cache-read/cache-write tokens (+ timing where recoverable), wires it into
`obs-hook.ts`, adds a Gemini price table mirroring `integrations/claude-code/model-prices.ts`,
and retires the README's "no cost or tokens" caveat.

## Users

### Primary User
- **Persona:** Developer running `agy` (Google Antigravity CLI) locally with the Pi
  observability dashboard open, who wants agy sessions to show real token/cost/timing
  columns alongside their Pi and Claude Code sessions.
- **Goal:** See non-zero usage, cost, and timing for agy sessions in the same dashboard.
- **Context:** Already has `just agy-install` run once (but against the wrong clone) and
  `OBS_AUTH_TOKEN` exported.

### Secondary Users
- **Maintainer (repo owner):** Wants `pi install git:github.com/BpdataIT/...@main` to update
  both the extension and the agy hooks in one step, and wants the decoder to survive agy
  version bumps without silent breakage.
- **Reviewer / future builder:** Needs the decoder to be a standalone, empirically-validated
  module with a debug CLI so the fragile reverse-engineered field map can be re-verified
  against new `.db` files.

## User Journey

1. The developer runs `just agy-uninstall` then `just agy-install` (or sets `AGY_HOOKS_SRC`
   to the pi-installed BpdataIT path). `~/.gemini/config/hooks.json` now points at the
   BpdataIT clone — the same path `pi install` updates. On the next `pi install
   git:github.com/BpdataIT/pi-agent-observability@main`, both the extension and the agy
   hooks pick up `007fa21` (and future commits) including `model-context.ts`.
2. The developer opens an agy session with `OBS_AUTH_TOKEN` exported. Each assistant turn,
   the `PostInvocation`/`Stop` hook opens the conversation's `.db` (read-only), decodes the
   newest `gen_metadata` blob(s), maps fields to `UsageSummary`, computes cost via a Gemini
   price table, and stamps `assistant_message.usage` + `output_tps`/`prefill_ms`/
   `generation_ms`/`latency_ms`.
3. In the dashboard, the agy session lane now shows real token counts, a populated context
   bar numerator, cost dollars, and (where derivable) tps / prefill / generation columns —
   matching the shape of Claude Code sessions.
4. When agy bumps a version and reshuffles the protobuf field tree, the decoder's empirical
   validation (CI or a `just` debug target run against the live `.db` set) flags a mismatch;
   the maintainer re-derives the field map using the decoder's debug CLI and updates the
   mapping table.

## User Stories

### Phase 1: Unify agy hooks on the BpdataIT clone (quick win)

**Delivers:** `pi install git:github.com/BpdataIT/...@main` updates both the pi extension
and the agy hooks; shipped fixes (e.g. `model-context.ts`) take effect for agy.
**Prerequisites:** None.

#### Story 1.1: Make `just agy-install` target the same clone `pi install` uses
**As a** maintainer
**I want to** run a single `pi install git:github.com/BpdataIT/pi-agent-observability@main`
that updates both the pi extension and the agy hooks
**So that** shipped fixes reach agy without a separate manual re-point step.

**Acceptance Criteria:**
- [ ] `justfile` `agy-install`/`agy-uninstall` resolve the agy hook source path from a
      configurable variable (e.g. `AGY_HOOKS_SRC`, default `~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability`)
      so the hooks point at the pi-installed BpdataIT clone rather than `$PWD`.
- [ ] `just agy-install` still refuses to clobber an existing `~/.gemini/config/hooks.json`
      (existing safety check preserved), and `just agy-uninstall` only removes a file that
      references this bridge's `obs-hook.ts`.
- [ ] After `just agy-uninstall` + `just agy-install`, `~/.gemini/config/hooks.json` commands
      point at `…/BpdataIT/pi-agent-observability/integrations/antigravity/obs-hook.ts`.
- [ ] `pi install git:github.com/BpdataIT/pi-agent-observability@main` updates the on-disk
      `obs-hook.ts` (and siblings) at that path; a subsequent agy session uses the new code
      (verified by the model-context `context_window` stamp appearing on new
      `assistant_message` events).
- [ ] README "Install" section documents the single-source convention: agy hooks track the
      BpdataIT clone the pi extension uses; the disler clone is no longer referenced.

**Complexity:** S
**Dependencies:** None

---

#### Story 1.2: Retire the disler clone reference and verify the fix end-to-end
**As a** developer
**I want to** confirm that an agy session after re-install picks up the latest shipped
bridge code (the `007fa21` `model-context.ts` change)
**So that** the stale-clone problem is provably closed.

**Acceptance Criteria:**
- [ ] A new agy session, after the re-install, emits `assistant_message` events with a
      non-null `context_window` (resolved via `model-context.ts:contextWindowForLabel`)
      for a recognized label like "Gemini 3.5 Flash (High)".
- [ ] The dashboard's context bar for that session shows a real denominator (1_000_000)
      instead of falling back to the UI's regex table (or showing 0).
- [ ] No live path references `github.com/disler/pi-agent-observability`; `~/.pi/agent/git/
      github.com/disler/` may remain on disk but is not executed.
- [ ] `~/.gemini/config/hooks.json` no longer contains the string `disler`.

**Complexity:** S
**Dependencies:** 1.1

---

### Phase 2: Standalone protobuf decoder for `gen_metadata`

**Delivers:** A standalone, testable `integrations/antigravity/usage-decoder.ts` that parses
a `.db` file's `gen_metadata` blobs into per-turn token/timing records, with a debug CLI.
**Prerequisites:** Phase 1 (so the decoder is built against the repo the hooks will load).

#### Story 2.1: Raw protobuf wire-format decoder + field-tree dump
**As a** builder
**I want to** a generic protobuf wire-format reader that turns an opaque blob into a nested
field tree (field number → wire type → value/submessage) without a `.proto` schema
**So that** I can reverse-engineer the `gen_metadata` field map empirically.

**Acceptance Criteria:**
- [ ] New module `integrations/antigravity/usage-decoder.ts` exposes a low-level
      `decodeProtobuf(buf: Buffer): ProtoField[]` that handles varint, 64-bit, length-delimited,
      start-group/end-group, and 32-bit wire types, recursing into length-delimited fields
      that themselves parse as valid protobuf.
- [ ] A `dumpFieldTree(fields, indent)` helper renders the tree as human-readable text.
- [ ] Pure functions, no I/O in the core decoder; only the CLI wrapper touches the filesystem.
- [ ] No new runtime dependencies (Node/Bun built-ins only; SQLite read via a thin
      `better-sqlite3`-free approach — see Builder Notes, prefer Bun's built-in or a tiny
      vendored SQLite reader, or shell out to `sqlite3` with `readonly` + `file` mode).

**Complexity:** M
**Dependencies:** 1.1

---

#### Story 2.2: `gen_metadata` → per-turn usage record, with debug CLI
**As a** builder
**I want to** run `bun integrations/antigravity/usage-decoder.ts <path-to-.db>` and get a
dump of every `gen_metadata` row decoded into a candidate `UsageRecord` plus the raw field
tree
**So that** I can validate the field map against many live `.db` files before wiring it in.

**Acceptance Criteria:**
- [ ] CLI takes a `.db` path (and optional `--idx N`), opens it **read-only** (URI
      `file:<path>?mode=ro`, or `sqlite3` subprocess with `readonly`), and reads `gen_metadata`.
- [ ] For each row, decodes the blob and prints: idx, size, the field tree, and a best-effort
      `UsageRecord { input, output, cache_read, cache_write, session_id?, uuid?, timing? }`
      derived from a `GEN_METADATA_FIELD_MAP` constant.
- [ ] `GEN_METADATA_FIELD_MAP` is a single, clearly-commented table mapping protobuf field
      numbers → `UsageRecord` keys, seeded from the parent agent's raw decode findings
      (idx 0: varints ~1132 input, 17279, 212, 179; sessionID + UUID `630a3743-…`; idx 1
      large blob: f1=1132, f3 len=3040 nested f1=1132/f6=65536/f7=1/f13=2597, f3.f3 len=7
      f1=312/f2=40000, f8 tool-names).
- [ ] Decoder never throws on a malformed/unexpected blob: it returns a record with a
      `decode_error` field and continues, so a bad row can't crash a hook.
- [ ] Documented assumption: pairing `gen_metadata` rows to transcript turns is **by idx**
      (row order = step order); a `--match-content` flag additionally prints the transcript
      step text alongside each idx so the builder can confirm idx↔turn pairing empirically.

**Complexity:** M
**Dependencies:** 2.1

---

### Phase 3: Empirical validation of the decoder

**Delivers:** Confidence that the reverse-engineered field map is correct across model
variants and effort levels, plus a reusable validation harness.
**Prerequisites:** Phase 2.

#### Story 3.1: Validate field map across the live `.db` corpus (~48 files)
**As a** builder
**I want to** run the decoder against every `~/.gemini/antigravity-cli/conversations/*.db`
and a `just agy-usage-validate` target that reports per-file sanity checks
**So that** I can trust the field map before wiring it into live hooks.

**Acceptance Criteria:**
- [ ] New `justfile` target `agy-usage-validate` runs the decoder CLI across all
      `~/.gemini/antigravity-cli/conversations/*.db` and prints a summary: per file — number
      of `gen_metadata` rows, decoded input/output/cache counts, and any `decode_error`s.
- [ ] Sanity checks encoded in the validator: (a) decoded **input tokens grow monotonically
      across idx** within a conversation (context prefix only grows); (b) **output tokens are
      plausible vs. assistant text length** (compare to the transcript's `PLANNER_RESPONSE`
      `content` character count, flag ratios outside a generous band); (c) **no negative or
      wildly large** varints (>1e9) flagged as probable mis-mapping.
- [ ] Where the large 107KB-style blob carries content text (the parent agent saw f13 with
      "…ipynb…As IDE feedback…"), the validator cross-references its length against the
      decoded output-token count as a coarse ground-truth proxy.
- [ ] Validator reports coverage: how many files decode cleanly vs. with errors, and which
      model/effort labels (scraped from the matching transcript) each `.db` used, so
      High-vs-Max field-tree variance is visible.
- [ ] Findings recorded in a short `integrations/antigravity/usage-decoder.md` note:
      confirmed field map, observed variants, and any rows the map can't explain.

**Complexity:** L
**Dependencies:** 2.2

---

### Phase 4: Gemini price table + wire decoder into the hook

**Delivers:** Live agy sessions populate `assistant_message.usage`, `cost_total`,
`output_tps`, `prefill_ms`, `generation_ms`, `latency_ms`.
**Prerequisites:** Phase 3.

#### Story 4.1: Gemini price table (mirror claude-code/model-prices.ts)
**As a** builder
**I want to** a `integrations/antigravity/model-prices.ts` with a Google/Gemini price table
keyed by the model label `contextWindowForLabel` already handles
**So that** cost is computed the same way the Claude Code bridge does.

**Acceptance Criteria:**
- [ ] New `integrations/antigravity/model-prices.ts` exports `ModelPrice` + `getModelPrice`
      + `computeCost` with the same shape/signature as `integrations/claude-code/model-prices.ts`.
- [ ] Price table keyed by the **normalized model label** (reuse the lowercasing /
      `(<effort>)`-stripping logic from `model-context.ts` so "Gemini 3.5 Flash (High)" maps
      to the same key used for context-window lookup), with entries for the Gemini variants
      agy currently ships (Gemini 3.5 Flash, Gemini 3 Pro, Gemini 2.5 Flash, etc.) and an
      `UNKNOWN_PRICE` sentinel returning `cost_total: 0`.
- [ ] Prices per-million tokens (input/output/cache-read/cache-write) sourced and dated in a
      comment (Google AI Studio / Gemini API pricing); values clearly labeled as correctable
      constants.
- [ ] Unknown-model path emits a debug log (mirrors the Claude Code `unknown_model_cost_zero`
      pattern) and never throws.

**Complexity:** S
**Dependencies:** 2.1

---

#### Story 4.2: Stamp decoded usage + timing onto `assistant_message`
**As a** developer
**I want to** the `PostInvocation`/`Stop` hook to decode the newest `gen_metadata` row(s)
for the conversation and stamp real `usage` + timing onto the `assistant_message` envelope
**So that** the dashboard shows non-zero token/cost/timing columns for agy.

**Acceptance Criteria:**
- [ ] `obs-hook.ts` `handleInvocation`/`handleStop` (the transcript-draining path) opens the
      conversation `.db` (path derived from `conversationId` →
      `~/.gemini/antigravity-cli/conversations/<conversationId>.db`) **read-only** and reads
      `gen_metadata` rows with idx >= a persisted `usageIdxOffset` (mirrors the
      `transcriptOffset` pattern in `state.ts`), so only new turns are decoded per hook.
- [ ] Decoded `UsageRecord`s are paired to drained transcript turns **by idx order** (the
      Nth new assistant turn ↔ the Nth new `gen_metadata` row past the offset); mismatch
      (e.g. row count != turn count) is logged to `debug.log` and usage falls back to zeros
      for the unpaired turns rather than mis-assigning.
- [ ] `buildAssistantMessagePayload` (in `transcript.ts`) accepts an optional
      `UsageRecord`/`UsageSummary` and stamps `usage` (with `total_tokens` and `cost_total`
      via the new Gemini price table) instead of `zeroUsage()`; `context_window` stamping
      is preserved.
- [ ] Timing fields populated where the decoder can derive them: `latency_ms` from
      transcript timestamps (same approach as `claude-code/transcript.ts`), `prefill_ms` /
      `generation_ms` / `output_tps` from `executor_metadata`/`steps` if those tables carry
      per-turn timestamps (decoder extended to read them); if timing is unavailable, the
      fields are omitted (never fabricated), matching the Claude Code bridge convention.
- [ ] `.db` read failures (file locked by agy's WAL writer, missing file, corrupt blob)
      are caught, logged to `debug.log`, and usage stays zero for that turn — the hook still
      exits 0 and never blocks agy.
- [ ] A new `state.json` field `usageIdxOffset` is persisted and advanced after successful
      decode, with the same "file shrank → reset to 0" resilience as `transcriptOffset`.

**Complexity:** L
**Dependencies:** 3.1, 4.1

---

#### Story 4.3: Wire the context-bar numerator for agy sessions
**As a** developer
**I want to** the decoded `usage.input`/`cache_read`/`cache_write` to be the real values
**So that** `db.ts:getSessionContext` (which sums those three as `latest_input`) produces a
real numerator and the agy session's context bar fills instead of showing 0/<window>.

**Acceptance Criteria:**
- [ ] After Story 4.2, a live agy session's most recent `assistant_message.usage` has
      non-zero `input + cache_read + cache_write` reflecting the actual prefix (e.g. for a
      Gemini 3.5 Flash session, the sum tracks the growing cached prefix).
- [ ] The dashboard context bar for that session shows a filled numerator (no longer 0)
      against the `context_window` denominator; visually matches the verified
      `gemini-3.5-flash` pi session behavior documented in `db.ts:getSessionContext`.
- [ ] Cost column, input/output tokens, cache r/w pills, and (where populated) tps/prefill/
      generation chips all render non-zero in the swimlane detail for agy sessions.

**Complexity:** S
**Dependencies:** 4.2

---

### Phase 5: Docs + optional backfill

**Delivers:** README reflects reality; legacy sessions optionally get retroactive usage.
**Prerequisites:** Phase 4.

#### Story 5.1: Retire the "no cost or tokens" caveat in the README
**As a** reader
**I want to** the Antigravity README's "Known limitations" to reflect that usage/cost/timing
now populate (with explicit caveats)
**So that** the docs match the shipped behavior.

**Acceptance Criteria:**
- [ ] The README's top "⚠️ Cost & tokens are not available" callout is replaced with an
      updated note: usage/cost/timing populate for new turns via the `gen_metadata` decoder;
      legacy agy sessions recorded before the decoder shipped still read 0 (no retroactive
      decode unless the optional backfill is run — see Story 5.2).
- [ ] "Known limitations" entry "No cost or tokens" is rewritten to describe the
      reverse-engineered-protobuf caveat: the field map is empirical (no `.proto` ships with
      agy), verified against the live corpus as of agy 1.0.10, and may need re-derivation
      after an agy version bump (link to `usage-decoder.md`).
- [ ] README documents the decoder module, the `agy-usage-validate` target, and the new
      `usageIdxOffset` state field.
- [ ] "Verified hook surface (agy 1.0.10)" section updated to note the `gen_metadata` schema
      was also verified against that version.

**Complexity:** S
**Dependencies:** 4.3

---

#### Story 5.2 (optional): Backfill script for legacy agy sessions
**As a** developer
**I want to** an optional script that reads all `~/.gemini/antigravity-cli/conversations/*.db`
and re-emits usage-bearing `assistant_message` events for sessions already in the dashboard
**So that** historical agy sessions also show tokens/cost.

**Acceptance Criteria:**
- [ ] New `scripts/agy-backfill-usage.ts` (or `integrations/antigravity/backfill.ts`) that,
      for a given session_id (or `--all`), opens the conversation `.db`, decodes all
      `gen_metadata` rows, pairs them to the session's existing `assistant_message` events
      (queried via the server's `getSessionEvents` or directly against `db/obs.db`), and
      POSTs **updated** envelopes (or a dedicated patch endpoint) that overwrite the zero
      `usage`.
- [ ] Idempotent: re-running on already-backfilled sessions is a no-op (skips turns whose
      `usage.total_tokens > 0`).
- [ ] Gated behind an explicit opt-in flag and documented as **optional**; the default
      behavior remains "legacy sessions stay zero" (the README caveat in 5.1).
- [ ] Decision recorded in the plan: include as optional because (a) it touches the server's
      event store (may need a PATCH/upsert path or raw `obs.db` write) and (b) the legacy-
      events caveat explicitly defers retroactive usage by default.

**Complexity:** L
**Dependencies:** 4.3, 5.1

---

## Technical Context

### Existing Patterns
- `integrations/claude-code/transcript.ts`: reference usage-stamping integration. Extracts
  `.message.usage` → `UsageSummary` (`input_tokens`→input, `output_tokens`→output,
  `cache_read_input_tokens`→cache_read, `cache_creation_input_tokens`→cache_write,
  `total_tokens` = sum), computes `cost_total` via `model-prices.ts:computeCost`, and
  derives `latency_ms` from transcript timestamps (`lastAssistantTs - precedingUserTs`).
  **Prefill/generation/output_tps are intentionally omitted** (not derivable) — agy should
  follow the same "omit rather than fabricate" convention unless `executor_metadata`/`steps`
  give real timing.
- `integrations/claude-code/model-prices.ts`: `ModelPrice`, `getModelPrice(modelId)`
  (case-insensitive + prefix match), `computeCost(usage, modelId)` →
  `{ cost_total, unknown_model }`. agy's table should mirror this exactly, keyed by the
  normalized Gemini label.
- `integrations/antigravity/transcript.ts`: `zeroUsage()` returns the all-zero
  `UsageSummary`; `buildAssistantMessagePayload(turn, toolCallIds, modelLabel)` currently
  calls `zeroUsage()` and stamps `context_window` via `model-context.ts:contextWindowForLabel`.
  This is the single call site to replace.
- `integrations/antigravity/state.ts`: `SessionState { transcriptOffset, bootEmitted, model,
  firstRunLogged }` persisted to `${TMPDIR}/pi-obs-agy/<conversationId>/state.json`;
  `nextSeq()` uses an O_APPEND byte counter. Add `usageIdxOffset` here.
- `integrations/antigravity/obs-hook.ts`: `handleInvocation`/`handleStop` call
  `drainTranscript`, which calls `parseNewTurns` then `buildAssistantMessagePayload`.
  `conversationId` (envelope `session_id`) and `transcriptPath` are on the hook stdin; the
  `.db` path is `~/.gemini/antigravity-cli/conversations/<conversationId>.db`.
- `shared/types.ts`: `UsageSummary { input, output, cache_read, cache_write, total_tokens,
  cost_total }`; `AssistantMessagePayload` carries `usage`, `latency_ms?`, `prefill_ms?`,
  `generation_ms?`, `output_tps?`, `context_window?`.
- `apps/observability/db.ts:getSessionContext`: numerator =
  `usage.input + usage.cache_read + usage.cache_write`; denominator = latest
  `context_window` on an `assistant_message`. Verified against a live gemini-3.5-flash pi
  session. agy must populate those three fields for the bar to fill.
- `apps/observability/public/app.js` + `swimlane.js`: read `usage`, `latency_ms`,
  `prefill_ms`, `generation_ms`, `output_tps`, `context_window` client-side from
  `assistant_message` payloads.
- `justfile`: `agy-install`/`agy-uninstall` use `$PWD` to fill `/ABS/PATH` in
  `hooks.template.json` and write `~/.gemini/config/hooks.json`; refuse to clobber;
  uninstall only removes if it references `obs-hook.ts`.

### New Components
- `integrations/antigravity/usage-decoder.ts` — protobuf wire decoder + `gen_metadata`
  field map + `UsageRecord` type + debug CLI.
- `integrations/antigravity/model-prices.ts` — Gemini price table + `computeCost` (mirrors
  claude-code).
- `integrations/antigravity/usage-decoder.md` — empirical validation notes / field map
  provenance.
- `scripts/agy-backfill-usage.ts` (optional) — retroactive usage re-emit.
- `justfile` target `agy-usage-validate`; `agy-install`/`agy-uninstall` updated for the
  configurable source path.

### Integration Points
- `transcript.ts:buildAssistantMessagePayload` — add an optional `usage?: UsageSummary`
  (or `usageRecord?: UsageRecord`) param; when present, use it instead of `zeroUsage()`,
  compute `cost_total`, and stamp timing fields.
- `obs-hook.ts:drainTranscript` / `handleInvocation` / `handleStop` — after draining
  transcript turns, decode the corresponding `gen_metadata` rows and pass them into
  `buildAssistantMessagePayload`. Persist `usageIdxOffset` in `state.ts:SessionState`.
- `justfile:agy-install` — switch `/ABS/PATH` source from `$PWD` to a configurable
  `AGY_HOOKS_SRC` defaulting to the pi-installed BpdataIT path.
- No server/dashboard changes required — the existing `getSessionContext`/`getSessionStats`
  queries and UI already read the fields the decoder will populate.

### Builder Notes
- **Protobuf without a `.proto` is brittle.** agy ships no schema; the field map is
  reverse-engineered. Mitigation: (1) the decoder is generic and dumps the full field tree
  so re-derivation is mechanical; (2) the `agy-usage-validate` target enforces monotonic
  input-token growth + output-vs-text-length sanity across the live corpus; (3) the map is
  a single commented constant; (4) decode failures degrade to zeros, never throw. Add a
  pinned "verified against agy X.Y.Z" note (the README already pins 1.0.10).
- **Reading SQLite while agy is writing.** agy uses WAL (`.db-shm`/`.db-wal` siblings
  observed for the active conversation). **Always open read-only** (`file:<path>?mode=ro`
  or `sqlite3 --readonly`); a read-only connection in WAL mode can read a consistent
  snapshot without blocking the writer. Never write to the `.db`. If the file is locked /
  corrupt / absent, log and fall back to zero usage for that turn.
- **SQLite access without a runtime dep.** Prefer shelling out to the `sqlite3` CLI (already
  used by the `backup` justfile target) with `readonly` mode and `.mode bytes` / a small
  helper, OR use Bun's `bun:sqlite` (Bun is already the runtime for the hook). Decision
  deferred to the builder; pick whichever keeps the hook dependency-free and fast (the hook
  runs synchronously in agy's per-event process and must stay <~100ms). Lean toward
  `bun:sqlite` read-only since the runtime is already Bun.
- **Field-tree variance across model/effort.** Sample broadly (all ~48 files, plus both
  High and Max effort) in `agy-usage-validate`. The large 107KB blob (idx 1 in the example)
  appears to be a per-turn context snapshot with nested tool lists; the small ~1KB idx 0
  blob carries the generation metadata. Confirm which idx holds the canonical per-turn usage
  before wiring — the parent agent's raw decode suggests **idx 0 is the usage row** and idx
  1 is the context/tool snapshot, but this must be confirmed per-turn across the corpus.
- **Pairing rows ↔ turns.** Default to **by idx order** (gen_metadata idx is monotonic with
  step_index; transcript `step_index` is the same ordering). Validate with a
  `--match-content` cross-check (decoded content length vs transcript text) during Phase 3
  before trusting it live. If idx↔turn 1:1 fails on some conversations, fall back to
  content-length matching (coarse) or skip usage for unpaired turns.
- **Cost keyed by model label.** Normalize the agy label the same way
  `model-context.ts:contextWindowForLabel` does (lowercase, strip `(<effort>)`) so the price
  key and the context-window key agree. `contextWindowForLabel` already handles "Gemini 3.5
  Flash (High)" → "gemini 3.5 flash".
- **Legacy caveat.** Existing agy sessions in `db/obs.db` recorded before the decoder ships
  have zero usage and **will not be retroactively decoded by default**. Only new turns
  populate. The optional backfill (5.2) is opt-in and may require a server PATCH/upsert path
  (or direct `obs.db` write) — flagged as a risk; do not block the core feature on it.
- **Single-source-of-truth for the hook path.** The clean fix for Problem A is to point agy
  hooks at the **same BpdataIT clone the pi extension uses**
  (`~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability/...`), so `pi install
  git:github.com/BpdataIT/...@main` updates both atomically. Keeping disler as the agy source
  would require maintaining a second remote and a second `pi install` — rejected as more
  fragile. The working repo at `/Users/bphil/pi-agent-observability` is also the BpdataIT
  clone (HEAD `007fa21`), so `just agy-install` from `$PWD` already points at the right
  remote; making the default the pi-installed path ensures consistency even when the user
  runs `just` from a different clone.
- **Empirical ground-truth sources.** (a) agy's own TUI — if it surfaces token counts, use
  them to confirm decoded values for one session; (b) the large blob's embedded content text
  length as a sanity bound on output tokens; (c) monotonic input growth across turns
  (context prefix only grows); (d) the transcript's `PLANNER_RESPONSE.content` character
  count vs. decoded output tokens. None is authoritative alone; the combination is the
  validation.

## Definition of Done

- [ ] All acceptance criteria met
- [ ] `just agy-uninstall` + `just agy-install` (or `AGY_HOOKS_SRC=…`) repoints hooks at the
      BpdataIT clone; `pi install git:github.com/BpdataIT/...@main` updates both extension
      and agy hooks
- [ ] `just agy-usage-validate` passes across the live `.db` corpus with documented field map
- [ ] A live agy session emits `assistant_message` events with non-zero usage/cost and a
      populated context-bar numerator; timing fields present where derivable, omitted (not
      fabricated) otherwise
- [ ] Decoder never throws; all failure paths degrade to zero usage + debug log
- [ ] README "Known limitations" updated; legacy-sessions caveat explicit
- [ ] Follows existing codebase patterns (ObsEvent envelopes, `createEnvelope`,
      `SessionInfo`, `state.ts` offset pattern, `model-prices.ts` shape)