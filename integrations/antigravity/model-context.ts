/**
 * Model → context window map for Antigravity (agy).
 *
 * agy exposes the active model only as a human display label scraped from the
 * transcript (e.g. `"Gemini 3.5 Flash (High)"`), and — unlike the pi extension
 * — the agy hook runs out-of-process with no access to pi's
 * ctx.getContextUsage(). So we can't read the real window at runtime; instead
 * we resolve it from the label here and stamp it onto the assistant_message
 * event as `context_window` (the same field the pi extension writes and the
 * server/UI read). This keeps the observability context bar correct for agy
 * sessions without relying on the shared UI's MODEL_CONTEXT_WINDOWS regex
 * table, which keys on canonical lowercase ids (`gemini-3.5-flash`) and does
 * not match agy's spaced/capitalized display labels.
 *
 * Windows mirror the values in apps/observability/public/app.js
 * (MODEL_CONTEXT_WINDOWS) so agy and pi render the same denominator for the
 * same model. Update both tables together when Google ships a new window.
 *
 * Label format observed: `Gemini <version> <variant> (<effort>)`, e.g.
 * "Gemini 3.5 Flash (High)", "Gemini 3 Pro", "Gemini 2.5 Flash".
 * The `(<effort>)` suffix is ignored by the matchers below.
 */

/**
 * Resolve a context window (in tokens) for an agy model display label.
 * Returns `undefined` for unrecognized labels so the UI can fall back to its
 * own table / default.
 */
export function contextWindowForLabel(label: string | undefined): number | undefined {
  if (!label) return undefined;
  // Normalize: lowercase, collapse spaces, strip the trailing "(...)" effort
  // suffix so "Gemini 3.5 Flash (High)" → "gemini 3.5 flash".
  const base = label
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  if (!base) return undefined;

  // Gemini 1.5 Pro has a 2M window; other 1.5 variants are 1M.
  if (/gemini.*1\.5.*pro/.test(base)) return 2_000_000;
  // All Gemini 2.x and 3.x variants currently advertise a 1M window.
  if (/gemini.*[23]\b/.test(base)) return 1_000_000;
  if (/gemini.*1\.5/.test(base)) return 1_000_000;
  // Catch-all for other Gemini labels we haven't special-cased (still 1M for
  // everything agy currently ships). Return undefined instead if you'd rather
  // force an explicit entry for new models.
  if (/gemini/.test(base)) return 1_000_000;

  return undefined;
}
