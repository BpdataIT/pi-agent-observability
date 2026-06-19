/**
 * Incremental JSONL transcript parser for Claude Code sessions.
 *
 * VERIFIED transcript facts (from real ~/.claude/projects/.../session.jsonl):
 *
 * 1. Each line has top-level .type in {assistant, user, system, attachment,
 *    file-history-snapshot, ai-title, last-prompt, mode, permission-mode}.
 *
 * 2. CRITICAL: Claude Code writes ONE assistant line PER content block.
 *    Every line for a single turn repeats the SAME .message.id and
 *    .message.usage. We MUST dedupe by .message.id and count usage once.
 *
 * 3. Usage shape: .message.usage = {
 *      input_tokens, output_tokens,
 *      cache_read_input_tokens, cache_creation_input_tokens, ...
 *    }
 *    Mapped to UsageSummary:
 *      input  ← input_tokens
 *      output ← output_tokens
 *      cache_read  ← cache_read_input_tokens
 *      cache_write ← cache_creation_input_tokens
 *      total_tokens ← input + output + cache_read + cache_write
 *
 * 4. No cost field in transcript; cost_total computed from model-prices.ts.
 *
 * 5. Native tool ids exist: tool_use block has .id = "toolu_...".
 *    Tool results live in user entries with .toolUseResult present.
 *
 * 6. Plain user prompt: .message.content is a string, no .toolUseResult.
 *    Tool result entry: has .toolUseResult, .message.content is an array.
 *
 * 7. stop_reason observed: "tool_use" → mapped to "toolUse",
 *    "end_turn" / null → "stop", "max_tokens" → "length".
 *
 * 8. Timing: entries have .timestamp. latency_ms ≈ last assistant line ts
 *    minus preceding user line ts (approximate, documented as such).
 */

import * as fs from "node:fs";
import {
  truncateToBytes,
  MAX_TEXT_FIELD,
  type UsageSummary,
  type AssistantMessagePayload,
  type ThinkingPayload,
} from "../../shared/types.ts";
import { computeCost } from "./model-prices.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssistantTurn {
  /** The .message.id / dedup key */
  messageId: string;
  /** .message.model */
  model: string;
  /** Concatenated text blocks */
  text: string;
  /** Concatenated thinking blocks */
  thinking: string;
  /** Collected tool_use ids (native "toolu_..." ids) */
  toolUseIds: string[];
  /** stop_reason from the transcript, normalized to ObsEvent union */
  stop_reason: string;
  /** Single usage object (taken from first line of the group) */
  usage: UsageSummary;
  /** Timestamp of the first line in this group (ISO-8601) */
  firstTimestamp: string;
  /** Timestamp of the last line in this group */
  lastTimestamp: string;
  /** Timestamp of the preceding user entry (for latency approximation) */
  precedingUserTimestamp?: string;
}

export interface ParseResult {
  /** New assistant turns extracted from new lines */
  turns: AssistantTurn[];
  /** Byte offset after the last fully-parsed line */
  newOffset: number;
  /** Anomaly flag if the file shrank */
  fileShrunk: boolean;
}

// ---------------------------------------------------------------------------
// stop_reason normalization
// ---------------------------------------------------------------------------

function normalizeStopReason(raw: string | null | undefined): string {
  if (!raw) return "stop";
  switch (raw) {
    case "tool_use":     return "toolUse";
    case "end_turn":     return "stop";
    case "max_tokens":   return "length";
    case "stop_sequence": return "stop";
    default:             return raw;
  }
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

function extractUsage(rawUsage: Record<string, any>): Omit<UsageSummary, "cost_total"> {
  const input       = Number(rawUsage?.input_tokens ?? 0);
  const output      = Number(rawUsage?.output_tokens ?? 0);
  const cache_read  = Number(rawUsage?.cache_read_input_tokens ?? 0);
  const cache_write = Number(rawUsage?.cache_creation_input_tokens ?? 0);
  const total_tokens = input + output + cache_read + cache_write;
  return { input, output, cache_read, cache_write, total_tokens };
}

// ---------------------------------------------------------------------------
// Incremental parser
// ---------------------------------------------------------------------------

/**
 * Parse new assistant turns from a transcript JSONL file, starting at
 * `fromOffset` bytes into the file.
 *
 * Algorithm:
 *  1. Read bytes from fromOffset to EOF.
 *  2. Split on newlines; skip the last element (may be a partial write).
 *  3. Parse each complete line; ignore lines that fail JSON.parse.
 *  4. Group assistant lines by .message.id; take usage once per group.
 *  5. Track the preceding user entry's timestamp for latency approximation.
 *  6. Return all new turns + the new offset.
 *
 * If the file is shorter than fromOffset (transcript rotated or new session),
 * restart from byte 0 and set fileShrunk = true in the result.
 */
export function parseNewTurns(
  transcriptPath: string,
  fromOffset: number,
): ParseResult {
  const empty: ParseResult = { turns: [], newOffset: fromOffset, fileShrunk: false };

  let fileSize = 0;
  try {
    fileSize = fs.statSync(transcriptPath).size;
  } catch {
    // File doesn't exist yet
    return empty;
  }

  let fileShrunk = false;
  let startOffset = fromOffset;

  if (fileSize < fromOffset) {
    // File shrank (transcript rotated or Claude Code started fresh)
    fileShrunk = true;
    startOffset = 0;
  }

  if (fileSize === startOffset) {
    // Nothing new
    return { turns: [], newOffset: startOffset, fileShrunk };
  }

  // Read only the new bytes
  let chunk: Buffer;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const len = fileSize - startOffset;
      chunk = Buffer.alloc(len);
      const bytesRead = fs.readSync(fd, chunk, 0, len, startOffset);
      if (bytesRead < len) chunk = chunk.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { turns: [], newOffset: startOffset, fileShrunk };
  }

  const rawText = chunk.toString("utf8");
  const lines = rawText.split("\n");

  // The last element may be a partial write — skip it and track the byte
  // offset of the last *complete* newline.
  const completeLines = lines.slice(0, lines.length - 1);

  // Track byte offset for each complete line
  // We need the offset after the last complete line.
  let parsedBytes = 0;
  for (const line of completeLines) {
    parsedBytes += Buffer.byteLength(line, "utf8") + 1; // +1 for \n
  }
  const newOffset = startOffset + parsedBytes;

  // ---- Group assistant lines by .message.id ----
  // We also track the last user-entry timestamp before each message group
  // for latency approximation.

  // Map from message.id → accumulated group data
  const groups = new Map<string, {
    model: string;
    text: string;
    thinking: string;
    toolUseIds: string[];
    stop_reason: string;
    rawUsage: Record<string, any>;
    firstTimestamp: string;
    lastTimestamp: string;
    // Insertion-order index so we return turns in transcript order
    orderIndex: number;
  }>();

  let lastUserTimestamp: string | undefined;
  // Map from message.id → preceding user timestamp
  const precedingUserTs = new Map<string, string>();
  let orderCounter = 0;

  for (const rawLine of completeLines) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      // Malformed / partial line — skip
      continue;
    }

    const entryType = entry?.type;

    if (entryType === "user") {
      // Track the timestamp for latency approximation
      if (entry.timestamp && !entry.toolUseResult) {
        lastUserTimestamp = entry.timestamp;
      }
      continue;
    }

    if (entryType !== "assistant") {
      continue;
    }

    const msg = entry?.message;
    if (!msg || msg.role !== "assistant") continue;

    const msgId: string = msg.id ?? entry.requestId ?? entry.uuid ?? "";
    if (!msgId) continue;

    const model: string = msg.model ?? "";
    const contentBlocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    const rawUsage: Record<string, any> = msg.usage ?? {};
    const stopReason = normalizeStopReason(msg.stop_reason);
    const ts: string = entry.timestamp ?? new Date().toISOString();

    if (!groups.has(msgId)) {
      // First line for this message group
      groups.set(msgId, {
        model,
        text: "",
        thinking: "",
        toolUseIds: [],
        stop_reason: stopReason,
        rawUsage,
        firstTimestamp: ts,
        lastTimestamp: ts,
        orderIndex: orderCounter++,
      });
      // Record the user timestamp that preceded this group
      if (lastUserTimestamp) {
        precedingUserTs.set(msgId, lastUserTimestamp);
      }
    }

    const group = groups.get(msgId)!;
    group.lastTimestamp = ts;

    // Accumulate content blocks
    for (const block of contentBlocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        group.text += (block.text ?? "") + "\n";
      } else if (block.type === "thinking") {
        group.thinking += (block.thinking ?? block.text ?? "") + "\n";
      } else if (block.type === "tool_use") {
        const toolId: string = block.id ?? "";
        if (toolId && !group.toolUseIds.includes(toolId)) {
          group.toolUseIds.push(toolId);
        }
      }
    }
  }

  // ---- Convert groups to AssistantTurn[] in transcript order ----
  const sortedEntries = Array.from(groups.entries()).sort(
    (a, b) => a[1].orderIndex - b[1].orderIndex,
  );

  const turns: AssistantTurn[] = [];
  for (const [msgId, group] of sortedEntries) {
    const baseUsage = extractUsage(group.rawUsage);
    const { cost_total, unknown_model } = computeCost(baseUsage, group.model);

    // Log unknown model (caller will write to debug log if needed)
    if (unknown_model && group.model) {
      // Mark it in the turn so the caller can log
    }

    const usage: UsageSummary = { ...baseUsage, cost_total };

    const textTrimmed = truncateToBytes(group.text.trim(), MAX_TEXT_FIELD).text;
    const thinkingTrimmed = truncateToBytes(group.thinking.trim(), MAX_TEXT_FIELD).text;

    // Latency approximation
    let latency_ms: number | undefined;
    const userTs = precedingUserTs.get(msgId);
    if (userTs) {
      try {
        const userTime = new Date(userTs).getTime();
        const assistantTime = new Date(group.lastTimestamp).getTime();
        if (assistantTime > userTime) {
          latency_ms = assistantTime - userTime;
        }
      } catch {
        // Non-fatal
      }
    }

    turns.push({
      messageId: msgId,
      model: group.model,
      text: textTrimmed,
      thinking: thinkingTrimmed,
      toolUseIds: group.toolUseIds,
      stop_reason: group.stop_reason,
      usage,
      firstTimestamp: group.firstTimestamp,
      lastTimestamp: group.lastTimestamp,
      precedingUserTimestamp: userTs,
    });
  }

  return { turns, newOffset, fileShrunk };
}

/**
 * Build an AssistantMessagePayload from a parsed AssistantTurn.
 * latency_ms is included if derivable from transcript timestamps.
 * prefill_ms / generation_ms / output_tps are NOT set (not derivable
 * from hook/transcript — omitting rather than fabricating).
 */
export function buildAssistantMessagePayload(turn: AssistantTurn): AssistantMessagePayload {
  // latency_ms: approximated from transcript timestamps, labeled as approximate
  let latency_ms: number | undefined;
  if (turn.precedingUserTimestamp) {
    try {
      const userTime = new Date(turn.precedingUserTimestamp).getTime();
      const assistantTime = new Date(turn.lastTimestamp).getTime();
      if (assistantTime > userTime) {
        latency_ms = assistantTime - userTime;
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    text: turn.text,
    thinking: turn.thinking,
    tool_call_ids: turn.toolUseIds,
    stop_reason: turn.stop_reason,
    usage: turn.usage,
    latency_ms,
    // prefill_ms, generation_ms, output_tps intentionally omitted
  };
}

/**
 * Build a ThinkingPayload from a parsed AssistantTurn (only if thinking is non-empty).
 */
export function buildThinkingPayload(turn: AssistantTurn): ThinkingPayload | null {
  if (!turn.thinking) return null;
  return { text: turn.thinking };
}
