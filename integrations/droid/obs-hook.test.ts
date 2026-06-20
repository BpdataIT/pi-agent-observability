/**
 * Unit tests for the Factory Droid → Pi Observability bridge.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { parseNewTurns, buildAssistantMessagePayload } from "./transcript.ts";
import { computeCost, getModelPrice } from "./model-prices.ts";
import {
  getStateDir,
  resetSession,
  nextSeq,
  loadState,
  saveState,
  wipeSession,
} from "./state.ts";
import {
  sidecarPathFromTranscript,
  readCumulativeUsage,
  computeUsageDelta,
  zeroUsage,
} from "./usage-sidecar.ts";
import type { UsageSummary } from "../../shared/types.ts";
import { MAX_TEXT_FIELD, MAX_ARGS_BYTES, MAX_RESULT_BYTES, truncateToBytes } from "../../shared/types.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const TRANSCRIPT_FIXTURE = path.join(FIXTURES_DIR, "transcript.sample.jsonl");
const SIDECAR_FIXTURE = path.join(FIXTURES_DIR, "sample.settings.json");

function makeTmpSessionId(): string {
  return "test-" + crypto.randomUUID().slice(0, 8);
}

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as any)[k])).join(",") + "}";
}

function deriveToolCallId(toolName: string, toolInput: Record<string, any>): string {
  const stable = stableStringify(toolInput);
  const hash = crypto.createHash("sha256").update(toolName + " " + stable, "utf8").digest("hex");
  return "droid-" + hash.slice(0, 16);
}

function attributeDeltaToTurns(
  turns: ReturnType<typeof parseNewTurns>["turns"],
  delta: UsageSummary,
): void {
  if (turns.length === 0) return;
  if (turns.length === 1) {
    const { cost_total } = computeCost(delta, turns[0].model);
    turns[0].usage = { ...delta, cost_total };
    return;
  }
  for (let i = 0; i < turns.length - 1; i++) turns[i].usage = zeroUsage();
  const last = turns[turns.length - 1];
  const { cost_total } = computeCost(delta, last.model);
  last.usage = { ...delta, cost_total };
}

describe("transcript parser", () => {
  test("emits exactly 3 assistant turns (one line per message, no dedup)", () => {
    const { turns, newOffset, fileShrunk } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    expect(turns.length).toBe(3);
    expect(fileShrunk).toBe(false);
    expect(newOffset).toBeGreaterThan(0);
  });

  test("turn count equals assistant message lines (no Claude-style grouping)", () => {
    const raw = fs.readFileSync(TRANSCRIPT_FIXTURE, "utf8");
    const assistantLines = raw
      .split("\n")
      .filter((l) => l.includes('"role":"assistant"') || l.includes('"role": "assistant"')).length;
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    expect(turns.length).toBe(assistantLines);
  });

  test("second parse at offset emits nothing", () => {
    const r1 = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    const r2 = parseNewTurns(TRANSCRIPT_FIXTURE, r1.newOffset);
    expect(r2.turns.length).toBe(0);
    expect(r2.newOffset).toBeGreaterThanOrEqual(r1.newOffset);
  });

  test("resets on file shrink", () => {
    const sessionId = makeTmpSessionId();
    const tmp = path.join(os.tmpdir(), `droid-transcript-${sessionId}.jsonl`);
    fs.copyFileSync(TRANSCRIPT_FIXTURE, tmp);
    const fileSize = fs.statSync(tmp).size;
    const result = parseNewTurns(tmp, fileSize + 500);
    expect(result.fileShrunk).toBe(true);
    expect(result.turns.length).toBe(3);
    fs.unlinkSync(tmp);
  });

  test("collects native tool_use ids", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    expect(turns[0].toolUseIds).toEqual(["chatcmpl-tool-abc123"]);
    expect(turns[1].toolUseIds).toEqual([]);
  });

  test("reads modelId per turn", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    expect(turns[0].model).toBe("glm-5.2");
    expect(turns[1].model).toBe("gemini-3.5-flash");
    expect(turns[2].model).toBe("gpt-5.5");
  });

  test("infers stop_reason from content blocks", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    expect(turns[0].stop_reason).toBe("toolUse");
    expect(turns[1].stop_reason).toBe("stop");
    expect(turns[2].stop_reason).toBe("stop");
  });

  test("approximates latency_ms from user message timestamp", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    const payload = buildAssistantMessagePayload(turns[0]);
    expect(payload.latency_ms).toBeGreaterThan(0);
  });

  test("sums generation_ms from thinking durationMs", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    expect(turns[0].generation_ms).toBe(1500);
    const payload = buildAssistantMessagePayload(turns[0]);
    expect(payload.generation_ms).toBe(1500);
  });

  test("ignores todo_state and session_start lines", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    expect(turns.every((t) => t.messageId.startsWith("msg-asst"))).toBe(true);
  });
});

describe("usage sidecar", () => {
  test("derives sidecar path from transcript path", () => {
    expect(sidecarPathFromTranscript("/tmp/sess.jsonl")).toBe("/tmp/sess.settings.json");
  });

  test("maps tokenUsage fields to UsageSummary", () => {
    const result = readCumulativeUsage(SIDECAR_FIXTURE);
    expect(result.usage.input).toBe(1000);
    expect(result.usage.output).toBe(200);
    expect(result.usage.cache_read).toBe(500);
    expect(result.usage.cache_write).toBe(50);
    expect(result.usage.total_tokens).toBe(1760);
    expect(result.usage.cost_total).toBe(0);
    expect(result.factoryCredits).toBe(1567347);
  });

  test("returns zero usage for missing sidecar", () => {
    const result = readCumulativeUsage("/tmp/nonexistent-sidecar.settings.json");
    expect(result.usage).toEqual(zeroUsage());
    expect(result.factoryCredits).toBe(0);
  });

  test("computeUsageDelta subtracts previous snapshot", () => {
    const prev: UsageSummary = {
      input: 100,
      output: 50,
      cache_read: 10,
      cache_write: 5,
      total_tokens: 165,
      cost_total: 0,
    };
    const cumulative: UsageSummary = {
      input: 300,
      output: 150,
      cache_read: 30,
      cache_write: 15,
      total_tokens: 495,
      cost_total: 0,
    };
    const delta = computeUsageDelta(cumulative, prev);
    expect(delta.input).toBe(200);
    expect(delta.output).toBe(100);
    expect(delta.cache_read).toBe(20);
    expect(delta.cache_write).toBe(10);
    expect(delta.total_tokens).toBe(330);
  });

  test("clamps negative deltas to zero", () => {
    const prev: UsageSummary = { input: 500, output: 0, cache_read: 0, cache_write: 0, total_tokens: 500, cost_total: 0 };
    const cumulative: UsageSummary = { input: 100, output: 0, cache_read: 0, cache_write: 0, total_tokens: 100, cost_total: 0 };
    const delta = computeUsageDelta(cumulative, prev);
    expect(delta.input).toBe(0);
  });
});

describe("delta attribution on Stop", () => {
  test("attributes full delta to last turn when multiple turns in one Stop", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    const delta: UsageSummary = {
      input: 200,
      output: 100,
      cache_read: 20,
      cache_write: 10,
      total_tokens: 330,
      cost_total: 0,
    };
    attributeDeltaToTurns(turns, delta);
    expect(turns[0].usage.total_tokens).toBe(0);
    expect(turns[1].usage.total_tokens).toBe(0);
    expect(turns[2].usage.input).toBe(200);
    expect(turns[2].usage.total_tokens).toBe(330);
    expect(turns[2].usage.cost_total).toBeGreaterThan(0);
  });

  test("two cumulative snapshots produce correct delta on second Stop", () => {
    const snap1 = readCumulativeUsage(SIDECAR_FIXTURE).usage;
    const snap2: UsageSummary = {
      input: snap1.input + 500,
      output: snap1.output + 100,
      cache_read: snap1.cache_read + 50,
      cache_write: snap1.cache_write + 25,
      total_tokens: 0,
      cost_total: 0,
    };
    snap2.total_tokens = snap2.input + snap2.output + snap2.cache_read + snap2.cache_write;
    const delta = computeUsageDelta(snap2, snap1);
    expect(delta.input).toBe(500);
    expect(delta.output).toBe(100);
    expect(delta.total_tokens).toBe(675);
  });
});

describe("model-prices", () => {
  test("computeCost returns > 0 for glm-5.2", () => {
    const usage = { input: 10000, output: 500, cache_read: 1000, cache_write: 200 };
    const { cost_total, unknown_model } = computeCost(usage, "glm-5.2");
    expect(cost_total).toBeGreaterThan(0);
    expect(unknown_model).toBe(false);
  });

  test("computeCost returns > 0 for gemini-3.5-flash", () => {
    const usage = { input: 10000, output: 500, cache_read: 1000, cache_write: 200 };
    const { cost_total, unknown_model } = computeCost(usage, "gemini-3.5-flash");
    expect(cost_total).toBeGreaterThan(0);
    expect(unknown_model).toBe(false);
  });

  test("computeCost returns > 0 for gpt-5.5 (prefix match to gpt-5)", () => {
    const usage = { input: 10000, output: 500, cache_read: 1000, cache_write: 200 };
    const { cost_total, unknown_model } = computeCost(usage, "gpt-5.5");
    expect(cost_total).toBeGreaterThan(0);
    expect(unknown_model).toBe(false);
  });

  test("computeCost returns 0 for unknown model", () => {
    const usage = { input: 10000, output: 500, cache_read: 1000, cache_write: 200 };
    const { cost_total, unknown_model } = computeCost(usage, "totally-unknown-model-xyz");
    expect(cost_total).toBe(0);
    expect(unknown_model).toBe(true);
  });

  test("getModelPrice prefix match works", () => {
    const price = getModelPrice("glm-5.2-0215");
    expect(price.unknown).toBe(false);
  });
});

describe("tool_call_id determinism", () => {
  test("same tool_name + tool_input produces same droid- id", () => {
    const input = { file_path: "/Users/tester/project/README.md" };
    expect(deriveToolCallId("Read", input)).toBe(deriveToolCallId("Read", input));
    expect(deriveToolCallId("Read", input).startsWith("droid-")).toBe(true);
  });

  test("key order variation produces the same id", () => {
    const a = { command: "ls", cwd: "/tmp" };
    const b = { cwd: "/tmp", command: "ls" };
    expect(deriveToolCallId("Bash", a)).toBe(deriveToolCallId("Bash", b));
  });
});

describe("seq counter (state.ts)", () => {
  test("seq starts at 0 after resetSession and increments", () => {
    const sessionId = makeTmpSessionId();
    const stateDir = getStateDir(sessionId);
    try {
      resetSession(stateDir);
      expect(nextSeq(stateDir)).toBe(0);
      expect(nextSeq(stateDir)).toBe(1);
      expect(nextSeq(stateDir)).toBe(2);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("resetSession resets seq to 0", () => {
    const sessionId = makeTmpSessionId();
    const stateDir = getStateDir(sessionId);
    try {
      resetSession(stateDir);
      nextSeq(stateDir);
      nextSeq(stateDir);
      resetSession(stateDir);
      expect(nextSeq(stateDir)).toBe(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("wipeSession creates clean stateDir", () => {
    const sessionId = makeTmpSessionId();
    const stateDir1 = getStateDir(sessionId);
    try {
      resetSession(stateDir1);
      nextSeq(stateDir1);
      const stateDir2 = wipeSession(sessionId);
      expect(stateDir2).toBe(stateDir1);
      expect(nextSeq(stateDir2)).toBe(0);
    } finally {
      fs.rmSync(stateDir1, { recursive: true, force: true });
    }
  });
});

describe("state load/save", () => {
  test("loadState returns defaults including null lastCumulativeUsage", () => {
    const sessionId = makeTmpSessionId();
    const stateDir = getStateDir(sessionId);
    try {
      const state = loadState(stateDir);
      expect(state.transcriptOffset).toBe(0);
      expect(state.lastCumulativeUsage).toBeNull();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("round-trips lastCumulativeUsage", () => {
    const sessionId = makeTmpSessionId();
    const stateDir = getStateDir(sessionId);
    try {
      const usage: UsageSummary = {
        input: 42,
        output: 7,
        cache_read: 3,
        cache_write: 1,
        total_tokens: 53,
        cost_total: 0,
      };
      saveState(stateDir, {
        transcriptOffset: 999,
        openToolIds: {},
        firstRunLogged: true,
        lastCumulativeUsage: usage,
      });
      const loaded = loadState(stateDir);
      expect(loaded.transcriptOffset).toBe(999);
      expect(loaded.lastCumulativeUsage?.input).toBe(42);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("hook stdin fixtures", () => {
  const fixtureNames = [
    "session-start.json",
    "user-prompt-submit.json",
    "pre-tool-use.json",
    "post-tool-use.json",
    "stop.json",
    "subagent-stop.json",
    "session-end.json",
    "pre-compact.json",
    "notification.json",
  ];

  for (const name of fixtureNames) {
    test(`${name} has required hook fields`, () => {
      const payload = loadFixture(name);
      expect(typeof payload.hook_event_name).toBe("string");
      expect(typeof payload.session_id).toBe("string");
      expect(typeof payload.transcript_path).toBe("string");
      expect(typeof payload.cwd).toBe("string");
      expect(payload.permission_mode).toBeDefined();
    });
  }

  test("stop fixture transcript_path ends in .jsonl", () => {
    const payload = loadFixture("stop.json");
    expect((payload.transcript_path as string).endsWith(".jsonl")).toBe(true);
  });
});

describe("buildAssistantMessagePayload", () => {
  test("stamps context_window for known models", () => {
    const { turns } = parseNewTurns(TRANSCRIPT_FIXTURE, 0);
    const payload = buildAssistantMessagePayload(turns[0]);
    expect(payload.context_window).toBeGreaterThan(0);
    expect(payload.usage.total_tokens).toBe(0);
  });
});

describe("shared/types.ts limits", () => {
  test("truncation constants match spec", () => {
    expect(MAX_TEXT_FIELD).toBe(32_000);
    expect(MAX_ARGS_BYTES).toBe(16_000);
    expect(MAX_RESULT_BYTES).toBe(32_000);
  });
});
