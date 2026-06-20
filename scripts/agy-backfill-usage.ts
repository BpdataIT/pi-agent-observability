#!/usr/bin/env bun
/**
 * OPTIONAL backfill: retroactively decode `gen_metadata` usage for legacy agy
 * sessions already in the dashboard (recorded before the usage decoder shipped,
 * whose `assistant_message.usage` is all zeros).
 *
 * For a session (or `--all`), opens the conversation `.db`, decodes every
 * `gen_metadata` usage row, end-align-pairs them to the session's existing
 * `assistant_message` events (by seq order), and writes the corrected `usage`
 * into `db/obs.db` (UPDATE events.payload_json).
 *
 * Safety / opt-in:
 *   - Idempotent: skips events whose `usage.total_tokens > 0` (already live-
 *     decoded or backfilled), so re-running is a no-op.
 *   - Gated behind `--confirm` (otherwise runs in dry-run mode).
 *   - Writes directly to `db/obs.db` — STOP the observability server first to
 *     avoid a write conflict (the spec deliberately makes this opt-in because
 *     it touches the server's event store; default behavior is "legacy stays
 *     zero"). Path via `OBS_DB` env (default `db/obs.db` relative to cwd).
 *
 * Usage:
 *   bun scripts/agy-backfill-usage.ts --session <conversationId>           # dry-run
 *   bun scripts/agy-backfill-usage.ts --session <conversationId> --confirm  # write
 *   bun scripts/agy-backfill-usage.ts --all --confirm
 */

import * as path from "node:path";
import { Database } from "bun:sqlite";

import { decodeConversationUsage, resolveDbPath, type UsageRecord } from "../integrations/antigravity/usage-decoder.ts";
import { computeCost } from "../integrations/antigravity/model-prices.ts";
import type { UsageSummary } from "../shared/types.ts";

interface Args {
  session: string | null;
  all: boolean;
  confirm: boolean;
  obsDb: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { session: null, all: false, confirm: false, obsDb: process.env.OBS_DB || path.resolve("db/obs.db") };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--session") a.session = argv[++i] ?? null;
    else if (t === "--all") a.all = true;
    else if (t === "--confirm") a.confirm = true;
    else if (t === "--obs-db") a.obsDb = path.resolve(argv[++i] ?? a.obsDb);
    else if (t === "--help" || t === "-h") {
      process.stdout.write(
        "Usage: bun scripts/agy-backfill-usage.ts --session <id> [--confirm] | --all [--confirm] [--obs-db path]\n",
      );
      process.exit(0);
    }
  }
  if (!a.session && !a.all) {
    process.stderr.write("✗ pass --session <id> or --all\n");
    process.exit(1);
  }
  return a;
}

interface EventRow {
  event_id: string;
  session_id: string;
  seq: number;
  payload_json: string;
  model: string | null;
}

/** Find agy sessions that have assistant_message events with zero usage. */
function findLegacySessions(db: Database): string[] {
  // assistant_message events whose usage.total_tokens is 0 (legacy / undecoded).
  const rows = db
    .query(
      `SELECT DISTINCT session_id FROM events
       WHERE type = 'assistant_message'
         AND CAST(COALESCE(json_extract(payload_json, '$.usage.total_tokens'), 0) AS INTEGER) = 0`,
    )
    .all() as Array<{ session_id: string }>;
  return rows.map((r) => r.session_id);
}

function loadSessionAssistantEvents(db: Database, sessionId: string): EventRow[] {
  return db
    .query(
      `SELECT event_id, session_id, seq, payload_json, model FROM events
       WHERE session_id = $sid AND type = 'assistant_message'
       ORDER BY seq ASC`,
    )
    .all({ $sid: sessionId }) as EventRow[];
}

/** Build a UsageSummary from a decoded record + model label. */
function toUsageSummary(rec: UsageRecord, modelLabel: string): UsageSummary {
  const { cost_total } = computeCost(
    { input: rec.input, output: rec.output, cache_read: 0, cache_write: 0 },
    modelLabel,
  );
  return {
    input: rec.input,
    output: rec.output,
    cache_read: 0,
    cache_write: 0,
    total_tokens: rec.input + rec.output,
    cost_total,
  };
}

function backfillSession(db: Database, sessionId: string, confirm: boolean): { scanned: number; updated: number; skipped: number; noDb: boolean } {
  const events = loadSessionAssistantEvents(db, sessionId);
  if (events.length === 0) return { scanned: 0, updated: 0, skipped: 0, noDb: false };

  // Decode the conversation .db (immutable snapshot; read-only).
  let records: UsageRecord[] | null = null;
  try {
    records = decodeConversationUsage(sessionId, "immutable");
  } catch {
    records = null;
  }
  if (!records) {
    return { scanned: events.length, updated: 0, skipped: events.length, noDb: true };
  }
  const usageRows = records.filter((r) => !r.is_snapshot && !r.decode_error);

  // End-align pair (same logic as the live hook): latest event ↔ latest row.
  const shift = Math.max(0, events.length - usageRows.length);

  let updated = 0;
  let skipped = 0;
  const update = db.query(
    `UPDATE events SET payload_json = $pj WHERE event_id = $eid`,
  );
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    let payload: any;
    try {
      payload = JSON.parse(ev.payload_json);
    } catch {
      skipped++;
      continue;
    }
    // Idempotent: skip if usage already non-zero (live-decoded or backfilled).
    if (payload?.usage && Number(payload.usage.total_tokens) > 0) {
      skipped++;
      continue;
    }
    const slot = i - shift;
    const usage: UsageSummary | undefined = slot >= 0 ? toUsageSummary(usageRows[slot], payload?.model_label || ev.model || "") : undefined;
    if (!usage || usage.total_tokens === 0) {
      skipped++;
      continue;
    }
    payload.usage = usage;
    if (confirm) {
      update.run({ $eid: ev.event_id, $pj: JSON.stringify(payload) });
    }
    updated++;
  }
  return { scanned: events.length, updated, skipped, noDb: false };
}

function main(): void {
  const args = parseArgs();
  process.stdout.write(
    `${args.confirm ? "WRITE" : "DRY-RUN"} mode — obs.db: ${args.obsDb}\n` +
      (args.confirm ? "⚠ make sure the observability server is STOPPED.\n" : "(add --confirm to actually write)\n"),
  );

  let db: Database;
  try {
    db = new Database(args.obsDb); // read-write
  } catch (err) {
    process.stderr.write(`✗ could not open ${args.obsDb}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  let sessionIds: string[];
  if (args.all) {
    sessionIds = findLegacySessions(db);
    process.stdout.write(`found ${sessionIds.length} session(s) with zero-usage assistant_message events\n`);
  } else {
    sessionIds = [args.session!];
  }

  let totalUpdated = 0;
  let totalSkipped = 0;
  let noDbCount = 0;
  for (const sid of sessionIds) {
    const res = backfillSession(db, sid, args.confirm);
    if (res.scanned === 0) continue;
    const tag = res.noDb ? " (no .db / undecodable)" : "";
    process.stdout.write(
      `  ${sid.slice(0, 12)}  scanned=${res.scanned} updated=${res.updated} skipped=${res.skipped}${tag}\n`,
    );
    totalUpdated += res.updated;
    totalSkipped += res.skipped;
    if (res.noDb) noDbCount++;
  }
  db.close();

  process.stdout.write(
    `\n${args.confirm ? "Done." : "Dry-run (no writes)."} updated=${totalUpdated} skipped=${totalSkipped}` +
      (noDbCount ? ` noDb=${noDbCount}` : "") +
      (args.confirm ? "" : " — re-run with --confirm to write.") +
      "\n",
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`backfill fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(0);
}
