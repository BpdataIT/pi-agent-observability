/**
 * Per-session persistent state for the Factory Droid observability bridge.
 *
 * Each hook invocation is a separate OS process, so state that Pi's extension
 * keeps in-memory (seqCounter, transcript offset, open tool ids, cumulative
 * usage snapshot) must be persisted to disk between invocations.
 *
 * State layout on disk:
 *   ${stateDir}/state.json   — JSON: { transcriptOffset, openToolIds, firstRunLogged, lastCumulativeUsage }
 *   ${stateDir}/seq          — binary append counter: fileSize = nextSeq value
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageSummary } from "../../shared/types.ts";

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
  /** Last cumulative usage snapshot from the sidecar (for delta on Stop). */
  lastCumulativeUsage: UsageSummary | null;
}

const DEFAULT_STATE: SessionState = {
  transcriptOffset: 0,
  openToolIds: {},
  firstRunLogged: false,
  lastCumulativeUsage: null,
};

/**
 * Return the state directory for a session. Creates it if it doesn't exist.
 * Path: ${TMPDIR or /tmp}/pi-obs-droid/<sessionId>/
 */
export function getStateDir(sessionId: string): string {
  const base = process.env.TMPDIR || "/tmp";
  const dir = path.join(base, "pi-obs-droid", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

function stateFilePath(stateDir: string): string {
  return path.join(stateDir, "state.json");
}

function parseUsageSummary(raw: unknown): UsageSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return {
    input: typeof u.input === "number" ? u.input : 0,
    output: typeof u.output === "number" ? u.output : 0,
    cache_read: typeof u.cache_read === "number" ? u.cache_read : 0,
    cache_write: typeof u.cache_write === "number" ? u.cache_write : 0,
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : 0,
    cost_total: typeof u.cost_total === "number" ? u.cost_total : 0,
  };
}

export function loadState(stateDir: string): SessionState {
  try {
    const raw = fs.readFileSync(stateFilePath(stateDir), "utf8");
    const parsed = JSON.parse(raw);
    return {
      transcriptOffset: typeof parsed.transcriptOffset === "number" ? parsed.transcriptOffset : 0,
      openToolIds: parsed.openToolIds && typeof parsed.openToolIds === "object" ? parsed.openToolIds : {},
      firstRunLogged: parsed.firstRunLogged === true,
      lastCumulativeUsage: parseUsageSummary(parsed.lastCumulativeUsage),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(stateDir: string, state: SessionState): void {
  try {
    fs.writeFileSync(stateFilePath(stateDir), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Non-fatal
  }
}

function seqFilePath(stateDir: string): string {
  return path.join(stateDir, "seq");
}

/**
 * Allocate the next sequence number for this session.
 * Returns: the seq value (0-based file size before the write).
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
    return Date.now() % 1_000_000;
  }
}

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

export function wipeSession(sessionId: string): string {
  const base = process.env.TMPDIR || "/tmp";
  const dir = path.join(base, "pi-obs-droid", sessionId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Non-fatal
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
