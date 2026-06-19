/**
 * Per-session persistent state for the Antigravity (agy) observability bridge.
 *
 * Like Claude Code, agy fires a fresh OS process per lifecycle hook, so any
 * state that must survive across hooks (the monotonic `seq`, the transcript
 * read offset, whether we've already emitted a synthetic session_start) is
 * persisted to disk between invocations.
 *
 * agy differs from Claude Code in two ways that matter here:
 *   - There is NO SessionStart hook. We synthesize `session_start` lazily on
 *     the first hook we observe for a conversation (tracked by `bootEmitted`).
 *   - The hook stdin carries `conversationId` (our session_id) and a
 *     `transcriptPath` pointing at a clean JSONL transcript we tail for the
 *     conversational content (prompts, thinking, assistant text).
 *
 * State layout on disk:
 *   ${stateDir}/state.json   — { transcriptOffset, bootEmitted, model, firstRunLogged }
 *   ${stateDir}/seq          — binary append counter: fileSize = nextSeq value
 *
 * Seq strategy is identical to the Claude Code bridge: each allocation appends
 * exactly one byte with O_APPEND, so the pre-write file size is a unique,
 * monotonic integer even across concurrent hook processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionState {
  /** Byte offset into transcript_full.jsonl; tail from here on the next hook. */
  transcriptOffset: number;
  /** True once we've emitted the synthetic session_start for this conversation. */
  bootEmitted: boolean;
  /** Most recently observed human model label (e.g. "Gemini 3.5 Flash (High)"). */
  model: string;
  /** True once we've logged the first-run debug payload for this session. */
  firstRunLogged: boolean;
}

const DEFAULT_STATE: SessionState = {
  transcriptOffset: 0,
  bootEmitted: false,
  model: "",
  firstRunLogged: false,
};

// ---------------------------------------------------------------------------
// State dir resolution
// ---------------------------------------------------------------------------

/**
 * Return the state directory for a conversation. Creates it if missing.
 * Path: ${TMPDIR or /tmp}/pi-obs-agy/<conversationId>/
 */
export function getStateDir(sessionId: string): string {
  const base = process.env.TMPDIR || "/tmp";
  const dir = path.join(base, "pi-obs-agy", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Debug log
// ---------------------------------------------------------------------------

/** Append a line to the debug log for this session (never throws). */
export function debugLog(stateDir: string, message: string, data?: unknown): void {
  try {
    const line =
      new Date().toISOString() +
      " " +
      message +
      (data !== undefined ? " " + JSON.stringify(data) : "") +
      "\n";
    fs.appendFileSync(path.join(stateDir, "debug.log"), line, "utf8");
  } catch {
    // Never throw — debug logging must not break the hook
  }
}

// ---------------------------------------------------------------------------
// JSON state
// ---------------------------------------------------------------------------

function stateFilePath(stateDir: string): string {
  return path.join(stateDir, "state.json");
}

export function loadState(stateDir: string): SessionState {
  try {
    const raw = fs.readFileSync(stateFilePath(stateDir), "utf8");
    const parsed = JSON.parse(raw);
    return {
      transcriptOffset: typeof parsed.transcriptOffset === "number" ? parsed.transcriptOffset : 0,
      bootEmitted: parsed.bootEmitted === true,
      model: typeof parsed.model === "string" ? parsed.model : "",
      firstRunLogged: parsed.firstRunLogged === true,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(stateDir: string, state: SessionState): void {
  try {
    fs.writeFileSync(stateFilePath(stateDir), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Non-fatal: the seq counter is more critical than state.json
  }
}

// ---------------------------------------------------------------------------
// Monotonic seq (append-byte atomic counter)
// ---------------------------------------------------------------------------

function seqFilePath(stateDir: string): string {
  return path.join(stateDir, "seq");
}

/**
 * Allocate the next sequence number for this session.
 *
 * Each call appends exactly 1 byte to the seq file with O_APPEND, so the
 * pre-write file size is a unique, monotonic integer even under concurrent
 * hook processes (e.g. PreInvocation and PreToolUse racing). seq 0 is the
 * synthetic session_start.
 */
export function nextSeq(stateDir: string): number {
  const seqPath = seqFilePath(stateDir);
  try {
    let currentSize = 0;
    try {
      currentSize = fs.statSync(seqPath).size;
    } catch {
      currentSize = 0;
    }
    const fd = fs.openSync(seqPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
    try {
      fs.writeSync(fd, Buffer.alloc(1, 0));
    } finally {
      fs.closeSync(fd);
    }
    return currentSize;
  } catch {
    // Fallback: a value unlikely to collide; the server's INSERT OR IGNORE
    // on UNIQUE(session_id, seq) handles any true collision.
    return Date.now() % 1_000_000;
  }
}
