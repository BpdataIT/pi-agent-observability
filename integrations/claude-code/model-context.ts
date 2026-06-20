/**
 * Model → context window map for Claude Code sessions.
 *
 * THIN WRAPPER — delegates to the single source of truth at
 * `shared/model-metadata.ts` (see `shared/model-metadata.md`). This file
 * exists only to preserve the `contextWindowForModel(modelId)` call site +
 * signature in `transcript.ts`; the table + normalizer live in the shared
 * module.
 *
 * Claude Code's hook payloads and JSONL transcript do NOT expose the model's
 * context window, and — unlike the pi extension — the claude-code hook runs
 * out-of-process with no access to pi's `ctx.getContextUsage()`. So we resolve
 * the window from the canonical model id here and stamp it onto the
 * assistant_message event as `context_window` (the same field the pi extension
 * and the agy integration write, and the server/UI read).
 *
 * The shared normalizer handles the canonical-id forms in play: bare ids
 * (`glm-5.2`, `claude-opus-4-8`), the `org/model` form some providers emit
 * (`zai-org/GLM-5.2` → `glm-5.2`), and dated aliases
 * (`claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`). One table answers all.
 *
 * The pi extension is intentionally NOT a consumer of this table — it reads
 * the real window from `ctx.getContextUsage()` at runtime (strictly more
 * accurate). This wrapper is the fallback for the out-of-process integrations.
 */

import { contextWindowForModelKey } from "../../shared/model-metadata.ts";

/**
 * Resolve a context window (in tokens) for a model id (canonical id, org/model
 * form, or dated alias). Returns `undefined` for unrecognized ids so the UI can
 * fall back to its own table / default. Signature preserved for the
 * `transcript.ts` call site; body delegates to the shared module.
 */
export function contextWindowForModel(modelId: string | undefined): number | undefined {
  return contextWindowForModelKey(modelId);
}
