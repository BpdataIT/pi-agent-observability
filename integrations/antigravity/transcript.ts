/**
 * Incremental parser for an Antigravity (agy) conversation transcript.
 *
 * agy writes a clean JSONL transcript per conversation at
 *   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
 * The hook stdin hands us its path as `transcriptPath`.
 *
 * Each line is one entry: { type, source, status, step_index, created_at, ... }.
 * The entry types we care about:
 *   - USER_INPUT (source USER_EXPLICIT): the user prompt. `content` is a string
 *     wrapped in <USER_REQUEST>…</USER_REQUEST> plus metadata blocks.
 *   - PLANNER_RESPONSE (source MODEL): an assistant turn. Optional `content`
 *     (final text), optional `thinking`, optional `tool_calls: [{name, args}]`.
 *   - Tool-result entries (source MODEL, type RUN_COMMAND / VIEW_FILE /
 *     CODE_ACTION / GREP_SEARCH / LIST_DIRECTORY / GENERIC / SEARCH_WEB / …):
 *     `content` holds the tool output. These pair with the PostToolUse hook.
 *
 * 🔴 There is NO token usage or cost anywhere in this transcript (verified).
 * `assistant_message.usage` is therefore emitted as zeros by the bridge.
 */

import * as fs from "node:fs";

import {
  truncateToBytes,
  MAX_TEXT_FIELD,
  type AssistantMessagePayload,
  type ThinkingPayload,
  type UsageSummary,
} from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Raw entry types
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  type?: string;
  source?: string;
  status?: string;
  step_index?: number;
  created_at?: string;
  content?: unknown;
  thinking?: unknown;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
  [k: string]: unknown;
}

/** Entry kinds we surface as conversational events. */
export type ParsedKind = "user" | "assistant" | "tool_output" | "skip";

export interface ParsedTurn {
  kind: ParsedKind;
  stepIndex: number;
  /** user: prompt text. assistant: final text. tool_output: raw output. */
  text: string;
  /** assistant only. */
  thinking: string;
  /** assistant only — tool calls issued this turn. */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Human model label, if discoverable from this entry. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Tool-result entry classification
// ---------------------------------------------------------------------------

const NON_TOOL_MODEL_TYPES = new Set(["PLANNER_RESPONSE"]);

/**
 * True when an entry is a tool *result* (the output of an executed tool). Such
 * entries come from the model side, are not planner responses, and carry a
 * string `content`. Using a denylist (rather than an allowlist) keeps this
 * robust as agy adds new tool types.
 */
export function isToolOutputEntry(e: TranscriptEntry): boolean {
  return (
    e.source === "MODEL" &&
    typeof e.type === "string" &&
    !NON_TOOL_MODEL_TYPES.has(e.type) &&
    typeof e.content === "string" &&
    (e.content as string).length > 0
  );
}

// ---------------------------------------------------------------------------
// Tool-arg normalization + deterministic id derivation
// ---------------------------------------------------------------------------

/**
 * agy decorates tool args with UI/runtime-only keys that differ between the
 * hook payload and the transcript (and run-to-run). Strip them so a tool_call
 * derived from the PreToolUse hook and the same call seen in the transcript
 * hash to the same id.
 */
const NOISE_ARG_KEYS = new Set([
  "toolAction",
  "toolSummary",
  "WaitMsBeforeAsync",
  "Blocking",
]);

export function normalizeToolArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    if (NOISE_ARG_KEYS.has(k)) continue;
    out[k] = (args as Record<string, unknown>)[k];
  }
  return out;
}

/**
 * Deterministic tool_call_id: "agy-" + sha256(name + " " + stableJSON(normArgs))[0:16].
 * Computed identically from the PreToolUse hook and from transcript tool_calls
 * so the dashboard links call ↔ result ↔ assistant_message.tool_call_ids.
 *
 * NOTE: keep in sync with obs-hook.ts (it re-implements the same hash so the
 * file stays importable standalone). The single source of truth is here.
 */
export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Pull the human prompt out of a USER_INPUT `content` string. agy wraps it in
 * <USER_REQUEST>…</USER_REQUEST> and appends <ADDITIONAL_METADATA> /
 * <USER_SETTINGS_CHANGE> blocks we don't want in the prompt text.
 */
export function extractUserText(content: string): string {
  if (!content) return "";
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (m) return m[1].trim();
  // Fallback: strip any metadata blocks, keep the rest.
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

/** Discover the human model label from a USER_SETTINGS_CHANGE block, if present. */
export function extractModelLabel(content: string): string | undefined {
  if (!content) return undefined;
  // "...changed setting `Model Selection` from None to Gemini 3.5 Flash (High)."
  const m = content.match(/Model Selection`?\s+from\s+.+?\s+to\s+(.+?)\.(?:\s|$)/);
  if (m) return m[1].trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Incremental tail parsing
// ---------------------------------------------------------------------------

export interface ParseResult {
  turns: ParsedTurn[];
  newOffset: number;
  fileShrunk: boolean;
}

/**
 * Read transcript entries from `offset` to EOF. Returns parsed turns (user /
 * assistant / tool_output), the advanced byte offset (stops at the last
 * complete newline, so a mid-write trailing partial line is left for next
 * time), and whether the file shrank (rotated → caller should reset).
 */
export function parseNewTurns(transcriptPath: string, offset: number): ParseResult {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns: [], newOffset: offset, fileShrunk: false };
  }

  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return { turns: [], newOffset: offset, fileShrunk: false };
  }

  let fileShrunk = false;
  let startOffset = offset;
  if (offset > size) {
    // File rotated / replaced — restart from 0.
    fileShrunk = true;
    startOffset = 0;
  }

  let buf: Buffer;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const len = size - startOffset;
      buf = Buffer.alloc(len > 0 ? len : 0);
      if (len > 0) fs.readSync(fd, buf, 0, len, startOffset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { turns: [], newOffset: offset, fileShrunk };
  }

  const chunk = buf.toString("utf8");
  // Only consume up to the last newline; keep the trailing partial line.
  const lastNl = chunk.lastIndexOf("\n");
  const consumable = lastNl >= 0 ? chunk.slice(0, lastNl) : "";
  const consumedBytes = lastNl >= 0 ? Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8") : 0;
  const newOffset = startOffset + consumedBytes;

  const turns: ParsedTurn[] = [];
  if (consumable) {
    for (const line of consumable.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed lines without aborting the batch
      }
      const turn = classifyEntry(entry);
      if (turn.kind !== "skip") turns.push(turn);
    }
  }

  return { turns, newOffset, fileShrunk };
}

function classifyEntry(e: TranscriptEntry): ParsedTurn {
  const stepIndex = typeof e.step_index === "number" ? e.step_index : -1;
  const base: ParsedTurn = { kind: "skip", stepIndex, text: "", thinking: "", toolCalls: [] };

  if (e.type === "USER_INPUT" && typeof e.content === "string") {
    const text = extractUserText(e.content);
    return { ...base, kind: "user", text, model: extractModelLabel(e.content) };
  }

  if (e.type === "PLANNER_RESPONSE") {
    const text = typeof e.content === "string" ? e.content : "";
    const thinking = typeof e.thinking === "string" ? e.thinking : "";
    const toolCalls = Array.isArray(e.tool_calls)
      ? e.tool_calls
          .filter((tc) => tc && typeof tc.name === "string")
          .map((tc) => ({ name: tc.name as string, args: (tc.args ?? {}) as Record<string, unknown> }))
      : [];
    // A planner response that is pure tool dispatch with no text/thinking is
    // not interesting on its own — the tool_call events already cover it.
    if (!text && !thinking && toolCalls.length === 0) return base;
    return { ...base, kind: "assistant", text, thinking, toolCalls };
  }

  if (isToolOutputEntry(e)) {
    return { ...base, kind: "tool_output", text: e.content as string };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/** All-zero usage — agy exposes no token/cost data via hooks or transcript. */
export function zeroUsage(): UsageSummary {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, cost_total: 0 };
}

export function buildAssistantMessagePayload(
  turn: ParsedTurn,
  toolCallIds: string[],
): AssistantMessagePayload {
  const text = truncateToBytes(turn.text, MAX_TEXT_FIELD).text;
  const thinking = truncateToBytes(turn.thinking, MAX_TEXT_FIELD).text;
  return {
    text,
    thinking,
    tool_call_ids: toolCallIds,
    stop_reason: turn.toolCalls.length > 0 ? "toolUse" : "stop",
    usage: zeroUsage(),
  };
}

export function buildThinkingPayload(turn: ParsedTurn): ThinkingPayload | null {
  if (!turn.thinking) return null;
  return { text: truncateToBytes(turn.thinking, MAX_TEXT_FIELD).text };
}
