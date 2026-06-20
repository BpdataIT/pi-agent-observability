#!/usr/bin/env bun
/**
 * Antigravity (agy) → Pi Observability bridge hook handler.
 *
 * Registered in ~/.gemini/config/hooks.json (the BACKEND-synced path — the
 * sibling ~/.gemini/antigravity-cli/hooks.json is read by the TUI for display
 * only and its hooks never execute). agy fires a fresh process per lifecycle
 * hook and passes a JSON payload on stdin. Unlike Claude Code, agy does NOT
 * put the event name on stdin, so the hooks.json command passes it as the
 * first CLI argument: `bun obs-hook.ts <EventName>`.
 *
 * agy hook events (the full set — 5): PreToolUse, PostToolUse, PreInvocation,
 * PostInvocation, Stop. There is no SessionStart / UserPromptSubmit / SessionEnd
 * hook, so:
 *   - session_start is synthesized lazily on the first hook for a conversation.
 *   - user_message / assistant_message / thinking are read from the JSONL
 *     transcript (transcriptPath) rather than from a dedicated hook.
 *
 * 🔴 agy exposes NO token usage or cost via hooks or the transcript, so
 * assistant_message.usage is emitted as zeros. The session lane, prompts,
 * thinking, tool calls and results all populate; cost/token columns read 0.
 *
 * Config env vars (same surface as the Claude Code bridge):
 *   OBS_SERVER_URL  — default http://127.0.0.1:43190
 *   OBS_AUTH_TOKEN  — bearer token
 *   OBS_POOL        — default "default"
 *   OBS_TAG         — comma-separated tag list
 *   OBS_NAME        — agent name, default "antigravity"
 *   OBS_DISABLE     — "true" to disable entirely
 *
 * Always exits 0. All errors are caught and logged to ${stateDir}/debug.log so
 * agy is never blocked (a throwing PreToolUse hook fails closed and blocks the
 * tool call).
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
  type ToolCallPayload,
  type ToolResultPayload,
  type CustomPayload,
  type UsageSummary,
} from "../../shared/types.ts";

import {
  getStateDir,
  nextSeq,
  loadState,
  saveState,
  debugLog,
  type SessionState,
} from "./state.ts";

import {
  parseNewTurns,
  normalizeToolArgs,
  stableStringify,
  buildAssistantMessagePayload,
  buildThinkingPayload,
  type TurnTiming,
} from "./transcript.ts";
import {
  decodeNewUsage,
  resolveDbPath,
  type UsageRecord,
} from "./usage-decoder.ts";
import { computeCost } from "./model-prices.ts";

const PROVIDER = "google";

/** Derive the conversation .db path from a conversationId. agy stores one
 *  SQLite db per conversation at this fixed location. */
function conversationDbPath(conversationId: string): string {
  return resolveDbPath(conversationId);
}

// ---------------------------------------------------------------------------
// .env loader (mirrors the Claude Code bridge / pi-observability.ts)
// ---------------------------------------------------------------------------

function loadEnv(cwd: string): void {
  const envPaths = [path.join(cwd, ".env"), path.join(cwd, ".env.local")];
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
    } catch {
      // Ignore env file read errors
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
  const agentName = process.env.OBS_NAME?.trim() || "antigravity";
  const disabled = process.env.OBS_DISABLE === "true" || process.env.OBS_DISABLE === "1";
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

function createEnvelope<T>(type: string, payload: T, info: SessionInfo, seq: number): ObsEventEnvelope<T> {
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
    model: info.model || undefined,
    payload,
    seq,
  };
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

/** Deterministic id shared by hook + transcript derivation (see transcript.ts). */
function deriveToolCallId(toolName: string, args: Record<string, unknown>): string {
  const stable = stableStringify(normalizeToolArgs(args));
  const hash = crypto.createHash("sha256").update(toolName + " " + stable, "utf8").digest("hex");
  return "agy-" + hash.slice(0, 16);
}

function truncateArgs(args: Record<string, any>): { args: Record<string, any>; truncated: boolean } {
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
// Transport (per-hook synchronous POST with bounded retry + spool fallback)
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

  const body = JSON.stringify(events);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES && events.length > 1) {
    const mid = Math.floor(events.length / 2);
    await postEvents(events.slice(0, mid), serverUrl, token, stateDir);
    await postEvents(events.slice(mid), serverUrl, token, stateDir);
    return;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

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

  debugLog(stateDir, "post_failed_spooled", { error: String(lastErr), count: events.length });
  try {
    const spoolDir = path.join(stateDir, "spool");
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.writeFileSync(path.join(spoolDir, `${Date.now()}.json`), body, "utf8");
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
    while (files.length > maxFiles) fs.unlinkSync(path.join(dir, files.shift()!.name));
  } catch {
    // Non-fatal
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Shared derivation of SessionInfo from a hook payload
// ---------------------------------------------------------------------------

function sessionInfoFrom(hook: Record<string, any>, config: Config, model: string): SessionInfo {
  const workspacePaths: string[] = Array.isArray(hook.workspacePaths) ? hook.workspacePaths : [];
  return {
    sessionId: hook.conversationId ?? "unknown",
    sessionFile: hook.transcriptPath,
    cwd: workspacePaths[0] ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: PROVIDER,
    model,
  };
}

/**
 * Synthesize session_start once per conversation. agy has no SessionStart hook,
 * so the first observed hook (whichever fires first) emits it with seq 0.
 */
function ensureBoot(
  state: SessionState,
  info: SessionInfo,
  stateDir: string,
  out: ObsEventEnvelope<any>[],
): void {
  if (state.bootEmitted) return;
  const payload: SessionStartPayload = { reason: "startup" };
  out.push(createEnvelope("session_start", payload, info, nextSeq(stateDir)));
  state.bootEmitted = true;
}

/**
 * Drain new transcript entries → user_message/agent_start + assistant_message/
 * thinking. Tool-output entries are skipped here (PostToolUse emits tool_result).
 * Advances state.transcriptOffset and learns the model label.
 *
 * Per-turn usage: decodes gen_metadata rows with idx >= state.usageIdxOffset
 * (read-only .db access) and pairs them to the NEW assistant turns by ordinal
 * order (Nth new assistant turn ↔ Nth new usage row). Mismatch (row count !=
 * turn count) leaves unpaired turns at zero usage rather than mis-assigning.
 * .db read failures degrade to zero usage + a debug log; the hook still exits 0.
 */
function drainTranscript(
  hook: Record<string, any>,
  config: Config,
  state: SessionState,
  stateDir: string,
  out: ObsEventEnvelope<any>[],
): void {
  const transcriptPath: string = hook.transcriptPath ?? "";
  if (!transcriptPath) return;

  const { turns, newOffset, fileShrunk } = parseNewTurns(transcriptPath, state.transcriptOffset);
  if (fileShrunk) {
    debugLog(stateDir, "transcript_shrunk", { path: transcriptPath, oldOffset: state.transcriptOffset });
  }
  state.transcriptOffset = newOffset;

  const conversationId: string = hook.conversationId ?? "";
  const assistantTurns = turns.filter((t) => t.kind === "assistant");
  // Decode new usage rows for pairing — only when there are new assistant
  // turns to stamp (no point opening the .db otherwise).
  const usageForTurn =
    assistantTurns.length > 0 ? decodeUsageForTurns(conversationId, state, stateDir) : [];

  if (assistantTurns.length > 0 && usageForTurn.length !== assistantTurns.length) {
    debugLog(stateDir, "usage_turn_mismatch", {
      assistantTurns: assistantTurns.length,
      usageRows: usageForTurn.length,
      usageIdxOffset: state.usageIdxOffset,
      pairing: "end-aligned (latest turn gets latest usage)",
    });
  }
  // End-align pairing: when there are fewer usage rows than assistant turns
  // (a gen_metadata row can be missing for a non-model step, or the first turn
  // lacks a row), the LATEST turn still gets the LATEST usage — important
  // because the dashboard's context bar / latest stats read the most recent
  // assistant_message. Unpaired turns fall at the start (where the first turn's
  // input is ~0 anyway).
  const usageShift = Math.max(0, assistantTurns.length - usageForTurn.length);

  let assistantIdx = 0;
  for (const turn of turns) {
    if (turn.model) state.model = turn.model;
    const info = sessionInfoFrom(hook, config, state.model);

    if (turn.kind === "user") {
      const text = truncateToBytes(turn.text, MAX_TEXT_FIELD).text;
      const userPayload: UserMessagePayload = { text, images_count: 0 };
      out.push(createEnvelope("user_message", userPayload, info, nextSeq(stateDir)));
      const agentPayload: AgentStartPayload = {
        prompt: text,
        images_count: 0,
        session_id: info.sessionId,
        session_file: info.sessionFile,
      };
      out.push(createEnvelope("agent_start", agentPayload, info, nextSeq(stateDir)));
    } else if (turn.kind === "assistant") {
      const toolCallIds = turn.toolCalls.map((tc) => deriveToolCallId(tc.name, tc.args));
      const usageSlot = assistantIdx - usageShift;
      const { usage, timing } = usageSlot >= 0 ? (usageForTurn[usageSlot] ?? { usage: undefined, timing: undefined }) : { usage: undefined, timing: undefined };
      const assistantPayload = buildAssistantMessagePayload(turn, toolCallIds, state.model, usage, timing);
      out.push(createEnvelope("assistant_message", assistantPayload, info, nextSeq(stateDir)));
      const thinkingPayload = buildThinkingPayload(turn);
      if (thinkingPayload) out.push(createEnvelope("thinking", thinkingPayload, info, nextSeq(stateDir)));
      assistantIdx++;
    }
  }
}

/**
 * Decode new gen_metadata rows past state.usageIdxOffset and return one
 * { usage, timing } per NEW assistant turn, paired by ordinal order. Advances
 * state.usageIdxOffset to one past the last decoded row. Never throws; on any
 * .db failure returns an empty list (turns fall back to zero usage) and leaves
 * the offset unchanged so the next hook retries.
 */
function decodeUsageForTurns(
  conversationId: string,
  state: SessionState,
  stateDir: string,
): Array<{ usage: UsageSummary | undefined; timing: TurnTiming | undefined }> {
  if (!conversationId) return [];
  const dbPath = conversationDbPath(conversationId);
  let records: UsageRecord[] | null = null;
  try {
    records = decodeNewUsage(dbPath, state.usageIdxOffset, "ro");
  } catch (err) {
    debugLog(stateDir, "usage_decode_error", {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (records === null) {
    // .db missing/locked (WAL) — leave the offset; turns get zero usage.
    // Expected on the first hook of a brand-new conversation (no .db yet) and
    // on lock contention; subsequent hooks retry.
    return [];
  }
  if (records.length === 0) return [];

  // Advance the offset past the rows we consumed (snapshots already filtered).
  // If the .db shrank (conversation reset) so every idx is below the offset,
  // reset to 0 — mirrors transcriptOffset's resilience.
  const maxIdx = records.reduce((m, r) => (r.idx > m ? r.idx : m), -1);
  if (maxIdx < state.usageIdxOffset) {
    debugLog(stateDir, "usage_db_shrunk", { oldOffset: state.usageIdxOffset, maxIdx });
    state.usageIdxOffset = 0;
  } else {
    state.usageIdxOffset = maxIdx + 1;
  }

  const out: Array<{ usage: UsageSummary | undefined; timing: TurnTiming | undefined }> = [];
  for (const rec of records) {
    if (rec.decode_error) {
      debugLog(stateDir, "usage_row_decode_error", { idx: rec.idx, error: rec.decode_error });
      out.push({ usage: undefined, timing: undefined });
      continue;
    }
    // input=f5 (prompt prefix), output=f10 (candidates); cache stays 0 (agy
    // doesn't split cached vs uncached). total_tokens = input + output.
    const { cost_total, unknown_model } = computeCost(
      { input: rec.input, output: rec.output, cache_read: 0, cache_write: 0 },
      rec.model_label || state.model,
    );
    if (unknown_model && rec.model_label) {
      debugLog(stateDir, "usage_unknown_model_cost_zero", { model_label: rec.model_label });
    }
    out.push({
      usage: {
        input: rec.input,
        output: rec.output,
        cache_read: 0,
        cache_write: 0,
        total_tokens: rec.input + rec.output,
        cost_total,
      },
      timing: undefined, // latency_ms derivable from transcript ts later; omitted for now
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

function handlePreToolUse(
  hook: Record<string, any>,
  config: Config,
  state: SessionState,
  stateDir: string,
): ObsEventEnvelope<any>[] {
  const out: ObsEventEnvelope<any>[] = [];
  const info = sessionInfoFrom(hook, config, state.model);
  ensureBoot(state, info, stateDir, out);

  // agy fires PreToolUse for non-tool steps too, with toolCall: null. Skip
  // those — only real tool invocations carry a toolCall.name.
  const toolCall = hook.toolCall && typeof hook.toolCall === "object" ? hook.toolCall : null;
  const toolName: string = toolCall?.name ?? "";
  if (!toolName) return out;
  const rawArgs: Record<string, any> = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const { args, truncated } = truncateArgs(rawArgs);

  const payload: ToolCallPayload = {
    tool_call_id: deriveToolCallId(toolName, rawArgs),
    tool_name: toolName,
    args,
    args_truncated: truncated,
  };
  out.push(createEnvelope("tool_call", payload, info, nextSeq(stateDir)));
  return out;
}

function handlePostToolUse(
  hook: Record<string, any>,
  config: Config,
  state: SessionState,
  stateDir: string,
): ObsEventEnvelope<any>[] {
  const out: ObsEventEnvelope<any>[] = [];
  const info = sessionInfoFrom(hook, config, state.model);
  ensureBoot(state, info, stateDir, out);

  // agy fires PostToolUse for non-tool steps too (toolCall: null) — skip those.
  const toolCall = hook.toolCall && typeof hook.toolCall === "object" ? hook.toolCall : null;
  const toolName: string = toolCall?.name ?? "";
  if (!toolName) return out;
  const rawArgs: Record<string, any> = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const errorStr: string = typeof hook.error === "string" ? hook.error : "";

  // The PostToolUse payload carries no tool output text — it lives in the
  // transcript. Best-effort: surface the newest tool-output entry's content.
  let content_text = "";
  try {
    content_text = latestToolOutput(hook.transcriptPath ?? "");
  } catch {
    content_text = "";
  }
  const tr = truncateToBytes(content_text, MAX_RESULT_BYTES);

  const details_summary: Record<string, any> = {};
  if (typeof hook.stepIdx === "number") details_summary.step_idx = hook.stepIdx;

  const payload: ToolResultPayload = {
    tool_call_id: deriveToolCallId(toolName, rawArgs),
    tool_name: toolName,
    content_text: tr.text,
    content_truncated: tr.truncated,
    is_error: errorStr.length > 0,
    details_summary: Object.keys(details_summary).length > 0 ? details_summary : undefined,
  };
  out.push(createEnvelope("tool_result", payload, info, nextSeq(stateDir)));
  return out;
}

function handleInvocation(
  hook: Record<string, any>,
  config: Config,
  state: SessionState,
  stateDir: string,
): ObsEventEnvelope<any>[] {
  const out: ObsEventEnvelope<any>[] = [];
  const info = sessionInfoFrom(hook, config, state.model);
  ensureBoot(state, info, stateDir, out);
  drainTranscript(hook, config, state, stateDir, out);
  return out;
}

function handleStop(
  hook: Record<string, any>,
  config: Config,
  state: SessionState,
  stateDir: string,
): ObsEventEnvelope<any>[] {
  const out: ObsEventEnvelope<any>[] = [];
  const info = sessionInfoFrom(hook, config, state.model);
  ensureBoot(state, info, stateDir, out);
  drainTranscript(hook, config, state, stateDir, out);

  const agentEnd: AgentEndPayload = { message_count: 0 };
  out.push(createEnvelope("agent_end", agentEnd, info, nextSeq(stateDir)));

  // Map agy terminationReason → legal SessionShutdownPayload.reason union.
  const shutdown: SessionShutdownPayload = { reason: "quit" };
  out.push(createEnvelope("session_shutdown", shutdown, info, nextSeq(stateDir)));
  return out;
}

function handleCustom(
  eventName: string,
  hook: Record<string, any>,
  config: Config,
  state: SessionState,
  stateDir: string,
): ObsEventEnvelope<any>[] {
  const out: ObsEventEnvelope<any>[] = [];
  const info = sessionInfoFrom(hook, config, state.model);
  ensureBoot(state, info, stateDir, out);
  const payload: CustomPayload = { custom_type: eventName, data: hook };
  out.push(createEnvelope("custom", payload, info, nextSeq(stateDir)));
  return out;
}

/** Read the transcript and return the content of the newest tool-output entry. */
function latestToolOutput(transcriptPath: string): string {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
  const raw = fs.readFileSync(transcriptPath, "utf8");
  let best = "";
  let bestStep = -1;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (e && e.source === "MODEL" && e.type !== "PLANNER_RESPONSE" && typeof e.content === "string" && e.content) {
      const step = typeof e.step_index === "number" ? e.step_index : 0;
      if (step >= bestStep) {
        bestStep = step;
        best = e.content;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // agy passes the hook event name as argv[2]: `bun obs-hook.ts <EventName>`.
  const eventName = (process.argv[2] ?? "").trim();

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

  let hook: Record<string, any>;
  try {
    hook = JSON.parse(stdinRaw);
  } catch {
    process.exit(0);
  }

  const workspacePaths: string[] = Array.isArray(hook.workspacePaths) ? hook.workspacePaths : [];
  const cwd: string = workspacePaths[0] ?? process.cwd();
  try {
    loadEnv(cwd);
  } catch {
    // Non-fatal
  }

  const config = resolveConfig();
  // This hook is installed globally (~/.gemini/config/hooks.json), so it runs
  // on EVERY agy session. Stay inert unless explicitly activated: require an
  // OBS_AUTH_TOKEN. Without it we exit immediately — no POST, no disk writes —
  // so normal agy usage is not taxed (and never hits a 401 retry loop).
  if (config.disabled || !config.token) process.exit(0);

  const sessionId: string = hook.conversationId ?? "unknown";
  const stateDir = getStateDir(sessionId);
  const state = loadState(stateDir);

  try {
    if (!state.firstRunLogged) {
      debugLog(stateDir, "first_hook_payload", { eventName, payload: hook });
      state.firstRunLogged = true;
    }
  } catch {
    // Non-fatal
  }

  let envelopes: ObsEventEnvelope<any>[] = [];
  try {
    switch (eventName) {
      case "PreToolUse":
        envelopes = handlePreToolUse(hook, config, state, stateDir);
        break;
      case "PostToolUse":
        envelopes = handlePostToolUse(hook, config, state, stateDir);
        break;
      case "PreInvocation":
      case "PostInvocation":
        envelopes = handleInvocation(hook, config, state, stateDir);
        break;
      case "Stop":
        envelopes = handleStop(hook, config, state, stateDir);
        break;
      default:
        envelopes = handleCustom(eventName || "unknown", hook, config, state, stateDir);
        break;
    }
  } catch (err) {
    debugLog(stateDir, "dispatch_error", {
      eventName,
      error: err instanceof Error ? err.message : String(err),
    });
    saveState(stateDir, state);
    process.exit(0);
  }

  // Persist state (offset, bootEmitted, model) before POSTing.
  saveState(stateDir, state);

  try {
    await postEvents(envelopes, config.serverUrl, config.token, stateDir);
  } catch (err) {
    debugLog(stateDir, "post_error", { error: err instanceof Error ? err.message : String(err) });
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
