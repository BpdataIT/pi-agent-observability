/**
 * db.ts — SQLite schema + prepared queries for Pi Observability server.
 *
 * Schema matches SPEC.md §Storage exactly, plus the (session_id, seq) UNIQUE
 * constraint required by the wire contract.
 */

import { Database } from "bun:sqlite";
import type { ObsEvent, SessionSummary, HealthResponse } from "../../shared/types.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  pool         TEXT NOT NULL DEFAULT 'default',
  agent_name   TEXT,
  cwd          TEXT,
  session_file TEXT,
  provider     TEXT,
  model        TEXT,
  first_ts     TEXT NOT NULL,
  last_ts      TEXT NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  tags_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  pool         TEXT NOT NULL DEFAULT 'default',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  provider     TEXT,
  model        TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_pool ON events(pool);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreparedQueries {
  insertEvent: ReturnType<Database["query"]>;
  upsertSession: ReturnType<Database["query"]>;
  upsertSessionNoBump: ReturnType<Database["query"]>;
  listSessions: ReturnType<Database["query"]>;
  getSessionEvents: ReturnType<Database["query"]>;
  getSessionEventsSince: ReturnType<Database["query"]>;
  getSessionStats: ReturnType<Database["query"]>;
  countTotals: ReturnType<Database["query"]>;
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function createDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA);
  return db;
}

export function prepare(db: Database): PreparedQueries {
  // ── Insert event (idempotent) ───────────────────────────────────────────
  const insertEvent = db.query(`
    INSERT OR IGNORE INTO events
      (event_id, session_id, seq, ts, type, pool, tags_json, payload_json, provider, model)
    VALUES
      ($event_id, $session_id, $seq, $ts, $type, $pool, $tags_json, $payload_json, $provider, $model)
  `);

  // ── Upsert session (bumps event_count) ──────────────────────────────────
  //
  // COALESCE logic: don't overwrite non-null existing fields with null
  // incoming values. Tags are merged via UNION to accumulate unique tags.
  const upsertSession = db.query(`
    INSERT INTO sessions
      (session_id, pool, agent_name, cwd, session_file, provider, model, first_ts, last_ts, event_count, tags_json)
    VALUES
      ($session_id, $pool, $agent_name, $cwd, $session_file, $provider, $model, $ts, $ts, 1, $tags_json)
    ON CONFLICT(session_id) DO UPDATE SET
      pool         = COALESCE(excluded.pool,         sessions.pool),
      agent_name   = COALESCE(excluded.agent_name,   sessions.agent_name),
      cwd          = COALESCE(excluded.cwd,          sessions.cwd),
      session_file = COALESCE(excluded.session_file, sessions.session_file),
      provider     = COALESCE(excluded.provider,     sessions.provider),
      model        = COALESCE(excluded.model,        sessions.model),
      first_ts     = COALESCE(sessions.first_ts,     excluded.last_ts),
      last_ts      = MAX(excluded.last_ts,           sessions.last_ts),
      event_count  = sessions.event_count + 1,
      tags_json    = (
        SELECT json_group_array(DISTINCT value)
        FROM (
          SELECT value FROM json_each(sessions.tags_json)
          UNION
          SELECT value FROM json_each(excluded.tags_json)
        )
      )
  `);

  // ── Upsert session without bumping event_count (duplicate events) ──────
  const upsertSessionNoBump = db.query(`
    INSERT INTO sessions
      (session_id, pool, agent_name, cwd, session_file, provider, model, first_ts, last_ts, event_count, tags_json)
    VALUES
      ($session_id, $pool, $agent_name, $cwd, $session_file, $provider, $model, $ts, $ts, 1, $tags_json)
    ON CONFLICT(session_id) DO UPDATE SET
      pool         = COALESCE(excluded.pool,         sessions.pool),
      agent_name   = COALESCE(excluded.agent_name,   sessions.agent_name),
      cwd          = COALESCE(excluded.cwd,          sessions.cwd),
      session_file = COALESCE(excluded.session_file, sessions.session_file),
      provider     = COALESCE(excluded.provider,     sessions.provider),
      model        = COALESCE(excluded.model,        sessions.model),
      first_ts     = COALESCE(sessions.first_ts,     excluded.last_ts),
      last_ts      = MAX(excluded.last_ts,           sessions.last_ts),
      tags_json    = (
        SELECT json_group_array(DISTINCT value)
        FROM (
          SELECT value FROM json_each(sessions.tags_json)
          UNION
          SELECT value FROM json_each(excluded.tags_json)
        )
      )
  `);

  // ── List sessions (with optional pool/tag/since/limit filters) ──────────
  const listSessions = db.query(`
    SELECT
      session_id, pool,
      COALESCE(agent_name, '') AS agent_name,
      COALESCE(cwd, '') AS cwd,
      COALESCE(session_file, '') AS session_file,
      COALESCE(provider, '') AS provider,
      COALESCE(model, '') AS model,
      first_ts, last_ts, event_count,
      tags_json
    FROM sessions
    WHERE ($pool = '' OR pool = $pool)
      AND ($tag = '' OR EXISTS (
        SELECT 1 FROM json_each(tags_json) WHERE value = $tag
      ))
    ORDER BY last_ts DESC
    LIMIT $limit
  `);

  // ── Get events for a session (backward pagination) ─────────────────────
  // before_seq: return events with seq < before_seq ordered DESC.
  // When before_seq IS NULL, return latest events up to $limit.
  const getSessionEvents = db.query(`
    SELECT
      event_id, session_id, seq, ts, type, pool, tags_json, payload_json, provider, model
    FROM events
    WHERE session_id = $session_id
      AND ($type = '' OR type = $type)
      AND ($before_seq IS NULL OR seq < $before_seq)
    ORDER BY seq DESC
    LIMIT $limit
  `);

  // ── Get events since seq (forward resync) ──────────────────────────────
  // since_seq: return events with seq > since_seq ordered ASC.
  const getSessionEventsSince = db.query(`
    SELECT
      event_id, session_id, seq, ts, type, pool, tags_json, payload_json, provider, model
    FROM events
    WHERE session_id = $session_id
      AND seq > $since_seq
      AND ($type = '' OR type = $type)
    ORDER BY seq ASC
    LIMIT $limit
  `);

  // ── Session stats (cost, tokens, errors) ──────────────────────────────
  const getSessionStats = db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.total_tokens') ELSE 0 END), 0) AS total_tokens,
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.input') ELSE 0 END), 0)        AS input_tokens,
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.output') ELSE 0 END), 0)       AS output_tokens,
      COALESCE(SUM(CASE WHEN type = 'assistant_message' THEN json_extract(payload_json, '$.usage.cost_total') ELSE 0 END), 0)   AS total_cost,
      COALESCE(SUM(CASE WHEN type = 'error' THEN 1 ELSE 0 END), 0) AS error_count
    FROM events
    WHERE session_id = $session_id
  `);

  // ── Latest assistant_message context size ───────────────────────
  // latest_input ≈ "context tokens used right now" — the full prefix sent to
  // the model on the most recent turn, used as the numerator for the context
  // utilization bar.
  //
  // Formula: usage.input + usage.cache_read + usage.cache_write.
  //
  // This matches pi's own terminal context bar. Verified against a live
  // gemini-3.5-flash session: input=2832, cache_read=98125, cache_write=0,
  // window=1_000_000 → (2832+98125+0)/1_000_000 = 10.1% — exactly what pi
  // terminal showed. The earlier "input only" formula returned ~0.3% here
  // because Gemini caches almost the entire conversation prefix, so most of
  // the in-context tokens move into cache_read after turn 1.
  //
  // For uncached providers (e.g. deepseek), cache_read/cache_write are 0 so
  // the sum collapses to input — preserving the previously-verified
  // deepseek-v4-flash 9% match.
  //
  // The dedicated `cache r` / `cache w` subnav pills still show the cache
  // volume independently for cost-attribution analysis.
  const getSessionContext = db.query(`
    SELECT
      (COALESCE(json_extract(payload_json, '$.usage.input'),       0)
     + COALESCE(json_extract(payload_json, '$.usage.cache_read'),  0)
     + COALESCE(json_extract(payload_json, '$.usage.cache_write'), 0)) AS latest_input,
      ts AS latest_ts,
      -- Latest model context window reported by the extension
      -- (ctx.getContextUsage().contextWindow, same source as pi's /context).
      -- Sourced from the most recent assistant_message that carries it, so
      -- mid-session model switches are reflected. NULL for legacy events
      -- recorded before context_window capture — the UI falls back to its
      -- /models/context-window endpoint (shared/model-metadata.ts) in that case.
      (
        SELECT json_extract(e2.payload_json, '$.context_window')
        FROM events e2
        WHERE e2.session_id = $session_id
          AND e2.type = 'assistant_message'
          AND json_extract(e2.payload_json, '$.context_window') IS NOT NULL
        ORDER BY e2.seq DESC
        LIMIT 1
      ) AS context_window
    FROM events
    WHERE session_id = $session_id
      AND type = 'assistant_message'
      AND json_extract(payload_json, '$.usage.input') IS NOT NULL
    ORDER BY seq DESC
    LIMIT 1
  `);

  // ── Totals for /health ──────────────────────────────────────────────────
  const countTotals = db.query(`
    SELECT
      (SELECT COUNT(*) FROM events) AS events_total,
      (SELECT COUNT(*) FROM sessions) AS sessions_total
  `);

  return {
    insertEvent,
    upsertSession,
    upsertSessionNoBump,
    listSessions,
    getSessionEvents,
    getSessionEventsSince,
    getSessionStats,
    getSessionContext,
    countTotals,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function toRow(e: ObsEvent): Record<string, unknown> {
  return {
    $event_id: e.event_id,
    $session_id: e.session_id,
    $seq: e.seq,
    $ts: e.ts,
    $type: e.type,
    $pool: e.pool ?? "default",
    $tags_json: JSON.stringify(e.tags ?? []),
    $payload_json: JSON.stringify(e.payload ?? {}),
    $provider: e.provider ?? null,
    $model: e.model ?? null,
  };
}

export function toSessionRow(e: ObsEvent): Record<string, unknown> {
  return {
    $session_id: e.session_id,
    $pool: e.pool ?? "default",
    $agent_name: e.agent_name ?? null,
    $cwd: e.cwd ?? null,
    $session_file: e.session_file ?? null,
    $provider: e.provider ?? null,
    $model: e.model ?? null,
    $ts: e.ts,
    $tags_json: JSON.stringify(e.tags ?? []),
  };
}

export function rowToSession(row: any): SessionSummary {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags_json ?? "[]");
  } catch {
    tags = [];
  }
  return {
    session_id: row.session_id,
    pool: row.pool,
    agent_name: row.agent_name || undefined,
    cwd: row.cwd || undefined,
    session_file: row.session_file || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    first_ts: row.first_ts,
    last_ts: row.last_ts,
    event_count: row.event_count,
    tags,
  };
}

export function rowToEvent(row: any): ObsEvent {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags_json ?? "[]");
  } catch {
    tags = [];
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json ?? "{}");
  } catch {
    payload = {};
  }
  return {
    event_id: row.event_id,
    ts: row.ts,
    type: row.type,
    session_id: row.session_id,
    cwd: row.cwd ?? "",
    pool: row.pool,
    tags,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    payload,
    seq: row.seq,
  } as ObsEvent;
}
