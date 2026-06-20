#!/usr/bin/env bun
/**
 * Claude Code → Pi Observability bridge hook handler.
 *
 * Registered in .claude/settings.json for every lifecycle hook. Claude Code
 * fires a fresh process per hook, passing a JSON payload on stdin. This script
 * reads that payload, maps it to an ObsEvent envelope, and POSTs it to the
 * same /events endpoint the Pi extension uses.
 *
 * Config env vars (same surface as extension/pi-observability.ts):
 *   OBS_SERVER_URL   — default http://127.0.0.1:43190
 *   OBS_AUTH_TOKEN   — bearer token
 *   OBS_POOL         — default "default"
 *   OBS_TAG          — comma-separated tag list
 *   OBS_NAME         — agent name, default "claude-code"
 *   OBS_DISABLE      — set to "true" to disable entirely
 *
 * Always exits 0. All errors are logged to ${stateDir}/debug.log and
 * swallowed so Claude Code is never blocked.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  truncateToBytes,
  MAX_TEXT_FIELD,
  MAX_ARGS_BYTES,
  MAX_RESULT_BYTES,
  MAX_REQUEST_BYTES,
  type ObsEventEnvelope,
  type SessionStartPayload,
  type SessionShutdownPayload,
  type AgentStartPayload,
  type AgentEndPayload,
  type UserMessagePayload,
  type AssistantMessagePayload,
  type ToolCallPayload,
  type ToolResultPayload,
  type ThinkingPayload,
  type CustomPayload,
  type CompactionPayload,
  type UsageSummary,
} from "../../shared/types.ts";

import {
  getStateDir,
  wipeSession,
  resetSession,
  nextSeq,
  loadState,
  saveState,
  debugLog,
} from "./state.ts";

import { parseNewTurns, buildAssistantMessagePayload, buildThinkingPayload } from "./transcript.ts";
import { shouldSkipCursorHook } from "./cursor-detect.ts";

// ---------------------------------------------------------------------------
// .env loader (mirrors extension/pi-observability.ts:37)
// ---------------------------------------------------------------------------

function loadEnv(cwd: string): void {
  const envPaths = [path.join(cwd, ".env"), path.join(cwd, ".env.local")];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx <= 0) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          // Don't overwrite vars already set by the shell
          if (process.env[key] === undefined) process.env[key] = val;
        }
      } catch {
        // Ignore env file read errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  serverUrl: string;
  token: string;
  pool: string;
  tags: string[];
  agentName: string;
  disabled: boolean;
}

function resolveConfig(): Config {
  const serverUrl = process.env.OBS_SERVER_URL?.trim() || "http://127.0.0.1:43190";
  const token = process.env.OBS_AUTH_TOKEN?.trim() || "";
  const pool = process.env.OBS_POOL?.trim() || "default";
  const tagRaw = process.env.OBS_TAG?.trim() || "";
  const tags = tagRaw ? tagRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const agentName = process.env.OBS_NAME?.trim() || "claude-code";
  const disabled =
    process.env.OBS_DISABLE === "true" || process.env.OBS_DISABLE === "1";
  return { serverUrl, token, pool, tags, agentName, disabled };
}

// ---------------------------------------------------------------------------
// Envelope factory
// ---------------------------------------------------------------------------

interface SessionInfo {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  agentName?: string;
  pool: string;
  tags: string[];
  provider?: string;
  model?: string;
}

function createEnvelope<T>(
  type: string,
  payload: T,
  info: SessionInfo,
  seq: number,
): ObsEventEnvelope<T> {
  return {
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type: type as any,
    session_id: info.sessionId,
    session_file: info.sessionFile,
    cwd: info.cwd,
    agent_name: info.agentName,
    pool: info.pool,
    tags: info.tags,
    provider: info.provider,
    model: info.model,
    payload,
    seq,
  };
}

// ---------------------------------------------------------------------------
// Provider derivation
// ---------------------------------------------------------------------------

/**
 * Derive a provider id from the model id, so non-Anthropic models routed
 * through the Claude Code harness (e.g. glm-5.2 via Z.AI) are labeled
 * correctly in the dashboard instead of all reading "anthropic".
 * Falls back to "anthropic" for unrecognized ids — the harness's native
 * provider — to preserve prior behavior for Claude models.
 */
function providerForModel(modelId: string | undefined): string {
  if (!modelId) return "anthropic";
  const id = modelId.toLowerCase().replace(/^.*\//, "").trim();
  if (id.startsWith("glm-"))      return "zhipuai";
  if (id.startsWith("gemini-"))   return "google";
  if (id.startsWith("gpt-") || /^o[13]/.test(id)) return "openai";
  if (id.startsWith("deepseek"))  return "deepseek";
  if (id.startsWith("qwen"))      return "qwen";
  if (id.startsWith("kimi"))      return "moonshotai";
  return "anthropic";
}

// ---------------------------------------------------------------------------
// Tool args truncation (mirrors extension/pi-observability.ts:81)
// ---------------------------------------------------------------------------

function truncateArgs(
  args: Record<string, any>,
): { args: Record<string, any>; truncated: boolean } {
  let truncated = false;
  let copy: Record<string, any>;
  try {
    copy = JSON.parse(JSON.stringify(args));
  } catch {
    return { args, truncated: false };
  }

  function walk(obj: any): void {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string") {
        const res = truncateToBytes(obj[key], MAX_ARGS_BYTES);
        if (res.truncated) {
          obj[key] = res.text;
          truncated = true;
        }
      } else if (typeof obj[key] === "object") {
        walk(obj[key]);
      }
    }
  }

  walk(copy);
  return { args: copy, truncated };
}

// ---------------------------------------------------------------------------
// Deterministic tool_call_id derivation
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic tool_call_id from tool_name + tool_input.
 * Both PreToolUse and PostToolUse carry identical tool_name + tool_input,
 * so they compute the same id and the dashboard links them.
 *
 * Format: "cc-" + first 16 hex chars of SHA-256(tool_name + " " + stableJSON(tool_input))
 * stableJSON = JSON.stringify with sorted keys to resist key-order jitter.
 */
function deriveToolCallId(toolName: string, toolInput: Record<string, any>): string {
  const stable = stableStringify(toolInput);
  const hash = crypto
    .createHash("sha256")
    .update(toolName + " " + stable, "utf8")
    .digest("hex");
  return "cc-" + hash.slice(0, 16);
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as any)[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const BACKOFF_INIT_MS = 250;
const BACKOFF_MAX_MS = 5000;

async function postEvents(
  events: ObsEventEnvelope<any>[],
  serverUrl: string,
  token: string,
  stateDir: string,
): Promise<void> {
  if (events.length === 0) return;

  // Chunk if request body would exceed MAX_REQUEST_BYTES
  const body = JSON.stringify(events);
  const bodyBytes = Buffer.byteLength(body, "utf8");

  if (bodyBytes > MAX_REQUEST_BYTES && events.length > 1) {
    const mid = Math.floor(events.length / 2);
    await postEvents(events.slice(0, mid), serverUrl, token, stateDir);
    await postEvents(events.slice(mid), serverUrl, token, stateDir);
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let backoffMs = BACKOFF_INIT_MS;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/events`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }

  // All retries failed — spool to disk for potential recovery
  debugLog(stateDir, "post_failed_spooled", { error: String(lastErr), count: events.length });
  try {
    const spoolDir = path.join(stateDir, "..", "spool");
    fs.mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, `${Date.now()}.json`);
    fs.writeFileSync(spoolFile, body, "utf8");
    // Cap spool to 20 files to avoid unbounded disk growth
    pruneSpoolDir(spoolDir, 20);
  } catch {
    // Non-fatal
  }
}

function pruneSpoolDir(dir: string, maxFiles: number): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    while (files.length > maxFiles) {
      const oldest = files.shift()!;
      fs.unlinkSync(path.join(dir, oldest.name));
    }
  } catch {
    // Non-fatal
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

async function handleSessionStart(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const source: string = hookPayload.source ?? "startup";

  // Map Claude Code source → SessionStartPayload.reason
  let reason: SessionStartPayload["reason"];
  switch (source) {
    case "startup":  reason = "startup"; break;
    case "resume":   reason = "resume"; break;
    case "clear":    reason = "new"; break;
    case "compact":  reason = "startup"; break; // closest legal value
    default:         reason = "startup";
  }

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const seq = nextSeq(stateDir); // should be 0 after resetSession

  const payload: SessionStartPayload = { reason };
  return [createEnvelope("session_start", payload, sessionInfo, seq)];
}

async function handleSessionEnd(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const rawReason: string = hookPayload.reason ?? "";

  // Map to legal SessionShutdownPayload.reason union
  const legalReasons = new Set(["quit", "reload", "new", "resume", "fork"]);
  const reason = legalReasons.has(rawReason)
    ? (rawReason as SessionShutdownPayload["reason"])
    : "quit";

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const seq = nextSeq(stateDir);
  const payload: SessionShutdownPayload = { reason };
  return [createEnvelope("session_shutdown", payload, sessionInfo, seq)];
}

async function handleUserPromptSubmit(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const rawPrompt: string = hookPayload.prompt ?? "";
  const text = truncateToBytes(rawPrompt, MAX_TEXT_FIELD).text;

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const envelopes: ObsEventEnvelope<any>[] = [];

  // user_message
  const userPayload: UserMessagePayload = { text, images_count: 0 };
  envelopes.push(createEnvelope("user_message", userPayload, sessionInfo, nextSeq(stateDir)));

  // agent_start (sibling to user_message, same prompt)
  const agentPayload: AgentStartPayload = {
    prompt: text,
    images_count: 0,
    session_id: hookPayload.session_id,
    session_file: hookPayload.transcript_path,
  };
  envelopes.push(createEnvelope("agent_start", agentPayload, sessionInfo, nextSeq(stateDir)));

  return envelopes;
}

async function handlePreToolUse(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const toolName: string = hookPayload.tool_name ?? "";
  const toolInput: Record<string, any> =
    hookPayload.tool_input && typeof hookPayload.tool_input === "object"
      ? hookPayload.tool_input
      : {};

  // Check if a native tool_use_id is present on the hook stdin
  // (as of current Claude Code, PreToolUse does not expose it — using derived id)
  const derivedId = deriveToolCallId(toolName, toolInput);

  // Track open tool ids for collision detection
  const state = loadState(stateDir);
  state.openToolIds[derivedId] = (state.openToolIds[derivedId] ?? 0) + 1;
  saveState(stateDir, state);

  const { args, truncated } = truncateArgs(toolInput);

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const payload: ToolCallPayload = {
    tool_call_id: derivedId,
    tool_name: toolName,
    args,
    args_truncated: truncated,
  };
  return [createEnvelope("tool_call", payload, sessionInfo, nextSeq(stateDir))];
}

async function handlePostToolUse(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const toolName: string = hookPayload.tool_name ?? "";
  const toolInput: Record<string, any> =
    hookPayload.tool_input && typeof hookPayload.tool_input === "object"
      ? hookPayload.tool_input
      : {};
  const toolResponse: unknown = hookPayload.tool_response;

  const derivedId = deriveToolCallId(toolName, toolInput);

  // Decrement open tool id counter
  const state = loadState(stateDir);
  if (state.openToolIds[derivedId]) {
    state.openToolIds[derivedId]--;
    if (state.openToolIds[derivedId] <= 0) {
      delete state.openToolIds[derivedId];
    }
  }
  saveState(stateDir, state);

  // Extract content_text from tool_response
  let content_text = "";
  let is_error = false;
  const details_summary: Record<string, any> = {};

  if (typeof toolResponse === "string") {
    content_text = toolResponse;
  } else if (toolResponse && typeof toolResponse === "object") {
    const resp = toolResponse as Record<string, any>;

    // Check for error indicators
    is_error = resp.is_error === true || resp.error === true || resp.type === "error";

    // Extract text from various response shapes
    if (typeof resp.output === "string") {
      content_text = resp.output;
    } else if (typeof resp.content === "string") {
      content_text = resp.content;
    } else if (Array.isArray(resp.content)) {
      for (const block of resp.content) {
        if (block && typeof block === "object" && block.type === "text") {
          content_text += (block.text ?? "") + "\n";
        }
      }
      content_text = content_text.trim();
    } else if (typeof resp.result === "string") {
      content_text = resp.result;
    } else {
      // Last resort: stringify
      try {
        content_text = JSON.stringify(toolResponse);
      } catch {
        content_text = String(toolResponse);
      }
    }

    // Collect details
    if ("exit_code" in resp || "exitCode" in resp) {
      details_summary.exit_code = resp.exit_code ?? resp.exitCode;
    }
    if ("cancelled" in resp) details_summary.cancelled = resp.cancelled;
    if ("truncated" in resp) details_summary.truncated = resp.truncated;
  } else if (toolResponse !== undefined && toolResponse !== null) {
    content_text = String(toolResponse);
  }

  const tr = truncateToBytes(content_text, MAX_RESULT_BYTES);

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const payload: ToolResultPayload = {
    tool_call_id: derivedId,
    tool_name: toolName,
    content_text: tr.text,
    content_truncated: tr.truncated,
    is_error,
    details_summary: Object.keys(details_summary).length > 0 ? details_summary : undefined,
  };
  return [createEnvelope("tool_result", payload, sessionInfo, nextSeq(stateDir))];
}

async function handleStop(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const transcriptPath: string = hookPayload.transcript_path ?? "";

  const state = loadState(stateDir);
  const { turns, newOffset, fileShrunk } = parseNewTurns(transcriptPath, state.transcriptOffset);

  if (fileShrunk) {
    debugLog(stateDir, "transcript_shrunk", { path: transcriptPath, oldOffset: state.transcriptOffset });
  }

  // Advance offset
  state.transcriptOffset = newOffset;
  saveState(stateDir, state);

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: transcriptPath,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const envelopes: ObsEventEnvelope<any>[] = [];

  for (const turn of turns) {
    // Set model on session info for this turn's envelopes
    const turnInfo: SessionInfo = { ...sessionInfo, provider: providerForModel(turn.model), model: turn.model };

    // assistant_message
    const assistantPayload = buildAssistantMessagePayload(turn);
    envelopes.push(createEnvelope("assistant_message", assistantPayload, turnInfo, nextSeq(stateDir)));

    // thinking (if present)
    const thinkingPayload = buildThinkingPayload(turn);
    if (thinkingPayload) {
      envelopes.push(createEnvelope("thinking", thinkingPayload, turnInfo, nextSeq(stateDir)));
    }

    if (turn.usage && !isFinite(turn.usage.cost_total) || (turn.usage.cost_total === 0 && turn.model)) {
      debugLog(stateDir, "unknown_model_cost_zero", { model: turn.model, msgId: turn.messageId });
    }
  }

  // agent_end
  const agentEndPayload: AgentEndPayload = { message_count: turns.length };
  envelopes.push(createEnvelope("agent_end", agentEndPayload, sessionInfo, nextSeq(stateDir)));

  return envelopes;
}

async function handlePreCompact(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const trigger: string = hookPayload.trigger ?? "auto";
  const reason: CompactionPayload["reason"] = trigger === "manual" ? "manual" : "auto";

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const payload: CompactionPayload = {
    reason,
    tokens_before: 0, // Not available in PreCompact hook
    first_kept_entry_id: "", // Not available
    summary_preview: "", // Not available
  };
  return [createEnvelope("compaction", payload, sessionInfo, nextSeq(stateDir))];
}

async function handleCustom(
  hookEventName: string,
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id ?? "unknown",
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "anthropic",
  };

  const payload: CustomPayload = {
    custom_type: hookEventName,
    data: hookPayload,
  };
  return [createEnvelope("custom", payload, sessionInfo, nextSeq(stateDir))];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read all of stdin
  let stdinRaw = "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    stdinRaw = Buffer.concat(chunks).toString("utf8");
  } catch {
    process.exit(0);
  }

  let hookPayload: Record<string, any>;
  try {
    hookPayload = JSON.parse(stdinRaw);
  } catch {
    // Unparseable stdin — exit silently
    process.exit(0);
  }

  // Load env from cwd BEFORE resolving config
  const cwd: string = hookPayload.cwd ?? process.cwd();
  try {
    loadEnv(cwd);
  } catch {
    // Non-fatal
  }

  const config = resolveConfig();

  if (config.disabled) {
    process.exit(0);
  }

  const sessionId: string = hookPayload.session_id ?? "unknown";
  const hookEventName: string = hookPayload.hook_event_name ?? "";

  // Setup state dir; wipe on "clear" source
  let stateDir: string;
  if (hookEventName === "SessionStart" && hookPayload.source === "clear") {
    stateDir = wipeSession(sessionId);
  } else {
    stateDir = getStateDir(sessionId);
  }

  // Reset seq counter on Claude Code SessionStart only (not Cursor sessionStart).
  if (hookEventName === "SessionStart") {
    resetSession(stateDir);
  }

  if (shouldSkipCursorHook(hookPayload, stateDir)) {
    debugLog(stateDir, "skip_cursor_pi_delegated", {
      hookEventName,
      sessionId,
      cursor_version: hookPayload.cursor_version,
    });
    process.exit(0);
  }

  // Log the first real hook payload to the debug file (Story 1.2 — "log one
  // real payload to the debug file on first run to confirm")
  try {
    const state = loadState(stateDir);
    if (!state.firstRunLogged) {
      debugLog(stateDir, "first_hook_payload", { hookEventName, payload: hookPayload });
      state.firstRunLogged = true;
      saveState(stateDir, state);
    }
  } catch {
    // Non-fatal
  }

  if (!config.token) {
    debugLog(stateDir, "no_token_warning", {
      message: "OBS_AUTH_TOKEN is not set — server will return 401",
      serverUrl: config.serverUrl,
    });
  }

  // Dispatch
  let envelopes: ObsEventEnvelope<any>[] = [];
  try {
    switch (hookEventName) {
      case "SessionStart":
        envelopes = await handleSessionStart(hookPayload, config, stateDir);
        break;
      case "SessionEnd":
        envelopes = await handleSessionEnd(hookPayload, config, stateDir);
        break;
      case "UserPromptSubmit":
        envelopes = await handleUserPromptSubmit(hookPayload, config, stateDir);
        break;
      case "PreToolUse":
        envelopes = await handlePreToolUse(hookPayload, config, stateDir);
        break;
      case "PostToolUse":
        envelopes = await handlePostToolUse(hookPayload, config, stateDir);
        break;
      case "Stop":
      case "SubagentStop":
        envelopes = await handleStop(hookPayload, config, stateDir);
        break;
      case "PreCompact":
        envelopes = await handlePreCompact(hookPayload, config, stateDir);
        break;
      case "Notification":
      default:
        // Unknown / unmapped → custom event
        envelopes = await handleCustom(hookEventName, hookPayload, config, stateDir);
        break;
    }
  } catch (err) {
    debugLog(stateDir, "dispatch_error", {
      hookEventName,
      error: err instanceof Error ? err.message : String(err),
    });
    // Exit 0 even on dispatch error
    process.exit(0);
  }

  // POST
  try {
    await postEvents(envelopes, config.serverUrl, config.token, stateDir);
  } catch (err) {
    debugLog(stateDir, "post_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
