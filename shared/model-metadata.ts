/**
 * Single source of truth for model → context window, model → price, and
 * model → provider id, shared by the out-of-process integrations (Antigravity
 * "agy", Claude Code) and the observability server/UI legacy-session fallback.
 *
 * Convention: edit ONE row here and every consumer picks it up. See
 * `shared/model-metadata.md` for the full convention, the normalizer rules,
 * the lossy-pair caveat, and how to add a model.
 *
 * Three key forms flow into one canonical bare-id key via `normalizeModelKey`:
 *   1. agy human display label  — "Gemini 3.5 Flash (High)"
 *   2. claude-code canonical id — "glm-5.2", "zai-org/GLM-5.2", "claude-opus-4-8"
 *   3. UI/model slug            — "gemini-3.5-flash"
 *
 * Importability: this module imports NOTHING (no node:, no bun:, no DOM). It
 * must stay importable by the Bun server, the Bun hook scripts, and (via the
 * server endpoint) the browser UI — the same constraint `shared/types.ts`
 * already satisfies. Do not add platform-specific imports.
 *
 * IMPORTANT — who does NOT consume this table:
 *   The pi extension (`extension/pi-observability.ts`) stays runtime-driven for
 *   `context_window` (it reads `ctx.getContextUsage().contextWindow` at
 *   message_end, which is strictly more accurate than any static table) and for
 *   cost (`event.message.usage.cost?.total`). This module is the fallback for
 *   the out-of-process integrations + the UI legacy path, NOT a replacement for
 *   pi's runtime values. Do not regress pi to this table.
 *
 * Registry source: models.dev `api.json`, consulted 2026-06-20.
 *   `just model-metadata-validate` cross-checks the tracked windows/prices
 *   against that registry (with graceful offline skip).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Per-million-token USD price for one model. Same shape as both integrations'
 *  pre-migration `ModelPrice`. */
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

/** Everything we know about one model. */
export interface ModelMeta {
  /** Context window in tokens (the denominator for the context bar). */
  context_window: number;
  /** Per-million-token price. `UNKNOWN_PRICE` when we carry the model for
   *  window/provider coverage but intentionally do not price it (preserves the
   *  historical "cost_total: 0" behavior for those families). */
  price: ModelPrice;
  /** Provider id matching what the integrations stamp (e.g. "zhipuai"). */
  provider: string;
}

export interface UsageForCost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Fallback when a model's price is unknown. All-zero → `computeCost` returns
 *  `cost_total: 0`. Exported so callers/tests can identity-compare. */
export const UNKNOWN_PRICE: ModelPrice = {
  input_per_million: 0,
  output_per_million: 0,
  cache_read_per_million: 0,
  cache_write_per_million: 0,
};

/** Default context window when a model is entirely unrecognized. Callers (UI,
 *  server endpoint) decide whether to use it; the lookups themselves return
 *  `undefined` for unknown models. Matches the legacy literal in app.js. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

// ─── Normalizer ─────────────────────────────────────────────────────────────

/**
 * Collapse any of the three key forms (agy label / canonical id / slug) into a
 * single lowercase bare-id key so one table answers all callers.
 *
 * Algorithm (documented step-by-step; see also shared/model-metadata.md):
 *   1. lowercase
 *   2. strip an `org/` prefix via `.replace(/^.*\//, "")`
 *      → "zai-org/GLM-5.2" and "z-ai/glm-4.6" become bare ids
 *   3. strip a trailing `(<effort>)` via `.replace(/\s*\([^)]*\)\s*$/, "")`
 *      → "Gemini 3.5 Flash (High)" loses "(High)"
 *   4. unify separators `.replace(/[-_\s]+/g, "-")`
 *      → "gemini 3.5 flash" and "gemini-3.5-flash" collide (space ↔ hyphen).
 *      NOTE: `.` is intentionally NOT unified, so "3.5" stays "3.5".
 *   5. strip a trailing date stamp `.replace(/-(\d{8})$/, "")`
 *      → "claude-3-5-sonnet-20241022" → "claude-3-5-sonnet"
 *   6. repeatedly strip trailing id-noise tokens `-a | -thinking | -preview |
 *      -latest | -snapshot`
 *      → "gemini-3-flash-a" → "gemini-3-flash"; "claude-opus-4-6-thinking" →
 *      "claude-opus-4-6"
 *   7. collapse `--+` → `-` and trim leading/trailing `-`
 *
 * Lossy-pair caveat (the #1 risk — see shared/model-metadata.md):
 *   The agy display label "Gemini 3.5 Flash (High)" and the real agy model_id
 *   "gemini-3-flash-a" normalize to DIFFERENT keys — `gemini-3.5-flash` vs
 *   `gemini-3-flash` — because the label says version "3.5" while the id says
 *   "3" (then "-a"). The normalizer cannot reconcile a label/id version
 *   disagreement; only explicit `MODEL_TABLE` entries can. So the table carries
 *   BOTH keys (both = 1M window). The self-test (scripts/model-metadata-selftest.ts)
 *   asserts both resolve.
 */
export function normalizeModelKey(raw: string | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  s = s.replace(/^.*\//, ""); // 2. strip org/ prefix
  s = s.replace(/\s*\([^)]*\)\s*$/, ""); // 3. strip trailing (effort)
  s = s.replace(/[-_\s]+/g, "-"); // 4. unify separators → -
  s = s.replace(/-(\d{8})$/, ""); // 5. strip trailing -YYYYMMDD date
  // 6. repeatedly strip trailing id-noise tokens
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(/-(a|thinking|preview|latest|snapshot)$/, "");
  }
  s = s.replace(/-{2,}/g, "-"); // 7a. collapse --
  s = s.replace(/^-+|-+$/g, ""); // 7b. trim edge hyphens
  return s;
}

// ─── Model table ────────────────────────────────────────────────────────────
//
// Prices are per-million tokens in USD. Context windows are in tokens.
//
// Source: the models.dev registry api.json (consulted 2026-06-20), using the
// canonical first-party provider entry for each model (anthropic/, google/,
// openai/, zai/ for Z.AI international, deepseek/). For models with multiple
// provider listings at different price points (e.g. zhipuai/glm-5.1 list vs
// zai/glm-5.1 post-cut), we use the endpoint most users actually route
// through (zai/ for GLM, since opencode-go and the international Z.AI API
// hit that).
//
// `just model-metadata-validate` cross-checks this table against the
// registry and reports drift. Run it after any provider reprices.

// Reused price constants keep the table readable and DRY.
// Claude 4.x Opus (4-5/4-6/4-7/4-8) all share Anthropic's $5/$25 API rate
// (cache_read $0.5, cache_write $6.25) — verified via anthropic/ entries in
// the models.dev registry 2026-06-20. (The pre-migration local table wrongly
// used the legacy 3-Opus $15/$75 rate for 4.x Opus; corrected here.)
const P_CLAUDE_OPUS4: ModelPrice = {
  input_per_million: 5.0, output_per_million: 25.0,
  cache_read_per_million: 0.5, cache_write_per_million: 6.25,
};
// Legacy Claude 3 Opus (claude-3-opus-20240229) keeps its original $15/$75 rate.
const P_CLAUDE_3_OPUS: ModelPrice = {
  input_per_million: 15.0, output_per_million: 75.0,
  cache_read_per_million: 1.5, cache_write_per_million: 18.75,
};
// Claude Sonnet 3.5/3.7/4.x all share $3/$15 (cr $0.3, cw $3.75).
const P_CLAUDE_SONNET: ModelPrice = {
  input_per_million: 3.0, output_per_million: 15.0,
  cache_read_per_million: 0.3, cache_write_per_million: 3.75,
};
// Claude Haiku 4-5: $1/$5 (cr $0.1, cw $1.25) — anthropic/ registry entry.
// (The pre-migration local table wrongly used the 3.5-Haiku $0.8/$4 rate; corrected.)
const P_CLAUDE_HAIKU4: ModelPrice = {
  input_per_million: 1.0, output_per_million: 5.0,
  cache_read_per_million: 0.1, cache_write_per_million: 1.25,
};
// Legacy Claude 3.5 Haiku / 3 Haiku keep their original rates.
const P_CLAUDE_3_5_HAIKU: ModelPrice = {
  input_per_million: 0.8, output_per_million: 4.0,
  cache_read_per_million: 0.08, cache_write_per_million: 1.0,
};
const P_CLAUDE_3_HAIKU: ModelPrice = {
  input_per_million: 0.25, output_per_million: 1.25,
  cache_read_per_million: 0.03, cache_write_per_million: 0.3,
};
// GLM (Z.AI / Zhipu) — per-model rates from the zai/ (international Z.AI)
// entries in the models.dev registry (consulted 2026-06-20). GLM-5.2 and
// GLM-5.1 share the current $1.4/$4.4 coding-tier rate; older GLM-5 and
// GLM-4.6/4.7 have their own lower rates. cache_write = 0 is honest: Z.AI
// reports no cache-write billing and the claude-code transcript reports
// cache_creation_input_tokens as 0 for GLM models.
const P_GLM_52: ModelPrice = {
  input_per_million: 1.4, output_per_million: 4.4,
  cache_read_per_million: 0.26, cache_write_per_million: 0,
};
const P_GLM_5: ModelPrice = {
  input_per_million: 1.0, output_per_million: 3.2,
  cache_read_per_million: 0.2, cache_write_per_million: 0,
};
const P_GLM_4: ModelPrice = {
  input_per_million: 0.6, output_per_million: 2.2,
  cache_read_per_million: 0.11, cache_write_per_million: 0,
};

function gemini(in_: number, out: number, cr: number): ModelPrice {
  // Gemini implicit caching bills hourly storage, no per-token write fee →
  // cache_write_per_million stays 0 (matches the agy price table).
  return { input_per_million: in_, output_per_million: out, cache_read_per_million: cr, cache_write_per_million: 0 };
}

const PROVIDER = {
  anthropic: "anthropic",
  zhipuai: "zhipuai",
  google: "google",
  openai: "openai",
  deepseek: "deepseek",
  qwen: "qwen",
  moonshotai: "moonshotai",
} as const;

export const MODEL_TABLE: Record<string, ModelMeta> = {
  // ── Claude (Anthropic) ───────────────────────────────────────────────────
  // Windows: opus-4-6/4-7/4-8 + sonnet-4-6 ship 1M by default; other Claude
  // 4.x/3.x are 200k. Prices from anthropic/ registry entries (2026-06-20):
  // 4.x Opus $5/$25, Sonnet $3/$15, Haiku 4-5 $1/$5; legacy 3-Opus $15/$75,
  // 3.5-Haiku $0.8/$4, 3-Haiku $0.25/$1.25.
  "claude-opus-4-8": { context_window: 1_000_000, price: P_CLAUDE_OPUS4, provider: PROVIDER.anthropic },
  "claude-opus-4": { context_window: 200_000, price: P_CLAUDE_OPUS4, provider: PROVIDER.anthropic },
  "claude-sonnet-4-6": { context_window: 1_000_000, price: P_CLAUDE_SONNET, provider: PROVIDER.anthropic },
  "claude-sonnet-4": { context_window: 200_000, price: P_CLAUDE_SONNET, provider: PROVIDER.anthropic },
  "claude-3-5-sonnet": { context_window: 200_000, price: P_CLAUDE_SONNET, provider: PROVIDER.anthropic }, // claude-3-5-sonnet-20241022 / -20240620
  "claude-3-7-sonnet": { context_window: 200_000, price: P_CLAUDE_SONNET, provider: PROVIDER.anthropic }, // claude-3-7-sonnet-20250219
  "claude-haiku-4-5": { context_window: 200_000, price: P_CLAUDE_HAIKU4, provider: PROVIDER.anthropic },
  "claude-haiku-4": { context_window: 200_000, price: P_CLAUDE_HAIKU4, provider: PROVIDER.anthropic },
  "claude-3-5-haiku": { context_window: 200_000, price: P_CLAUDE_3_5_HAIKU, provider: PROVIDER.anthropic }, // claude-3-5-haiku-20241022
  "claude-3-haiku": { context_window: 200_000, price: P_CLAUDE_3_HAIKU, provider: PROVIDER.anthropic }, // claude-3-haiku-20240307
  "claude-3-opus": { context_window: 200_000, price: P_CLAUDE_3_OPUS, provider: PROVIDER.anthropic }, // claude-3-opus-20240229

  // ── GLM (Z.AI / Zhipu) ───────────────────────────────────────────────────
  // glm-5.2 advertises a 1M window; glm-5.1/4.6/4.7 are 200k; glm-5 is
  // 204800. Prices: glm-5.2/5.1 share the $1.4/$4.4 coding-tier rate; glm-5
  // is $1.0/$3.2; glm-4.6/4.7 are $0.6/$2.2. cache_write = 0 (Z.AI reports no
  // cache-write billing).
  "glm-5.2": { context_window: 1_000_000, price: P_GLM_52, provider: PROVIDER.zhipuai },
  "glm-5.1": { context_window: 200_000, price: P_GLM_52, provider: PROVIDER.zhipuai },
  "glm-5": { context_window: 204_800, price: P_GLM_5, provider: PROVIDER.zhipuai },
  "glm-4.7": { context_window: 200_000, price: P_GLM_4, provider: PROVIDER.zhipuai },
  "glm-4.6": { context_window: 204_800, price: P_GLM_4, provider: PROVIDER.zhipuai },

  // ── Gemini (Google) ──────────────────────────────────────────────────────
  // All current Gemini 2.x/3.x variants advertise a 1M window; 1.5 Pro is 2M.
  // Prices reproduce the pre-migration agy table (consulted 2026-06-20).
  //
  // LOSSY PAIR: the label "Gemini 3.5 Flash (High)" → `gemini-3.5-flash`, but
  // the real agy model_id `gemini-3-flash-a` → `gemini-3-flash`. BOTH keys are
  // carried (both 1M) so the label form (used by agy for cost) and the id form
  // both resolve. `gemini-3-flash` is ALSO Google's canonical slug for the
  // cheaper "Gemini 3 Flash" model (in 0.5/out 3) — agy never computes cost
  // from the bare id (it passes the label), so the pricing assigned to
  // `gemini-3-flash` only affects the id/canonical path, where Gemini 3 Flash
  // rates are correct. See shared/model-metadata.md.
  "gemini-3.5-flash": { context_window: 1_000_000, price: gemini(1.5, 9.0, 0.15), provider: PROVIDER.google },
  "gemini-3-flash": { context_window: 1_000_000, price: gemini(0.5, 3.0, 0.05), provider: PROVIDER.google },
  "gemini-3-pro": { context_window: 1_000_000, price: gemini(2.0, 12.0, 0.2), provider: PROVIDER.google },
  "gemini-3.1-pro": { context_window: 1_000_000, price: gemini(2.0, 12.0, 0.2), provider: PROVIDER.google },
  "gemini-2.5-flash": { context_window: 1_000_000, price: gemini(0.3, 2.5, 0.03), provider: PROVIDER.google },
  "gemini-2.5-pro": { context_window: 1_000_000, price: gemini(1.25, 10.0, 0.13), provider: PROVIDER.google },
  "gemini-2-flash": { context_window: 1_000_000, price: gemini(0.1, 0.4, 0.01), provider: PROVIDER.google },
  "gemini-2.0-flash": { context_window: 1_000_000, price: gemini(0.1, 0.4, 0.01), provider: PROVIDER.google }, // canonical-id alias of gemini-2-flash
  "gemini-1.5-flash": { context_window: 1_000_000, price: gemini(0.075, 0.3, 0.01), provider: PROVIDER.google },
  "gemini-1.5-pro": { context_window: 2_000_000, price: gemini(1.25, 5.0, 0.31), provider: PROVIDER.google },

  // ── GPT / o-series (OpenAI) ──────────────────────────────────────────────
  // Windows + prices from the openai/ registry entries (consulted
  // 2026-06-20). gpt-5 $1.25/$10 (cr $0.125), gpt-4o $2.5/$10 (cr $1.25),
  // o1 $15/$60 (cr $7.5), o3 $2/$8 (cr $0.5). cache_write = 0 (OpenAI reports
  // no cache-write billing). Windows mirror the registry.
  "gpt-5": { context_window: 400_000, price: { input_per_million: 1.25, output_per_million: 10.0, cache_read_per_million: 0.125, cache_write_per_million: 0 }, provider: PROVIDER.openai },
  "gpt-4o": { context_window: 128_000, price: { input_per_million: 2.5, output_per_million: 10.0, cache_read_per_million: 1.25, cache_write_per_million: 0 }, provider: PROVIDER.openai },
  "gpt-4": { context_window: 128_000, price: UNKNOWN_PRICE, provider: PROVIDER.openai }, // legacy gpt-4 (32k variant) — registry price $30/$60 not wired (rarely routed via these harnesses)
  "o1": { context_window: 200_000, price: { input_per_million: 15.0, output_per_million: 60.0, cache_read_per_million: 7.5, cache_write_per_million: 0 }, provider: PROVIDER.openai },
  "o3": { context_window: 200_000, price: { input_per_million: 2.0, output_per_million: 8.0, cache_read_per_million: 0.5, cache_write_per_million: 0 }, provider: PROVIDER.openai },

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  // 64k mirrors pi's own context-bar cap for DeepSeek (verified against a live
  // deepseek-v4-flash session). Prices from the deepseek/ registry entries
  // (consulted 2026-06-20): deepseek-v3 $0.287/$1.147, deepseek-r1
  // $0.574/$2.294 (131072 window). cache_write = 0. The generic "deepseek"
  // key uses v3 rates as the conservative default for the family.
  "deepseek": { context_window: 64_000, price: { input_per_million: 0.287, output_per_million: 1.147, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.deepseek },
  "deepseek-v3": { context_window: 65_536, price: { input_per_million: 0.287, output_per_million: 1.147, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.deepseek },
  "deepseek-r1": { context_window: 131_072, price: { input_per_million: 0.574, output_per_million: 2.294, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.deepseek },

  // ── Qwen (Alibaba) — NEW, sourced from models.dev (2026-06-20) ───────────
  // cache_read/cache_write are 0 where the registry omits them.
  "qwen-max": { context_window: 32_768, price: { input_per_million: 1.6, output_per_million: 6.4, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.qwen },
  "qwen3-max": { context_window: 262_144, price: { input_per_million: 1.2, output_per_million: 6, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.qwen },
  "qwen3.7-max": { context_window: 1_000_000, price: { input_per_million: 2.5, output_per_million: 7.5, cache_read_per_million: 0.5, cache_write_per_million: 3.125 }, provider: PROVIDER.qwen },
  "qwen-plus": { context_window: 1_000_000, price: { input_per_million: 0.4, output_per_million: 1.2, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.qwen },
  "qwen3.5-plus": { context_window: 1_000_000, price: { input_per_million: 0.4, output_per_million: 2.4, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.qwen },
  "qwen3-coder-plus": { context_window: 1_048_576, price: { input_per_million: 1, output_per_million: 5, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.qwen },
  "qwen-flash": { context_window: 1_000_000, price: { input_per_million: 0.05, output_per_million: 0.4, cache_read_per_million: 0, cache_write_per_million: 0 }, provider: PROVIDER.qwen },

  // ── Kimi (Moonshot AI) — NEW, sourced from models.dev (2026-06-20) ───────
  // Registry omits cache_write for Kimi → 0 (no per-token write fee reported).
  "kimi-k2.5": { context_window: 262_144, price: { input_per_million: 0.6, output_per_million: 3, cache_read_per_million: 0.1, cache_write_per_million: 0 }, provider: PROVIDER.moonshotai },
  "kimi-k2.6": { context_window: 262_144, price: { input_per_million: 0.95, output_per_million: 4, cache_read_per_million: 0.16, cache_write_per_million: 0 }, provider: PROVIDER.moonshotai },
  "kimi-k2": { context_window: 262_144, price: { input_per_million: 0.6, output_per_million: 2.5, cache_read_per_million: 0.15, cache_write_per_million: 0 }, provider: PROVIDER.moonshotai }, // kimi-k2-thinking (stripped)
  "kimi-k2-thinking-turbo": { context_window: 262_144, price: { input_per_million: 1.15, output_per_million: 8, cache_read_per_million: 0.15, cache_write_per_million: 0 }, provider: PROVIDER.moonshotai },
  "kimi-k2-turbo": { context_window: 262_144, price: { input_per_million: 2.4, output_per_million: 10, cache_read_per_million: 0.6, cache_write_per_million: 0 }, provider: PROVIDER.moonshotai }, // kimi-k2-turbo-preview (stripped)
};

// ─── Internal resolution ────────────────────────────────────────────────────

/** Find the ModelMeta for a raw model string: exact match on the normalized
 *  key first, then both-direction prefix match (mirrors the pre-migration
 *  agy/cc `getModelPrice` resolution so e.g. "glm-5.2-0215" still hits glm-5.2).
 *  Returns undefined when unknown. */
function resolveModelMeta(raw: string | undefined): ModelMeta | undefined {
  if (!raw) return undefined;
  const key = normalizeModelKey(raw);
  if (!key) return undefined;
  const exact = MODEL_TABLE[key];
  if (exact) return exact;
  for (const [tableKey, meta] of Object.entries(MODEL_TABLE)) {
    if (key.startsWith(tableKey) || tableKey.startsWith(key)) return meta;
  }
  return undefined;
}

/** True when a price is the all-zero sentinel. Used so models carried only for
 *  window/provider coverage (GPT, o-series, DeepSeek) keep producing
 *  cost_total: 0 + unknown_model: true, exactly as the pre-migration tables did
 *  (which simply omitted those families). No legitimately-priced entry in
 *  MODEL_TABLE is all-zero. */
function isUnknownPrice(p: ModelPrice): boolean {
  return (
    p.input_per_million === 0 &&
    p.output_per_million === 0 &&
    p.cache_read_per_million === 0 &&
    p.cache_write_per_million === 0
  );
}

// ─── Public lookups ─────────────────────────────────────────────────────────

/**
 * Resolve a context window (tokens) for any model string (label, canonical id,
 * or slug). Returns `undefined` for unrecognized models — callers/UI decide the
 * default (the server endpoint uses DEFAULT_CONTEXT_WINDOW).
 */
export function contextWindowForModelKey(raw: string | undefined): number | undefined {
  return resolveModelMeta(raw)?.context_window;
}

/**
 * Look up a price entry for any model string. Returns the resolved price with
 * `unknown: false`, or `UNKNOWN_PRICE` with `unknown: true` when the model is
 * absent OR carried only for window/provider coverage (all-zero price).
 * Never throws.
 */
export function getModelPrice(raw: string): ModelPrice & { unknown: boolean } {
  const meta = resolveModelMeta(raw);
  if (!meta) return { ...UNKNOWN_PRICE, unknown: true };
  if (isUnknownPrice(meta.price)) return { ...UNKNOWN_PRICE, unknown: true };
  return { ...meta.price, unknown: false };
}

/**
 * Resolve a provider id for any model string (e.g. "zhipuai", "google"). Returns
 * `undefined` for unrecognized models — callers keep their existing fallback
 * (claude-code → "anthropic").
 */
export function providerForModelKey(raw: string | undefined): string | undefined {
  return resolveModelMeta(raw)?.provider;
}

/**
 * Compute cost_total in USD for a usage blob + model. Returns 0 for unknown /
 * unpriced models (never throws). Identical shape + contract to the
 * pre-migration integrations' `computeCost`.
 */
export function computeCost(
  usage: UsageForCost,
  raw: string,
): { cost_total: number; unknown_model: boolean } {
  try {
    const price = getModelPrice(raw);
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
