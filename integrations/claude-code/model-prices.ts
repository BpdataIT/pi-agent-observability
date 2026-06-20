/**
 * Model → price table for Claude Code cost computation.
 *
 * THIN WRAPPER — delegates to the single source of truth at
 * `shared/model-metadata.ts` (see `shared/model-metadata.md`). This file
 * exists only to preserve the `getModelPrice` / `computeCost` / `ModelPrice` /
 * `UsageForCost` signatures used by `transcript.ts` and `obs-hook.test.ts`; the
 * price table + normalizer live in the shared module.
 *
 * Prices are per-million tokens (USD). The transcript carries no `cost` field
 * — only token counts and a model id — so the bridge computes cost_total here:
 *
 *   cost_total = (input*in + output*out + cache_read*cr + cache_write*cw) / 1e6
 *
 * The shared table covers Claude + GLM (Z.AI / Zhipu) + Gemini + the new
 * Qwen/Kimi families. If a model id is not found, `getModelPrice` returns
 * `UNKNOWN_PRICE` (`unknown: true`) and `computeCost` returns
 * `{ cost_total: 0, unknown_model: true }` (never throws) — the
 * `unknown_model_cost_zero` pattern.
 *
 * Source: https://www.anthropic.com/pricing + models.dev registry, consulted
 * 2026-06-20 (see the shared table for per-model citations). NOTE: some legacy
 * Claude/GLM entries intentionally keep their pre-migration values for the
 * Phase 2/3 no-op (e.g. claude-opus-4-8 stays 15/75 though the registry lists
 * 5/25); `just model-metadata-validate` reports that drift.
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
 * Look up a price entry for the given model id (canonical id, org/model form,
 * or dated alias), resolved through the shared normalizer. Returns the
 * UNKNOWN_PRICE sentinel (all zeros, `unknown: true`) if not found. Signature
 * preserved for the `transcript.ts` / `obs-hook.test.ts` call sites.
 */
export function getModelPrice(modelId: string): ModelPrice & { unknown: boolean } {
  return sharedGetModelPrice(modelId);
}

/**
 * Compute cost_total in USD for a given usage + model id. Returns 0 for unknown
 * models (never throws). Signature preserved.
 *
 * @param usage   Token counts mapped to UsageSummary keys.
 * @param modelId The `.message.model` string from the transcript.
 */
export function computeCost(
  usage: UsageForCost,
  modelId: string,
): { cost_total: number; unknown_model: boolean } {
  return sharedComputeCost(usage, modelId);
}
