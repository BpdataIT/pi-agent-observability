/**
 * Model → context window for Antigravity (agy) sessions.
 *
 * THIN WRAPPER — delegates to the single source of truth at
 * `shared/model-metadata.ts` (see `shared/model-metadata.md`). This file
 * exists only to preserve the `contextWindowForLabel(label)` call site +
 * signature in `transcript.ts`; the table + normalizer live in the shared
 * module.
 *
 * agy exposes the active model only as a human display label scraped from the
 * transcript (e.g. `"Gemini 3.5 Flash (High)"`), and — unlike the pi extension
 * — the agy hook runs out-of-process with no access to pi's
 * `ctx.getContextUsage()`. So we resolve the window from the label and stamp it
 * onto the assistant_message event as `context_window` (the same field the pi
 * extension writes and the server/UI read). The shared normalizer handles the
 * label → canonical-key collapse (lowercase, strip `(Effort)` suffix, space →
 * hyphen), so agy's human labels resolve through the SAME table the
 * canonical-id integrations use.
 *
 * The pi extension is intentionally NOT a consumer of this table — it reads
 * the real window from `ctx.getContextUsage()` at runtime (strictly more
 * accurate). This wrapper is the fallback for the out-of-process integrations.
 */

import { contextWindowForModelKey } from "../../shared/model-metadata.ts";

/**
 * Resolve a context window (in tokens) for an agy model display label OR
 * canonical id. Returns `undefined` for unrecognized models so the UI can fall
 * back to its own default. Signature preserved for the `transcript.ts` call
 * site; body delegates to the shared module.
 */
export function contextWindowForLabel(label: string | undefined): number | undefined {
  return contextWindowForModelKey(label);
}
