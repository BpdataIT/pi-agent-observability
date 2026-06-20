#!/usr/bin/env bun
/**
 * Self-test for `shared/model-metadata.ts` — the lossy-normalizer regression
 * pairs that gate Phases 2 & 3 (Stories 2.2 + 3.3).
 *
 * Run standalone:   `just model-metadata-selftest`
 *                   (or `bun scripts/model-metadata-selftest.ts`)
 *
 * It is ALSO invoked by `scripts/model-metadata-validate.ts` so
 * `just model-metadata-validate` reports the lossy-pair results inline.
 *
 * Why this exists: a normalization bug that flips e.g. "Gemini 3.5 Flash (High)"
 * from 1M → undefined/128k is the exact failure the shared-table consolidation
 * exists to prevent AND the exact failure a sloppy migration could introduce.
 * These pairs pin the known-lossy cases (label↔id version disagreement) and
 * the documented before/after cost snapshots.
 *
 * Ground-truth label↔id pairs come from the live corpora:
 *   - agy:    ~/.gemini/antigravity-cli/conversations/<id>.db   (model_label || model_id)
 *   - cc:     ~/.claude/projects/<proj>/<session>.jsonl        (.message.model)
 * See shared/model-metadata.md.
 */

import {
  normalizeModelKey,
  contextWindowForModelKey,
  getModelPrice,
  providerForModelKey,
  computeCost,
} from "../shared/model-metadata.ts";

export interface SelfTestCase {
  /** Human description of what's being asserted. */
  name: string;
  /** The raw model string under test. */
  raw?: string;
  /** Expected normalized key (checked when present). */
  key?: string;
  /** Expected context window (checked when present). */
  window?: number;
  /** Expected provider id (checked when present). */
  provider?: string;
  /** Expected price fields (checked when present; only the set fields compared). */
  price?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  /** When true, getModelPrice must report unknown. */
  priceUnknown?: boolean;
}

/** The full pair set from spec Stories 2.2 (agy corpus) + 3.3 (cc corpus). */
export const SELF_TEST_CASES: SelfTestCase[] = [
  // ── Story 2.2 — agy lossy pairs (label ↔ id) ─────────────────────────────
  {
    name: "lossy label: 'Gemini 3.5 Flash (High)' → gemini-3.5-flash, 1M",
    raw: "Gemini 3.5 Flash (High)",
    key: "gemini-3.5-flash",
    window: 1_000_000,
    provider: "google",
    price: { input: 1.5, output: 9.0, cache_read: 0.15, cache_write: 0 },
  },
  {
    name: "lossy id: 'gemini-3-flash-a' → gemini-3-flash, 1M (diverges from 3.5 label)",
    raw: "gemini-3-flash-a",
    key: "gemini-3-flash",
    window: 1_000_000,
    provider: "google",
  },
  { name: "Gemini 3 Pro → 1M", raw: "Gemini 3 Pro", key: "gemini-3-pro", window: 1_000_000 },
  { name: "Gemini 2.5 Flash → 1M", raw: "Gemini 2.5 Flash", key: "gemini-2.5-flash", window: 1_000_000 },
  { name: "Gemini 1.5 Pro → 2M", raw: "Gemini 1.5 Pro", key: "gemini-1.5-pro", window: 2_000_000 },
  {
    name: "agy corpus id 'claude-opus-4-6-thinking' → claude-opus-4-6, anthropic, priced",
    raw: "claude-opus-4-6-thinking",
    key: "claude-opus-4-6",
    provider: "anthropic",
    price: { input: 5, output: 25 },
  },
  {
    name: "zai-org/GLM-5.2 (org-prefix strip) → glm-5.2, 1M, zhipuai",
    raw: "zai-org/GLM-5.2",
    key: "glm-5.2",
    window: 1_000_000,
    provider: "zhipuai",
  },

  // ── Story 3.3 — claude-code canonical ids ────────────────────────────────
  {
    name: "glm-5.2 → 1M, zhipuai, in 1.4/out 4.4/cr 0.26/cw 0",
    raw: "glm-5.2",
    key: "glm-5.2",
    window: 1_000_000,
    provider: "zhipuai",
    price: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
  },
  { name: "glm-4.6 → 204_800", raw: "glm-4.6", key: "glm-4.6", window: 204_800 },
  {
    name: "claude-opus-4-8 → 1M, anthropic, in 5/out 25",
    raw: "claude-opus-4-8",
    key: "claude-opus-4-8",
    window: 1_000_000,
    provider: "anthropic",
    price: { input: 5, output: 25 },
  },
  {
    name: "dated 'claude-opus-4-8-20250514' strips to claude-opus-4-8 → 1M",
    raw: "claude-opus-4-8-20250514",
    key: "claude-opus-4-8",
    window: 1_000_000,
    provider: "anthropic",
    price: { input: 5, output: 25 },
  },
  { name: "claude-sonnet-4-6 → 1M", raw: "claude-sonnet-4-6", key: "claude-sonnet-4-6", window: 1_000_000 },
  {
    name: "dated 'claude-3-5-sonnet-20241022' strips to claude-3-5-sonnet → 200_000",
    raw: "claude-3-5-sonnet-20241022",
    key: "claude-3-5-sonnet",
    window: 200_000,
  },
];

/** Cost snapshots (usage, model) → expected cost_total, mirroring the
 *  pre-migration agy/cc tables. */
export const COST_SNAPSHOTS: Array<{
  name: string;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
  raw: string;
  /** Expected cost_total, rounded to 6 dp for float compare. */
  expected: number;
}> = [
  {
    name: "agy Gemini 3.5 Flash rate (in 1.5 / out 9.0)",
    usage: { input: 39, output: 1635, cache_read: 267072, cache_write: 0 },
    raw: "Gemini 3.5 Flash (High)",
    // (39*1.5 + 1635*9.0 + 267072*0.15) / 1e6
    expected: (39 * 1.5 + 1635 * 9.0 + 267072 * 0.15) / 1_000_000,
  },
  {
    name: "cc claude-opus-4-8 rate (in 5 / out 25 / cr 0.5 / cw 6.25)",
    usage: { input: 39, output: 1635, cache_read: 267072, cache_write: 100 },
    raw: "claude-opus-4-8",
    expected: (39 * 5 + 1635 * 25 + 267072 * 0.5 + 100 * 6.25) / 1_000_000,
  },
  {
    name: "glm-5.2 sample (≈0.0767) — in 1.4 / out 4.4 / cr 0.26 / cw 0",
    usage: { input: 39, output: 1635, cache_read: 267072, cache_write: 0 },
    raw: "glm-5.2",
    expected: (39 * 1.4 + 1635 * 4.4 + 267072 * 0.26) / 1_000_000,
  },
];

export interface SelfTestResult {
  passed: number;
  failed: number;
  failures: string[];
  /** Lines of human-readable output (one per check + verdict). */
  lines: string[];
}

/** Run the self-test. Never throws — collects failures into the result. */
export function runSelfTest(): SelfTestResult {
  const lines: string[] = [];
  const failures: string[] = [];
  let passed = 0;
  let failed = 0;
  const W = 78;

  lines.push(`${"=".repeat(W)}`);
  lines.push(`LOSSY-NORMALIZER SELF-TEST  (Stories 2.2 + 3.3)`);
  lines.push(`${"=".repeat(W)}`);

  for (const c of SELF_TEST_CASES) {
    const raw = c.raw ?? "";
    const key = normalizeModelKey(raw);
    const win = contextWindowForModelKey(raw);
    const prov = providerForModelKey(raw);
    const price = getModelPrice(raw);
    const problems: string[] = [];

    if (c.key !== undefined && key !== c.key) {
      problems.push(`key: got ${JSON.stringify(key)} expected ${JSON.stringify(c.key)}`);
    }
    if (c.window !== undefined && win !== c.window) {
      problems.push(`window: got ${win} expected ${c.window}`);
    }
    if (c.provider !== undefined && prov !== c.provider) {
      problems.push(`provider: got ${JSON.stringify(prov)} expected ${JSON.stringify(c.provider)}`);
    }
    if (c.priceUnknown !== undefined && price.unknown !== c.priceUnknown) {
      problems.push(`price.unknown: got ${price.unknown} expected ${c.priceUnknown}`);
    }
    if (c.price) {
      if (c.price.input !== undefined && price.input_per_million !== c.price.input) {
        problems.push(`price.input: got ${price.input_per_million} expected ${c.price.input}`);
      }
      if (c.price.output !== undefined && price.output_per_million !== c.price.output) {
        problems.push(`price.output: got ${price.output_per_million} expected ${c.price.output}`);
      }
      if (c.price.cache_read !== undefined && price.cache_read_per_million !== c.price.cache_read) {
        problems.push(`price.cache_read: got ${price.cache_read_per_million} expected ${c.price.cache_read}`);
      }
      if (c.price.cache_write !== undefined && price.cache_write_per_million !== c.price.cache_write) {
        problems.push(`price.cache_write: got ${price.cache_write_per_million} expected ${c.price.cache_write}`);
      }
    }

    if (problems.length === 0) {
      passed++;
      lines.push(`  ✓ ${c.name}`);
    } else {
      failed++;
      const msg = `  ✗ ${c.name} — ${problems.join("; ")}`;
      lines.push(msg);
      failures.push(msg.trim());
    }
  }

  lines.push("");
  lines.push(`${"-".repeat(W)}`);
  lines.push(`computeCost snapshots (must equal the pre-migration tables)`);
  lines.push(`${"-".repeat(W)}`);
  for (const s of COST_SNAPSHOTS) {
    const { cost_total, unknown_model } = computeCost(s.usage, s.raw);
    const got = Math.round(cost_total * 1e6) / 1e6;
    const exp = Math.round(s.expected * 1e6) / 1e6;
    if (got === exp) {
      passed++;
      lines.push(`  ✓ ${s.name} → cost_total=${cost_total.toFixed(6)}`);
    } else {
      failed++;
      const msg = `  ✗ ${s.name} — got ${cost_total.toFixed(6)} expected ${s.expected.toFixed(6)} (unknown_model=${unknown_model})`;
      lines.push(msg);
      failures.push(msg.trim());
    }
  }

  lines.push("");
  lines.push(`${"=".repeat(W)}`);
  lines.push(`SELF-TEST VERDICT: ${failed === 0 ? "✓ PASS" : "✗ FAIL"} — ${passed} passed, ${failed} failed`);
  lines.push(`${"=".repeat(W)}`);

  return { passed, failed, failures, lines };
}

async function main(): Promise<void> {
  const res = runSelfTest();
  for (const line of res.lines) process.stdout.write(line + "\n");
  process.exit(res.failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`selftest fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
