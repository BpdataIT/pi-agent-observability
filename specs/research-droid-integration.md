# Research: Factory Droid → Pi Observability Bridge

**Status:** Research / evidence-gathering (not yet a build spec)
**Date:** 2026-06-20
**Author:** Claude (research task)
**Goal:** Determine the feasibility and shape of a `integrations/droid/` bridge that mirrors `integrations/claude-code/` and `integrations/antigravity/`, so Factory **Droid** CLI sessions appear in the Pi Observability dashboard with correct tokens/cost.

**Bottom line up front:** Factory Droid ships a hooks system that is a **near-exact clone of Claude Code's hooks** (same event names, same JSON config schema, same stdin field names + one extra `permission_mode`, same exit-code/stdout control protocol). The **hook handler layer (`obs-hook.ts`) is ~90% reusable**. The **transcript layer is NOT** — Droid's session JSONL is a completely different shape and, critically, **carries no per-message token usage**. Usage/cost lives in a **sidecar `<id>.settings.json`** file as session-cumulative totals plus a Factory-specific `factoryCredits` unit. So: fork `transcript.ts`, add a sidecar-usage reader, keep almost everything else.

---

## 1. Droid hook events & stdin JSON schema (vs Claude Code)

### 1.1 Event list

Factory documents these hook events ([hooks-guide](https://docs.factory.ai/cli/configuration/hooks-guide)):

| Event | Fires when |
|---|---|
| `SessionStart` | Droid starts a new session or resumes one |
| `UserPromptSubmit` | User submits a prompt, before Droid processes it |
| `PreToolUse` | Before a tool call (can **block**) |
| `PostToolUse` | After a tool call completes |
| `Stop` | Droid finishes responding |
| `SubagentStop` | A sub-droid task completes |
| `Notification` | Droid sends a notification |
| `PreCompact` | Before a compact operation |
| `SessionEnd` | Session ends |

**This is the exact Claude Code event set.** Claude Code has the identical nine events. No Droid-only events; no missing events.

### 1.2 stdin schema (per event)

All events receive a common base, then event-specific fields ([hooks-reference](https://docs.factory.ai/cli/configuration/hooks-reference)):

```
common: session_id, transcript_path, cwd, permission_mode, hook_event_name
```

| Event | Additional stdin fields | Enum values |
|---|---|---|
| `SessionStart` | `source` | `startup` \| `resume` \| `clear` \| `compact` |
| `UserPromptSubmit` | `prompt` | — |
| `PreToolUse` | `tool_name`, `tool_input` | — |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` | — |
| `Stop` / `SubagentStop` | `stop_hook_active` | — |
| `Notification` | `message` | — |
| `PreCompact` | `trigger`, `custom_instructions` | trigger: `manual` \| `auto` |
| `SessionEnd` | `reason` | `clear` \| `logout` \| `prompt_input_exit` \| `other` |

### 1.3 Diff vs Claude Code stdin

| Field | Claude Code | Droid | Impact on bridge |
|---|---|---|---|
| `session_id` | ✅ | ✅ | none |
| `transcript_path` | ✅ | ✅ | none — points at the `.jsonl` (see §2) |
| `cwd` | ✅ | ✅ | none |
| `hook_event_name` | ✅ | ✅ | none — same PascalCase dispatch values |
| `tool_name` / `tool_input` / `tool_response` | ✅ | ✅ | none |
| `source` / `reason` / `trigger` / `prompt` / `message` | ✅ | ✅ | none |
| `permission_mode` | ⚠️ (Claude has it too) | ✅ | new — can pass through to `custom`/details, optional |
| native `tool_use_id` on Pre/PostToolUse | ❌ | ❌ | **same gap** — derive deterministic id (reuse `deriveToolCallId`) |

**Verdict:** The hook stdin contract is effectively identical. `obs-hook.ts`'s `main()` dispatch, `handleSessionStart/End/UserPromptSubmit/PreToolUse/PostToolUse/PreCompact/Custom`, the `.env` loader, transport/backoff/spool, seq counter, and state files all transfer **unchanged**. Only `handleStop` (which reads the transcript) needs Droid-specific logic.

### 1.4 stdout control protocol (also identical)

Exit codes: `0` success, `2` blocking error, other = non-blocking error. Optional JSON stdout with `continue`, `stopReason`, `suppressOutput`, `systemMessage`, plus per-event `hookSpecificOutput` / `decision` / `permissionDecision`. **The bridge is a passive observer and should always exit 0 and emit no control JSON** (same as the Claude Code bridge), so this protocol is irrelevant to us beyond "don't accidentally block Droid."

---

## 2. Transcript JSONL format (`~/.factory/sessions/...`)

### 2.1 Location & file layout (verified on this machine)

```
~/.factory/sessions/<slugified-cwd>/<session-uuid>.jsonl          ← transcript
~/.factory/sessions/<slugified-cwd>/<session-uuid>.settings.json  ← usage/cost sidecar
```

`<slugified-cwd>` = the project path with `/` → `-` (e.g. `-Users-bphil-Projects-agentics-battery-change-sim`). Same scheme as Claude Code's `~/.claude/projects/`. The `transcript_path` hook field points at the `.jsonl`; the sidecar is the **same path with `.settings.json`** instead of `.jsonl` — trivially derivable.

### 2.2 Top-level line types (verified)

A real 320-line session contained:

| `type` | Count | Meaning |
|---|---|---|
| `message` | 306 | user/assistant turns |
| `todo_state` | 12 | todo list snapshots |
| `session_start` | 1 | session metadata header |
| `compaction_state` | 1 | compaction summary |

This is **totally different** from Claude Code, where every line's `.type` ∈ `{assistant, user, system, attachment, file-history-snapshot, …}` and there is one line **per content block**. Droid writes **one line per message** (content blocks are an array inside `message.content`).

### 2.3 `session_start` line

```json
{
  "type": "session_start",
  "id": "2c179b50-...",
  "title": "Review the implemented project against the specs...",
  "sessionTitle": "Review project implementation against file specifications",
  "owner": "bphil",
  "version": 2,
  "cwd": "/Users/bphil/Projects/agentics/battery-change-sim",
  "hostId": "7d9dc69f-...",
  "isSessionTitleManuallySet": false,
  "sessionTitleAutoStage": "first_message"
}
```

### 2.4 `message` line — assistant turn (verified)

```json
{
  "type": "message",
  "id": "6071866d-...",
  "timestamp": "2026-06-18T20:11:31.361Z",
  "parentId": "f5ed6228-...",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "signature": "reasoning_content",
        "signatureProvider": "factory", "durationMs": 2335,
        "thinking": "The user wants me to review..." },
      { "type": "tool_use", "id": "chatcmpl-tool-b9f330b3515a1eff",
        "name": "LS", "input": { "directory_path": "/Users/..." } }
    ],
    "openaiMessageId": "chatcmpl-d0cc3e52...",
    "chatCompletionReasoningField": "reasoning_content",
    "chatCompletionReasoningContent": "The user wants me to review...",
    "modelId": "glm-5.2",
    "reasoningEffort": "high"
  }
}
```

Union of `message.*` keys observed: `role`, `content`, `modelId`, `reasoningEffort`, `openaiMessageId`, `chatCompletionReasoningField`, `chatCompletionReasoningContent`, `visibility`.

Content block types: `thinking`, `text`, `tool_use`.

### 2.5 `message` line — user / tool_result turn (verified)

User lines carry either `text` blocks (real prompts) or `tool_result` blocks (tool outputs):

```json
{
  "type": "tool_result",
  "tool_use_id": "chatcmpl-tool-b9f330b3515a1eff",
  "is_error": false,
  "content": "total 512\ndrwxr-xr-x  20 bphil staff ..."
}
```

`tool_result.tool_use_id` matches the assistant's `tool_use.id` (both `chatcmpl-tool-*`), so within the transcript tool calls/results are linkable. (In one 306-message session: 254 `tool_result` blocks, 29 `text` blocks on the user side.)

### 2.6 `todo_state` and `compaction_state`

```json
{ "type": "todo_state", "id": "...", "timestamp": "...",
  "todos": { "todos": "1. [in_progress] Read all 14 brief files\n2. [pending] ..." },
  "messageIndex": 1 }

{ "type": "compaction_state", "id": "...", "timestamp": "...",
  "summaryText": "1. Chronological Play-by-Play\n   - Initial project review..." }
```

`compaction_state` could feed a richer `compaction` event (Droid actually gives us a `summaryText`, which Claude Code's `PreCompact` does **not**).

### 2.7 Field-name diff vs Claude Code transcript

| Concept | Claude Code | Droid | Consequence |
|---|---|---|---|
| line granularity | one line **per content block** | one line **per message** | Droid is simpler — **no dedup-by-message-id needed** |
| dedup key | `message.id` repeated per block | `id` unique per message | drop the grouping logic |
| model field | `message.model` | `message.modelId` | rename |
| tool id | `toolu_...` | `chatcmpl-tool-...` | cosmetic |
| thinking block | `{type:"thinking", thinking}` | `{type:"thinking", thinking, durationMs, signatureProvider}` | extra `durationMs` available |
| **per-msg usage** | `message.usage` present ✅ | **absent ❌** | **must read sidecar (§5)** |
| stop_reason | `message.stop_reason` | absent | infer from presence of `tool_use` / end |
| top-level types | assistant/user/system/… | message/todo_state/session_start/compaction_state | different switch |

---

## 3. `hooks.json` install locations

Confirmed by docs ([hooks-guide](https://docs.factory.ai/cli/configuration/hooks-guide)):

| Scope | Path |
|---|---|
| User (global) | `~/.factory/hooks.json` |
| Project | `<project>/.factory/hooks.json` |

Notes:
- **`~/.factory/hooks.json` does not exist on this machine yet** (no hooks configured) — clean install target, no merge needed for the user. `~/.factory/settings.json` exists but holds plugin/model defaults, **not** hooks (hooks are a separate file, unlike Claude Code which nests `hooks` inside `settings.json`).
- Config structure is the Claude Code shape exactly:
  ```json
  {
    "hooks": {
      "PreToolUse": [
        { "matcher": "*", "hooks": [
          { "type": "command", "command": "bun /ABS/PATH/integrations/droid/obs-hook.ts" }
        ]}
      ]
    }
  }
  ```
- `matcher` filters by tool name; `*` matches all. `$FACTORY_PROJECT_DIR` is available for project-relative script paths (Claude Code uses `$CLAUDE_PROJECT_DIR`).
- Interactive setup via the `/hooks` slash command inside `droid`.
- **Difference from antigravity:** unlike `agy`, Droid **does** pass `hook_event_name` on stdin, so we do **not** need the `obs-hook.ts <EventName>` argv trick that antigravity required. We can register identically to Claude Code (no positional arg).

---

## 4. Reuse vs fork analysis

| Component (claude-code) | Reuse? | Notes |
|---|---|---|
| `obs-hook.ts` — env loader, config, envelope factory, transport, backoff, spool, seq | ✅ **copy as-is** | provider-agnostic |
| `obs-hook.ts` — `main()` dispatch switch | ✅ **copy** | same `hook_event_name` values |
| `handleSessionStart/SessionEnd/UserPromptSubmit/PreToolUse/PostToolUse/PreCompact/Custom` | ✅ **copy, retune defaults** | swap default `provider: "anthropic"` → derived from `modelId`; default `agent_name` → `"droid"` |
| `deriveToolCallId` + open-id state | ✅ **copy** | Droid also lacks native tool id on hooks → same `cc-`/`droid-` derived id approach |
| `state.ts` (seq, offset, openToolIds, debug, spool) | ✅ **copy** | state dir → `${TMPDIR}/pi-obs-droid/<session_id>/` |
| `cursor-detect.ts` | ❌ **drop** | Cursor/pi-delegation dedup is Claude-Code-specific |
| `transcript.ts` | 🔧 **fork/rewrite** | different line shape; no per-msg usage; read `modelId`; pull usage from sidecar |
| `model-prices.ts` / `model-context.ts` | ✅ **reuse via shared table** | thin wrappers over `shared/model-metadata.ts`; already covers `glm-*`, `gemini-*`, `gpt-*`, etc. — exactly Droid's model spread |
| `shared/types.ts`, `shared/model-metadata.ts` | ✅ **reuse unchanged** | envelope + provider table already shared |
| `settings.template.json` | 🔧 **rename → `hooks.template.json`** | top-level `{ "hooks": {...} }`, no `settings` wrapper |

**Recommendation: thin fork.** Create `integrations/droid/` by copying `integrations/claude-code/`, deleting `cursor-detect.ts`, rewriting `transcript.ts` (the only substantive work), adding a `usage-sidecar.ts` reader, and flipping a handful of provider/agent-name defaults. This matches how `integrations/antigravity/` already relates to `integrations/claude-code/` (shared `shared/` modules, per-integration `obs-hook.ts`/`transcript.ts`/`state.ts`). Do **not** try to make one parameterized handler serve both — the antigravity precedent is "copy + diverge," and it keeps each integration's quirks isolated.

---

## 5. Token / cost metadata sources

### 5.1 The transcript has NO usage

`grep -c '"usage"'` over a full session `.jsonl` = **0**. Assistant messages carry `modelId` and `reasoningEffort` but no token counts. This is the single biggest divergence from Claude Code (whose transcript embeds `message.usage` per turn).

### 5.2 Usage lives in the sidecar `<id>.settings.json` (verified)

```json
{
  "model": "glm-5.2",
  "reasoningEffort": "high",
  "assistantActiveTimeMs": 6170630,
  "tokenUsage": {
    "inputTokens": 714370, "outputTokens": 110193,
    "cacheCreationTokens": 0, "cacheReadTokens": 17826109,
    "thinkingTokens": 0, "factoryCredits": 1567347
  },
  "inclusiveTokenUsage": {            // this session + all child/subagent sessions
    "inputTokens": 998323, "outputTokens": 171411,
    "cacheCreationTokens": 0, "cacheReadTokens": 30645366,
    "thinkingTokens": 0, "factoryCredits": 2536403
  },
  "childInclusiveTokenUsageBySessionId": { "<subagent-uuid>": { ... } },
  "providerLock": "factory", "autonomyMode": "auto-high"
}
```

Field mapping to `UsageSummary`:

| `UsageSummary` | Droid sidecar field |
|---|---|
| `input` | `tokenUsage.inputTokens` |
| `output` | `tokenUsage.outputTokens` |
| `cache_read` | `tokenUsage.cacheReadTokens` |
| `cache_write` | `tokenUsage.cacheCreationTokens` |
| `total_tokens` | sum of the four above (+ `thinkingTokens` if desired) |
| `cost_total` | **computed** from token counts × `shared/model-metadata.ts` price (NOT `factoryCredits`) |

### 5.3 Two unit systems — `factoryCredits` ≠ USD

`factoryCredits` is Factory's internal billing unit, not dollars, and there is **no public credit→USD rate** we can rely on. **Recommendation:** compute `cost_total` in USD from token deltas × the shared price table keyed by per-turn `modelId` (exactly as the Claude Code bridge does), and **carry `factoryCredits` as an opt-in extra** in `assistant_message.usage` details or a `custom` event, so the dashboard's existing USD cost column stays meaningful.

### 5.4 Per-turn attribution problem & recommended delta approach

The sidecar gives **cumulative** totals only; the transcript gives **per-turn `modelId`** but no per-turn tokens. Also, a single session can mix models — verified: one session had `gemini-3.5-flash` ×21 **and** `gpt-5.5` ×45 messages, while the sidecar's single `model` field said only `gpt-5.5`. So the sidecar's `model` is unreliable for attribution; the transcript's per-message `modelId` is the source of truth for *which* model, and the sidecar is the source of truth for *how many* tokens.

**Recommended `handleStop` algorithm:**
1. Parse new transcript turns since `state.transcriptOffset` → get text, thinking, tool ids, and **per-turn `modelId`** (reuse the incremental-offset reader from `transcript.ts`).
2. Read the sidecar `<id>.settings.json`; take cumulative `tokenUsage` (or `inclusiveTokenUsage` to fold in subagents — pick one, document it).
3. Compute the **delta** vs `state.lastCumulativeUsage` (persist in state). Attribute the delta to this Stop's turn(s); if multiple turns, attach the full delta to the **last** turn and emit prior turns with zero usage (documented approximation), or split proportionally by output text length.
4. `cost_total` = delta tokens × shared price for that turn's `modelId`.
5. Persist new cumulative totals + offset.

This yields **accurate session totals** (the number the dashboard sums) even though per-turn splits are approximate — same honesty posture as the Claude Code bridge's `latency_ms` ("approximate, documented as such").

### 5.5 Other timing signal

`assistantActiveTimeMs` (sidecar) and `durationMs` (per thinking block) are available and could populate `generation_ms`-ish fields that Claude Code had to leave blank. Optional nicety.

---

## 6. Entire.io as prior art

**Could not verify a public "Entire.io" Factory/Droid observability integration.** Targeted web searches (Factory + entire.io, "entire" + AI agent observability + droid, GitHub) returned **no product or repo by that name** integrating with Droid. It may be (a) a private/internal reference, (b) a misremembered name, or (c) a very new/unindexed project. **Flagging as unconfirmed — recommend the requester share a URL** if they have one.

Closest **real, relevant** prior art found instead:

| Project | Relevance |
|---|---|
| **OpenLIT** ([github.com/openlit/openlit](https://github.com/openlit/openlit)) | Open-source LLM observability that **installs vendor hooks** into local coding agents (Claude Code, Cursor, Codex) and emits **OpenTelemetry** traces for sessions/prompts/tool-calls. Closest architectural analog to this bridge — same "install hooks, translate to a wire format, ship to a server" pattern, but OTel-native instead of the Pi `ObsEvent` envelope. |
| **o11y-dev/opentelemetry-skill** ([github](https://github.com/o11y-dev/opentelemetry-skill)) | Config guides for monitoring coding agents (Claude Code, Gemini CLI, Copilot) via OTel. |
| Factory's own observability | Factory uses **LangSmith** internally and integrates with Sentry/PagerDuty for an "observability-to-resolution" pipeline ([factory.ai GA](https://factory.ai/news/factory-is-ga)) — that's *Factory consuming* observability, not *exposing agent telemetry* the way our bridge needs. Not directly reusable. |

Takeaway: no off-the-shelf Droid→Pi bridge exists; the OpenLIT hook-installer pattern validates our approach but uses a different wire format, so we still build our own (cheap, given §4).

---

## 7. Recommended hook set & OBS event mapping

Register **all nine** hooks (same as Claude Code) for full lifecycle coverage:

| Droid hook | OBS event(s) | Handler source | Notes |
|---|---|---|---|
| `SessionStart` | `session_start` | reuse | `source`→`reason`: `startup`→startup, `resume`→resume, `clear`→new, `compact`→startup; reset seq |
| `UserPromptSubmit` | `user_message` + `agent_start` | reuse | text truncated to `MAX_TEXT_FIELD` |
| `PreToolUse` | `tool_call` | reuse | derived `droid-<sha256(name+input)>` id; args truncated 16 KB |
| `PostToolUse` | `tool_result` | reuse | same derived id; `tool_response`→`content_text`, `is_error`; result truncated 32 KB |
| `Stop` | `assistant_message` (+ `thinking`) + `agent_end` | **fork** | parse Droid JSONL turns; usage/cost from sidecar delta (§5.4); provider/model from per-turn `modelId` |
| `SubagentStop` | `assistant_message` (+ `thinking`) + `agent_end` | **fork** | same; consider `childInclusiveTokenUsageBySessionId` for subagent tokens |
| `PreCompact` | `compaction` | reuse, enrich | `trigger`→`reason`; optionally enrich `summary_preview` from `compaction_state.summaryText` later |
| `SessionEnd` | `session_shutdown` | reuse | `reason` map: `clear`→new, `logout`→quit, `prompt_input_exit`→quit, `other`→quit |
| `Notification` | `custom` | reuse | `custom_type="Notification"`, carry `message` |

### 7.1 Defaults to flip from the Claude Code bridge
- `OBS_NAME` default `"claude-code"` → **`"droid"`**.
- State dir `${TMPDIR}/pi-obs-cc/` → **`${TMPDIR}/pi-obs-droid/`**.
- Envelope `provider` default `"anthropic"` → **derive from `modelId`** via `providerForModelKey` (Droid is multi-model by default; this machine's default is `gemini-3.5-flash`, sessions also use `glm-5.2`, `gpt-5.5`). Fall back to `"factory"` rather than `"anthropic"` when unknown.
- Add `permission_mode` pass-through into `tool_call`/`custom` details (optional).

### 7.2 Env surface (unchanged from Claude Code)
`OBS_SERVER_URL`, `OBS_AUTH_TOKEN`, `OBS_POOL`, `OBS_TAG`, `OBS_NAME`, `OBS_DISABLE` — plus the same `.env` / `.env.local` auto-load from `cwd`.

---

## 8. Open questions / verification TODO before building

1. **Live stdin capture** — register a one-line debug hook (`bun obs-hook.ts` that dumps stdin to a file) and run `droid exec "hi"` to confirm the documented stdin fields verbatim (esp. that `transcript_path` is absolute and points at the `.jsonl`, and exact `permission_mode` values). Docs were cross-checked against the reference page but not against a live payload.
2. **Sidecar write timing** — confirm `<id>.settings.json` `tokenUsage` is already updated by the time the `Stop` hook fires (race risk: hook fires before the sidecar flush). If racy, fall back to reading it on the *next* Stop/SessionEnd.
3. **`tokenUsage` vs `inclusiveTokenUsage`** — decide which is the session's headline number (recommend `tokenUsage` for the session's own lane; emit subagent lanes separately keyed by `childInclusiveTokenUsageBySessionId`).
4. **`factoryCredits` exposure** — confirm with the dashboard owner whether to surface credits as a secondary metric or ignore.
5. **stop_reason** — Droid transcript has no `stop_reason`; infer `toolUse` when the last assistant turn ends with `tool_use` blocks, else `stop`.
6. **Entire.io** — get a URL from the requester to evaluate as real prior art (§6).

---

## Appendix A — key file references

- `integrations/claude-code/obs-hook.ts` — handler to clone (dispatch at `:762`, `handleStop` at `:569`).
- `integrations/claude-code/transcript.ts` — the file to **fork** (Claude-specific dedup + `message.usage` reader; Droid needs neither).
- `integrations/claude-code/README.md` — install/mapping doc to adapt.
- `integrations/antigravity/` — precedent for a second, diverging integration sharing `shared/`.
- `shared/types.ts` — `ObsEventEnvelope` + payload types (reuse).
- `shared/model-metadata.ts` — provider/price/window table; already covers Droid's model spread (reuse).
- Local evidence: `~/.factory/sessions/<slug>/<uuid>.jsonl` + `.settings.json`; `~/.factory/settings.json`; `droid --help` (no `hooks` subcommand — hooks are file/`/hooks`-driven).

## Appendix B — sources
- [Factory Hooks Guide](https://docs.factory.ai/cli/configuration/hooks-guide)
- [Factory Hooks Reference](https://docs.factory.ai/cli/configuration/hooks-reference)
- [Factory CLI overview](https://docs.factory.ai/cli/getting-started/overview)
- [OpenLIT (hook-installer prior art)](https://github.com/openlit/openlit)
- [o11y-dev/opentelemetry-skill](https://github.com/o11y-dev/opentelemetry-skill)
- [Factory is GA](https://factory.ai/news/factory-is-ga)
</content>
</invoke>
