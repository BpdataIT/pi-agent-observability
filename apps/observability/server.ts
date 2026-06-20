/**
 * server.ts — Bun HTTP + SSE + SQLite observability server.
 *
 * Single-file server. Hand-rolled routing. Uses bun:sqlite via db.ts.
 * Serves static UI from apps/observability/public/.
 */

import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { createDb, prepare, toRow, toSessionRow, rowToSession, rowToEvent } from "./db.js";
import { MAX_REQUEST_BYTES } from "../../shared/types.js";
import type { ObsEvent } from "../../shared/types.js";
import { contextWindowForModelKey, DEFAULT_CONTEXT_WINDOW } from "../../shared/model-metadata.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.OBS_PORT ?? "43190", 10);
const HOST = process.env.OBS_HOST ?? "127.0.0.1";
// Resolve database path: if OBS_DB_PATH env is set, use it as is.
// Otherwise, default to the "db/obs.db" directory relative to the project root.
const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "db", "obs.db");
const DB_PATH = process.env.OBS_DB_PATH ?? DEFAULT_DB_PATH;

// Ensure parent folder exists (e.g. "db/" directory) before initializing SQLite
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const AUTH_TOKEN = process.env.OBS_AUTH_TOKEN ?? crypto.randomUUID?.() ?? "dev";
const VERSION = "0.1.0";
// Browser-openable UI URL with the token baked in. The UI's API + SSE calls are
// auth-walled, so opening the bare host:port (no ?token=) yields a blank UI.
// Print this so copy/paste straight from the boot banner just works.
const OPEN_URL = `http://${HOST}:${PORT}/?token=${encodeURIComponent(AUTH_TOKEN)}`;

// ─── Init ───────────────────────────────────────────────────────────────────

const db: Database = createDb(DB_PATH);
const q = prepare(db);
const startTime = Date.now();

console.log(`\n  pi-observability server v${VERSION}`);
console.log(`  UI:    ${OPEN_URL}`);
console.log(`  Token: ${AUTH_TOKEN}`);
console.log(`  DB:    ${DB_PATH}\n`);

// ─── SSE subscriber registry ────────────────────────────────────────────────

interface SSESubscriber {
  id: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  pool?: string;
  tag?: string;
  session_id?: string;
}

let nextSubId = 1;
const subscribers = new Map<number, SSESubscriber>();

function addSubscriber(
  controller: ReadableStreamDefaultController<Uint8Array>,
  pool?: string,
  tag?: string,
  session_id?: string,
): number {
  const id = nextSubId++;
  subscribers.set(id, { id, controller, pool, tag, session_id });
  return id;
}

function removeSubscriber(id: number) {
  subscribers.delete(id);
}

/** Push an SSE-formatted event to one subscriber. Returns false if closed. */
function pushSSE(sub: SSESubscriber, data: string): boolean {
  try {
    sub.controller.enqueue(new TextEncoder().encode(data));
    return true;
  } catch {
    removeSubscriber(sub.id);
    return false;
  }
}

/** Broadcast an event to all SSE subscribers matching the event's pool/tags/session. */
function broadcastEvent(event: ObsEvent) {
  const payload = JSON.stringify(event);
  const frame = `event: event\ndata: ${payload}\n\n`;
  for (const sub of subscribers.values()) {
    if (sub.pool && sub.pool !== event.pool) continue;
    if (sub.tag && (!event.tags || !event.tags.includes(sub.tag))) continue;
    if (sub.session_id && sub.session_id !== event.session_id) continue;
    pushSSE(sub, frame);
  }
}

// Heartbeat every 15s
setInterval(() => {
  const ping = ": ping\n\n";
  for (const sub of subscribers.values()) {
    pushSSE(sub, ping);
  }
}, 15_000);

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function textResponse(body: string, status: number, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "access-control-allow-origin": "*" },
  });
}

function readTokenFromQuery(url: URL): string | null {
  return url.searchParams.get("token");
}

function checkAuth(req: Request): boolean {
  // Check Authorization header
  const auth = req.headers.get("authorization");
  if (auth) {
    const parts = auth.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] === AUTH_TOKEN) {
      return true;
    }
    return false;
  }
  // Check ?token= query param
  const url = new URL(req.url);
  const qToken = url.searchParams.get("token");
  if (qToken && qToken === AUTH_TOKEN) return true;

  return false;
}

/**
 * Ingest a single event: insert into DB, upsert session, broadcast to SSE.
 * Returns the event_id if ingested, null if duplicate.
 */
function ingestEvent(event: ObsEvent): string | null {
  const row = toRow(event);
  const result = q.insertEvent.run(row);
  const isNew = result.changes > 0;

  if (isNew) {
    q.upsertSession.run(toSessionRow(event));
  } else {
    q.upsertSessionNoBump.run(toSessionRow(event));
  }

  if (isNew) {
    broadcastEvent(event);
  }

  return isNew ? event.event_id : null;
}

// ─── Request body reader with size cap ─────────────────────────────────────

async function readBody(req: Request): Promise<string> {
  const len = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (len > MAX_REQUEST_BYTES) {
    throw new Error("Payload too large");
  }
  return await req.text();
}

// ─── MIME types for static files ────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(pathname: string): Response | null {
  // Remove leading slash and guard against path traversal
  const safe = pathname.replace(/^\/+/, "").replace(/\.\./g, "");
  const filePath = `${import.meta.dir}/public/${safe}`;
  const file = Bun.file(filePath);
  const mimeKey = safe.slice(safe.lastIndexOf(".")) || ".html";
  return new Response(file, {
    headers: { "content-type": MIME[mimeKey] ?? "application/octet-stream" },
  });
}

// ─── Routing helpers ────────────────────────────────────────────────────────

/** Match /sessions/<session_id>/events */
function matchSessionEvents(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)\/events$/);
  return m ? m[1] : null;
}

/** Match /sessions/<session_id>/stats */
function matchSessionStats(pathname: string): string | null {
  const m = pathname.match(/^\/sessions\/([^/]+)\/stats$/);
  return m ? m[1] : null;
}

// ─── Main handler ───────────────────────────────────────────────────────────

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // OPTIONS — CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
      },
    });
  }

  // ── Unauthenticated routes ─────────────────────────────────────────────
  if (pathname === "/health") {
    if (method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);

    try {
      const totals = q.countTotals.get() as any;
      return jsonResponse({
        ok: true,
        version: VERSION,
        uptime_s: Math.round((Date.now() - startTime) / 1000),
        events_total: totals.events_total ?? 0,
        sessions_total: totals.sessions_total ?? 0,
      });
    } catch (err: any) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  if (pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (pathname === "/" || pathname === "/index.html") {
    return serveStatic("index.html") ?? textResponse("not found", 404, "text/plain");
  }

  if (pathname.match(/\.(js|css|svg|png|ico)$/)) {
    return serveStatic(pathname.replace(/^\//, "")) ?? textResponse("not found", 404, "text/plain");
  }

  // ── Auth wall for everything else ──────────────────────────────────────
  if (!checkAuth(req)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // ── POST /events ───────────────────────────────────────────────────────
  if (pathname === "/events" && method === "POST") {
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "invalid JSON" }, 400);
    }

    const events: ObsEvent[] = Array.isArray(parsed) ? parsed : [parsed];
    const ingested: string[] = [];
    const rejected: string[] = [];

    for (const evt of events) {
      if (!evt || typeof evt !== "object" || !evt.event_id || !evt.type) {
        rejected.push(evt?.event_id ?? "unknown");
        continue;
      }
      // Normalize defaults
      evt.pool = evt.pool ?? "default";
      evt.tags = evt.tags ?? [];
      evt.seq = typeof evt.seq === "number" ? evt.seq : 0;
      evt.cwd = evt.cwd ?? "";

      const ingestedId = ingestEvent(evt as ObsEvent);
      if (ingestedId) {
        ingested.push(ingestedId);
      } else {
        rejected.push(evt.event_id);
      }
    }

    return jsonResponse({ ingested: ingested.length, rejected });
  }

  // ── GET /sessions ──────────────────────────────────────────────────────
  if (pathname === "/sessions" && method === "GET") {
    const pool = url.searchParams.get("pool") ?? "";
    const tag = url.searchParams.get("tag") ?? "";
    const since = url.searchParams.get("since") ?? "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

    try {
      const rows = q.listSessions.all({ $pool: pool, $tag: tag, $limit: limit }) as any[];

      // Filter by `since` in application code (optional low-frequency filter)
      const sessions = rows
        .filter((r) => !since || r.last_ts >= since)
        .map(rowToSession);

      return jsonResponse({ sessions });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /sessions/:session_id/events ───────────────────────────────────
  const sidEvents = matchSessionEvents(pathname);
  if (sidEvents && method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 1000);
    const beforeSeq = url.searchParams.get("before_seq");
    const sinceSeq = url.searchParams.get("since_seq");
    const type = url.searchParams.get("type") ?? "";

    try {
      if (sinceSeq !== null) {
        // Forward resync: seq > since_seq, ascending
        const rows = q.getSessionEventsSince.all({
          $session_id: sidEvents,
          $limit: limit,
          $since_seq: parseInt(sinceSeq, 10),
          $type: type,
        }) as any[];
        return jsonResponse({ events: rows.map(rowToEvent) });
      }

      const rows = q.getSessionEvents.all({
        $session_id: sidEvents,
        $limit: limit,
        $before_seq: beforeSeq ? parseInt(beforeSeq, 10) : null,
        $type: type,
      }) as any[];

      const events = rows.map(rowToEvent);
      // Return in ascending seq order for display
      events.reverse();
      return jsonResponse({ events });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /sessions/:session_id/stats ────────────────────────────────────
  const sidStats = matchSessionStats(pathname);
  if (sidStats && method === "GET") {
    try {
      const row = q.getSessionStats.get({ $session_id: sidStats }) as any;
      const ctx = q.getSessionContext.get({ $session_id: sidStats }) as any;
      return jsonResponse({
        total_tokens: row.total_tokens ?? 0,
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        total_cost: row.total_cost ?? 0,
        error_count: row.error_count ?? 0,
        latest_input: ctx?.latest_input ?? null,
        latest_ts: ctx?.latest_ts ?? null,
        // Model context window from the most recent assistant_message that
        // reported it (see db.ts getSessionContext). null for legacy events.
        context_window: ctx?.context_window != null ? Number(ctx.context_window) : null,
      });
    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ── GET /models/context-window?model=<raw> ──────────────────────────────
  // Backs the UI's legacy-session fallback. shared/model-metadata.ts is the
  // single source of truth for model → context window; this endpoint lets the
  // browser UI (which can't import the TS module directly) read it for legacy
  // sessions whose events carry no stamped `context_window`. Auth matches the
  // other GETs. Returns DEFAULT_CONTEXT_WINDOW when the model is unknown, so
  // the UI always gets a sane denominator (never null).
  if (pathname === "/models/context-window" && method === "GET") {
    const model = url.searchParams.get("model") ?? "";
    const context_window = contextWindowForModelKey(model) ?? DEFAULT_CONTEXT_WINDOW;
    return jsonResponse({ context_window });
  }

  // ── GET /events/stream (SSE) ──────────────────────────────────────────
  if (pathname === "/events/stream" && method === "GET") {
    const streamPool = url.searchParams.get("pool") ?? undefined;
    const streamTag = url.searchParams.get("tag") ?? undefined;
    const streamSession = url.searchParams.get("session_id") ?? undefined;

    let subId: number;

    const stream = new ReadableStream({
      start(controller) {
        subId = addSubscriber(controller, streamPool, streamTag, streamSession);

        // Initial hello
        const hello = JSON.stringify({ server: "pi-observability", version: VERSION });
        controller.enqueue(new TextEncoder().encode(`retry: 5000\nevent: hello\ndata: ${hello}\n\n`));
      },
      cancel() {
        removeSubscriber(subId!);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  return jsonResponse({ error: "not found" }, 404);
}

// ─── Boot ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: handle,
});

console.log(`  Listening on http://${HOST}:${PORT}`);
console.log(`  Open the UI →  ${OPEN_URL}\n`);
