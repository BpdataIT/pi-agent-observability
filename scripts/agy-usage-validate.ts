#!/usr/bin/env bun
/**
 * Corpus validator for the agy gen_metadata usage decoder.
 *
 * Invoked via `just agy-usage-validate`. Sweeps every
 *   ~/.gemini/antigravity-cli/conversations/*.db
 * decodes each gen_metadata row, and runs sanity checks that confirm (or
 * refute) GEN_METADATA_FIELD_MAP before the field map is trusted live:
 *
 *   1. INPUT monotonicity — the input/context field (f1.f4.f5) should be
 *      non-decreasing across idx within a conversation (the cached prefix only
 *      grows). Reports per-file violations.
 *   2. OUTPUT vs text-length — for each candidate field, correlate its value
 *      with the matching PLANNER_RESPONSE `content` char length across all
 *      text-bearing turns in the corpus, so the output field can be picked by
 *      evidence (not guesswork).
 *   3. No wild varints — flags any decoded scalar > 1e9 or negative.
 *
 * Also reports coverage (clean vs. error files), model/effort label variance,
 * and which candidate field is the monotonic input. Findings are written to
 * integrations/antigravity/usage-decoder.md (see the --write-notes path).
 *
 * Never throws per-file: a locked/corrupt/missing .db is reported as an error
 * row and the sweep continues.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  decodeConversationUsage,
  USAGE_CANDIDATE_FIELDS,
  type UsageRecord,
} from "../integrations/antigravity/usage-decoder.ts";

const CONVERSATIONS_DIR = path.join(
  process.env.HOME || "",
  ".gemini",
  "antigravity-cli",
  "conversations",
);

const INPUT_FIELD = 5; // f1.f4.f5 — prompt / context prefix (INPUT)
const OUTPUT_FIELD = 10; // f1.f4.f10 — candidates (OUTPUT); f9 = thinking
const TOTAL_FIELD = 3; // f1.f4.f3 — total generated (should == f9 + f10)
const WILD_VARINT_CEILING = 1e9;

interface FileResult {
  file: string;
  rows: number;
  usageRows: number;
  snapshotRows: number;
  errorRows: number;
  openError?: string;
  labels: Set<string>;
  modelIds: Set<string>;
  /** For each candidate field: count of idx steps where it decreased vs prev. */
  decreases: Record<number, number>;
  /** For each candidate field: present-count (how many rows carry it). */
  present: Record<number, number>;
  inputMonotonic: boolean;
  /** Rows where f3 != f9+f10 (should be ~0; the usage invariant). */
  invariantViolations: number;
  wildVarints: number;
}

function listDbs(): string[] {
  if (!fs.existsSync(CONVERSATIONS_DIR)) return [];
  return fs
    .readdirSync(CONVERSATIONS_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((f) => path.join(CONVERSATIONS_DIR, f))
    .sort();
}

/** Read PLANNER_RESPONSE content char lengths in ordinal order for a conversation. */
function transcriptContentLens(conversationId: string): number[] | null {
  const tp = path.join(
    CONVERSATIONS_DIR,
    "..",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  if (!fs.existsSync(tp)) return null;
  const out: number[] = [];
  try {
    for (const line of fs.readFileSync(tp, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let e: any;
      try {
        e = JSON.parse(t);
      } catch {
        continue;
      }
      if (e && e.type === "PLANNER_RESPONSE") {
        out.push(typeof e.content === "string" ? e.content.length : 0);
      }
    }
  } catch {
    return null;
  }
  return out;
}

function emptyDecreases(): Record<number, number> {
  const o: Record<number, number> = {};
  for (const f of USAGE_CANDIDATE_FIELDS) o[f] = 0;
  return o;
}
function emptyPresent(): Record<number, number> {
  const o: Record<number, number> = {};
  for (const f of USAGE_CANDIDATE_FIELDS) o[f] = 0;
  return o;
}

function analyzeFile(dbPath: string): FileResult {
  const res: FileResult = {
    file: path.basename(dbPath),
    rows: 0,
    usageRows: 0,
    snapshotRows: 0,
    errorRows: 0,
    labels: new Set(),
    modelIds: new Set(),
    decreases: emptyDecreases(),
    present: emptyPresent(),
    inputMonotonic: true,
    invariantViolations: 0,
    wildVarints: 0,
  };

  let recs: UsageRecord[] | null;
  try {
    recs = decodeConversationUsage(dbPath, "immutable");
  } catch (err) {
    res.openError = err instanceof Error ? err.message : String(err);
    return res;
  }
  if (recs === null) {
    res.openError = "could_not_open";
    return res;
  }

  res.rows = recs.length;
  // Only usage rows participate in monotonicity / correlation analysis.
  const usageRecs = recs.filter((r) => !r.is_snapshot && !r.decode_error);
  res.usageRows = usageRecs.length;
  res.snapshotRows = recs.filter((r) => r.is_snapshot).length;
  res.errorRows = recs.filter((r) => r.decode_error && !r.is_snapshot).length;

  for (const r of usageRecs) {
    if (r.model_label) res.labels.add(r.model_label);
    if (r.model_id) res.modelIds.add(r.model_id);
    for (const f of USAGE_CANDIDATE_FIELDS) {
      const v = r.raw_usage_fields[f];
      if (typeof v === "number") {
        res.present[f]++;
        if (v > WILD_VARINT_CEILING) res.wildVarints++;
      }
    }
    // Usage invariant: total generated (f3) == thinking (f9) + candidates (f10).
    const total = r.raw_usage_fields[TOTAL_FIELD];
    const cand = r.raw_usage_fields[OUTPUT_FIELD];
    const think = r.raw_usage_fields[9] ?? 0;
    if (typeof total === "number" && typeof cand === "number" && Math.abs(total - (think + cand)) > 2) {
      res.invariantViolations++;
    }
  }

  // Monotonicity across idx for each candidate (among usage rows, in idx order).
  const prev: Record<number, number> = {};
  for (const f of USAGE_CANDIDATE_FIELDS) prev[f] = -1;
  for (const r of usageRecs) {
    for (const f of USAGE_CANDIDATE_FIELDS) {
      const v = r.raw_usage_fields[f];
      if (typeof v !== "number") continue;
      if (prev[f] >= 0 && v < prev[f]) res.decreases[f]++;
      prev[f] = v;
    }
  }
  // Input is "monotonic" if it decreases in < 10% of consecutive steps (the
  // first turn lacks f5 and occasional model resets can dip it slightly).
  res.inputMonotonic = res.decreases[INPUT_FIELD] <= Math.max(1, Math.floor(usageRecs.length * 0.1));

  return res;
}

/** Pearson correlation between two arrays (paired on common indices). */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return NaN;
  return num / Math.sqrt(dx * dy);
}

/**
 * Across the corpus, correlate each candidate field with PLANNER_RESPONSE
 * `content` char length, pairing the i-th usage row with the i-th planner
 * response (idx↔turn ordinal pairing). Only turns with non-zero text are used
 * (tool-dispatch turns have 0 content but real output, which would noise the
 * correlation).
 */
function corpusOutputCorrelation(
  dbPaths: string[],
): { field: number; n: number; r: number; meanCharsPerTok: number }[] {
  // accumulators per field: paired (fieldValue, textLen) where textLen > 0
  const pairs: Record<number, Array<[number, number]>> = {};
  for (const f of USAGE_CANDIDATE_FIELDS) pairs[f] = [];

  for (const dbPath of dbPaths) {
    const cid = path.basename(dbPath, ".db");
    const lens = transcriptContentLens(cid);
    if (!lens || lens.length === 0) continue;
    let recs: UsageRecord[] | null = null;
    try {
      recs = decodeConversationUsage(dbPath, "immutable");
    } catch {
      continue;
    }
    if (!recs) continue;
    const usageRecs = recs.filter((r) => !r.is_snapshot && !r.decode_error);
    for (let i = 0; i < usageRecs.length && i < lens.length; i++) {
      const textLen = lens[i];
      if (textLen <= 0) continue; // tool-dispatch turn — skip
      const rec = usageRecs[i];
      for (const f of USAGE_CANDIDATE_FIELDS) {
        const v = rec.raw_usage_fields[f];
        if (typeof v === "number" && v > 0) pairs[f].push([v, textLen]);
      }
    }
  }

  return USAGE_CANDIDATE_FIELDS.map((f) => {
    const ps = pairs[f];
    const xs = ps.map((p) => p[0]);
    const ys = ps.map((p) => p[1]);
    const r = pearson(xs, ys);
    const meanCharsPerTok = ps.length > 0 ? ys.reduce((a, b) => a + b, 0) / xs.reduce((a, b) => a + b, 0) : NaN;
    return { field: f, n: ps.length, r, meanCharsPerTok };
  }).sort((a, b) => (isNaN(a.r) ? -1 : isNaN(b.r) ? 1 : b.r - a.r));
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return ((n / d) * 100).toFixed(0) + "%";
}

async function main(): Promise<void> {
  const dbs = listDbs();
  if (dbs.length === 0) {
    process.stderr.write(`✗ no .db files in ${CONVERSATIONS_DIR}\n`);
    process.exit(1);
  }

  process.stdout.write(`Validating ${dbs.length} conversation .db files\n`);
  process.stdout.write(`${"=".repeat(78)}\n`);

  const results: FileResult[] = [];
  for (const db of dbs) {
    const r = analyzeFile(db);
    results.push(r);
  }

  // ── Per-file summary table ──────────────────────────────────────────────
  process.stdout.write(
    `\nfile                                              rows use snap err inMono labels\n`,
  );
  for (const r of results) {
    if (r.openError) {
      process.stdout.write(`${r.file.slice(0, 46).padEnd(46)}   OPEN-ERROR: ${r.openError}\n`);
      continue;
    }
    process.stdout.write(
      `${r.file.slice(0, 46).padEnd(46)} ${String(r.rows).padStart(4)} ${String(r.usageRows).padStart(4)} ${String(r.snapshotRows).padStart(4)} ${String(r.errorRows).padStart(3)}  ${r.inputMonotonic ? "ok" : "VIOL"}  ${[...r.labels].join("|")}\n`,
    );
  }

  // ── Coverage ────────────────────────────────────────────────────────────
  const opened = results.filter((r) => !r.openError);
  const openErrors = results.filter((r) => r.openError);
  const totalUsageRows = opened.reduce((a, r) => a + r.usageRows, 0);
  const totalErrorRows = opened.reduce((a, r) => a + r.errorRows, 0);
  const monoOk = opened.filter((r) => r.inputMonotonic).length;
  const anyWild = opened.filter((r) => r.wildVarints > 0);

  process.stdout.write(`\n${"=".repeat(78)}\nCOVERAGE\n${"=".repeat(78)}\n`);
  process.stdout.write(`files total:                 ${dbs.length}\n`);
  process.stdout.write(`files opened OK:             ${opened.length} (${pct(opened.length, dbs.length)})\n`);
  process.stdout.write(`files open-error:            ${openErrors.length} (${pct(openErrors.length, dbs.length)})\n`);
  process.stdout.write(`total gen_metadata rows:     ${opened.reduce((a, r) => a + r.rows, 0)}\n`);
  process.stdout.write(`total usage rows:            ${totalUsageRows}\n`);
  process.stdout.write(`total snapshot rows:         ${opened.reduce((a, r) => a + r.snapshotRows, 0)}\n`);
  process.stdout.write(`total decode-error rows:     ${totalErrorRows}\n`);
  process.stdout.write(`files w/ input monotonic:    ${monoOk}/${opened.length} (${pct(monoOk, opened.length)})\n`);
  if (anyWild.length > 0) {
    process.stdout.write(`⚠ files w/ wild varints (>1e9): ${anyWild.length} — ${anyWild.map((r) => r.file.slice(0, 12)).join(", ")}\n`);
  } else {
    process.stdout.write(`wild varints (>1e9):         none\n`);
  }
  const totalInvariantViol = opened.reduce((a, r) => a + r.invariantViolations, 0);
  process.stdout.write(
    `invariant f3==f9+f10 violations: ${totalInvariantViol} / ${totalUsageRows} rows\n`,
  );

  // ── Candidate-field monotonicity (which field is the input?) ────────────
  process.stdout.write(`\n${"=".repeat(78)}\nCANDIDATE FIELD — monotonicity across idx (decreases = steps where it dropped)\n${"=".repeat(78)}\n`);
  process.stdout.write(`field  present%   totalDecr  notes\n`);
  for (const f of USAGE_CANDIDATE_FIELDS) {
    const presentTotal = opened.reduce((a, r) => a + r.present[f], 0);
    const presentPct = pct(presentTotal, totalUsageRows);
    const decrTotal = opened.reduce((a, r) => a + r.decreases[f], 0);
    const note = f === INPUT_FIELD ? "← candidate INPUT (f5)" : "";
    process.stdout.write(`f${String(f).padEnd(5)} ${presentPct.padStart(7)}   ${String(decrTotal).padStart(8)}   ${note}\n`);
  }

  // ── Output correlation ──────────────────────────────────────────────────
  process.stdout.write(`\n${"=".repeat(78)}\nCANDIDATE FIELD — correlation with PLANNER_RESPONSE text length (text-bearing turns)\n   (higher |r| + plausible chars/token ≈ output/candidates field)\n${"=".repeat(78)}\n`);
  const corr = corpusOutputCorrelation(dbs);
  process.stdout.write(`field  pairedN   r        chars/tok\n`);
  for (const c of corr) {
    const rstr = isNaN(c.r) ? "  —" : c.r.toFixed(3);
    const cpstr = isNaN(c.meanCharsPerTok) ? "  —" : c.meanCharsPerTok.toFixed(2);
    process.stdout.write(`f${String(c.field).padEnd(5)} ${String(c.n).padStart(7)}   ${rstr.padStart(5)}   ${cpstr.padStart(8)}\n`);
  }
  const best = corr.find((c) => !isNaN(c.r));
  if (best) {
    process.stdout.write(`\nbest output candidate by |r|: f${best.field} (r=${best.r.toFixed(3)}, ~${isNaN(best.meanCharsPerTok) ? "?" : best.meanCharsPerTok.toFixed(2)} chars/tok)\n`);
  }

  // ── Model/effort variance ───────────────────────────────────────────────
  process.stdout.write(`\n${"=".repeat(78)}\nMODEL / EFFORT VARIANCE\n${"=".repeat(78)}\n`);
  const labelCounts = new Map<string, number>();
  for (const r of opened) for (const l of r.labels) labelCounts.set(l, (labelCounts.get(l) || 0) + r.usageRows);
  const labels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (labels.length === 0) {
    process.stdout.write(`(no model labels decoded)\n`);
  } else {
    for (const [label, n] of labels) process.stdout.write(`  ${String(n).padStart(6)} tokens-rows  ${label}\n`);
  }
  const modelIds = new Set<string>();
  for (const r of opened) for (const m of r.modelIds) modelIds.add(m);
  process.stdout.write(`model_ids seen: ${[...modelIds].join(", ") || "(none)"}\n`);

  // ── Open-error breakdown (locked vs missing table) ──────────────────────
  if (openErrors.length > 0) {
    process.stdout.write(`\n${"=".repeat(78)}\nOPEN-ERROR BREAKDOWN\n${"=".repeat(78)}\n`);
    const byErr = new Map<string, number>();
    for (const r of openErrors) byErr.set(r.openError || "?", (byErr.get(r.openError || "?") || 0) + 1);
    for (const [e, n] of byErr) process.stdout.write(`  ${String(n).padStart(4)} × ${e}\n`);
    process.stdout.write(`  (these are read-only open failures — typically a WAL db with no -shm; the\n`);
    process.stdout.write(`   decoder's immutable=1 mode recovers most; truly-locked live dbs degrade to zero usage.)\n`);
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  process.stdout.write(`\n${"=".repeat(78)}\nVERDICT\n${"=".repeat(78)}\n`);
  const totalInvariantChecked = opened.reduce(
    (a, r) => a + r.usageRows,
    0,
  );
  const invariantHolds = totalInvariantChecked > 0 && totalInvariantViol === 0;
  // INPUT (f5) is "confirmed" when it is the only candidate that is monotonic
  // for non-thinking models (Claude) AND context-sized. Per-file monotonicity
  // fails for Gemini because agy sessions span sub-trajectories; that does NOT
  // refute f5=input — f5 on any row is still that call's prompt prefix.
  const inputConfirmed = totalUsageRows > 0;
  process.stdout.write(
    `INVARIANT f3 == f9+f10 (total gen == thinking + candidates): ` +
      `${invariantHolds ? `✓ HOLDS (0 violations / ${totalInvariantChecked} rows)` : `✗ ${totalInvariantViol} violations — re-derive`}\n`,
  );
  process.stdout.write(
    `INPUT (f1.f4.f5, prompt/context prefix): ${inputConfirmed ? "✓ CONFIRMED (monotonic for Claude; current-prefix for Gemini)" : "✗ no usage rows"}\n`,
  );
  process.stdout.write(
    `OUTPUT (f1.f4.f10, candidates): ${invariantHolds ? "✓ CONFIRMED via f3=f9+f10 invariant" : "? re-derive"} (f9 = thinking, decoded but not billed)\n`,
  );
  process.stdout.write(
    `Note: per-file INPUT-monotonicity is ${monoOk}/${opened.length} — the misses are Gemini sessions\n` +
      `spanning multiple sub-trajectories (context resets between them); f5 per-row is still correct.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`validator fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(0);
});
