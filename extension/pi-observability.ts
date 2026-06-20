import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  truncateToBytes,
  MAX_TEXT_FIELD,
  MAX_ARGS_BYTES,
  MAX_RESULT_BYTES,
  type ObsEventEnvelope,
  type SessionStartPayload,
  type SessionShutdownPayload,
  type AgentStartPayload,
  type AgentEndPayload,
  type TurnStartPayload,
  type TurnEndPayload,
  type UserMessagePayload,
  type AssistantMessagePayload,
  type ToolCallPayload,
  type ToolResultPayload,
  type ModelChangePayload,
  type ThinkingPayload,
  type UsageSummary,
  type CompactionPayload,
  type BranchNavPayload,
  type SystemPromptOptionsDigest,
  type PromptText,
  type ContextFileDigest,
  type SkillDigest,
} from "../shared/types.ts";

// ━━ Module-scope state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let seqCounter = 0;

// ━━ Helper functions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadEnv(cwd: string) {
  const envPaths = [
    path.join(cwd, ".env"),
    path.join(cwd, ".env.local"),
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
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          // Don't overwrite vars already set by the shell (avoid stale-.env footgun)
          if (process.env[key] === undefined) process.env[key] = val;
        }
      } catch {
        // ignore errors reading env files
      }
    }
  }
}

// Lightweight reachability check against the obs server's unauthenticated
// /health endpoint. Short timeout so a dead server never stalls agent boot.
async function probeServer(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function truncateArgs(args: Record<string, any>): { args: Record<string, any>; truncated: boolean } {
  let truncated = false;
  let copy: Record<string, any>;
  try {
    copy = JSON.parse(JSON.stringify(args));
  } catch {
    return { args, truncated: false };
  }

  function walk(obj: any) {
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

function extractUserMessage(content: any): { text: string; images_count: number } {
  if (typeof content === "string") {
    return { text: content, images_count: 0 };
  }
  let text = "";
  let images_count = 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === "text") {
        text += (block.text || "") + "\n";
      } else if (block && block.type === "image") {
        images_count++;
      }
    }
  }
  return { text: text.trim(), images_count };
}

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Boot-snapshot fields (system prompt, skills, context files, custom/append
// prompts) are captured verbatim with no truncation — this event fires once
// per session and the user explicitly wants full fidelity for audit. Bytes
// + sha256 are still recorded so the receiver can detect drift / verify
// integrity. `truncated: false` is preserved for schema stability.
function digestPromptText(s: string | undefined): PromptText | undefined {
  if (!s) return undefined;
  return {
    text: s,
    bytes: Buffer.byteLength(s, "utf8"),
    sha256: sha256hex(s),
    truncated: false,
  };
}

function digestContextFile(f: { path: string; content: string }): ContextFileDigest {
  const content = f.content ?? "";
  return {
    path: f.path,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256hex(content),
    content,
    truncated: false,
  };
}

// Skills hand us a file path; pi already read it to format the prompt, so
// reading it ourselves to capture the exact text it loaded is faithful, not
// inventive. Defensive try/catch — the file could be removed between pi's
// disclosure and our read.
function digestSkill(skill: any): SkillDigest {
  const filePath: string = skill?.filePath ?? "";
  const source = skill?.sourceInfo ?? {};
  let content = "";
  let read_error: string | undefined;
  try {
    if (filePath) content = fs.readFileSync(filePath, "utf8");
  } catch (err: any) {
    read_error = err?.message ? String(err.message) : "read failed";
  }
  return {
    name: String(skill?.name ?? ""),
    description: String(skill?.description ?? ""),
    file_path: filePath,
    base_dir: String(skill?.baseDir ?? ""),
    source_scope: source?.scope ? String(source.scope) : undefined,
    source_origin: source?.origin ? String(source.origin) : undefined,
    source: source?.source ? String(source.source) : undefined,
    source_path: source?.path ? String(source.path) : undefined,
    disable_model_invocation: skill?.disableModelInvocation === true,
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: content ? sha256hex(content) : "",
    truncated: false,
    read_error,
  };
}

function buildSystemPromptOptionsDigest(opts: any): SystemPromptOptionsDigest | undefined {
  if (!opts || typeof opts !== "object") return undefined;
  const digest: SystemPromptOptionsDigest = {};
  if (typeof opts.cwd === "string") digest.cwd = opts.cwd;
  if (Array.isArray(opts.selectedTools)) digest.selected_tools = opts.selectedTools.map(String);
  if (opts.toolSnippets && typeof opts.toolSnippets === "object") {
    const snippets: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.toolSnippets)) snippets[k] = String(v ?? "");
    digest.tool_snippets = snippets;
  }
  if (Array.isArray(opts.promptGuidelines)) digest.prompt_guidelines = opts.promptGuidelines.map(String);
  const cp = digestPromptText(opts.customPrompt);
  if (cp) digest.custom_prompt = cp;
  const ap = digestPromptText(opts.appendSystemPrompt);
  if (ap) digest.append_system_prompt = ap;
  if (Array.isArray(opts.contextFiles)) {
    digest.context_files = opts.contextFiles
      .filter((f: any) => f && typeof f.path === "string")
      .map(digestContextFile);
  }
  if (Array.isArray(opts.skills)) {
    digest.skills = opts.skills.map(digestSkill);
  }
  return digest;
}

function createEventEnvelope<T>(
  type: string,
  payload: T,
  sessionInfo: {
    sessionId: string;
    sessionFile?: string;
    cwd: string;
    agentName?: string;
    pool: string;
    tags: string[];
    provider?: string;
    model?: string;
  }
): ObsEventEnvelope<T> {
  const seq = seqCounter++;
  return {
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type: type as any,
    session_id: sessionInfo.sessionId,
    session_file: sessionInfo.sessionFile,
    cwd: sessionInfo.cwd,
    agent_name: sessionInfo.agentName,
    pool: sessionInfo.pool,
    tags: sessionInfo.tags,
    provider: sessionInfo.provider,
    model: sessionInfo.model,
    payload,
    seq,
  };
}

// ━━ Event Queue Manager ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class EventQueue {
  private queue: any[] = [];
  private maxQueueSize = 10000;
  private flushTimer: NodeJS.Timeout | null = null;
  private backoffMs = 250;
  private maxBackoffMs = 5000;
  private isFlushing = false;
  private consecutiveFailures = 0;
  private droppedEventsCount = 0;
  private getNextSeq: () => number;

  constructor(
    private serverUrl: string,
    private token: string,
    private pi: ExtensionAPI,
    private onPostFailed: (err: any) => void,
    getNextSeq: () => number
  ) {
    this.getNextSeq = getNextSeq;
  }

  public push(event: any) {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift(); // Drop oldest
      this.droppedEventsCount++;
      if (this.droppedEventsCount === 1) {
        const overflowError = this.createOverflowErrorEvent(event.session_id, event.cwd, event.pool, event.tags);
        this.queue.push(overflowError);
      }
    }
    this.queue.push(event);

    if (this.queue.length >= 50) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private createOverflowErrorEvent(sessionId: string, cwd: string, pool: string, tags: string[]): any {
    return {
      event_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type: "error",
      session_id: sessionId,
      cwd: cwd,
      pool: pool,
      tags: tags,
      payload: {
        message: "Extension event queue overflowed. Oldest events dropped.",
        where: "extension-queue",
      },
      // Allocate a real monotonic seq instead of -1 (which would collide on the
      // server's (session_id, seq) UNIQUE index if overflow recurs).
      seq: this.getNextSeq(),
    };
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.backoffMs);
  }

  public async flush() {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;

    const batch = this.queue.slice(0, 50);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.token) {
        headers["Authorization"] = `Bearer ${this.token}`;
      }

      const response = await fetch(`${this.serverUrl}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      // Success! Remove sent items from the queue
      this.queue.splice(0, batch.length);
      this.consecutiveFailures = 0;
      this.backoffMs = 250;
      this.droppedEventsCount = 0;
    } catch (err) {
      this.consecutiveFailures++;
      this.onPostFailed(err);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  public async stop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length > 0) {
      await this.flush();
    }
  }
}

// ━━ Default Export (Extension Entry) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
  // ━━ CLI flag registrations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.registerFlag("obs-server-url", {
    description: "Pi observability server URL (overrides env OBS_SERVER_URL)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("obs-token", {
    description: "Bearer token for authenticating with the observability server",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("o-pool", {
    description: "Logical pool name (overrides env OBS_POOL)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("o-tag", {
    description: "Observation tags (comma-separated or repeated)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("o-name", {
    description: "Friendly name for the agent (overrides env OBS_NAME)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("obs-disable", {
    description: "Disable pi observability extension entirely (overrides env OBS_DISABLE)",
    type: "boolean",
    default: false,
  });

  const isDisabled = pi.getFlag("obs-disable") === true || process.env.OBS_DISABLE === "true";
  if (isDisabled) {
    return;
  }

  let queue: EventQueue | null = null;
  let sessionInfo: {
    sessionId: string;
    sessionFile?: string;
    cwd: string;
    agentName?: string;
    pool: string;
    tags: string[];
    provider?: string;
    model?: string;
  } | null = null;

  let activeTurnIndex = 0;
  // Rich boot snapshot (system prompt + skills + context files) is emitted
  // only on the FIRST before_agent_start of each session. Later turns get the
  // original thin payload so we don't reflow ~1k+ lines of JSON every turn.
  let bootSnapshotEmitted = false;
  const turnStartTimes = new Map<number, number>();
  // turnIndex → ts of first text/thinking delta (per-turn TTFT marker).
  // Cleared alongside turnStartTimes at message_end.
  const firstTokenTimes = new Map<number, number>();

  function logObs(message: string, extra?: any) {
    try {
      pi.appendEntry("obs-log", { message, timestamp: new Date().toISOString(), ...extra });
    } catch {
      // ignore
    }
  }

  // ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_start", async (event, ctx) => {
    // 1. Load env files from CWD
    loadEnv(ctx.cwd);

    // 2. Resolve parameters
    const serverUrl = (pi.getFlag("obs-server-url") as string) || process.env.OBS_SERVER_URL || "http://127.0.0.1:43190";
    const token = (pi.getFlag("obs-token") as string) || process.env.OBS_AUTH_TOKEN || "";
    const pool = (pi.getFlag("o-pool") as string) || process.env.OBS_POOL || "default";
    const name = (pi.getFlag("o-name") as string) || process.env.OBS_NAME || undefined;

    // Parse tags
    const rawTag = pi.getFlag("o-tag");
    let tags: string[] = [];
    if (rawTag) {
      if (Array.isArray(rawTag)) {
        tags = rawTag.map(t => String(t).trim()).filter(Boolean);
      } else if (typeof rawTag === "string") {
        tags = rawTag.split(",").map(t => t.trim()).filter(Boolean);
      }
    } else if (process.env.OBS_TAG) {
      tags = process.env.OBS_TAG.split(",").map(t => t.trim()).filter(Boolean);
    }

    // 3. Reset seq counter + boot-snapshot gate
    seqCounter = 0;
    bootSnapshotEmitted = false;

    // 4. Initialize Queue Manager
    queue = new EventQueue(
      serverUrl,
      token,
      pi,
      (err) => {
        logObs("post_failed", { error: err?.message || String(err) });
      },
      () => seqCounter++
    );

    if (!token) {
      // Loud, single-line warning. Server will 401 every POST otherwise.
      try {
        ctx.ui?.notify?.(
          `📡 pi-observability: no auth token — set OBS_AUTH_TOKEN env or --obs-token to match the server.`,
          "warning",
        );
      } catch { /* hasUI may be false */ }
      logObs("no_token_configured", { server_url: serverUrl });
    }

    // 4b. Simple connectivity check — tell the operator whether the obs server
    // is reachable. Fire-and-forget with a short timeout so boot never blocks.
    void (async () => {
      const connected = await probeServer(serverUrl);
      try {
        if (connected) {
          ctx.ui?.notify?.(`📡 pi-observability: connected to ${serverUrl}`, "info");
        } else {
          ctx.ui?.notify?.(
            `📡 pi-observability: NOT connected to ${serverUrl}. If that's intentional, ignore this — otherwise start the server with \`just obs\`.`,
            "warning",
          );
        }
      } catch { /* hasUI may be false */ }
      logObs(connected ? "server_connected" : "server_unreachable", { server_url: serverUrl });
    })();

    // 5. Initialize session info
    sessionInfo = {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      agentName: name,
      pool,
      tags,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
    };

    // 6. Log boot
    logObs("obs boot", { serverUrl, pool, tags, agentName: name });

    // 7. Emit session_start event
    const startPayload: SessionStartPayload = {
      reason: event.reason,
      pi_version: (pi as any).version || undefined,
      previous_session_file: event.previousSessionFile,
    };
    queue.push(createEventEnvelope("session_start", startPayload, sessionInfo));
  });

  // ━━ before_agent_start (agent_start) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Full per-turn snapshot of what pi assembled: rendered system prompt
  // (truncated + hashed) plus the structured BuildSystemPromptOptions digest
  // — selected tools, prompt guidelines, custom/appended overrides, context
  // files, and skills (including their file contents). This is the canonical
  // audit record for "what was the agent told before this turn".
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const payload: AgentStartPayload = {
      prompt: event.prompt ?? "",
      images_count: event.images ? event.images.length : 0,
      session_id: sessionInfo.sessionId,
      session_file: sessionInfo.sessionFile,
    };
    if (!bootSnapshotEmitted) {
      const sys = event.systemPrompt ?? "";
      if (sys) {
        payload.system_prompt = sys;
        payload.system_prompt_bytes = Buffer.byteLength(sys, "utf8");
        payload.system_prompt_sha256 = sha256hex(sys);
        payload.system_prompt_truncated = false;
      }
      payload.system_prompt_options = buildSystemPromptOptionsDigest(event.systemPromptOptions);
      bootSnapshotEmitted = true;
    }
    queue.push(createEventEnvelope("agent_start", payload, sessionInfo));
  });

  // ━━ agent_end ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("agent_end", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const payload: AgentEndPayload = {
      message_count: event.messages ? event.messages.length : 0,
    };
    queue.push(createEventEnvelope("agent_end", payload, sessionInfo));
  });

  // ━━ turn_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("turn_start", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    activeTurnIndex = event.turnIndex;
    turnStartTimes.set(event.turnIndex, Date.now());
    const payload: TurnStartPayload = {
      turn_index: event.turnIndex,
    };
    queue.push(createEventEnvelope("turn_start", payload, sessionInfo));
  });

  // ━━ turn_end ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("turn_end", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    let usage: UsageSummary | undefined = undefined;
    if (event.message?.usage) {
      const u = event.message.usage;
      usage = {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cache_read: u.cacheRead ?? 0,
        cache_write: u.cacheWrite ?? 0,
        total_tokens: u.totalTokens ?? 0,
        cost_total: u.cost?.total ?? 0,
      };
    }
    const payload: TurnEndPayload = {
      turn_index: event.turnIndex,
      usage,
    };
    queue.push(createEventEnvelope("turn_end", payload, sessionInfo));
  });

  // ━━ message_start (user_message) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("message_start", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    if (event.message?.role !== "user") return;

    const { text, images_count } = extractUserMessage(event.message.content);
    const payload: UserMessagePayload = {
      text: truncateToBytes(text, MAX_TEXT_FIELD).text,
      images_count,
    };
    queue.push(createEventEnvelope("user_message", payload, sessionInfo));
  });

  // First-token timing for TTFT — we watch streaming deltas only to record
  // the first-token timestamp, not to emit per-delta observability events.
  // Either text or thinking counts as "first token on the wire". Using
  // activeTurnIndex (set in turn_start) since event.turnIndex isn't
  // guaranteed on message_update payloads (obv-flash review note).
  pi.on("message_update", async (event: any, _ctx) => {
    if (firstTokenTimes.has(activeTurnIndex)) return;
    const d = event?.assistantMessageEvent;
    if (d?.type === "text_delta" || d?.type === "thinking_delta") {
      firstTokenTimes.set(activeTurnIndex, Date.now());
    }
  });

  // ━━ message_end (assistant_message & thinking) ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("message_end", async (event, ctx) => {
    if (!queue || !sessionInfo) return;
    if (event.message?.role !== "assistant") return;

    let text = "";
    let thinking = "";
    const tool_call_ids: string[] = [];

    if (Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === "text") {
          text += (block.text || "") + "\n";
        } else if (block.type === "thinking") {
          thinking += (block.thinking || block.text || "") + "\n";
        } else if (block.type === "toolCall") {
          if (block.id) {
            tool_call_ids.push(block.id);
          }
        }
      }
    } else if (typeof event.message.content === "string") {
      text = event.message.content;
    }

    text = truncateToBytes(text.trim(), MAX_TEXT_FIELD).text;
    thinking = truncateToBytes(thinking.trim(), MAX_TEXT_FIELD).text;

    let usage: UsageSummary = {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total_tokens: 0,
      cost_total: 0,
    };
    if (event.message.usage) {
      const u = event.message.usage;
      usage = {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cache_read: u.cacheRead ?? 0,
        cache_write: u.cacheWrite ?? 0,
        total_tokens: u.totalTokens ?? 0,
        cost_total: u.cost?.total ?? 0,
      };
    }

    const startTs = turnStartTimes.get(activeTurnIndex);
    const firstTs = firstTokenTimes.get(activeTurnIndex);
    const endTs   = Date.now();
    const latency_ms    = startTs ? endTs - startTs : undefined;
    const prefill_ms    = startTs && firstTs ? firstTs - startTs : undefined;
    const generation_ms = firstTs ? endTs - firstTs : undefined;
    // Floor at 50 ms: below that the streaming window is too small to measure
    // a rate (batched deltas produce e.g. 4 ms → 18000 TPS, pure measurement
    // noise). 50 ms × 2000 TPS ceiling = 100 tokens, which is still well above
    // any realistic single-batch arrival, so the floor only drops noise.
    const output_tps    = generation_ms && generation_ms >= 50 && usage.output > 0
      ? Math.round((usage.output / generation_ms) * 1000)
      : undefined;
    // Memory hygiene (obv-flash v3 nit, bundled here): clean both Maps so they
    // don't accumulate one entry per turn over the life of the session.
    turnStartTimes.delete(activeTurnIndex);
    firstTokenTimes.delete(activeTurnIndex);

    // Context window for the active model, from the same source pi's
    // /context command uses (ctx.getContextUsage()). Falls back to the
    // model registry value if the usage estimate isn't ready yet. Stored
    // on the event so the UI can render the context bar denominator
    // without a hardcoded per-model guess table.
    const contextUsage = ctx.getContextUsage();
    const context_window =
      contextUsage?.contextWindow ?? ctx.model?.contextWindow;

    const payload: AssistantMessagePayload = {
      text,
      thinking,
      tool_call_ids,
      stop_reason: event.message.stopReason || "stop",
      usage,
      error_message: event.message.errorMessage,
      latency_ms,
      prefill_ms,
      generation_ms,
      output_tps,
      turn_index: activeTurnIndex,
      context_window,
    };

    queue.push(createEventEnvelope("assistant_message", payload, sessionInfo));

    if (thinking) {
      const thinkingPayload: ThinkingPayload = {
        text: thinking,
      };
      queue.push(createEventEnvelope("thinking", thinkingPayload, sessionInfo));
    }
  });

  // ━━ tool_call (do NOT block) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("tool_call", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const { args, truncated } = truncateArgs(event.input || {});
    const payload: ToolCallPayload = {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      args,
      args_truncated: truncated,
    };
    queue.push(createEventEnvelope("tool_call", payload, sessionInfo));
  });

  // ━━ tool_result (do NOT modify) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("tool_result", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    let content_text = "";
    if (Array.isArray(event.content)) {
      for (const block of event.content) {
        if (block.type === "text") {
          content_text += (block.text || "") + "\n";
        }
      }
    } else if (typeof event.content === "string") {
      content_text = event.content;
    }

    const tr = truncateToBytes(content_text.trim(), MAX_RESULT_BYTES);

    let details_summary: Record<string, any> | undefined = undefined;
    if (event.details && typeof event.details === "object") {
      details_summary = {};
      if ("exitCode" in event.details) details_summary.exit_code = event.details.exitCode;
      if ("exit_code" in event.details) details_summary.exit_code = event.details.exit_code;
      if ("cancelled" in event.details) details_summary.cancelled = event.details.cancelled;
      if ("truncated" in event.details) details_summary.truncated = event.details.truncated;
    }

    const payload: ToolResultPayload = {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      content_text: tr.text,
      content_truncated: tr.truncated,
      is_error: event.isError === true,
      details_summary,
    };
    queue.push(createEventEnvelope("tool_result", payload, sessionInfo));
  });

  // ━━ model_select ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("model_select", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;

    sessionInfo.provider = event.model.provider;
    sessionInfo.model = event.model.id;

    const payload: ModelChangePayload = {
      provider: event.model.provider,
      model: event.model.id,
      previous_provider: event.previousModel?.provider,
      previous_model: event.previousModel?.id,
      source: event.source ?? "set",
    };
    queue.push(createEventEnvelope("model_change", payload, sessionInfo));
  });

  // ━━ session_compact ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_compact", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const ce = event.compactionEntry;
    const payload: CompactionPayload = {
      reason: event.fromExtension ? "manual" : "auto",
      tokens_before: ce?.tokensBefore ?? 0,
      first_kept_entry_id: ce?.firstKeptEntryId ?? "",
      summary_preview: truncateToBytes(ce?.summary ?? "", 2000).text,
    };
    queue.push(createEventEnvelope("compaction", payload, sessionInfo));
  });

  // ━━ session_tree ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_tree", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;
    const se = event.summaryEntry;
    const payload: BranchNavPayload = {
      from_id: event.oldLeafId ?? "",
      to_id:   event.newLeafId ?? "",
      has_summary: !!se,
      summary_preview: se ? truncateToBytes(se.summary ?? "", 2000).text : undefined,
    };
    queue.push(createEventEnvelope("branch_nav", payload, sessionInfo));
  });

  // ━━ session_shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_shutdown", async (event, _ctx) => {
    if (!queue || !sessionInfo) return;

    const shutdownPayload: SessionShutdownPayload = {
      reason: event.reason,
    };
    queue.push(createEventEnvelope("session_shutdown", shutdownPayload, sessionInfo));

    await queue.stop();
  });
}
