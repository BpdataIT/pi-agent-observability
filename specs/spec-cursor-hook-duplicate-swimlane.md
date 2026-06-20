# Plan: Cursor Hook Duplicate Swimlane Fix

## Task Description

When a user runs `pi` with the Cursor provider while global Claude Code observability hooks are installed (`~/.claude/settings.json` → `integrations/claude-code/obs-hook.ts`), the observability dashboard in swimlane mode shows **two lanes** for a single user action: the real Pi session lane and a phantom `claude-code` lane containing only four `custom` events.

The phantom lane is caused by Cursor SDK lifecycle hooks firing through the Claude Code hook infrastructure with camelCase event names and a `cursor_version` field. The CC bridge does not recognize those names, falls through to `handleCustom()`, and POSTs them as a separate session (`agent-<uuid>`). Swimlane mode auto-creates a lane on the first SSE event for any unknown `session_id`.

## Objective

Stop pi-delegated Cursor sessions from emitting duplicate observability sessions/lanes, while preserving:

1. Full Claude Code CLI observability (PascalCase hooks → mapped `ObsEvent` envelopes).
2. Visibility of standalone Cursor sessions (non-pi) if the user wants them in the dashboard.

Achieve this with a **minimal bridge-level fix** as the primary solution.

## Problem Statement

### Observed behavior

| Session | `session_id` | `agent_name` | `provider` | Events |
|---------|--------------|--------------|------------|--------|
| Pi session (correct) | `019ee571-…` (UUID) | pi | `cursor` | Full stream: `session_start`, `user_message`, `agent_start`, `assistant_message`, … |
| Phantom session (bug) | `agent-3cb5e3e9-…` | `claude-code` | `anthropic` | 4× `custom`: `sessionStart`, `beforeSubmitPrompt`, `stop`, `sessionEnd` |

### Root cause chain

```
pi (provider=cursor)
  → Cursor SDK fires hooks via ~/.claude/settings.json CC hook commands
    → obs-hook.ts switch(hook_event_name) only handles PascalCase CC names
      → camelCase Cursor names hit default → handleCustom()
        → POST /events with agent_name="claude-code", session_id="agent-…"
          → swimlane.js routeSSEEvent() + autoAddLanes=true → createLane(phantom)
```

`extension/pi-observability.ts` already emits complete telemetry for the Pi session. The CC bridge output is redundant for pi-delegated Cursor.

## Solution Approach

### Primary fix (bridge): detect and skip pi-delegated Cursor hooks

Add Cursor hook detection and pi-delegation detection **before dispatch** in `integrations/claude-code/obs-hook.ts`. When both match, exit 0 without POSTing.

**Detection signals:**

| Signal | Purpose |
|--------|---------|
| `cursor_version` field on stdin JSON | Authoritative Cursor hook marker |
| camelCase `hook_event_name` in known Cursor set | Fallback if `cursor_version` absent |
| Pi harness text in `prompt` on `beforeSubmitPrompt` | Confirms Cursor is running inside Pi |
| Persisted `piDelegated: true` in session state | Skip `stop` / `sessionEnd` when prompt absent |

**Pi harness markers:**

- `"System instructions from pi"`
- `"operating inside pi"`

**Non-goals:**

- Do not map Cursor camelCase hooks to full ObsEvent types in the CC bridge (would duplicate Pi extension events).
- Do not change server schema or `/events` API.

## Relevant Files

| File | Role |
|------|------|
| `integrations/claude-code/cursor-detect.ts` | Detection helpers (new) |
| `integrations/claude-code/obs-hook.ts` | Early-exit before dispatch |
| `integrations/claude-code/state.ts` | Persist `piDelegated` flag |
| `integrations/claude-code/obs-hook.test.ts` | Unit tests |
| `integrations/claude-code/README.md` | Document skip behavior |

## Implementation Phases

### Phase 1: Detection module + state flag

Extract testable detection logic; persist delegation state across Cursor hook processes.

### Phase 2: Wire early-exit into obs-hook.ts

Insert guard after config resolution, before dispatch `switch`. Keep pure CC paths unchanged.

### Phase 3: Tests + fixtures

Fixture JSON and unit tests for CC regression, Cursor standalone pass-through, pi-delegated skip.

## Step by Step Tasks

1. Create `integrations/claude-code/cursor-detect.ts` with `isCursorHookPayload`, `isPiDelegatedCursorPayload`, `shouldSkipCursorHook`.
2. Extend `integrations/claude-code/state.ts` with `piDelegated` field and helpers.
3. Insert early-exit in `obs-hook.ts` `main()` before dispatch; guard `resetSession` to PascalCase `SessionStart` only.
4. Add fixtures under `integrations/claude-code/fixtures/cursor-*.json`.
5. Add tests to `obs-hook.test.ts`.
6. Update `integrations/claude-code/README.md`.

## Testing Strategy

```bash
cd integrations/claude-code && bun test obs-hook.test.ts
```

Manual: run `pi` with Cursor provider, send one message, open swimlane with auto-add — expect **one** lane only.

## Acceptance Criteria

- [ ] `pi` + Cursor provider produces one swimlane (Pi session only) with auto-add enabled.
- [ ] No new `agent-*` phantom session during pi+cursor runs.
- [ ] Pure Claude Code CLI sessions continue to emit mapped events.
- [ ] Standalone Cursor sessions are not blanket-suppressed.
- [ ] `bun test integrations/claude-code/obs-hook.test.ts` passes.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Pi harness marker strings change | Centralize markers; use persisted `piDelegated` after first detection |
| False positive on standalone Cursor | Specific multi-word phrases, not bare `"pi"` |
| Early hooks before prompt | Always skip Cursor `sessionStart`; persist `piDelegated` on first positive `beforeSubmitPrompt` |

## Tradeoffs (global hooks, bridge-level dedup)

Documented in full in `integrations/claude-code/README.md` § *Cursor hooks and Pi delegation*.

### Summary

| Stakeholder | Outcome |
|-------------|---------|
| **Pi + Cursor** | One lane, full stream from pi extension; CC bridge silent |
| **Claude Code CLI** | Unchanged full mapping |
| **Standalone Cursor IDE** | No `sessionStart` event; lane from `beforeSubmitPrompt`; sparse `custom` stream only |

### Give-ups (intentional)

1. **Cursor `sessionStart` never POSTed** — prevents phantom swimlane auto-add; standalone Cursor loses session-start metadata in the dashboard.
2. **Pi harness string coupling** — `"System instructions from pi"` / `"operating inside pi"` required for delegation detection after `sessionStart`.
3. **No full Cursor→ObsEvent mapping** — would duplicate pi extension; standalone Cursor stays `custom`-only for unmapped hooks.
4. **Skipped hooks invisible in UI** — only in `debug.log`; pi extension is source of truth for pi+cursor.
5. **Historical phantoms** — pre-fix `agent-*` sessions may linger in DB / URL-restored lanes.

### Alternatives not chosen

- Per-project hook scoping (user requires global install)
- Map all Cursor hooks to ObsEvents (duplicate semantics)
- Blanket suppress all `cursor_version` hooks (hides standalone Cursor)
- Server/dashboard changes (scope kept to bridge)
