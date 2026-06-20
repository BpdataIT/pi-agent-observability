/**
 * Model → price table for Factory Droid cost computation.
 *
 * THIN WRAPPER — delegates to `shared/model-metadata.ts`.
 */

import {
  getModelPrice as sharedGetModelPrice,
  computeCost as sharedComputeCost,
  type ModelPrice as SharedModelPrice,
  type UsageForCost as SharedUsageForCost,
} from "../../shared/model-metadata.ts";

export type ModelPrice = SharedModelPrice;
export type UsageForCost = SharedUsageForCost;

export function getModelPrice(modelId: string): ModelPrice & { unknown: boolean } {
  return sharedGetModelPrice(modelId);
}

export function computeCost(
  usage: UsageForCost,
  modelId: string,
): { cost_total: number; unknown_model: boolean } {
  return sharedComputeCost(usage, modelId);
}
