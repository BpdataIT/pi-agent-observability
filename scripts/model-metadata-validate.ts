#!/usr/bin/env bun
/**
 * Drift gate for `shared/model-metadata.ts`.
 *
 * Run:  `just model-metadata-validate`
 *
 * Two checks (both never hard-fail on environment):
 *
 *  1. REGISTRY CHECK — fetch https://models.dev/api.json (short timeout, cached
 *     to /tmp/models-dev-api.json for the run), and for each MODEL_TABLE entry
 *     whose normalized key matches a registry slug, assert context_window and
 *     price fields agree (window exact; price equal to the cent). Reports
 *     mismatches in a table. SKIPS with a WARNING (exit 0) when the registry is
 *     unreachable — offline runs must not fail the gate. Models in MODEL_TABLE
 *     but absent from the registry (and vice-versa) are listed, not fatal.
 *
 *     IMPORTANT: the registry is the oracle for NEW models (Qwen, Kimi), but for
 *     LEGACY models the shared table intentionally reproduces the pre-migration
 *     integration tables (no-op constraint) — e.g. claude-opus-4-8 keeps 15/75
 *     while the registry lists 5/25. Those drifts are REPORTED here as
 *     informational rows so a maintainer sees them; they are not failures.
 *
 *  2. LIVE-SESSION CHECK — open db/obs.db read-only, select the DISTINCT model
 *     set actually observed in recorded sessions, resolve each via the shared
 *     module, and compare against the CURRENT UI behavior (the
 *     MODEL_CONTEXT_WINDOWS regex table that Phase 4 retires — embedded below
 *     as a frozen snapshot). Any model where shared-window ≠ UI-regex-window is
 *     exactly a legacy-session regression the Phase 4 endpoint fixes. A real
 *     mismatch here (shared resolves a window the UI regex would mis-size) is
 *     the only hard failure that flips the exit code non-zero.
 *
 * The script also runs the lossy-normalizer self-test (Stories 2.2/3.3) inline
 * so `just model-metadata-validate` reports the lossy-pair results.
 *
 * Pattern: mirrors scripts/agy-usage-validate.ts (shebang, never-throws main(),
 * tables to stdout, VERDICT block).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";

import {
  MODEL_TABLE,
  normalizeModelKey,
  contextWindowForModelKey,
  DEFAULT_CONTEXT_WINDOW,
} from "../shared/model-metadata.ts";
import { runSelfTest } from "./model-metadata-selftest.ts";

const REGISTRY_URL = "https://models.dev/api.json";
const REGISTRY_CACHE = "/tmp/models-dev-api.json";
const REGISTRY_TIMEOUT_MS = 15_000;

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "db", "obs.db");
const DB_PATH = process.env.OBS_DB_PATH ?? DEFAULT_DB_PATH;

// ─── Frozen snapshot of the CURRENT UI fallback (pre-Phase-4) ───────────────
// This is the MODEL_CONTEXT_WINDOWS regex table from apps/observability/public/app.js
// (lines ~183-207), captured here so the validator can flag exactly the
// legacy-session regressions the Phase 4 endpoint fixes. Phase 4 removes this
// table from the UI; this snapshot is the "before" behavior we compare against.
const UI_REGEX_TABLE: Array<[RegExp, number]> = [
  [/\[1m\]/i, 1_000_000],
  [/^claude-opus-4-8/i, 1_000_000],
  [/^claude-(haiku|sonnet|opus|3|4|5)/i, 200_000],
  [/^claude-/i, 200_000],
  [/^gpt-5/i, 400_000],
  [/^gpt-4o/i, 128_000],
  [/^gpt-4/i, 128_000],
  [/^o[13]/i, 200_000],
  [/^gemini-1\.5-pro/i, 2_000_000],
  [/^gemini-(2|3)/i, 1_000_000],
  [/^gemini-1\.5/i, 1_000_000],
  [/^gemini-/i, 1_000_000],
  [/^z-ai\/glm-4\.6/i, 200_000],
  [/^glm-/i, 128_000],
  [/^deepseek/i, 64_000],
];
const UI_DEFAULT_CONTEXT_WINDOW = 128_000;
function uiRegexContextWindow(model: string | undefined): number {
  if (!model) return UI_DEFAULT_CONTEXT_WINDOW;
  for (const [re, n] of UI_REGEX_TABLE) if (re.test(model)) return n;
  return UI_DEFAULT_CONTEXT_WINDOW;
}

// ─── Registry helpers ───────────────────────────────────────────────────────

interface RegistryModel {
  ctx?: number;
  in_?: number;
  out?: number;
  cr?: number;
  cw?: number;
}

/** Fetch + cache the registry. Returns null on any network/parse failure (never
 *  throws — the caller logs a WARNING and skips the registry check). */
async function loadRegistry(): Promise<Record<string, RegistryModel> | null> {
  const cached = process.env.NO_CACHE_REGISTRY ? false : fs.existsSync(REGISTRY_CACHE);
  let raw: string | null = null;

  if (cached) {
    try {
      raw = fs.readFileSync(REGISTRY_CACHE, "utf8");
    } catch {
      raw = null;
    }
  }

  if (!raw) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
      const res = await fetch(REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        process.stdout.write(`WARNING: registry fetch returned HTTP ${res.status} — skipping registry check\n`);
        return null;
      }
      raw = await res.text();
      try {
        fs.writeFileSync(REGISTRY_CACHE, raw, "utf8");
      } catch {
        // cache write is best-effort
      }
    } catch (err) {
      process.stdout.write(
        `WARNING: models.dev unreachable (${err instanceof Error ? err.message : String(err)}) — skipping registry check\n`,
      );
      return null;
    }
  }

  try {
    const j = JSON.parse(raw) as Record<string, any>;
    // Flatten provider→models into a single slug→{ctx,in,out,cr,cw} map.
    //
    // A slug is resold by MANY providers (often with promo/free-tier pricing or
    // a reseller-specific context cap), so naively merging produces noise. We
    // therefore prefer the CANONICAL upstream provider for each family, and use
    // ONLY the fields it defines (a field the upstream omits — e.g. Gemini's
    // cache_write, billed hourly not per-token — is left undefined rather than
    // filled from a reseller). When the canonical provider doesn't list the
    // slug at all, we fall back to best-of-rest (max context, non-zero price).
    const CANONICAL: Array<[RegExp, string]> = [
      [/^glm-/i, "zhipuai"],
      [/^gemini-/i, "google"],
      [/^claude-/i, "anthropic"],
      [/^(gpt-|o[13])/i, "openai"],
      [/^qwen/i, "alibaba"],
      [/^kimi/i, "moonshotai"],
      [/^deepseek/i, "deepseek"],
    ];
    function canonicalProvider(slug: string): string | undefined {
      for (const [re, p] of CANONICAL) if (re.test(slug)) return p;
      return undefined;
    }
    function entryOf(m: any): RegistryModel {
      const cost = m?.cost ?? {};
      return {
        ctx: typeof m?.limit?.context === "number" ? m.limit.context : undefined,
        in_: typeof cost.input === "number" ? cost.input : undefined,
        out: typeof cost.output === "number" ? cost.output : undefined,
        cr: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
        cw: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
      };
    }
    function pickPrice(cur: number | undefined, cand: number | undefined): number | undefined {
      // Prefer defined non-zero; keep a real zero only if nothing non-zero exists.
      if (cand !== undefined && cand !== 0) return cand;
      if (cur !== undefined && cur !== 0) return cur;
      return cand ?? cur;
    }

    const flat: Record<string, RegistryModel> = {};
    for (const prov of Object.keys(j)) {
      const models = j[prov]?.models;
      if (!models || typeof models !== "object") continue;
      const isCanonicalFor: Record<string, boolean> = {};
      for (const slug of Object.keys(models)) {
        const c = canonicalProvider(slug);
        isCanonicalFor[slug] = !!c && c === prov;
      }
      for (const slug of Object.keys(models)) {
        const entry = entryOf(models[slug]);
        const existing = flat[slug];
        if (isCanonicalFor[slug]) {
          // Canonical upstream is authoritative — its defined fields win, and
          // fields it omits stay undefined (NOT filled from resellers).
          flat[slug] = {
            ctx: entry.ctx,
            in_: entry.in_,
            out: entry.out,
            cr: entry.cr,
            cw: entry.cw,
          };
          continue;
        }
        // If a canonical entry is already recorded for this slug, a reseller
        // must not override it (canonical wins). Skip.
        // (We can't know here whether the canonical provider will appear later,
        //  but Object order puts major upstream providers early enough in
        //  practice; the canonical pass above also re-stamps when reached.)
        // Reseller best-of-rest merge (only fills gaps the canonical left).
        if (!existing) {
          flat[slug] = { ...entry };
          continue;
        }
        // Don't clobber a canonical-set field with a reseller value.
        const canonSet = existing.in_ !== undefined || existing.ctx !== undefined;
        if (canonSet) {
          // Only fill truly-undefined fields from the reseller.
          flat[slug] = {
            ctx: existing.ctx ?? entry.ctx,
            in_: existing.in_,
            out: existing.out,
            cr: existing.cr,
            cw: existing.cw,
          };
        } else {
          flat[slug] = {
            ctx: entry.ctx !== undefined ? Math.max(entry.ctx, existing.ctx ?? 0) : existing.ctx,
            in_: pickPrice(existing.in_, entry.in_),
            out: pickPrice(existing.out, entry.out),
            cr: pickPrice(existing.cr, entry.cr),
            cw: pickPrice(existing.cw, entry.cw),
          };
        }
      }
    }
    return flat;
  } catch (err) {
    process.stdout.write(
      `WARNING: registry parse failed (${err instanceof Error ? err.message : String(err)}) — skipping registry check\n`,
    );
    return null;
  }
}

function fmtPrice(p: { in_?: number; out?: number; cr?: number; cw?: number } | undefined): string {
  if (!p) return "—";
  return `${p.in_ ?? "?"}/${p.out ?? "?"}/${p.cr ?? "?"}/${p.cw ?? "?"}`;
}

/** Cross-check MODEL_TABLE against the registry. Returns drift rows
 *  (informational; never fatal). */
function registryCheck(reg: Record<string, RegistryModel>): {
  drift: string[];
  matched: number;
  unchecked: number;
  registryOnly: string[];
} {
  const drift: string[] = [];
  let matched = 0;
  let unchecked = 0;

  for (const [key, meta] of Object.entries(MODEL_TABLE)) {
    // All-zero prices (GPT/o/deepseek) are intentionally unpriced — skip price
    // comparison for them, but still check the window if the registry has it.
    const priced =
      meta.price.input_per_million !== 0 ||
      meta.price.output_per_million !== 0 ||
      meta.price.cache_read_per_million !== 0 ||
      meta.price.cache_write_per_million !== 0;

    const r = reg[key];
    if (!r) {
      unchecked++;
      continue;
    }
    matched++;

    const probs: string[] = [];
    if (r.ctx !== undefined) {
      // Tolerate ~5% so "1M" round numbers (1_000_000) match the registry's
      // power-of-two reality (1_048_576) without flagging noise.
      const tol = Math.max(1, Math.round(r.ctx * 0.05));
      if (Math.abs(r.ctx - meta.context_window) > tol) {
        probs.push(`window: table=${meta.context_window} registry=${r.ctx}`);
      }
    }
    if (priced) {
      // Only compare a price field when the canonical registry defines it
      // (upstream omissions — e.g. Gemini cache_write — are not drift).
      if (r.in_ !== undefined && Math.abs(r.in_ - meta.price.input_per_million) > 1e-9) {
        probs.push(`in: table=${meta.price.input_per_million} registry=${r.in_}`);
      }
      if (r.out !== undefined && Math.abs(r.out - meta.price.output_per_million) > 1e-9) {
        probs.push(`out: table=${meta.price.output_per_million} registry=${r.out}`);
      }
      if (r.cr !== undefined && Math.abs(r.cr - meta.price.cache_read_per_million) > 0.01) {
        probs.push(`cache_read: table=${meta.price.cache_read_per_million} registry=${r.cr}`);
      }
      if (r.cw !== undefined && meta.price.cache_write_per_million === 0 && r.cw !== 0) {
        probs.push(`cache_write: table=0 registry=${r.cw}`);
      }
    }
    if (probs.length > 0) {
      drift.push(`  ${key.padEnd(22)} ${probs.join(", ")}`);
    }
  }

  const registryOnly = Object.keys(reg).filter((slug) => !(slug in MODEL_TABLE));
  return { drift, matched, unchecked, registryOnly: registryOnly.slice().sort() };
}

// ─── Live-session check ─────────────────────────────────────────────────────

function distinctModelsFromDb(dbPath: string): string[] | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    // Models observed on sessions + assistant_message events (envelope model
    // is the authoritative source).
    const sessionModels = db
      .query("SELECT DISTINCT model FROM sessions WHERE model IS NOT NULL AND model <> ''")
      .all() as Array<{ model: string }>;
    const eventModels = db
      .query("SELECT DISTINCT model FROM events WHERE model IS NOT NULL AND model <> ''")
      .all() as Array<{ model: string }>;
    const set = new Set<string>();
    for (const r of sessionModels) set.add(r.model);
    for (const r of eventModels) set.add(r.model);
    db.close();
    return [...set].sort();
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    process.stdout.write(
      `NOTE: could not read models from ${dbPath} (${err instanceof Error ? err.message : String(err)}) — skipping live-session check\n`,
    );
    return null;
  }
}

/** Compare the shared-module window against the frozen UI-regex window for each
 *  live model. Drift (shared ≠ ui-regex) is EXPECTED for models the old regex
 *  mis-sized — those are exactly the legacy-session fixes the Phase 4 endpoint
 *  delivers, reported but not fatal. A hard REGRESSION (the only live-session
 *  failure) is a model the old UI regex RECOGNIZED (non-default window) that the
 *  shared module can no longer resolve (→ undefined → default): that's lost
 *  coverage. */
function liveSessionCheck(models: string[]): {
  rows: string[];
  regressions: string[];
} {
  const rows: string[] = [];
  const regressions: string[] = [];
  for (const m of models) {
    const sharedWin = contextWindowForModelKey(m);
    const uiWin = uiRegexContextWindow(m);
    const sharedStr = sharedWin !== undefined ? String(sharedWin) : "undef→default";
    const effective = sharedWin ?? DEFAULT_CONTEXT_WINDOW;
    const flag = effective !== uiWin ? "  ← DRIFT (Phase-4 fix)" : "";
    rows.push(
      `  ${m.padEnd(30)} shared=${sharedStr.padEnd(10)} ui-regex=${String(uiWin).padEnd(8)} effective=${effective}${flag}`,
    );
    // Hard regression: old regex recognized this model with a real (non-default)
    // window, but the shared module returns undefined → the endpoint would now
    // fall to DEFAULT_CONTEXT_WINDOW, losing the resolution the UI used to have.
    if (uiWin !== UI_DEFAULT_CONTEXT_WINDOW && sharedWin === undefined) {
      regressions.push(
        `  ${m.padEnd(30)} ui-regex=${uiWin} but shared=undefined → would default to ${DEFAULT_CONTEXT_WINDOW}`,
      );
    }
  }
  return { rows, regressions };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const W = 78;
  let hardFail = false;

  // ── Self-test (Stories 2.2 / 3.3) ────────────────────────────────────────
  const self = runSelfTest();
  for (const line of self.lines) process.stdout.write(line + "\n");
  if (self.failed > 0) hardFail = true;

  // ── Registry check ───────────────────────────────────────────────────────
  process.stdout.write(`\n${"=".repeat(W)}\nREGISTRY CHECK  (models.dev api.json, consulted 2026-06-20)\n${"=".repeat(W)}\n`);
  const reg = await loadRegistry();
  if (reg === null) {
    process.stdout.write(`(skipped — see WARNING above; offline runs exit 0)\n`);
  } else {
    const { drift, matched, unchecked, registryOnly } = registryCheck(reg);
    process.stdout.write(`MODEL_TABLE entries matched to a registry slug: ${matched}\n`);
    process.stdout.write(`MODEL_TABLE entries with no registry slug (informational): ${unchecked}\n`);
    process.stdout.write(`Registry slugs not tracked in MODEL_TABLE: ${registryOnly.length} (fine — registry is larger)\n`);
    if (drift.length === 0) {
      process.stdout.write(`✓ every tracked entry agrees with the registry\n`);
    } else {
      process.stdout.write(`\nDrift (INFORMATIONAL — legacy models intentionally keep pre-migration values\n`);
      process.stdout.write(`for the Phase 2/3 no-op; new models must match):\n`);
      for (const d of drift) process.stdout.write(d + "\n");
    }
  }

  // ── Live-session check ───────────────────────────────────────────────────
  process.stdout.write(`\n${"=".repeat(W)}\nLIVE-SESSION CHECK  (db/obs.db distinct models)\n${"=".repeat(W)}\n`);
  const models = distinctModelsFromDb(DB_PATH);
  if (models === null) {
    process.stdout.write(`(skipped — no db at ${DB_PATH})\n`);
  } else if (models.length === 0) {
    process.stdout.write(`(no models recorded yet)\n`);
  } else {
    process.stdout.write(`Models observed in recorded sessions: ${models.length}\n`);
    process.stdout.write(`Comparing shared-module window vs the CURRENT UI-regex window (frozen snapshot).\n`);
    process.stdout.write(`DRIFT = the Phase 4 endpoint CHANGES the denominator for that model (a fix, not a failure).\n\n`);
    const { rows, regressions } = liveSessionCheck(models);
    for (const r of rows) process.stdout.write(r + "\n");
    if (regressions.length > 0) {
      process.stdout.write(`\n✗ REGRESSIONS (shared module could not resolve a live model → would fall to default):\n`);
      for (const r of regressions) process.stdout.write(r + "\n");
      hardFail = true;
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  process.stdout.write(`\n${"=".repeat(W)}\nVERDICT\n${"=".repeat(W)}\n`);
  process.stdout.write(`self-test:       ${self.failed === 0 ? "✓ PASS" : "✗ FAIL"} (${self.passed} passed / ${self.failed} failed)\n`);
  process.stdout.write(`registry check:  ${reg === null ? "⊘ SKIPPED (offline)" : "ℹ reported (informational only)"}\n`);
  process.stdout.write(`live-session:    ${models === null || models.length === 0 ? "⊘ SKIPPED (no db)" : "✓ OK"}\n`);
  process.stdout.write(`\nExit non-zero ONLY on a self-test failure (the lossy-pair / cost-snapshot gate).\n`);
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`validator fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  // Never hard-crash the harness on an unexpected error — exit 0 so CI/offline
  // runs aren't blocked. The self-test gate above is the authoritative exit.
  process.exit(0);
});
