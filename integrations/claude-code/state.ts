/**
 * Per-session persistent state for the Claude Code observability bridge.
 *
 * Each hook invocation is a separate OS process, so state that Pi's extension
 * keeps in-memory (seqCounter, transcript offset, open tool ids) must be
 * persisted to disk between invocations.
 *
 * State layout on disk:
 *   ${stateDir}/state.json   — JSON: { transcriptOffset, openToolIds, bootSnapshotEmitted }
 *   ${stateDir}/seq          — binary append counter: fileSize = nextSeq value
 *
 * Seq strategy (atomic, lock-free):
 *   Each event allocation opens the seq file with O_APPEND and writes exactly
 *   1 byte. The resulting fileSize equals the seq value just allocated.
 *   Specifically: before the write fileSize=N, after the write fileSize=N+1,
 *   so seq = N (pre-increment value). This is atomic on local FS up to
 *   PIPE_BUF and makes collisions essentially impossible.
 *
 * Tradeoff: on a true race (two processes write simultaneously), both get a
 * unique seq because append is atomic. The server's INSERT OR IGNORE on
 * UNIQUE(session_id, seq) is a safety net, not the primary mechanism.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface SessionState {
  /** Byte offset into the transcript JSONL; parse from here on next Stop. */
  transcriptOffset: number;
  /**
   * Map of derived tool_call_id → open-count (PreToolUse without PostToolUse).
   * Used to detect concurrent identical tool calls and add a salt.
   */
  openToolIds: Record<string, number>;
  /** True once we've logged the first-run debug payload for this session. */
  firstRunLogged: boolean;
}

const DEFAULT_STATE: SessionState = {
  transcriptOffset: 0,
  openToolIds: {},
  firstRunLogged: false,
};

// ---------------------------------------------------------------------------
// State dir resolution
// ---------------------------------------------------------------------------

/**
 * Return the state directory for a session. Creates it if it doesn't exist.
 * Path: ${TMPDIR or /tmp}/pi-obs-cc/<sessionId>/
 */
export function getStateDir(sessionId: string): string {
  const base = process.env.TMPDIR || "/tmp";
  const dir = path.join(base, "pi-obs-cc", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Debug log
// ---------------------------------------------------------------------------

/**
 * Append a line to the debug log for this session (never throws).
 */
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
// JSON state (transcriptOffset, openToolIds, firstRunLogged)
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
      openToolIds: parsed.openToolIds && typeof parsed.openToolIds === "object" ? parsed.openToolIds : {},
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
 * Each call appends exactly 1 byte (0x00) to the seq file using the
 * O_APPEND | O_CREAT | O_WRONLY flags. The atomic append means the
 * returned value is unique even across concurrent processes.
 *
 * Returns: the seq value (0-based file size before the write).
 *
 * Seq 0 = session_start. Subsequent events get seq 1, 2, 3, ...
 */
export function nextSeq(stateDir: string): number {
  const seqPath = seqFilePath(stateDir);
  try {
    // Get the current size (= value we're about to allocate)
    let currentSize = 0;
    try {
      currentSize = fs.statSync(seqPath).size;
    } catch {
      // File doesn't exist yet; size = 0
      currentSize = 0;
    }
    // Append one byte atomically
    const fd = fs.openSync(seqPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
    try {
      fs.writeSync(fd, Buffer.alloc(1, 0));
    } finally {
      fs.closeSync(fd);
    }
    return currentSize;
  } catch {
    // If anything goes wrong, fall back to a timestamp-based value that is
    // unlikely to collide (the server's INSERT OR IGNORE handles true collisions)
    return Date.now() % 1_000_000;
  }
}

/**
 * Reset the seq counter for a session (used on SessionStart / clear).
 * Deletes the seq file so the next nextSeq() call returns 0.
 * Also resets the JSON state.
 */
export function resetSession(stateDir: string): void {
  try {
    const seqPath = seqFilePath(stateDir);
    if (fs.existsSync(seqPath)) {
      fs.unlinkSync(seqPath);
    }
  } catch {
    // Non-fatal
  }
  saveState(stateDir, { ...DEFAULT_STATE });
}

/**
 * Wipe the entire session state directory (used on SessionStart with source=clear).
 * Recreates the directory immediately so subsequent operations can proceed.
 */
export function wipeSession(sessionId: string): string {
  const base = process.env.TMPDIR || "/tmp";
  const dir = path.join(base, "pi-obs-cc", sessionId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Non-fatal
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
