#!/usr/bin/env bun
/**
 * Synthetic harness (verification only — not shipped) that drives an existing
 * conversation .db + its transcript through the SAME usage-stamping logic the
 * live obs-hook.ts uses (decodeUsageForTurns + buildAssistantMessagePayload),
 * and asserts the resulting assistant_message payloads would carry non-zero
 * usage.input and a real context_window. Run when no live agy session is
 * available to verify Phase 4 end-to-end.
 *
 *   bun scripts/agy-verify-stamp.ts <conversationId-or-dbPath>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { decodeNewUsage, resolveDbPath, type UsageRecord } from "../integrations/antigravity/usage-decoder.ts";
import { computeCost } from "../integrations/antigravity/model-prices.ts";
import {
  buildAssistantMessagePayload,
  parseNewTurns,
  type TurnTiming,
} from "../integrations/antigravity/transcript.ts";
import type { UsageSummary } from "../shared/types.ts";

function transcriptPathFor(dbArg: string): string {
  const resolved = resolveDbPath(dbArg);
  const cid = path.basename(resolved, ".db");
  return path.join(
    process.env.HOME || "",
    ".gemini",
    "antigravity-cli",
    "brain",
    cid,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
}

/** Mirror of obs-hook.ts:decodeUsageForTurns (single shared implementation). */
function decodeUsageForTurns(dbArg: string, usageIdxOffset: number): Array<{
  usage: UsageSummary | undefined;
  timing: TurnTiming | undefined;
}> {
  const dbPath = resolveDbPath(dbArg);
  let records: UsageRecord[] | null = null;
  try {
    records = decodeNewUsage(dbPath, usageIdxOffset, "ro");
  } catch {
    return [];
  }
  if (!records || records.length === 0) return [];
  const maxIdx = records.reduce((m, r) => (r.idx > m ? r.idx : m), -1);
  const nextOffset = maxIdx < usageIdxOffset ? 0 : maxIdx + 1;
  const out: Array<{ usage: UsageSummary | undefined; timing: TurnTiming | undefined }> = [];
  for (const rec of records) {
    if (rec.decode_error) {
      out.push({ usage: undefined, timing: undefined });
      continue;
    }
    const { cost_total } = computeCost(
      { input: rec.input, output: rec.output, cache_read: 0, cache_write: 0 },
      rec.model_label || "",
    );
    out.push({
      usage: {
        input: rec.input,
        output: rec.output,
        cache_read: 0,
        cache_write: 0,
        total_tokens: rec.input + rec.output,
        cost_total,
      },
      timing: undefined,
    });
  }
  return { out: out, nextOffset } as any;
}

const dbArg = process.argv[2];
if (!dbArg) {
  process.stderr.write("Usage: bun scripts/agy-verify-stamp.ts <conversationId-or-dbPath>\n");
  process.exit(1);
}

const tp = transcriptPathFor(dbArg);
const dbPath = resolveDbPath(dbArg);
console.log(`transcript: ${tp} (${fs.existsSync(tp) ? "exists" : "MISSING"})`);
console.log(`db:         ${dbPath} (${fs.existsSync(dbPath) ? "exists" : "MISSING"})\n`);

if (!fs.existsSync(tp)) {
  process.stderr.write("✗ transcript not found for this conversationId\n");
  process.exit(1);
}

// Drain the WHOLE transcript from offset 0 (simulating a fresh session).
const { turns } = parseNewTurns(tp, 0);
const assistantTurns = turns.filter((t) => t.kind === "assistant");
console.log(`parsed turns: ${turns.length} (${assistantTurns.length} assistant)\n`);

// Decode ALL usage rows from idx 0 (simulating fresh usageIdxOffset=0).
const decoded = decodeUsageForTurns(dbArg, 0);
const usageForTurn: any[] = decoded.out || decoded;
console.log(`decoded usage rows: ${usageForTurn.length}`);

let nonZeroInput = 0;
let nonZeroOutput = 0;
let withWindow = 0;
let totalCost = 0;
let assistantIdx = 0;
for (const turn of turns) {
  if (turn.kind !== "assistant") continue;
  const { usage, timing } = usageForTurn[assistantIdx] ?? { usage: undefined, timing: undefined };
  const payload = buildAssistantMessagePayload(turn, [], turn.model || "Gemini 3.5 Flash (High)", usage, timing);
  if ((usage?.input ?? 0) > 0) nonZeroInput++;
  if ((usage?.output ?? 0) > 0) nonZeroOutput++;
  if (payload.context_window) withWindow++;
  totalCost += usage?.cost_total ?? 0;
  assistantIdx++;
}

console.log(`\nassistant turns stamped: ${assistantIdx}`);
console.log(`  with non-zero usage.input:  ${nonZeroInput} / ${assistantIdx}`);
console.log(`  with non-zero usage.output: ${nonZeroOutput} / ${assistantIdx}`);
console.log(`  with context_window:        ${withWindow} / ${assistantIdx}`);
console.log(`  total cost_total (sum):     $${totalCost.toFixed(4)}`);

// Show one concrete stamped payload (the last assistant turn).
const lastIdx = Math.max(0, assistantIdx - 1);
const lastUsage = usageForTurn[lastIdx]?.usage;
console.log(`\nlast assistant turn usage: ${JSON.stringify(lastUsage)}`);

const pass = nonZeroInput > 0 && withWindow > 0;
console.log(`\n${pass ? "✓ PASS" : "✗ FAIL"} — ${pass ? "context-bar numerator (input) + context_window populate" : "expected non-zero input + context_window"}`);
process.exit(pass ? 0 : 1);
