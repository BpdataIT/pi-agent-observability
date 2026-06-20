/**
 * Incremental JSONL transcript parser for Factory Droid sessions.
 *
 * Droid writes one line per message (not per content block like Claude Code).
 * Per-message token usage is absent — usage comes from the `.settings.json`
 * sidecar and is merged in obs-hook.ts on Stop.
 *
 * Line types:
 *   message          — user/assistant turns (assistant only become turns)
 *   todo_state       — ignored for turn extraction
 *   session_start    — ignored
 *   compaction_state — ignored (Phase 5 enrichment deferred)
 */

import * as fs from "node:fs";
import {
  truncateToBytes,
  MAX_TEXT_FIELD,
  type UsageSummary,
  type AssistantMessagePayload,
  type ThinkingPayload,
} from "../../shared/types.ts";
import { contextWindowForModel } from "./model-context.ts";

export interface AssistantTurn {
  /** The line-level `id` (one line = one turn) */
  messageId: string;
  /** `.message.modelId` */
  model: string;
  /** Concatenated text blocks */
  text: string;
  /** Concatenated thinking blocks */
  thinking: string;
  /** Collected tool_use ids (native `chatcmpl-tool-*` ids) */
  toolUseIds: string[];
  /** Inferred stop_reason */
  stop_reason: string;
  /** Placeholder until sidecar delta merge in obs-hook.ts */
  usage: UsageSummary;
  /** Line timestamp (ISO-8601) */
  firstTimestamp: string;
  /** Same as firstTimestamp for Droid (one line per turn) */
  lastTimestamp: string;
  /** Timestamp of the preceding user message (for latency approximation) */
  precedingUserTimestamp?: string;
  /** Sum of thinking block durationMs when present */
  generation_ms?: number;
}

export interface ParseResult {
  turns: AssistantTurn[];
  newOffset: number;
  fileShrunk: boolean;
}

function inferStopReason(contentBlocks: any[]): string {
  if (contentBlocks.length === 0) return "stop";
  const last = contentBlocks[contentBlocks.length - 1];
  if (last && typeof last === "object" && last.type === "tool_use") {
    return "toolUse";
  }
  return "stop";
}

function placeholderUsage(): UsageSummary {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    total_tokens: 0,
    cost_total: 0,
  };
}

/**
 * Parse new assistant turns from a Droid transcript JSONL file, starting at
 * `fromOffset` bytes into the file.
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
    return empty;
  }

  let fileShrunk = false;
  let startOffset = fromOffset;

  if (fileSize < fromOffset) {
    fileShrunk = true;
    startOffset = 0;
  }

  if (fileSize === startOffset) {
    return { turns: [], newOffset: startOffset, fileShrunk };
  }

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
  const completeLines = lines.slice(0, lines.length - 1);

  let parsedBytes = 0;
  for (const line of completeLines) {
    parsedBytes += Buffer.byteLength(line, "utf8") + 1;
  }
  const newOffset = startOffset + parsedBytes;

  const turns: AssistantTurn[] = [];
  let lastUserTimestamp: string | undefined;

  for (const rawLine of completeLines) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const entryType = entry?.type;

    if (entryType === "message") {
      const msg = entry?.message;
      if (!msg || typeof msg !== "object") continue;

      if (msg.role === "user") {
        const contentBlocks: any[] = Array.isArray(msg.content) ? msg.content : [];
        const hasTextOnly = contentBlocks.some((b) => b?.type === "text");
        if (hasTextOnly && entry.timestamp) {
          lastUserTimestamp = entry.timestamp;
        }
        continue;
      }

      if (msg.role !== "assistant") continue;

      const msgId: string = entry.id ?? "";
      if (!msgId) continue;

      const model: string = msg.modelId ?? "";
      const contentBlocks: any[] = Array.isArray(msg.content) ? msg.content : [];
      const ts: string = entry.timestamp ?? new Date().toISOString();

      let text = "";
      let thinking = "";
      const toolUseIds: string[] = [];
      let generation_ms = 0;

      for (const block of contentBlocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          text += (block.text ?? "") + "\n";
        } else if (block.type === "thinking") {
          thinking += (block.thinking ?? block.text ?? "") + "\n";
          if (typeof block.durationMs === "number") {
            generation_ms += block.durationMs;
          }
        } else if (block.type === "tool_use") {
          const toolId: string = block.id ?? "";
          if (toolId && !toolUseIds.includes(toolId)) {
            toolUseIds.push(toolId);
          }
        }
      }

      const turn: AssistantTurn = {
        messageId: msgId,
        model,
        text: truncateToBytes(text.trim(), MAX_TEXT_FIELD).text,
        thinking: truncateToBytes(thinking.trim(), MAX_TEXT_FIELD).text,
        toolUseIds,
        stop_reason: inferStopReason(contentBlocks),
        usage: placeholderUsage(),
        firstTimestamp: ts,
        lastTimestamp: ts,
        precedingUserTimestamp: lastUserTimestamp,
      };
      if (generation_ms > 0) {
        turn.generation_ms = generation_ms;
      }
      turns.push(turn);
      continue;
    }

    // todo_state, session_start, compaction_state — skip for turn extraction
  }

  return { turns, newOffset, fileShrunk };
}

export function buildAssistantMessagePayload(turn: AssistantTurn): AssistantMessagePayload {
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

  const payload: AssistantMessagePayload = {
    text: turn.text,
    thinking: turn.thinking,
    tool_call_ids: turn.toolUseIds,
    stop_reason: turn.stop_reason,
    usage: turn.usage,
    latency_ms,
    context_window: contextWindowForModel(turn.model),
  };

  if (turn.generation_ms !== undefined) {
    payload.generation_ms = turn.generation_ms;
  }

  return payload;
}

export function buildThinkingPayload(turn: AssistantTurn): ThinkingPayload | null {
  if (!turn.thinking) return null;
  return { text: turn.thinking };
}
