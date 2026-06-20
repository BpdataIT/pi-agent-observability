/**
 * Model → price computation for Antigravity (agy) cost.
 *
 * THIN WRAPPER — delegates to the single source of truth at
 * `shared/model-metadata.ts` (see `shared/model-metadata.md`). This file
 * exists only to preserve the `getModelPrice` / `computeCost` / `ModelPrice` /
 * `UsageForCost` signatures used by `obs-hook.ts:decodeUsageForTurns`,
 * `scripts/agy-backfill-usage.ts`, and `scripts/agy-verify-stamp.ts`; the
 * price table + normalizer live in the shared module.
 *
 * agy exposes the active model as a human display label (e.g.
 * `"Gemini 3.5 Flash (High)"`) — the SAME string `contextWindowForLabel` keys
 * on. The shared `normalizeModelKey` collapses that label to the same
 * canonical key the canonical-id integrations produce, so one price table
 * answers both. Prices are per-million tokens (USD).
 *
 * If a model is not found, `getModelPrice` returns `UNKNOWN_PRICE`
 * (`unknown: true`) and `computeCost` returns `{ cost_total: 0, unknown_model: true }`
 * (never throws) — mirroring the Claude Code bridge's `unknown_model_cost_zero`
 * pattern.
 *
 * agy does not report cached vs uncached prefix separately (the whole prefix is
 * one number in usage.input), so cache_read/cache_write stay 0 at runtime.
 *
 * Source: Google AI for Developers — Gemini API pricing + Anthropic pricing,
 * consulted 2026-06-20 (see the shared table for per-model citations).
 */

import {
  getModelPrice as sharedGetModelPrice,
  computeCost as sharedComputeCost,
  type ModelPrice as SharedModelPrice,
  type UsageForCost as SharedUsageForCost,
} from "../../shared/model-metadata.ts";

/** Per-million-token USD price for one model. Same shape as the shared module's. */
export type ModelPrice = SharedModelPrice;

/** Token-count blob mapped to UsageSummary keys. Same shape as the shared module's. */
export type UsageForCost = SharedUsageForCost;

/**
 * Look up a price entry for an agy model label (or canonical id), resolved
 * through the shared normalizer. Returns `UNKNOWN_PRICE` (all zeros,
 * `unknown: true`) if not found. Signature preserved for the call sites.
 */
export function getModelPrice(modelLabel: string): ModelPrice & { unknown: boolean } {
  return sharedGetModelPrice(modelLabel);
}

/**
 * Compute cost_total in USD for a given usage + agy model label (or canonical
 * id). Returns 0 for unknown models (never throws). Signature preserved.
 *
 * NOTE: thinking tokens are intentionally NOT passed here — `output` is
 * candidates only, so cost is a conservative lower bound for Gemini High-effort
 * turns. See usage-decoder.md.
 */
export function computeCost(
  usage: UsageForCost,
  modelLabel: string,
): { cost_total: number; unknown_model: boolean } {
  return sharedComputeCost(usage, modelLabel);
}
