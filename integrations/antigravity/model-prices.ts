/**
 * Model → price table for Antigravity (agy) cost computation.
 *
 * Mirrors the shape of `integrations/claude-code/model-prices.ts`
 * (`ModelPrice`, `getModelPrice`, `computeCost`) so the agy bridge computes
 * cost exactly the way the Claude Code bridge does — but keyed by the
 * **normalized human model label** agy exposes (e.g. "Gemini 3.5 Flash (High)"),
 * the same string `model-context.ts:contextWindowForLabel` keys on.
 *
 * Prices are per-million tokens (input / output / cache-read / cache-write) in USD.
 *
 * Source: Google AI for Developers — Gemini API pricing
 * (https://ai.google.dev/gemini-api/docs/pricing), consulted 2026-06-20.
 * Anthropic prices from https://www.anthropic.com/pricing (agy can drive Claude
 * models via the same hook, so Claude entries are included).
 *
 * NOTE: These are placeholder constants in one place so they are trivially
 * correctable when Google/Anthropic update pricing. All values are clearly
 * labeled and keyed by the normalized model label. agy model ids observed in
 * the corpus: `gemini-3-flash-a`, `claude-opus-4-6-thinking`.
 *
 * If a label is not found, `getModelPrice` returns `UNKNOWN_PRICE`
 * (`cost_total: 0`) and `computeCost` sets `unknown_model: true` (never throws)
 * — mirrors the Claude Code `unknown_model_cost_zero` pattern.
 *
 * agy does not report cached vs uncached prefix separately (the whole prefix is
 * one number in usage.input), so cache_read/cache_write stay 0 at runtime and
 * these per-million cache rates are unused for now — they are present for shape
 * parity and future use.
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
// Label normalization — MUST match model-context.ts:contextWindowForLabel
// ---------------------------------------------------------------------------

/**
 * Normalize an agy model label/id to a single lowercase key, stripping the
 * trailing `(<effort>)` effort suffix and the `-a` / `-thinking` id suffixes
 * so "Gemini 3.5 Flash (High)", "gemini-3-flash-a", and "gemini 3.5 flash" all
 * map to the same price entry. Mirrors the lowercasing/effort-strip in
 * `contextWindowForLabel` so the price key and the context-window key agree.
 */
export function normalizeModelLabel(label: string | undefined): string {
  if (!label) return "";
  return label
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "") // strip trailing "(High)" etc.
    .replace(/[-_]/g, " ") // "gemini-3-flash-a" → "gemini 3 flash a"
    .replace(/\b(a|thinking|preview|latest)\b/g, " ") // drop id/version noise
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Price table — update these constants when Google/Anthropic change pricing
// ---------------------------------------------------------------------------

/** Fallback when a model label is unknown. Results in cost_total: 0. */
const UNKNOWN_PRICE: ModelPrice = {
  input_per_million: 0,
  output_per_million: 0,
  cache_read_per_million: 0,
  cache_write_per_million: 0,
};

const PRICE_TABLE: Record<string, ModelPrice> = {
  // ── Gemini 3.5 Flash ────────────────────────────────────────────────────
  // https://ai.google.dev/gemini-api/docs/pricing (consulted 2026-06-20)
  // Output price includes thinking tokens (billed at the output rate).
  "gemini 3.5 flash": {
    input_per_million: 1.5,
    output_per_million: 9.0,
    cache_read_per_million: 0.15,
    cache_write_per_million: 0, // Gemini implicit caching: storage is hourly, no per-token write fee
  },

  // ── Gemini 3 Pro (gemini-3-pro-preview / gemini-3.1-pro-preview) ────────
  // <200K tier: in $2 / out $12 / cached $0.20
  "gemini 3 pro": {
    input_per_million: 2.0,
    output_per_million: 12.0,
    cache_read_per_million: 0.2,
    cache_write_per_million: 0,
  },
  "gemini 3.1 pro": {
    input_per_million: 2.0,
    output_per_million: 12.0,
    cache_read_per_million: 0.2,
    cache_write_per_million: 0,
  },

  // ── Gemini 3 Flash (gemini-3-flash-preview) ─────────────────────────────
  "gemini 3 flash": {
    input_per_million: 0.5,
    output_per_million: 3.0,
    cache_read_per_million: 0.05,
    cache_write_per_million: 0,
  },

  // ── Gemini 2.5 Flash ────────────────────────────────────────────────────
  "gemini 2.5 flash": {
    input_per_million: 0.3,
    output_per_million: 2.5,
    cache_read_per_million: 0.03,
    cache_write_per_million: 0,
  },

  // ── Gemini 2.5 Pro (<200K tier) ─────────────────────────────────────────
  "gemini 2.5 pro": {
    input_per_million: 1.25,
    output_per_million: 10.0,
    cache_read_per_million: 0.13,
    cache_write_per_million: 0,
  },

  // ── Gemini 2.0 Flash ────────────────────────────────────────────────────
  "gemini 2 flash": {
    input_per_million: 0.1,
    output_per_million: 0.4,
    cache_read_per_million: 0.01,
    cache_write_per_million: 0,
  },

  // ── Gemini 1.5 Flash / Pro (legacy) ─────────────────────────────────────
  "gemini 1.5 flash": {
    input_per_million: 0.075,
    output_per_million: 0.3,
    cache_read_per_million: 0.01,
    cache_write_per_million: 0,
  },
  "gemini 1.5 pro": {
    input_per_million: 1.25,
    output_per_million: 5.0,
    cache_read_per_million: 0.31,
    cache_write_per_million: 0,
  },

  // ── Claude (agy can drive Claude models via the same hook) ──────────────
  // https://www.anthropic.com/pricing — matches integrations/claude-code/model-prices.ts
  "claude opus 4 6": {
    input_per_million: 15.0,
    output_per_million: 75.0,
    cache_read_per_million: 1.5,
    cache_write_per_million: 18.75,
  },
  "claude opus 4": {
    input_per_million: 15.0,
    output_per_million: 75.0,
    cache_read_per_million: 1.5,
    cache_write_per_million: 18.75,
  },
  "claude sonnet 4 6": {
    input_per_million: 3.0,
    output_per_million: 15.0,
    cache_read_per_million: 0.3,
    cache_write_per_million: 3.75,
  },
  "claude sonnet 4": {
    input_per_million: 3.0,
    output_per_million: 15.0,
    cache_read_per_million: 0.3,
    cache_write_per_million: 3.75,
  },
  "claude haiku 4 5": {
    input_per_million: 0.8,
    output_per_million: 4.0,
    cache_read_per_million: 0.08,
    cache_write_per_million: 1.0,
  },
};

/**
 * Look up a price entry for an agy model label (or canonical id), case/space
 * normalized via `normalizeModelLabel`. Returns `UNKNOWN_PRICE` (all zeros,
 * `unknown: true`) if not found.
 */
export function getModelPrice(modelLabel: string): ModelPrice & { unknown: boolean } {
  if (!modelLabel) return { ...UNKNOWN_PRICE, unknown: true };
  const key = normalizeModelLabel(modelLabel);
  if (!key) return { ...UNKNOWN_PRICE, unknown: true };
  const exact = PRICE_TABLE[key];
  if (exact) return { ...exact, unknown: false };
  // Partial match: "gemini 3.5 flash" matches a key that starts with it or
  // vice-versa, so version drift ("gemini 3.5 flash v2") still resolves.
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
 * Compute cost_total in USD for a given usage + agy model label.
 * Returns 0 for unknown models (never throws).
 *
 * NOTE: thinking tokens (UsageRecord raw f9) are intentionally NOT passed here
 * — `output` is candidates only, so cost is a conservative lower bound for
 * Gemini High-effort turns. See usage-decoder.md.
 */
export function computeCost(
  usage: UsageForCost,
  modelLabel: string,
): { cost_total: number; unknown_model: boolean } {
  try {
    const price = getModelPrice(modelLabel);
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
