# Implementation Plan: Factory Droid → Pi Observability Integration

## Metadata

**ID:** feature-f8a2c3
**Created:** 2026-06-20
**Total Stories:** 12
**Estimated Phases:** 5

## Feature Description

Add `integrations/droid/`, a thin fork of the Claude Code bridge that translates
**Factory Droid** CLI lifecycle hooks into the same `ObsEvent` envelopes the Pi
extension uses and POSTs them to `POST /events`. Droid sessions appear in the
**same dashboard** as Pi, Claude Code, and Antigravity sessions — with correct
session totals for tokens and USD cost.

**Key architectural facts (from research):**

- Droid's hook system is a **near-exact clone of Claude Code's** — same nine
  event names, same stdin JSON schema (+ `permission_mode`), same exit-code
  protocol. `obs-hook.ts` dispatch and most handlers are ~90% reusable.
- Droid's session JSONL is **completely different** — one line per message, no
  per-message `usage`, `modelId` instead of `model`. Usage lives in a **sidecar**
  `<session-uuid>.settings.json` as session-cumulative totals.
- **No server or dashboard changes** are required; reuse `shared/types.ts` and
  `shared/model-metadata.ts` unchanged.

**Bottom line:** Copy `integrations/claude-code/`, drop `cursor-detect.ts`, fork
`transcript.ts`, add `usage-sidecar.ts`, retune defaults (`agent_name`, state
dir, provider derivation, tool id prefix).

## Users

### Primary User
- **Persona:** Developer running Factory Droid (`droid`) locally with the Pi
  observability dashboard open.
- **Goal:** See Droid sessions in the same swimlane/race views as Pi and Claude
  Code, with non-zero token totals and meaningful USD cost.
- **Context:** Has `just obs` running, `OBS_AUTH_TOKEN` exported, and Droid
  installed (`~/.factory/` present).

### Secondary Users
- **Maintainer:** Wants a third integration that follows the established
  copy-and-diverge pattern (`claude-code` template, `antigravity` precedent)
  without coupling quirks across providers.
- **Dashboard reviewer:** Needs honest documentation when per-turn usage splits
  are approximate (sidecar deltas) while session totals remain accurate.

## User Journey

1. Developer copies or installs `hooks.template.json` into
   `~/.factory/hooks.json` (or `<project>/.factory/hooks.json`), pointing at
   `bun …/integrations/droid/obs-hook.ts`.
2. Developer exports `OBS_AUTH_TOKEN` (and optional `OBS_POOL` / `OBS_TAG` /
   `OBS_NAME=droid`) and runs `droid` or `droid exec "…"`.
3. On each lifecycle event, Droid spawns the hook; the bridge reads stdin JSON,
   maps to `ObsEventEnvelope`s, persists cross-hook state under
   `${TMPDIR}/pi-obs-droid/<session_id>/`, and POSTs to the observability server.
4. On `Stop` / `SubagentStop`, the bridge parses new Droid transcript turns,
   reads cumulative `tokenUsage` from the `.settings.json` sidecar, computes the
   **delta** since the last Stop, attributes usage to the turn(s), and emits
   `assistant_message` (+ optional `thinking`) and `agent_end`.
5. Developer opens the dashboard; the Droid lane shows `agent_name=droid`,
   correct model labels from per-turn `modelId`, and session-level token/cost
   totals that match the sidecar.

## User Stories

### Phase 1: Scaffold & hook shell (copy Claude Code, retune defaults)

**Delivers:** Runnable `integrations/droid/` directory with hook dispatch,
transport, state, and install template — handlers wired but `Stop` may emit
zero usage until Phase 2.
**Prerequisites:** None.

#### Story 1.1: Create `integrations/droid/` from Claude Code template
**As a** maintainer
**I want to** scaffold the Droid integration by copying the Claude Code bridge
**So that** proven hook plumbing is reused without cross-provider coupling.

**Acceptance Criteria:**
- [ ] Directory exists: `integrations/droid/` with the file set below (see
      [Directory structure](#directory-structure)).
- [ ] `obs-hook.ts` copied from `integrations/claude-code/obs-hook.ts` with
      `cursor-detect.ts` imports and skip logic **removed** (Droid has no Cursor
      delegation path).
- [ ] Defaults retuned: `OBS_NAME` default `"droid"`; state dir
      `${TMPDIR}/pi-obs-droid/<session_id>/`; derived tool id prefix
      `droid-` (not `cc-`); envelope `provider` derived via
      `providerForModelKey(modelId)` with fallback `"factory"` (not
      `"anthropic"`).
- [ ] `state.ts` copied with `pi-obs-cc` → `pi-obs-droid` and `piDelegated`
      field removed from `SessionState`.
- [ ] `model-prices.ts` and `model-context.ts` copied as thin wrappers over
      `shared/model-metadata.ts` (same pattern as claude-code / antigravity).
- [ ] `hooks.template.json` created (top-level `{ "hooks": { … } }` only — no
      `settings` wrapper; Droid keeps hooks in a separate file per Factory docs).

**Complexity:** M
**Dependencies:** None

---

#### Story 1.2: Register all nine hooks in `hooks.template.json`
**As a** developer
**I want to** install a complete hook set matching Claude Code coverage
**So that** the full Droid session lifecycle appears in the dashboard.

**Acceptance Criteria:**
- [ ] `hooks.template.json` registers all nine events:
      `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
      `SubagentStop`, `PreCompact`, `SessionEnd`, `Notification`.
- [ ] Each command is `bun /ABS/PATH/integrations/droid/obs-hook.ts` with **no**
      positional event-name argv (Droid passes `hook_event_name` on stdin —
      unlike antigravity).
- [ ] `PreToolUse` / `PostToolUse` use `"matcher": "*"` (Factory docs).
- [ ] `_instructions` key documents install paths:
      `~/.factory/hooks.json` (global) and `<project>/.factory/hooks.json`
      (project); notes `$FACTORY_PROJECT_DIR` for project-relative paths.

**Complexity:** S
**Dependencies:** Story 1.1

---

#### Story 1.3: Port lifecycle handlers (non-Stop) from Claude Code
**As a** developer
**I want to** emit correct ObsEvents for every hook except Stop/SubagentStop
**So that** session start, prompts, tools, compaction, shutdown, and
notifications appear before transcript work lands.

**Acceptance Criteria:**
- [ ] Handlers copied/adapted: `handleSessionStart`, `handleSessionEnd`,
      `handleUserPromptSubmit`, `handlePreToolUse`, `handlePostToolUse`,
      `handlePreCompact`, `handleCustom` (Notification → `custom`).
- [ ] OBS event mapping matches research §7 (see [Hook → ObsEvent mapping](#hook--obsevent-mapping)).
- [ ] Optional: `permission_mode` from stdin passed through in `tool_call` or
      `custom` payload `details` / `data` (documented in README).
- [ ] Hook always exits `0` with no stdout control JSON (passive observer).
- [ ] `SessionStart` with `source=clear` wipes state dir (same as Claude Code).

**Complexity:** M
**Dependencies:** Story 1.1

---

### Phase 2: Droid transcript parser & sidecar usage (core work)

**Delivers:** Accurate session token/cost totals on `Stop` / `SubagentStop`.
**Prerequisites:** Phase 1.

#### Story 2.1: Fork `transcript.ts` for Droid JSONL shape
**As a** developer
**I want to** parse Droid's one-line-per-message transcript incrementally
**So that** assistant turns expose text, thinking, tool ids, model, and timing
without Claude Code dedup logic.

**Acceptance Criteria:**
- [ ] `parseNewTurns(transcriptPath, fromOffset)` reads from byte offset; handles
      `fileShrunk` when file size < offset (reset to 0).
- [ ] Processes line `type` values: `message` (assistant only for turns),
      ignores `todo_state`, `session_start`, `compaction_state` for turn
      extraction (compaction enrichment deferred to Story 4.2).
- [ ] For `type=message` + `message.role=assistant`: extracts `modelId`,
      concatenates `content` blocks (`text`, `thinking`, `tool_use`), collects
      native `tool_use.id` values (`chatcmpl-tool-*`).
- [ ] **No** `message.id` dedup grouping (one line = one turn).
- [ ] `stop_reason` inferred: `toolUse` when last content block is `tool_use`,
      else `stop` (no `max_tokens` signal in transcript — document limitation).
- [ ] `latency_ms` approximated from turn `timestamp` minus preceding user
      `message` timestamp when available (document as approximate).
- [ ] Optional: `generation_ms` from sum of `thinking.durationMs` when present.
- [ ] Turn type exports mirror Claude Code (`AssistantTurn`, `ParseResult`) for
      `obs-hook.ts` compatibility; `usage` field may be placeholder until
      sidecar merge.

**Complexity:** L
**Dependencies:** Story 1.1

---

#### Story 2.2: Implement `usage-sidecar.ts` reader
**As a** developer
**I want to** read cumulative token totals from `<id>.settings.json`
**So that** usage can be differenced across Stop events.

**Acceptance Criteria:**
- [ ] `sidecarPathFromTranscript(transcriptPath)` replaces `.jsonl` with
      `.settings.json`.
- [ ] `readCumulativeUsage(sidecarPath)` returns `UsageSummary` fields mapped:
      `input` ← `tokenUsage.inputTokens`,
      `output` ← `tokenUsage.outputTokens`,
      `cache_read` ← `tokenUsage.cacheReadTokens`,
      `cache_write` ← `tokenUsage.cacheCreationTokens`,
      `total_tokens` ← sum of four (+ optional `thinkingTokens` — document choice),
      `cost_total` ← **not** from sidecar (computed separately).
- [ ] Never throws; missing/unreadable sidecar → zero usage + `debug.log` entry.
- [ ] Exports raw `factoryCredits` separately for optional pass-through (not used
      for `cost_total`).
- [ ] Unit tests with fixture `fixtures/sample.settings.json` (sanitized from
      research doc).

**Complexity:** M
**Dependencies:** Story 1.1

---

#### Story 2.3: Sidecar delta attribution in `handleStop` / `handleSubagentStop`
**As a** developer
**I want to** attribute token deltas to new transcript turns on each Stop
**So that** dashboard session totals match Droid's cumulative sidecar while
per-turn splits remain a documented approximation.

**Acceptance Criteria:**
- [ ] `SessionState` extended with `lastCumulativeUsage: UsageSummary | null`
      (all numeric fields, default null / zeros).
- [ ] **Delta algorithm** (research §5.4) implemented in `handleStop`:
      1. `parseNewTurns(transcriptPath, state.transcriptOffset)` → new turns.
      2. Read sidecar cumulative `tokenUsage` (session-scoped, **not**
         `inclusiveTokenUsage` — subagents handled separately).
      3. `delta = cumulative - state.lastCumulativeUsage` (per field, clamp
         negatives to 0 and log anomaly).
      4. If multiple turns in one Stop: attach **full delta** to the **last**
         turn; prior turns get zero usage (documented approximation). Alternative
         proportional split by output text length is acceptable if simpler and
         documented — pick one and test it.
      5. `cost_total` on each attributed turn = `computeCost(delta, turn.modelId)`
         from `model-prices.ts` / shared table (never `factoryCredits`).
      6. Persist `state.transcriptOffset`, `state.lastCumulativeUsage` = new
         cumulative snapshot.
- [ ] Envelope `provider` and `model` set per turn from `message.modelId` via
      `providerForModelKey`; unknown models → `cost_total: 0` + debug log.
- [ ] `context_window` stamped via `contextWindowForModel(modelId)` on
      `assistant_message` (agy/claude-code pattern).
- [ ] `SubagentStop` uses same handler path; document that parent `session_id`
      and `transcript_path` are used (subagent lane behavior matches Claude Code).
- [ ] Optional: expose `factoryCredits` delta in `assistant_message` via extended
      field in `usage` details or `custom` event — gated behind README note until
      dashboard owner confirms (research open question #4).

**Complexity:** L
**Dependencies:** Story 2.1, Story 2.2, Story 1.3

---

#### Story 2.4: Verify sidecar write timing (pre-build gate)
**As a** maintainer
**I want to** confirm the sidecar is flushed before `Stop` fires
**So that** the delta algorithm does not systematically read stale totals.

**Acceptance Criteria:**
- [ ] One-line debug hook or `OBS_DEBUG=1` path logs sidecar `mtime` vs hook
      `ts` on first real `droid exec` run.
- [ ] If race confirmed: implement retry-on-next-Stop or short bounded retry
      in `readCumulativeUsage` (document in README).
- [ ] Finding recorded in `integrations/droid/README.md` § "Sidecar timing".

**Complexity:** S
**Dependencies:** Story 2.3

---

### Phase 3: Tests & fixtures

**Delivers:** Automated coverage for parser, sidecar, delta, and envelopes.
**Prerequisites:** Phase 2.

#### Story 3.1: Unit tests — transcript, sidecar, delta, envelopes
**As a** maintainer
**I want to** run `bun test integrations/droid/obs-hook.test.ts`
**So that** regressions in the highest-risk paths are caught in CI.

**Acceptance Criteria:**
- [ ] Fixtures under `integrations/droid/fixtures/`:
      - `transcript.sample.jsonl` — multi-turn Droid session excerpt (assistant +
        user + tool_result blocks; at least 2 assistant turns, mixed `modelId` if
        possible).
      - `sample.settings.json` — sidecar with `tokenUsage` totals.
      - Per-hook stdin JSON: `session-start.json`, `user-prompt-submit.json`,
        `pre-tool-use.json`, `post-tool-use.json`, `stop.json`, `session-end.json`,
        `pre-compact.json`, `notification.json` (adapted from claude-code
        fixtures; add `permission_mode` where applicable).
- [ ] Tests cover:
      - Incremental parse: N turns from fixture; second parse at offset emits 0.
      - No Claude-style dedup conflation (line count ≠ inflated turn count).
      - Sidecar path derivation and field mapping.
      - Delta math: two cumulative snapshots → correct delta on second Stop.
      - Multi-turn Stop: delta on last turn only (chosen attribution rule).
      - `computeCost` + known `glm-5.2` / `gemini-3.5-flash` / `gpt-5.5` models.
      - `tool_call_id` determinism (`droid-` prefix).
      - Seq monotonicity and `resetSession` on clear.
      - Envelope shape / required fields per event type.
- [ ] Test count target: ≥ 25 tests (claude-code has 42; droid skips cursor tests).

**Complexity:** L
**Dependencies:** Story 2.3

---

#### Story 3.2: Manual smoke — `droid exec` live verification
**As a** developer
**I want to** document a manual E2E checklist
**So that** installers can confirm hooks fire against real Droid.

**Acceptance Criteria:**
- [ ] README § "Live E2E verification" documents:
      ```bash
      OBS_AUTH_TOKEN=mytoken just obs
      OBS_AUTH_TOKEN=mytoken OBS_POOL=droid-test droid exec "say hi"
      curl -H "Authorization: Bearer mytoken" \
           "http://127.0.0.1:43190/sessions?pool=droid-test"
      ```
- [ ] Expected: session with `agent_name=droid`, non-zero `total_tokens` after
      at least one assistant turn, `session_file` ending in `.jsonl`.
- [ ] Pre-flight debug hook step (research §8 #1): optional one-liner to dump
      stdin to `/tmp/droid-hook-debug.json` for first install validation.
- [ ] Live stdin capture checklist: confirm `transcript_path` absolute,
      `permission_mode` values, `hook_event_name` PascalCase.

**Complexity:** S
**Dependencies:** Story 3.1

---

### Phase 4: Install ergonomics & documentation

**Delivers:** README, justfile helpers, open-question resolutions documented.
**Prerequisites:** Phase 3.

#### Story 4.1: `integrations/droid/README.md`
**As a** developer
**I want to** install and operate the bridge from documented steps
**So that** I do not need to read the research doc.

**Acceptance Criteria:**
- [ ] README mirrors `integrations/claude-code/README.md` structure: How it works,
      Install, Environment variables, Hook → ObsEvent mapping, Cost & context
      window (shared table), Persistent state, Live E2E, Known limitations,
      Running tests.
- [ ] Documents Droid-specific paths: `~/.factory/hooks.json`,
      `~/.factory/sessions/<slugified-cwd>/<uuid>.jsonl` + `.settings.json`.
- [ ] Documents sidecar delta attribution honesty (session totals accurate,
      per-turn approximate).
- [ ] Documents `factoryCredits` ≠ USD; cost from `shared/model-metadata.ts`.
- [ ] Documents `tokenUsage` vs `inclusiveTokenUsage` choice: **session lane uses
      `tokenUsage`**; subagent inclusive totals deferred unless Story 4.2 ships.
- [ ] No `cursor-detect` section.

**Complexity:** M
**Dependencies:** Story 3.2

---

#### Story 4.2: justfile targets for Droid hooks
**As a** maintainer
**I want to** `just droid-hooks-print` and optional `just droid-install`
**So that** hook installation matches agy ergonomics.

**Acceptance Criteria:**
- [ ] `droid_hooks_src` variable in `justfile` (default
      `~/.pi/agent/git/github.com/BpdataIT/pi-agent-observability`, same
      convention as `agy_hooks_src`).
- [ ] `droid-hooks-print`: sed-replace `/ABS/PATH` in
      `integrations/droid/hooks.template.json`, print to stdout with
      `OBS_AUTH_TOKEN` / `OBS_SERVER_URL` hints.
- [ ] `droid-install`: write `~/.factory/hooks.json` if absent; refuse overwrite
      (merge-by-hand message, like `agy-install`).
- [ ] `droid-uninstall`: remove only if file references
      `integrations/droid/obs-hook.ts`.
- [ ] Root README or integrations index mentions Droid bridge (one paragraph).

**Complexity:** S
**Dependencies:** Story 1.2, Story 4.1

---

#### Story 4.3: Resolve pre-build open questions (research §8)
**As a** maintainer
**I want to** close verification TODOs before calling the integration done
**So that** known risks are either fixed or explicitly accepted.

**Acceptance Criteria:**
- [ ] #1 Live stdin: captured and fixture updated if docs drift.
- [ ] #2 Sidecar timing: resolved per Story 2.4.
- [ ] #3 `tokenUsage` vs `inclusiveTokenUsage`: documented decision in README.
- [ ] #4 `factoryCredits`: documented as ignored for cost unless product asks.
- [ ] #5 `stop_reason` inference: documented in README limitations.
- [ ] #6 Entire.io: noted as unconfirmed; no code dependency.

**Complexity:** S
**Dependencies:** Story 2.4, Story 4.1

---

### Phase 5: Optional enrichments (post-MVP)

**Delivers:** nicer compaction events and subagent usage visibility.
**Prerequisites:** Phase 4 (MVP shippable without this phase).

#### Story 5.1: Enrich `PreCompact` from `compaction_state` transcript line
**As a** developer
**I want to** populate `summary_preview` on compaction events when available
**So that** Droid compaction is more visible than Claude Code's empty preview.

**Acceptance Criteria:**
- [ ] On `PreCompact`, scan transcript for latest `type=compaction_state` line
      (or read incrementally from offset) and set `summary_preview` (truncated to
      `MAX_TEXT_FIELD`).
- [ ] `tokens_before` remains 0 if not available from hook.

**Complexity:** S
**Dependencies:** Story 2.1, Story 4.3

---

#### Story 5.2: Subagent usage via `childInclusiveTokenUsageBySessionId`
**As a** developer
**I want to** optionally surface subagent token lanes
**So that** `SubagentStop` events can reflect child session totals.

**Acceptance Criteria:**
- [ ] README documents current behavior (parent session_id lane).
- [ ] If implemented: read child entry from sidecar map keyed by subagent session
      id when `SubagentStop` stdin carries distinguishable id (verify live first).
- [ ] Emit `custom` event with child usage snapshot OR attribute delta to
      SubagentStop turn — design note in PR if scope grows.

**Complexity:** M
**Dependencies:** Story 2.4

---

## Technical Context

### Directory structure

```
integrations/droid/
├── obs-hook.ts              # fork from claude-code; drop cursor-detect; fork handleStop
├── transcript.ts            # NEW fork — Droid JSONL parser (one line per message)
├── usage-sidecar.ts         # NEW — .settings.json reader + delta helpers
├── state.ts                 # fork — pi-obs-droid, + lastCumulativeUsage
├── model-prices.ts          # thin wrapper → shared/model-metadata.ts
├── model-context.ts         # thin wrapper → shared/model-metadata.ts
├── hooks.template.json      # nine hooks → obs-hook.ts (no argv)
├── obs-hook.test.ts         # fixture-based tests
├── README.md                # install, mapping, limitations, E2E
└── fixtures/
    ├── transcript.sample.jsonl
    ├── sample.settings.json
    ├── session-start.json
    ├── user-prompt-submit.json
    ├── pre-tool-use.json
    ├── post-tool-use.json
    ├── stop.json
    ├── subagent-stop.json
    ├── session-end.json
    ├── pre-compact.json
    └── notification.json
```

**Explicitly NOT copied from claude-code:**
- `cursor-detect.ts` — Claude/Cursor-specific; Droid has no equivalent.
- `settings.template.json` naming — Droid uses standalone `hooks.json` (rename to
  `hooks.template.json`).

### Files to copy / fork / create

| File | Action | Notes |
|------|--------|-------|
| `obs-hook.ts` | Copy + edit | Remove cursor imports/skip; retune defaults; fork `handleStop` to call sidecar delta; prefix `droid-` for tool ids |
| `state.ts` | Copy + edit | `pi-obs-droid`; add `lastCumulativeUsage`; drop `piDelegated` |
| `transcript.ts` | **Rewrite** | Droid line types; no dedup; `modelId`; infer `stop_reason` |
| `usage-sidecar.ts` | **Create** | Path derivation, read, map, delta subtract |
| `model-prices.ts` | Copy as-is | Delegates to `shared/model-metadata.ts` |
| `model-context.ts` | Copy as-is | Delegates to `shared/model-metadata.ts` |
| `hooks.template.json` | Create | From `claude-code/settings.template.json` hooks block; rename file |
| `README.md` | Create | Adapt claude-code README |
| `obs-hook.test.ts` | Create | Adapt claude-code tests minus cursor; add sidecar/delta tests |
| `fixtures/*` | Create | Droid-shaped samples |

### Hook registration & install steps

1. **Prerequisites:** `bun` ≥ 1.1, observability server (`just obs`),
   `OBS_AUTH_TOKEN` matching server.
2. **Install hooks config:**
   - Global: `~/.factory/hooks.json`
   - Project: `<project>/.factory/hooks.json`
   - Factory also supports `/hooks` slash command in interactive `droid`.
   - Use `just droid-hooks-print` or copy `hooks.template.json` with `/ABS/PATH`
     replaced.
   - Unlike Claude Code, hooks are **not** nested inside `settings.json`.
3. **Environment:** `OBS_SERVER_URL`, `OBS_AUTH_TOKEN`, `OBS_POOL`, `OBS_TAG`,
   `OBS_NAME` (default `droid`), `OBS_DISABLE`; auto-load `.env` / `.env.local`
   from `cwd` (inherited from claude-code `obs-hook.ts`).
4. **Run:** `droid` (interactive) or `droid exec "prompt"` for headless smoke.

### Hook → ObsEvent mapping

| Droid hook | ObsEvent(s) | Handler | Notes |
|------------|-------------|---------|-------|
| `SessionStart` | `session_start` | reuse | `source`→`reason`: `startup`→startup, `resume`→resume, `clear`→new, `compact`→startup; reset seq |
| `UserPromptSubmit` | `user_message` + `agent_start` | reuse | prompt truncated to `MAX_TEXT_FIELD` |
| `PreToolUse` | `tool_call` | reuse | `droid-<sha256(name+stableJSON(input))>[0:16]`; args truncated 16 KB |
| `PostToolUse` | `tool_result` | reuse | same derived id; `tool_response`→`content_text`; truncated 32 KB |
| `Stop` | `assistant_message` (+ `thinking`) + `agent_end` | **fork** | Droid JSONL + sidecar delta (§5.4); provider/model from `modelId` |
| `SubagentStop` | same as Stop | **fork** | same handler; parent `session_id` |
| `PreCompact` | `compaction` | reuse | `trigger`→`reason`; tokens_before=0 until enriched (Phase 5) |
| `SessionEnd` | `session_shutdown` | reuse | `clear`→new, `logout`→quit, `prompt_input_exit`→quit, `other`→quit |
| `Notification` | `custom` | reuse | `custom_type="Notification"`, carry `message` |

### Sidecar delta usage algorithm (research §5.4)

```
on Stop / SubagentStop:
  turns, newOffset ← parseNewTurns(transcriptPath, state.transcriptOffset)
  cumulative ← readCumulativeUsage(sidecarPathFromTranscript(transcriptPath))
  delta[field] = max(0, cumulative[field] - state.lastCumulativeUsage[field])
  if turns.length == 0:
    persist offset + lastCumulativeUsage; emit agent_end only (or nothing)
  else if turns.length == 1:
    turns[0].usage ← delta + computeCost(delta, turns[0].modelId)
  else:
    turns[0..n-2].usage ← zeroUsage()
    turns[n-1].usage ← delta + computeCost(delta, turns[n-1].modelId)
  emit assistant_message (+ thinking) per turn, agent_end
  state.transcriptOffset ← newOffset
  state.lastCumulativeUsage ← cumulative
```

**Cost rule:** Always `computeCost` from `shared/model-metadata.ts` keyed by
per-turn `modelId`. Never convert `factoryCredits` to USD.

**Session totals accuracy:** Summing emitted `assistant_message.usage` across a
session equals the final sidecar `tokenUsage` delta sum (modulo clamp anomalies).

### Integration Points

| Location | Role |
|----------|------|
| `shared/types.ts` | `ObsEventEnvelope`, payloads, `UsageSummary`, truncation limits — **no changes** |
| `shared/model-metadata.ts` | `providerForModelKey`, `computeCost`, `contextWindowForModelKey` — **no changes**; Droid models (`glm-*`, `gemini-*`, `gpt-*`) already present |
| `integrations/claude-code/obs-hook.ts` | Primary template for hook shell, transport, spool, handlers |
| `integrations/antigravity/` | Precedent for copy-diverge, `hooks.template.json`, justfile install |
| `justfile` | Add `droid-hooks-print`, `droid-install`, `droid-uninstall` |
| Observability server | Unchanged — ingests same `POST /events` |

### Testing strategy

| Layer | What | How |
|-------|------|-----|
| Unit | `transcript.ts` incremental parse | Fixture JSONL; offset idempotence |
| Unit | `usage-sidecar.ts` mapping | Fixture `.settings.json` |
| Unit | Delta attribution | Two cumulative snapshots in test |
| Unit | Envelopes / seq / tool ids | Hook stdin fixtures |
| Integration | Hook subprocess | Optional: `bun obs-hook.ts < fixtures/stop.json` with mock server (follow claude-code if present) |
| Manual | Real Droid | `droid exec` + curl sessions API + dashboard |
| Gate | Sidecar timing | Story 2.4 live check before release |

### Builder Notes

- **Thin fork, not abstraction:** Do not parameterize claude-code to serve both;
  antigravity precedent is copy + diverge.
- **State dir:** `${TMPDIR}/pi-obs-droid/<session_id>/` — files: `seq`,
  `state.json` (`transcriptOffset`, `openToolIds`, `lastCumulativeUsage`,
  `firstRunLogged`), `debug.log`, `spool/*.json`.
- **Tool id pairing:** Same `deriveToolCallId` + `openToolIds` FIFO as Claude Code;
  only prefix changes to `droid-`.
- **Multi-model sessions:** Sidecar `model` field is unreliable; always stamp
  envelope `model` from per-turn `modelId`.
- **Subagents:** Default MVP uses `tokenUsage` (session-scoped). Child inclusive
  totals are Phase 5 optional.
- **CI:** Add `bun test integrations/droid/obs-hook.test.ts` to existing test
  recipe if one exists (grep `justfile` / CI for claude-code test invocation).
- **Research reference:** `specs/research-droid-integration.md` is the evidence
  base; this plan is the build spec.

## Definition of Done

- [ ] All Phase 1–4 acceptance criteria met
- [ ] `bun test integrations/droid/obs-hook.test.ts` passes
- [ ] Manual `droid exec` smoke produces non-zero session tokens in dashboard
- [ ] README documents install path, mapping, sidecar delta honesty, limitations
- [ ] `just droid-hooks-print` works from repo root
- [ ] No changes required to server, dashboard, or `shared/types.ts`
- [ ] Follows copy-diverge patterns from `claude-code` and `antigravity`
