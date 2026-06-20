#!/usr/bin/env bun
/**
 * Factory Droid → Pi Observability bridge hook handler.
 *
 * Registered in ~/.factory/hooks.json for every lifecycle hook. Droid fires a
 * fresh process per hook, passing a JSON payload on stdin. This script reads
 * that payload, maps it to ObsEvent envelopes, and POSTs to POST /events.
 *
 * Config env vars:
 *   OBS_SERVER_URL   — default http://127.0.0.1:43190
 *   OBS_AUTH_TOKEN   — bearer token
 *   OBS_POOL         — default "default"
 *   OBS_TAG          — comma-separated tag list
 *   OBS_NAME         — agent name, default "droid"
 *   OBS_DISABLE      — set to "true" to disable entirely
 *   OBS_DEBUG        — set to "1" for sidecar timing diagnostics
 *
 * Always exits 0. All errors are logged to ${stateDir}/debug.log.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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
import {
  sidecarPathFromTranscript,
  readCumulativeUsageWithRetry,
  computeUsageDelta,
  zeroUsage,
} from "./usage-sidecar.ts";
import { computeCost } from "./model-prices.ts";
import { providerForModelKey } from "../../shared/model-metadata.ts";

function loadEnv(cwd: string): void {
  const home = process.env.HOME?.trim() || os.homedir();
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const envPaths = [
    path.join(cwd, ".env"),
    path.join(cwd, ".env.local"),
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(home, ".env"),
    path.join(home, ".env.local"),
  ];
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
          if (process.env[key] === undefined) process.env[key] = val;
        }
      } catch {
        // Ignore
      }
    }
  }
}

interface Config {
  serverUrl: string;
  token: string;
  pool: string;
  tags: string[];
  agentName: string;
  disabled: boolean;
  debug: boolean;
}

function resolveConfig(): Config {
  const serverUrl = process.env.OBS_SERVER_URL?.trim() || "http://127.0.0.1:43190";
  const token = process.env.OBS_AUTH_TOKEN?.trim() || "";
  const pool = process.env.OBS_POOL?.trim() || "default";
  const tagRaw = process.env.OBS_TAG?.trim() || "";
  const tags = tagRaw ? tagRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const agentName = process.env.OBS_NAME?.trim() || "droid";
  const disabled = process.env.OBS_DISABLE === "true" || process.env.OBS_DISABLE === "1";
  const debug = process.env.OBS_DEBUG === "1" || process.env.OBS_DEBUG === "true";
  return { serverUrl, token, pool, tags, agentName, disabled, debug };
}

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

function providerForModel(modelId: string | undefined): string {
  return providerForModelKey(modelId) ?? "factory";
}

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

function deriveToolCallId(toolName: string, toolInput: Record<string, any>): string {
  const stable = stableStringify(toolInput);
  const hash = crypto
    .createHash("sha256")
    .update(toolName + " " + stable, "utf8")
    .digest("hex");
  return "droid-" + hash.slice(0, 16);
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as any)[k])).join(",") + "}";
}

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
  const bodyBytes = Buffer.byteLength(body, "utf8");

  if (bodyBytes > MAX_REQUEST_BYTES && events.length > 1) {
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
    const spoolDir = path.join(stateDir, "..", "spool");
    fs.mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, `${Date.now()}.json`);
    fs.writeFileSync(spoolFile, body, "utf8");
    pruneSpoolDir(spoolDir, 20);
  } catch {
    // Non-fatal
  }
}

function pruneSpoolDir(dir: string, maxFiles: number): void {
  try {
    const files = fs
      .readdirSync(dir)
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

function baseSessionInfo(hookPayload: Record<string, any>, config: Config): SessionInfo {
  return {
    sessionId: hookPayload.session_id,
    sessionFile: hookPayload.transcript_path,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "factory",
  };
}

async function handleSessionStart(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const source: string = hookPayload.source ?? "startup";
  let reason: SessionStartPayload["reason"];
  switch (source) {
    case "startup": reason = "startup"; break;
    case "resume": reason = "resume"; break;
    case "clear": reason = "new"; break;
    case "compact": reason = "startup"; break;
    default: reason = "startup";
  }

  const sessionInfo = baseSessionInfo(hookPayload, config);
  const payload: SessionStartPayload = { reason };
  return [createEnvelope("session_start", payload, sessionInfo, nextSeq(stateDir))];
}

async function handleSessionEnd(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const rawReason: string = hookPayload.reason ?? "";
  let reason: SessionShutdownPayload["reason"];
  switch (rawReason) {
    case "clear": reason = "new"; break;
    case "logout":
    case "prompt_input_exit":
    case "other":
      reason = "quit";
      break;
    default:
      reason = "quit";
  }

  const sessionInfo = baseSessionInfo(hookPayload, config);
  const payload: SessionShutdownPayload = { reason };
  return [createEnvelope("session_shutdown", payload, sessionInfo, nextSeq(stateDir))];
}

async function handleUserPromptSubmit(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const rawPrompt: string = hookPayload.prompt ?? "";
  const text = truncateToBytes(rawPrompt, MAX_TEXT_FIELD).text;
  const sessionInfo = baseSessionInfo(hookPayload, config);
  const envelopes: ObsEventEnvelope<any>[] = [];

  envelopes.push(
    createEnvelope("user_message", { text, images_count: 0 } satisfies UserMessagePayload, sessionInfo, nextSeq(stateDir)),
  );
  envelopes.push(
    createEnvelope(
      "agent_start",
      {
        prompt: text,
        images_count: 0,
        session_id: hookPayload.session_id,
        session_file: hookPayload.transcript_path,
      } satisfies AgentStartPayload,
      sessionInfo,
      nextSeq(stateDir),
    ),
  );
  return envelopes;
}

async function handlePreToolUse(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const toolName: string = hookPayload.tool_name ?? "";
  const toolInput: Record<string, any> =
    hookPayload.tool_input && typeof hookPayload.tool_input === "object" ? hookPayload.tool_input : {};

  const derivedId = deriveToolCallId(toolName, toolInput);
  const state = loadState(stateDir);
  state.openToolIds[derivedId] = (state.openToolIds[derivedId] ?? 0) + 1;
  saveState(stateDir, state);

  const { args, truncated } = truncateArgs(toolInput);
  const sessionInfo = baseSessionInfo(hookPayload, config);

  const payload: ToolCallPayload = {
    tool_call_id: derivedId,
    tool_name: toolName,
    args,
    args_truncated: truncated,
  };

  if (hookPayload.permission_mode) {
    (payload as any).details = { permission_mode: hookPayload.permission_mode };
  }

  return [createEnvelope("tool_call", payload, sessionInfo, nextSeq(stateDir))];
}

async function handlePostToolUse(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const toolName: string = hookPayload.tool_name ?? "";
  const toolInput: Record<string, any> =
    hookPayload.tool_input && typeof hookPayload.tool_input === "object" ? hookPayload.tool_input : {};
  const toolResponse: unknown = hookPayload.tool_response;
  const derivedId = deriveToolCallId(toolName, toolInput);

  const state = loadState(stateDir);
  if (state.openToolIds[derivedId]) {
    state.openToolIds[derivedId]--;
    if (state.openToolIds[derivedId] <= 0) delete state.openToolIds[derivedId];
  }
  saveState(stateDir, state);

  let content_text = "";
  let is_error = false;
  const details_summary: Record<string, any> = {};

  if (typeof toolResponse === "string") {
    content_text = toolResponse;
  } else if (toolResponse && typeof toolResponse === "object") {
    const resp = toolResponse as Record<string, any>;
    is_error = resp.is_error === true || resp.error === true || resp.type === "error";
    if (typeof resp.output === "string") content_text = resp.output;
    else if (typeof resp.content === "string") content_text = resp.content;
    else if (Array.isArray(resp.content)) {
      for (const block of resp.content) {
        if (block && typeof block === "object" && block.type === "text") {
          content_text += (block.text ?? "") + "\n";
        }
      }
      content_text = content_text.trim();
    } else if (typeof resp.result === "string") content_text = resp.result;
    else {
      try {
        content_text = JSON.stringify(toolResponse);
      } catch {
        content_text = String(toolResponse);
      }
    }
    if ("exit_code" in resp || "exitCode" in resp) {
      details_summary.exit_code = resp.exit_code ?? resp.exitCode;
    }
    if ("cancelled" in resp) details_summary.cancelled = resp.cancelled;
    if ("truncated" in resp) details_summary.truncated = resp.truncated;
  } else if (toolResponse !== undefined && toolResponse !== null) {
    content_text = String(toolResponse);
  }

  const tr = truncateToBytes(content_text, MAX_RESULT_BYTES);
  const sessionInfo = baseSessionInfo(hookPayload, config);

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

function attributeUsageToTurns(
  turns: ReturnType<typeof parseNewTurns>["turns"],
  delta: UsageSummary,
  stateDir: string,
): void {
  if (turns.length === 0) return;

  if (turns.length === 1) {
    const { cost_total, unknown_model } = computeCost(delta, turns[0].model);
    turns[0].usage = { ...delta, cost_total };
    if (unknown_model && turns[0].model) {
      debugLog(stateDir, "unknown_model_cost_zero", { model: turns[0].model, msgId: turns[0].messageId });
    }
    return;
  }

  for (let i = 0; i < turns.length - 1; i++) {
    turns[i].usage = zeroUsage();
  }

  const last = turns[turns.length - 1];
  const { cost_total, unknown_model } = computeCost(delta, last.model);
  last.usage = { ...delta, cost_total };
  if (unknown_model && last.model) {
    debugLog(stateDir, "unknown_model_cost_zero", { model: last.model, msgId: last.messageId });
  }
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

  const sidecarPath = sidecarPathFromTranscript(transcriptPath);
  const logFn = (msg: string, data?: unknown) => debugLog(stateDir, msg, data);
  const sidecarResult = readCumulativeUsageWithRetry(
    sidecarPath,
    state.lastCumulativeUsage,
    logFn,
  );

  if (config.debug) {
    debugLog(stateDir, "sidecar_timing", {
      sidecarPath,
      sidecarMtimeMs: sidecarResult.sidecarMtimeMs,
      hookTs: new Date().toISOString(),
      cumulative: sidecarResult.usage,
    });
  }

  const delta = computeUsageDelta(sidecarResult.usage, state.lastCumulativeUsage, logFn);
  attributeUsageToTurns(turns, delta, stateDir);

  state.transcriptOffset = newOffset;
  state.lastCumulativeUsage = sidecarResult.usage;
  saveState(stateDir, state);

  const sessionInfo: SessionInfo = {
    sessionId: hookPayload.session_id,
    sessionFile: transcriptPath,
    cwd: hookPayload.cwd ?? "",
    agentName: config.agentName,
    pool: config.pool,
    tags: config.tags,
    provider: "factory",
  };

  const envelopes: ObsEventEnvelope<any>[] = [];

  for (const turn of turns) {
    const turnInfo: SessionInfo = { ...sessionInfo, provider: providerForModel(turn.model), model: turn.model };
    envelopes.push(
      createEnvelope("assistant_message", buildAssistantMessagePayload(turn), turnInfo, nextSeq(stateDir)),
    );
    const thinkingPayload = buildThinkingPayload(turn);
    if (thinkingPayload) {
      envelopes.push(createEnvelope("thinking", thinkingPayload, turnInfo, nextSeq(stateDir)));
    }
  }

  envelopes.push(
    createEnvelope("agent_end", { message_count: turns.length } satisfies AgentEndPayload, sessionInfo, nextSeq(stateDir)),
  );

  return envelopes;
}

async function handlePreCompact(
  hookPayload: Record<string, any>,
  config: Config,
  stateDir: string,
): Promise<ObsEventEnvelope<any>[]> {
  const trigger: string = hookPayload.trigger ?? "auto";
  const reason: CompactionPayload["reason"] = trigger === "manual" ? "manual" : "auto";
  const sessionInfo = baseSessionInfo(hookPayload, config);
  const payload: CompactionPayload = {
    reason,
    tokens_before: 0,
    first_kept_entry_id: "",
    summary_preview: "",
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
    provider: "factory",
  };
  const payload: CustomPayload = {
    custom_type: hookEventName,
    data: hookPayload,
  };
  return [createEnvelope("custom", payload, sessionInfo, nextSeq(stateDir))];
}

async function main(): Promise<void> {
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
    process.exit(0);
  }

  const cwd: string = hookPayload.cwd ?? process.cwd();
  try {
    loadEnv(cwd);
  } catch {
    // Non-fatal
  }

  const config = resolveConfig();
  if (config.disabled) process.exit(0);

  const sessionId: string = hookPayload.session_id ?? "unknown";
  const hookEventName: string = hookPayload.hook_event_name ?? "";

  let stateDir: string;
  if (hookEventName === "SessionStart" && hookPayload.source === "clear") {
    stateDir = wipeSession(sessionId);
  } else {
    stateDir = getStateDir(sessionId);
  }

  if (hookEventName === "SessionStart") {
    resetSession(stateDir);
  }

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
        envelopes = await handleCustom(hookEventName, hookPayload, config, stateDir);
        break;
    }
  } catch (err) {
    debugLog(stateDir, "dispatch_error", {
      hookEventName,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(0);
  }

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
