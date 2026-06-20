/**
 * Model → context window map for Claude Code sessions.
 *
 * Claude Code's hook payloads and JSONL transcript do NOT expose the model's
 * context window, and — unlike the pi extension — the claude-code hook runs
 * out-of-process with no access to pi's ctx.getContextUsage(). So we resolve
 * the window from the canonical model id here and stamp it onto the
 * assistant_message event as `context_window` (the same field the pi extension
 * and the agy integration write, and the server/UI read).
 *
 * This keeps the observability context bar denominator correct for any model
 * routed through the Claude Code harness — including non-Anthropic models
 * like glm-5.2 (1M) that the shared UI's MODEL_CONTEXT_WINDOWS regex table
 * would otherwise mis-size (it maps /^glm-/i → 128_000, which underflows the
 * real 1M window and makes the bar overflow).
 *
 * Windows mirror the authoritative values in apps/observability/public/app.js
 * (MODEL_CONTEXT_WINDOWS) and the models.dev registry. Update both together
 * when a provider ships a new window.
 *
 * Keyed by the canonical lowercase model id as it appears in the transcript's
 * `.message.model` field (e.g. "glm-5.2", "claude-opus-4-8",
 * "zai-org/GLM-5.2"). Matching is case-insensitive; a normalized-id helper
 * handles the `org/model` form some providers emit.
 */

/**
 * Resolve a context window (in tokens) for a model id.
 * Returns `undefined` for unrecognized ids so the UI can fall back to its
 * own MODEL_CONTEXT_WINDOWS table / default.
 */
export function contextWindowForModel(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  // Normalize: lowercase, strip an "org/" prefix (e.g. "zai-org/GLM-5.2" →
  // "glm-5.2"), trim. Keep the bare id form the UI regex table also keys on.
  const id = modelId.toLowerCase().replace(/^.*\//, "").trim();
  if (!id) return undefined;

  // ── GLM (Z.AI / Zhipu) ────────────────────────────────────────────────
  // glm-5.2 advertises a 1M context window (verified via models.dev registry
  // api.json, 2026-06-20). Older GLM variants ship 128k–200k; the UI table
  // maps /^glm-/i → 128k, so only pin the models we know are larger.
  if (id.startsWith("glm-5.2")) return 1_000_000;
  if (id.startsWith("glm-5.1")) return 200_000;
  if (id.startsWith("glm-5"))   return 204_800;
  if (id.startsWith("glm-4.7")) return 200_000;
  if (id.startsWith("glm-4.6")) return 204_800;

  // ── Claude (Anthropic) ────────────────────────────────────────────────
  // Opus 4.8 and Sonnet 4.6 ship a 1M window by default; other Claude 4/5
  // variants are 200k. Keep these aligned with the UI table's explicit
  // 1M entries so the denominator matches what pi sessions show.
  if (id.includes("opus-4-8"))     return 1_000_000;
  if (id.includes("sonnet-4-6"))   return 1_000_000;
  if (/^claude-(haiku|sonnet|opus|3|4|5)/.test(id)) return 200_000;
  if (id.startsWith("claude-"))    return 200_000;

  // ── Gemini ────────────────────────────────────────────────────────────
  if (id.startsWith("gemini-1.5-pro")) return 2_000_000;
  if (/^gemini-(2|3)/.test(id))         return 1_000_000;
  if (id.startsWith("gemini-1.5"))      return 1_000_000;
  if (id.startsWith("gemini-"))         return 1_000_000;

  // ── GPT ───────────────────────────────────────────────────────────────
  if (id.startsWith("gpt-5"))     return 400_000;
  if (id.startsWith("gpt-4o"))    return 128_000;
  if (id.startsWith("gpt-4"))     return 128_000;
  if (/^o[13]/.test(id))          return 200_000;

  // ── DeepSeek (mirrors pi's own 64k cap, per the UI table comment) ──────
  if (id.startsWith("deepseek"))  return 64_000;

  return undefined;
}
