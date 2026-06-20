/**
 * Detect Cursor IDE hooks that fire through the Claude Code hook registration.
 * Pi-delegated Cursor sessions are already tracked by extension/pi-observability.ts;
 * skip duplicate emission here to avoid phantom swimlane lanes.
 */

import { isPiDelegated, markPiDelegated } from "./state.ts";

/** Known Cursor hook_event_name values (camelCase). */
export const CURSOR_HOOK_EVENT_NAMES = new Set([
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "stop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "preCompact",
  "afterAgentResponse",
  "afterAgentThought",
  "beforeTabFileRead",
  "afterTabFileEdit",
]);

const PI_DELEGATION_MARKERS = [
  "System instructions from pi",
  "operating inside pi",
] as const;

function extractPromptText(payload: Record<string, unknown>): string {
  for (const key of ["prompt", "user_message", "text", "message"]) {
    const v = payload[key];
    if (typeof v === "string") return v;
  }
  return "";
}

export function isCursorHookPayload(payload: Record<string, unknown>): boolean {
  if (typeof payload.cursor_version === "string" && payload.cursor_version.length > 0) {
    return true;
  }
  const name = payload.hook_event_name;
  return typeof name === "string" && CURSOR_HOOK_EVENT_NAMES.has(name);
}

export function isPiDelegatedCursorPayload(payload: Record<string, unknown>): boolean {
  const text = extractPromptText(payload);
  if (!text) return false;
  return PI_DELEGATION_MARKERS.some((m) => text.includes(m));
}

export function shouldSkipCursorHook(
  hookPayload: Record<string, unknown>,
  stateDir: string,
): boolean {
  if (!isCursorHookPayload(hookPayload)) return false;
  if (isPiDelegatedCursorPayload(hookPayload) || isPiDelegated(stateDir)) {
    markPiDelegated(stateDir);
    return true;
  }
  return false;
}
