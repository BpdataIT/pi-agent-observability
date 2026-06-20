/**
 * Factory Droid session usage sidecar reader.
 *
 * Droid stores cumulative token totals in `<session-uuid>.settings.json`
 * alongside the transcript JSONL. The bridge reads cumulative totals on each
 * Stop and computes deltas vs the last snapshot in session state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageSummary } from "../../shared/types.ts";

export interface SidecarReadResult {
  usage: UsageSummary;
  factoryCredits: number;
  sidecarMtimeMs: number | null;
}

const ZERO_USAGE: UsageSummary = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  total_tokens: 0,
  cost_total: 0,
};

/**
 * Derive the sidecar path from a transcript path by replacing `.jsonl` with
 * `.settings.json`.
 */
export function sidecarPathFromTranscript(transcriptPath: string): string {
  if (transcriptPath.endsWith(".jsonl")) {
    return transcriptPath.slice(0, -".jsonl".length) + ".settings.json";
  }
  return transcriptPath + ".settings.json";
}

/**
 * Return a zero UsageSummary (cost_total always 0 — computed separately).
 */
export function zeroUsage(): UsageSummary {
  return { ...ZERO_USAGE };
}

/**
 * Read cumulative token usage from a Droid `.settings.json` sidecar.
 * Never throws; missing/unreadable sidecar → zero usage.
 */
export function readCumulativeUsage(
  sidecarPath: string,
  debugLogFn?: (message: string, data?: unknown) => void,
): SidecarReadResult {
  let sidecarMtimeMs: number | null = null;
  try {
    const stat = fs.statSync(sidecarPath);
    sidecarMtimeMs = stat.mtimeMs;
    const raw = fs.readFileSync(sidecarPath, "utf8");
    const parsed = JSON.parse(raw);
    const tokenUsage = parsed?.tokenUsage;
    if (!tokenUsage || typeof tokenUsage !== "object") {
      debugLogFn?.("sidecar_missing_token_usage", { path: sidecarPath });
      return { usage: zeroUsage(), factoryCredits: 0, sidecarMtimeMs };
    }

    const input = Number(tokenUsage.inputTokens ?? 0);
    const output = Number(tokenUsage.outputTokens ?? 0);
    const cache_read = Number(tokenUsage.cacheReadTokens ?? 0);
    const cache_write = Number(tokenUsage.cacheCreationTokens ?? 0);
    const thinking = Number(tokenUsage.thinkingTokens ?? 0);
    const total_tokens = input + output + cache_read + cache_write + thinking;
    const factoryCredits = Number(tokenUsage.factoryCredits ?? 0);

    return {
      usage: {
        input,
        output,
        cache_read,
        cache_write,
        total_tokens,
        cost_total: 0,
      },
      factoryCredits,
      sidecarMtimeMs,
    };
  } catch (err) {
    debugLogFn?.("sidecar_read_failed", {
      path: sidecarPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { usage: zeroUsage(), factoryCredits: 0, sidecarMtimeMs };
  }
}

/**
 * Compute usage delta: cumulative minus previous snapshot.
 * Negative deltas are clamped to 0 and logged as anomalies.
 */
export function computeUsageDelta(
  cumulative: UsageSummary,
  previous: UsageSummary | null,
  debugLogFn?: (message: string, data?: unknown) => void,
): UsageSummary {
  const prev = previous ?? zeroUsage();
  const fields: Array<keyof Pick<UsageSummary, "input" | "output" | "cache_read" | "cache_write">> = [
    "input",
    "output",
    "cache_read",
    "cache_write",
  ];

  const delta: UsageSummary = { ...zeroUsage() };
  for (const field of fields) {
    const diff = cumulative[field] - prev[field];
    if (diff < 0) {
      debugLogFn?.("usage_delta_negative_clamped", { field, diff, cumulative: cumulative[field], previous: prev[field] });
      delta[field] = 0;
    } else {
      delta[field] = diff;
    }
  }
  delta.total_tokens = delta.input + delta.output + delta.cache_read + delta.cache_write;
  delta.cost_total = 0;
  return delta;
}

/**
 * Bounded retry read for sidecar timing races (Stop fires before flush).
 * Retries up to `maxAttempts` with `delayMs` between attempts when totals
 * are unchanged from the previous snapshot and the file mtime is very recent.
 */
export function readCumulativeUsageWithRetry(
  sidecarPath: string,
  previous: UsageSummary | null,
  debugLogFn?: (message: string, data?: unknown) => void,
  maxAttempts = 3,
  delayMs = 50,
): SidecarReadResult {
  let result = readCumulativeUsage(sidecarPath, debugLogFn);
  if (!previous) return result;

  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const unchanged =
      result.usage.input === previous.input &&
      result.usage.output === previous.output &&
      result.usage.cache_read === previous.cache_read &&
      result.usage.cache_write === previous.cache_write;

    if (!unchanged) break;

    const ageMs = result.sidecarMtimeMs ? Date.now() - result.sidecarMtimeMs : Infinity;
    if (ageMs > 500) break;

    try {
      Bun.sleepSync(delayMs);
    } catch {
      break;
    }
    result = readCumulativeUsage(sidecarPath, debugLogFn);
  }

  return result;
}
