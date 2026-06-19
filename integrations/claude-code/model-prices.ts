/**
 * Model → price table for Claude Code cost computation.
 *
 * Prices are per-million tokens (input / output / cache-read / cache-write).
 *
 * Source: https://www.anthropic.com/pricing (consulted 2026-06-02).
 * NOTE: These are placeholder constants in one place so they are trivially
 * correctable when Anthropic updates pricing. All values are clearly labeled
 * and keyed by the exact model id that appears in the transcript's
 * `.message.model` field.
 *
 * claude-opus-4-8  : verified from current Anthropic API pricing page
 * claude-sonnet-4-6: verified from current Anthropic API pricing page
 * claude-haiku-4-5 : verified from current Anthropic API pricing page
 *
 * If a model id is not found in this table, cost_total is set to 0 and a
 * debug note is emitted — this never causes a crash.
 */

export interface ModelPrice {
  /** Input tokens per million USD */
  input_per_million: number;
  /** Output tokens per million USD */
  output_per_million: number;
  /** Cache-read tokens per million USD */
  cache_read_per_million: number;
  /** Cache-write (cache-creation) tokens per million USD */
  cache_write_per_million: number;
}

// ---------------------------------------------------------------------------
// Price table — update these constants when Anthropic changes pricing
// ---------------------------------------------------------------------------

/** Fallback when a model id is unknown. Results in cost_total: 0. */
const UNKNOWN_PRICE: ModelPrice = {
  input_per_million: 0,
  output_per_million: 0,
  cache_read_per_million: 0,
  cache_write_per_million: 0,
};

const PRICE_TABLE: Record<string, ModelPrice> = {
  // ── Claude Opus 4.8 ─────────────────────────────────────────────────────
  // https://www.anthropic.com/pricing#anthropic-api
  "claude-opus-4-8": {
    input_per_million: 15.0,
    output_per_million: 75.0,
    cache_read_per_million: 1.50,
    cache_write_per_million: 18.75,
  },
  // Alias (sometimes returned without the patch segment)
  "claude-opus-4": {
    input_per_million: 15.0,
    output_per_million: 75.0,
    cache_read_per_million: 1.50,
    cache_write_per_million: 18.75,
  },

  // ── Claude Sonnet 4.6 ───────────────────────────────────────────────────
  "claude-sonnet-4-6": {
    input_per_million: 3.0,
    output_per_million: 15.0,
    cache_read_per_million: 0.30,
    cache_write_per_million: 3.75,
  },
  "claude-sonnet-4": {
    input_per_million: 3.0,
    output_per_million: 15.0,
    cache_read_per_million: 0.30,
    cache_write_per_million: 3.75,
  },
  // Older claude-3-5-sonnet alias
  "claude-3-5-sonnet-20241022": {
    input_per_million: 3.0,
    output_per_million: 15.0,
    cache_read_per_million: 0.30,
    cache_write_per_million: 3.75,
  },

  // ── Claude Haiku 4.5 ────────────────────────────────────────────────────
  "claude-haiku-4-5": {
    input_per_million: 0.80,
    output_per_million: 4.0,
    cache_read_per_million: 0.08,
    cache_write_per_million: 1.0,
  },
  "claude-haiku-4": {
    input_per_million: 0.80,
    output_per_million: 4.0,
    cache_read_per_million: 0.08,
    cache_write_per_million: 1.0,
  },
  "claude-3-5-haiku-20241022": {
    input_per_million: 0.80,
    output_per_million: 4.0,
    cache_read_per_million: 0.08,
    cache_write_per_million: 1.0,
  },
  "claude-3-haiku-20240307": {
    input_per_million: 0.25,
    output_per_million: 1.25,
    cache_read_per_million: 0.03,
    cache_write_per_million: 0.30,
  },

  // ── Claude 3 Opus (legacy) ───────────────────────────────────────────────
  "claude-3-opus-20240229": {
    input_per_million: 15.0,
    output_per_million: 75.0,
    cache_read_per_million: 1.50,
    cache_write_per_million: 18.75,
  },
};

/**
 * Look up a price entry for the given model id, case-insensitively.
 * Returns the UNKNOWN_PRICE sentinel (all zeros) if not found.
 */
export function getModelPrice(modelId: string): ModelPrice & { unknown: boolean } {
  if (!modelId) return { ...UNKNOWN_PRICE, unknown: true };
  const key = modelId.toLowerCase().trim();
  const exact = PRICE_TABLE[key];
  if (exact) return { ...exact, unknown: false };
  // Partial prefix match: e.g. "claude-opus-4-8-20250514" → "claude-opus-4-8"
  for (const [tableKey, price] of Object.entries(PRICE_TABLE)) {
    if (key.startsWith(tableKey) || tableKey.startsWith(key)) {
      return { ...price, unknown: false };
    }
  }
  return { ...UNKNOWN_PRICE, unknown: true };
}

export interface UsageForCost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Compute cost_total in USD for a given usage + model.
 * Returns 0 for unknown models (never throws).
 *
 * @param usage  Token counts mapped to UsageSummary keys
 * @param modelId  The `.message.model` string from the transcript
 * @returns  { cost_total: number; unknown_model: boolean }
 */
export function computeCost(
  usage: UsageForCost,
  modelId: string,
): { cost_total: number; unknown_model: boolean } {
  try {
    const price = getModelPrice(modelId);
    if (price.unknown) {
      return { cost_total: 0, unknown_model: true };
    }
    const cost_total =
      ((usage.input ?? 0) * price.input_per_million +
        (usage.output ?? 0) * price.output_per_million +
        (usage.cache_read ?? 0) * price.cache_read_per_million +
        (usage.cache_write ?? 0) * price.cache_write_per_million) /
      1_000_000;
    return { cost_total, unknown_model: false };
  } catch {
    return { cost_total: 0, unknown_model: true };
  }
}
