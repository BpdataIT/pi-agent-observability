/**
 * Model → context window map for Factory Droid sessions.
 *
 * THIN WRAPPER — delegates to `shared/model-metadata.ts`.
 */

import { contextWindowForModelKey } from "../../shared/model-metadata.ts";

export function contextWindowForModel(modelId: string | undefined): number | undefined {
  return contextWindowForModelKey(modelId);
}
