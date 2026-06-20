/**
 * Canonical event shapes shared by the pi observability extension and the
 * Bun observability server.
 *
 * Both sides MUST agree on these. If you change a shape, change it here first
 * and announce it before touching either consumer.
 */

// ─── Event envelope ─────────────────────────────────────────────────────────

export type ObsEventType =
  | "session_start"
  | "session_shutdown"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "model_change"
  | "thinking"
  | "error"
  | "custom"
  | "compaction"
  | "branch_nav";

export interface ObsEventEnvelope<P = unknown> {
  /** uuid v4, client-generated, primary key on the server */
  event_id: string;
  /** ISO-8601 with milliseconds, client clock */
  ts: string;
  /** discriminator for `payload` */
  type: ObsEventType;

  // ── identity ──
  /** pi session uuid (stable for the life of one pi session) */
  session_id: string;
  /** absolute path to session.jsonl, if pi has one */
  session_file?: string;
  /** the agent's working directory at session_start */
  cwd: string;
  /** human-friendly name from --o-name (optional) */
  agent_name?: string;
  /** logical bucket from --o-pool, defaults to "default" */
  pool: string;
  /** flat tag list from --o-tag (may be empty, never undefined) */
  tags: string[];

  // ── model ──
  provider?: string;
  model?: string;

  // ── payload + ordering ──
  payload: P;
  /** monotonic per session_id, starts at 0 */
  seq: number;
}

// ─── Payloads ───────────────────────────────────────────────────────────────

export interface SessionStartPayload {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  pi_version?: string;
  previous_session_file?: string;
}

export interface SessionShutdownPayload {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
}

export interface AgentStartPayload {
  prompt: string;
  images_count: number;
  /** Pi session id this snapshot belongs to. Duplicated from the envelope so a payload-only consumer is self-contained. */
  session_id?: string;
  /** Pi session.jsonl path, when one exists. */
  session_file?: string;
  /** Fully assembled system prompt for this turn. Truncated to MAX_TEXT_FIELD. */
  system_prompt?: string;
  /** Pre-truncation byte length of the system prompt. */
  system_prompt_bytes?: number;
  /** SHA-256 hex digest of the full pre-truncation system prompt. Lets the UI detect drift turn-over-turn without storing the full string. */
  system_prompt_sha256?: string;
  /** Whether system_prompt was truncated to MAX_TEXT_FIELD. */
  system_prompt_truncated?: boolean;
  /** Structured digest of pi's BuildSystemPromptOptions for this turn. */
  system_prompt_options?: SystemPromptOptionsDigest;
}

/** Digest of pi's BuildSystemPromptOptions — what pi loaded into the system prompt for this turn. */
export interface SystemPromptOptionsDigest {
  cwd?: string;
  /** Tool names selected for the prompt (e.g. ["read","bash","edit","write"]). */
  selected_tools?: string[];
  /** Optional one-line tool snippets keyed by tool name. */
  tool_snippets?: Record<string, string>;
  /** Additional guideline bullets appended to the default prompt guidelines. */
  prompt_guidelines?: string[];
  /** Captured when --system-prompt is set. */
  custom_prompt?: PromptText;
  /** Captured when --append-system-prompt is set. */
  append_system_prompt?: PromptText;
  /** Pre-loaded context files (AGENTS.md / CLAUDE.md / etc.). */
  context_files?: ContextFileDigest[];
  /** Pre-loaded skills with file metadata + content digest. */
  skills?: SkillDigest[];
}

/** Captured prompt-text field: truncated text + byte length + sha256 of full pre-truncation content. */
export interface PromptText {
  text: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
}

/** Digest of a single context file pi folded into the system prompt. */
export interface ContextFileDigest {
  path: string;
  bytes: number;
  sha256: string;
  /** File content, truncated to MAX_TEXT_FIELD. */
  content: string;
  truncated: boolean;
}

/** Digest of a single skill loaded for this turn. */
export interface SkillDigest {
  name: string;
  description: string;
  file_path: string;
  base_dir: string;
  /** SourceInfo.scope: "user" | "project" | "temporary". */
  source_scope?: string;
  /** SourceInfo.origin: "package" | "top-level". */
  source_origin?: string;
  /** SourceInfo.source — the package or path the skill came from. */
  source?: string;
  /** SourceInfo.path — full path pi resolved the skill from. */
  source_path?: string;
  disable_model_invocation: boolean;
  /** Skill file body, truncated to MAX_TEXT_FIELD. Empty string when the file could not be read. */
  content: string;
  /** Pre-truncation byte length of the skill file. 0 when unreadable. */
  bytes: number;
  /** SHA-256 hex of the full skill file. Empty string when unreadable. */
  sha256: string;
  truncated: boolean;
  /** Set when fs read failed (file missing, permission, etc.). */
  read_error?: string;
}

export interface AgentEndPayload {
  message_count: number;
}

export interface TurnStartPayload {
  turn_index: number;
}

export interface TurnEndPayload {
  turn_index: number;
  usage?: UsageSummary;
}

export interface UserMessagePayload {
  text: string;
  images_count: number;
}

export interface AssistantMessagePayload {
  text: string;
  thinking: string;
  tool_call_ids: string[];
  stop_reason: "stop" | "length" | "toolUse" | "error" | "aborted" | string;
  usage: UsageSummary;
  error_message?: string;
  /** turn_start → message_end (wall-clock). Includes prefill + generation. */
  latency_ms?: number;
  /** turn_start → first text/thinking delta (TTFT). Missing on non-streaming turns. */
  prefill_ms?: number;
  /** first delta → message_end. Missing on non-streaming turns. */
  generation_ms?: number;
  /** usage.output / (generation_ms / 1000), int-rounded. Missing on non-streaming turns. */
  output_tps?: number;
  turn_index?: number;
  /**
   * Model context window (denominator for the context utilization bar),
   * sourced from pi's ctx.getContextUsage().contextWindow at message_end —
   * the same value pi's /context command reports. Present on events emitted
   * by extension versions that capture it; absent on legacy events (UI falls
   * back to its MODEL_CONTEXT_WINDOWS regex table).
   */
  context_window?: number;
}

export interface ToolCallPayload {
  tool_call_id: string;
  tool_name: string;
  /** parsed args; large blobs may be truncated, see args_truncated */
  args: Record<string, unknown>;
  args_truncated: boolean;
}

export interface ToolResultPayload {
  tool_call_id: string;
  tool_name: string;
  /** concatenated text content from result blocks; may be truncated */
  content_text: string;
  content_truncated: boolean;
  is_error: boolean;
  /** small JSON-safe summary of details (exit_code etc.); never the full blob */
  details_summary?: Record<string, unknown>;
}

export interface ModelChangePayload {
  provider: string;
  model: string;
  previous_provider?: string;
  previous_model?: string;
  source: "set" | "cycle" | "restore" | string;
}

export interface ThinkingPayload {
  text: string;
}

export interface ErrorPayload {
  message: string;
  where: string;
}

export interface CustomPayload {
  custom_type: string;
  data: unknown;
}

export interface CompactionPayload {
  reason: "manual" | "auto";
  tokens_before: number;
  first_kept_entry_id: string;
  summary_preview: string;
}

export interface BranchNavPayload {
  from_id: string;
  to_id: string;
  has_summary: boolean;
  summary_preview?: string;
}

export interface UsageSummary {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost_total: number;
}

// ─── Discriminated union ────────────────────────────────────────────────────

export type ObsEvent =
  | ObsEventEnvelope<SessionStartPayload>     & { type: "session_start" }
  | ObsEventEnvelope<SessionShutdownPayload>  & { type: "session_shutdown" }
  | ObsEventEnvelope<AgentStartPayload>       & { type: "agent_start" }
  | ObsEventEnvelope<AgentEndPayload>         & { type: "agent_end" }
  | ObsEventEnvelope<TurnStartPayload>        & { type: "turn_start" }
  | ObsEventEnvelope<TurnEndPayload>          & { type: "turn_end" }
  | ObsEventEnvelope<UserMessagePayload>      & { type: "user_message" }
  | ObsEventEnvelope<AssistantMessagePayload> & { type: "assistant_message" }
  | ObsEventEnvelope<ToolCallPayload>         & { type: "tool_call" }
  | ObsEventEnvelope<ToolResultPayload>       & { type: "tool_result" }
  | ObsEventEnvelope<ModelChangePayload>      & { type: "model_change" }
  | ObsEventEnvelope<ThinkingPayload>         & { type: "thinking" }
  | ObsEventEnvelope<ErrorPayload>            & { type: "error" }
  | ObsEventEnvelope<CustomPayload>           & { type: "custom" }
  | ObsEventEnvelope<CompactionPayload>       & { type: "compaction" }
  | ObsEventEnvelope<BranchNavPayload>        & { type: "branch_nav" };

// ─── HTTP responses ─────────────────────────────────────────────────────────

export interface IngestResponse {
  ingested: number;
  /** event_ids that were rejected (duplicate or invalid). Empty on full success. */
  rejected: string[];
}

export interface SessionSummary {
  session_id: string;
  pool: string;
  agent_name?: string;
  cwd?: string;
  session_file?: string;
  provider?: string;
  model?: string;
  first_ts: string;
  last_ts: string;
  event_count: number;
  tags: string[];
}

export interface SessionsListResponse {
  sessions: SessionSummary[];
}

export interface HealthResponse {
  ok: true;
  version: string;
  uptime_s: number;
  events_total: number;
  sessions_total: number;
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Strings longer than this are truncated by the extension before sending. */
export const MAX_TEXT_FIELD = 32_000;
/** Args JSON longer than this is truncated. */
export const MAX_ARGS_BYTES = 16_000;
/** Tool result text longer than this is truncated. */
export const MAX_RESULT_BYTES = 32_000;
/** Server-side request body limit. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Truncate a string to a max byte budget; appends a marker on truncation. */
export function truncateToBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (!s) return { text: s ?? "", truncated: false };
  const buf = Buffer.byteLength(s, "utf8");
  if (buf <= max) return { text: s, truncated: false };
  // Crude byte-aware truncation: slice characters until under budget, then mark.
  const head = max - 64;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= head) lo = mid;
    else hi = mid - 1;
  }
  return { text: s.slice(0, lo) + `\n…[truncated ${buf - max} bytes]`, truncated: true };
}
