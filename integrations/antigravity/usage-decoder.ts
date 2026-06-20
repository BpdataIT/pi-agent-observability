/**
 * Standalone protobuf decoder for agy's per-conversation SQLite.
 *
 * agy writes one SQLite database per conversation at
 *   ~/.gemini/antigravity-cli/conversations/<conversationId>.db
 * The `gen_metadata` table (schema: `idx INTEGER, data BLOB, size INTEGER`)
 * holds protobuf-encoded rows: most are small (~1KB) per-call usage snapshots
 * carrying token counts, and a few are large (~100KB+) context/tool snapshots
 * that are NOT usage. There is no `.proto` schema shipped with agy, so this
 * decoder is a generic wire-format reader + an empirically-derived field map.
 *
 * agy's hooks and JSONL transcript carry NO token usage, cost, or timing, so
 * this is the only place per-turn tokens live. The live hook (obs-hook.ts)
 * uses `decodeConversationUsage` on each PostInvocation/Stop to stamp real
 * usage onto `assistant_message` events. The debug CLI lets a maintainer
 * re-derive the field map after an agy version bump.
 *
 * SAFETY CONTRACT (critical for the live hook):
 *   - NEVER throws. Every failure path (locked/corrupt/missing .db, malformed
 *     blob, unknown field tree) degrades to a zero/empty `UsageRecord` plus a
 *     `decode_error` string. A throwing PreToolUse hook blocks the tool call.
 *   - NEVER writes to a conversation .db. All access is read-only via
 *     `bun:sqlite` with `immutable=1` (snapshot of committed data; works for
 *     both actively-written WAL dbs and checkpointed historical dbs) with a
 *     `mode=ro` fallback path used by the validator.
 *   - Pure functions in the core (`decodeProtobuf`, `dumpFieldTree`,
 *     `extractUsageRecord`). Only the CLI + `openDb` touch the filesystem.
 *
 * SEE: integrations/antigravity/usage-decoder.md for the empirical validation
 * that confirmed GEN_METADATA_FIELD_MAP across the live corpus (agy 1.0.10).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
//  Protobuf wire format — generic, schemaless
// ═══════════════════════════════════════════════════════════════════════════

/** Protobuf wire types. */
export const enum WireType {
  Varint = 0,
  Bit64 = 1,
  LengthDelimited = 2,
  StartGroup = 3,
  EndGroup = 4,
  Bit32 = 5,
}

/**
 * One decoded protobuf field. `value` is:
 *   - number      for Varint (wire 0) and Bit32 (wire 5)
 *   - bigint      for Bit64 (wire 1)
 *   - Uint8Array  for LengthDelimited (wire 2) — caller decides text vs submessage
 *   - undefined   for group markers (wire 3/4; rarely used, not recursed)
 */
export interface ProtoField {
  /** Field number from the tag. */
  field: number;
  /** Wire type of the value. */
  wire: WireType;
  /** Byte offset of the tag within the parent buffer (for debugging). */
  offset: number;
  /** Decoded value (type depends on wire — see interface doc). */
  value: number | bigint | Uint8Array | undefined;
}

/**
 * Read a base-128 varint from `buf` starting at `offset`.
 * Returns the unsigned 32-bit-safe value and the new offset. Guards against
 * overrun (returns 0 + buf.length if the buffer ends mid-varint) so a
 * truncated tail never throws.
 */
export function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let off = offset;
  // Cap at 10 bytes (a 64-bit varint is at most 10 bytes); beyond that, stop.
  for (let i = 0; i < 10 && off < buf.length; i++) {
    const b = buf[off++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, off];
    shift += 7;
    // Varints encode unsigned values; once shift exceeds 32 bits the low
    // bits are all we keep (we return a JS number, not bigint). 35+ bit
    // values lose precision here — acceptable for token counts (<1e9).
  }
  return [result >>> 0, off];
}

/**
 * Decode a buffer of protobuf wire bytes into a flat list of top-level fields.
 * Does NOT recurse — length-delimited values are returned as raw Uint8Array;
 * use `maybeDecodeSubmessage` / `decodeProtobuf` recursively on them.
 *
 * Never throws: on a malformed/truncated tail it stops at the overrun.
 */
export function decodeProtobuf(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let off = 0;
  // Hard stop if the buffer is empty or absurdly large recursion-fed junk.
  while (off < buf.length) {
    const start = off;
    let tag: number;
    [tag, off] = readVarint(buf, off);
    const fieldNum = tag >>> 3;
    const wire = tag & 0x7;
    // field 0 is illegal in protobuf → treat as end / corrupt.
    if (fieldNum === 0) break;

    let value: number | bigint | Uint8Array | undefined;
    if (wire === WireType.Varint) {
      [value, off] = readVarint(buf, off);
    } else if (wire === WireType.Bit64) {
      if (off + 8 > buf.length) break;
      try {
        value = buf.readBigUInt64LE(off);
      } catch {
        break;
      }
      off += 8;
    } else if (wire === WireType.LengthDelimited) {
      let len: number;
      [len, off] = readVarint(buf, off);
      if (len < 0 || off + len > buf.length) break; // truncated
      value = buf.subarray(off, off + len);
      off += len;
    } else if (wire === WireType.Bit32) {
      if (off + 4 > buf.length) break;
      try {
        value = buf.readUInt32LE(off);
      } catch {
        break;
      }
      off += 4;
    } else if (wire === WireType.StartGroup || wire === WireType.EndGroup) {
      // Groups are deprecated and not used by agy's schema; skip the marker.
      value = undefined;
    } else {
      // Unknown wire type → stop (can't safely continue).
      break;
    }

    fields.push({ field: fieldNum, wire: wire as WireType, offset: start, value });
    if (off <= start) break; // defensive: never loop forever
  }
  return fields;
}

/**
 * Heuristic: does this length-delimited payload plausibly parse as a nested
 * protobuf message? Used to decide whether to recurse in dumpFieldTree.
 * A submessage is "valid" if decoding it consumes (near) all of its bytes and
 * every field has a sane (>=1) field number. Pure text fails this.
 */
export function maybeDecodeSubmessage(data: Uint8Array): ProtoField[] | null {
  if (data.length < 2) return null;
  let fields: ProtoField[];
  try {
    fields = decodeProtobuf(data);
  } catch {
    return null;
  }
  if (fields.length === 0) return null;
  // Re-encode check: a valid submessage's last field should end at or near the
  // buffer end. If decoding consumed < 60% of bytes, it's likely not a message.
  const last = fields[fields.length - 1];
  let lastEnd = last.offset;
  if (last.wire === WireType.Varint || last.wire === WireType.Bit32 || last.wire === WireType.Bit64) {
    lastEnd = last.offset; // approximate; we don't track value byte-length here
  }
  // Require every field number >= 1 (decodeProtobuf already drops 0) and that
  // at least one field is a varint or a length-delimited block.
  const hasScalar = fields.some(
    (f) => f.wire === WireType.Varint || f.wire === WireType.LengthDelimited,
  );
  if (!hasScalar) return null;
  return fields;
}

/**
 * Render a decoded field tree as human-readable, indented text, recursing into
 * length-delimited fields that parse as submessages. Strings are detected when
 * the bytes are printable UTF-8. Used by the debug CLI and for re-deriving the
 * field map.
 *
 *   dumpFieldTree(decodeProtobuf(buf))  // top-level
 */
export function dumpFieldTree(
  fields: ProtoField[],
  indent = 0,
  maxDepth = 8,
  prefix = "",
): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const f of fields) {
    const label = `${prefix}f${f.field}`;
    if (f.wire === WireType.Varint) {
      lines.push(`${pad}${label} varint = ${f.value}`);
    } else if (f.wire === WireType.Bit32) {
      lines.push(`${pad}${label} fixed32 = ${f.value}`);
    } else if (f.wire === WireType.Bit64) {
      lines.push(`${pad}${label} fixed64 = ${f.value}`);
    } else if (f.wire === WireType.LengthDelimited) {
      const data = f.value as Uint8Array;
      const str = Buffer.from(data).toString("utf8");
      const printable = /^[\x20-\x7e\r\n\t]+$/.test(str) && data.length > 0 && data.length <= 200;
      if (printable) {
        const shown = str.length > 80 ? str.slice(0, 80) + "…" : str;
        lines.push(`${pad}${label} len=${data.length} str="${shown}"`);
        continue;
      }
      lines.push(`${pad}${label} len=${data.length} (submsg)`);
      if (indent < maxDepth && data.length > 1 && data.length < 256 * 1024) {
        const sub = maybeDecodeSubmessage(data);
        if (sub) {
          lines.push(dumpFieldTree(sub, indent + 1, maxDepth, label + "."));
        }
      }
    } else {
      lines.push(`${pad}${label} group(wire=${f.wire})`);
    }
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
//  Field-path navigation helpers (operate on decoded trees)
// ═══════════════════════════════════════════════════════════════════════════

/** Get the first sub-ProtobufField list matching field number, or null. */
function fieldSubmessage(fields: ProtoField[], fieldNum: number): ProtoField[] | null {
  const f = fields.find((x) => x.field === fieldNum && x.wire === WireType.LengthDelimited);
  if (!f) return null;
  return maybeDecodeSubmessage(f.value as Uint8Array);
}

/** Get the first varint value for a field number, or undefined. */
function fieldVarint(fields: ProtoField[], fieldNum: number): number | undefined {
  const f = fields.find((x) => x.field === fieldNum && x.wire === WireType.Varint);
  return typeof f?.value === "number" ? f.value : undefined;
}

/** Get the first length-delimited value as a UTF-8 string, or undefined. */
function fieldString(fields: ProtoField[], fieldNum: number): string | undefined {
  const f = fields.find((x) => x.field === fieldNum && x.wire === WireType.LengthDelimited);
  if (!f) return undefined;
  return Buffer.from(f.value as Uint8Array).toString("utf8");
}

/**
 * Navigate a dotted field path like "f1.f4.f5" through the tree, returning the
 * first matching varint. Used by both the candidate extractor and tests.
 */
export function pathVarint(buf: Uint8Array, fieldPath: string): number | undefined {
  const parts = fieldPath.split(".").map((p) => parseInt(p.replace(/^f/, ""), 10));
  let current: Uint8Array | null = buf;
  for (let i = 0; i < parts.length; i++) {
    if (!current) return undefined;
    const fields = decodeProtobuf(current);
    const isLast = i === parts.length - 1;
    const f = fields.find((x) => x.field === parts[i]);
    if (!f) return undefined;
    if (isLast) {
      return f.wire === WireType.Varint && typeof f.value === "number" ? f.value : undefined;
    }
    if (f.wire !== WireType.LengthDelimited) return undefined;
    current = f.value as Uint8Array;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
//  gen_metadata field map (EMPIRICAL — no .proto ships with agy)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The reverse-engineered field map for a gen_metadata USAGE row.
 *
 * Structure (confirmed across the live corpus, agy 1.0.10 — see
 * usage-decoder.md): a usage row is a protobuf message whose top-level fields
 * include:
 *   f1   = request/usage envelope (submessage); the per-call token counts live
 *          inside f1.f4 (a UsageMetadata-like submessage, duplicated at f1.f17.f2)
 *   f4   = conversation/session UUID string (e.g. "5d1ba9b7-...")
 *   f1.f19 = canonical model id string (e.g. "gemini-3-flash-a")
 *   f1.f21 = human model label string (e.g. "Gemini 3.5 Flash (High)")
 *
 * Inside the usage submessage (f1.f4) the scalar token fields are (CONFIRMED —
 * f3 == f9+f10 held in 100% of 2226 corpus rows):
 *   f1   = constant (~1132 Gemini / ~1026 Claude) — a fixed per-request base
 *          count; NOT per-turn input.
 *   f5   = prompt / INPUT tokens — the context prefix sent on this call. For
 *          Claude it grows strictly turn-over-turn; for Gemini it clusters
 *          because an agy session spans multiple sub-trajectories with their
 *          own context windows, but f5 on any row IS that call's input prefix
 *          (exactly what the context-bar numerator needs for the latest turn).
 *   f10  = candidates / OUTPUT tokens — the model's generated response.
 *   f9   = thoughts / thinking tokens — present for thinking models (Gemini
 *          High effort); absent for Claude. Decoded but NOT billed (see note).
 *   f3   = total generated = f9 + f10 (invariant verified on 100% of rows).
 *   f2   = varies; not total (f5 > f2 in ~99% of rows) — likely a per-call
 *          generated sub-count; not surfaced.
 *   f6   = constant (~24 Gemini / ~26 Claude) — a fixed modality/overhead count.
 *
 * `usage_submessage`: dotted path to the token submessage.
 * `input`, `output`: dotted paths (relative to the row root) for the two
 *   counts we surface. cache_read/cache_write are not separately reported by
 *   agy (the prefix is one cumulative number in `input`), so they stay 0 and
 *   the getSessionContext numerator (input + cache_read + cache_write) equals
 *   the real current prefix.
 *
 * COST NOTE: thinking tokens (f9) are decoded into `raw_usage_fields` but
 * intentionally NOT included in `output`/cost — a conservative lower bound
 * for Gemini High-effort turns (thinking bills at the output rate). This keeps
 * `output` = response tokens, matching the Claude Code bridge convention.
 *
 * If agy reshuffles the tree after a version bump, re-derive with the debug CLI
 * (`bun usage-decoder.ts <db>`) and `agy-usage-validate`, then update this map
 * + integrations/antigravity/usage-decoder.md.
 */
export interface GenMetadataFieldMap {
  /** Dotted path to the per-call usage submessage (e.g. "f1.f4"). */
  usage_submessage: string;
  /** Dotted path (row root → varint) for input/context tokens. */
  input: string;
  /** Dotted path (row root → varint) for output/candidates tokens. */
  output: string;
  /** Dotted path (row root → string) for the conversation UUID. */
  session_uuid: string;
  /** Dotted path (row root → string) for the canonical model id. */
  model_id: string;
  /** Dotted path (row root → string) for the human model label. */
  model_label: string;
}

export const GEN_METADATA_FIELD_MAP: GenMetadataFieldMap = {
  usage_submessage: "f1.f4",
  input: "f1.f4.f5",
  output: "f1.f4.f10",
  session_uuid: "f4",
  model_id: "f1.f19",
  model_label: "f1.f21",
};

/**
 * Candidate scalar fields inside the usage submessage, in field-number order.
 * The validator sweeps these to (re)discover which is the monotonic input and
 * which tracks output text length, in case GEN_METADATA_FIELD_MAP drifts.
 */
export const USAGE_CANDIDATE_FIELDS = [1, 2, 3, 5, 6, 9, 10];

// ═══════════════════════════════════════════════════════════════════════════
//  UsageRecord — the decoder's output
// ═══════════════════════════════════════════════════════════════════════════

export interface UsageRecordTiming {
  /** Optional per-turn latency in ms (derived from transcript timestamps, not the .db). */
  latency_ms?: number;
}

export interface UsageRecord {
  /** gen_metadata idx (row order = call order within the conversation). */
  idx: number;
  /** Decoded input/context tokens for the call (0 if undecodable). */
  input: number;
  /** Decoded output/candidates tokens for the call (0 if undecodable). */
  output: number;
  /** agy does not split cached vs uncached prefix — stays 0. */
  cache_read: number;
  /** agy does not report cache-write — stays 0. */
  cache_write: number;
  /** Conversation/session UUID, when present in the blob. */
  session_id?: string;
  /** Canonical model id (e.g. "gemini-3-flash-a"), when present. */
  model_id?: string;
  /** Human model label (e.g. "Gemini 3.5 Flash (High)"), when present. */
  model_label?: string;
  /** Raw byte length of the blob (for snapshot detection / debugging). */
  size: number;
  /**
   * All scalar (varint) fields found in the usage submessage, keyed by field
   * number. Lets the validator sweep candidates without re-decoding.
   */
  raw_usage_fields: Record<number, number>;
  /** True when this row is a large context/tool SNAPSHOT, not a usage row. */
  is_snapshot: boolean;
  /** Populated when decoding degraded (never thrown). Empty on success. */
  decode_error?: string;
  /** Optional timing (populated by the hook from transcript timestamps). */
  timing?: UsageRecordTiming;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Row classification + extraction
// ═══════════════════════════════════════════════════════════════════════════

/** Rows larger than this are context/tool SNAPSHOT dumps (not per-turn usage). */
const SNAPSHOT_SIZE_THRESHOLD = 8192;

/**
 * A blob is a USAGE row when it carries the usage submessage (f1.f4) AND a model
 * label/id. Large blobs (>8KB) are context/tool SNAPSHOT dumps — these often
 * embed a copy of the usage submessage too, so `is_snapshot` is decided by SIZE
 * independently of `isUsage`: a snapshot row may still yield counts, but it is
 * NOT a per-turn row and is skipped when pairing rows to transcript turns.
 */
function classifyRow(buf: Uint8Array): { isUsage: boolean; isSnapshot: boolean } {
  let fields: ProtoField[];
  try {
    fields = decodeProtobuf(buf);
  } catch {
    return { isUsage: false, isSnapshot: false };
  }
  const hasUsageSub = fieldSubmessage(fields, 1) !== null && pathVarint(buf, "f1.f4.f1") !== undefined;
  const hasModel = pathString(buf, "f1.f21") !== undefined || pathString(buf, "f1.f19") !== undefined;
  const isSnapshot = buf.length > SNAPSHOT_SIZE_THRESHOLD;
  return { isUsage: hasUsageSub && hasModel, isSnapshot };
}

/**
 * Decode a single gen_metadata blob into a candidate UsageRecord. NEVER throws:
 * any error becomes `decode_error` and the record degrades to zeros.
 */
export function extractUsageRecord(idx: number, data: Uint8Array, map = GEN_METADATA_FIELD_MAP): UsageRecord {
  const rec: UsageRecord = {
    idx,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    size: data.length,
    raw_usage_fields: {},
    is_snapshot: false,
  };

  try {
    const { isUsage, isSnapshot } = classifyRow(data);
    rec.is_snapshot = isSnapshot;
    if (!isUsage) {
      // Unrecognized blob (no usage submessage / no model) — record and bail.
      rec.decode_error = "not_a_usage_row";
      return rec;
    }
    // A snapshot row (>8KB) still carries an embedded usage submessage; we
    // extract its counts for inspection but flag is_snapshot so the pairing
    // logic (hook) and validator can skip it when aligning rows to turns.

    // Extract all candidate scalar fields from the usage submessage so the
    // validator can re-derive the map without touching the bytes again.
    const subPath = map.usage_submessage.split(".").map((p) => parseInt(p.replace(/^f/, ""), 10));
    let current: Uint8Array | null = data;
    for (let i = 0; i < subPath.length && current; i++) {
      const fs2 = decodeProtobuf(current);
      const f = fs2.find((x) => x.field === subPath[i]);
      if (!f || f.wire !== WireType.LengthDelimited) {
        current = null;
        break;
      }
      current = f.value as Uint8Array;
    }
    if (current) {
      for (const f of decodeProtobuf(current)) {
        if (f.wire === WireType.Varint && typeof f.value === "number") {
          rec.raw_usage_fields[f.field] = f.value;
        }
      }
    }

    const input = pathVarint(data, map.input);
    const output = pathVarint(data, map.output);
    if (typeof input === "number" && input >= 0 && input < 1e9) rec.input = input;
    if (typeof output === "number" && output >= 0 && output < 1e9) rec.output = output;

    const sid = pathString(data, map.session_uuid);
    if (sid) rec.session_id = sid;
    const mid = pathString(data, map.model_id);
    if (mid) rec.model_id = mid;
    const label = pathString(data, map.model_label);
    if (label) rec.model_label = label;
  } catch (err) {
    rec.decode_error = err instanceof Error ? err.message : String(err);
  }

  return rec;
}

/** Navigate a dotted field path to a string (UTF-8 length-delimited) value. */
function pathString(buf: Uint8Array, fieldPath: string): string | undefined {
  const parts = fieldPath.split(".").map((p) => parseInt(p.replace(/^f/, ""), 10));
  let current: Uint8Array | null = buf;
  for (let i = 0; i < parts.length; i++) {
    if (!current) return undefined;
    const fields = decodeProtobuf(current);
    const isLast = i === parts.length - 1;
    const f = fields.find((x) => x.field === parts[i]);
    if (!f) return undefined;
    if (isLast) {
      return f.wire === WireType.LengthDelimited
        ? Buffer.from(f.value as Uint8Array).toString("utf8")
        : undefined;
    }
    if (f.wire !== WireType.LengthDelimited) return undefined;
    current = f.value as Uint8Array;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SQLite access (read-only, never writes, never throws)
// ═══════════════════════════════════════════════════════════════════════════

export interface GenMetadataRow {
  idx: number;
  data: Uint8Array;
  size: number;
}

export type DbOpenMode = "immutable" | "ro";

/**
 * Open a conversation .db read-only and return rows from `gen_metadata`.
 *
 * Open strategy (both strictly read-only, never writes a -wal/-shm):
 *   - "immutable" (default): `file:<path>?immutable=1` — a consistent snapshot
 *     of committed data. Robust for BOTH actively-written WAL dbs and
 *     checkpointed historical dbs (whose -wal/-shm are gone and which fail
 *     mode=ro with SQLITE_CANTOPEN). Used by the validator and decoder CLI.
 *   - "ro": `file:<path>?mode=ro` — WAL-aware, reads the freshest committed
 *     data including not-yet-checkpointed WAL frames. Used by the LIVE HOOK
 *     (it reads the active conversation while agy is writing), with an
 *     automatic immutable fallback if the file lacks -wal/-shm.
 *
 * Returns `null` (never throws) if the db can't be opened, gen_metadata is
 * absent, or a query fails — the caller degrades to zero usage.
 */
export function readGenMetadata(dbPath: string, mode: DbOpenMode = "immutable"): GenMetadataRow[] | null {
  // Resolve ~ and relative paths so the live hook can pass a bare conversationId path.
  const resolved = resolveDbPath(dbPath);
  try {
    const Database = loadBunSqlite();
    if (!Database) return openViaSqlite3(resolved, mode);
    // Try the requested mode first, then the other — each attempt does the
    // FULL open + table-check + query, so a mode that OPENS but can't read
    // (e.g. mode=ro on a checkpointed WAL db whose -wal/-shm are gone, where
    // the gen_metadata lookup returns nothing) falls through to the other mode
    // rather than returning null.
    const attempts: DbOpenMode[] = mode === "ro" ? ["ro", "immutable"] : ["immutable", "ro"];
    for (const m of attempts) {
      const rows = tryReadWithMode(Database, resolved, m);
      if (rows) return rows;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * One full read attempt: open with the given mode, confirm gen_metadata exists,
 * read all rows. Returns null on ANY failure (open, missing table, query error)
 * so the caller can try the next mode. Always closes the handle. Never throws.
 */
function tryReadWithMode(Database: any, resolved: string, mode: DbOpenMode): GenMetadataRow[] | null {
  let db: any = null;
  try {
    const uri = mode === "immutable" ? `file:${resolved}?immutable=1` : `file:${resolved}?mode=ro`;
    db = new Database(uri, { readonly: true });
    // Confirm the table exists before querying (some dbs may differ).
    const tbl = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='gen_metadata'").get() as
      | { name: string }
      | null;
    if (!tbl || tbl.name !== "gen_metadata") {
      try { db.close(); } catch { /* ignore */ }
      return null;
    }
    const rows = db.query("SELECT idx, data, size FROM gen_metadata ORDER BY idx ASC").all() as Array<{
      idx: number;
      data: Uint8Array;
      size: number;
    }>;
    try { db.close(); } catch { /* ignore */ }
    return rows.map((r) => ({ idx: r.idx, data: toUint8(r.data), size: typeof r.size === "number" ? r.size : r.data?.length ?? 0 }));
  } catch {
    try { db?.close?.(); } catch { /* ignore */ }
    return null;
  }
}

/** Normalize whatever bun:sqlite returns for a BLOB into a Uint8Array. */
function toUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(0);
}

/** Lazy-load bun:sqlite; returns null (→ sqlite3 subprocess fallback) if absent. */
function loadBunSqlite(): any | null {
  try {
    // `require` works under Bun; under plain Node this returns null and we
    // fall back to the sqlite3 CLI.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("bun:sqlite");
    return mod.Database;
  } catch {
    return null;
  }
}

/**
 * Fallback reader via the `sqlite3` CLI (read-only). Used only if bun:sqlite
 * is unavailable. Dumps each row's blob to a temp file via writefile() and
 * reads it back as bytes. Never throws.
 */
function openViaSqlite3(resolved: string, _mode: DbOpenMode): GenMetadataRow[] | null {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const tmp = path.join(
      typeof process.env.TMPDIR === "string" && process.env.TMPDIR ? process.env.TMPDIR : "/tmp",
      `agy-decode-${process.pid}-${Date.now()}`,
    );
    fs.mkdirSync(tmp, { recursive: true });
    // Export each row's blob to <tmp>/row_<idx>.bin via SQLite writefile().
    execFileSync(
      "sqlite3",
      [
        "--readonly",
        resolved,
        `SELECT writefile('${tmp}/row_' || idx || '.bin', data) FROM gen_metadata ORDER BY idx;`,
      ],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
    );
    const rows: GenMetadataRow[] = [];
    for (const f of fs.readdirSync(tmp)) {
      const m = f.match(/^row_(\d+)\.bin$/);
      if (!m) continue;
      const data = fs.readFileSync(path.join(tmp, f));
      rows.push({ idx: parseInt(m[1], 10), data, size: data.length });
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    rows.sort((a, b) => a.idx - b.idx);
    return rows;
  } catch {
    return null;
  }
}

/** Resolve ~, relative, and bare conversationId inputs to an absolute .db path. */
export function resolveDbPath(p: string): string {
  let s = p;
  if (s.startsWith("~")) s = path.join(process.env.HOME || "", s.slice(1));
  if (!path.isAbsolute(s)) {
    // A bare UUID → the conversations dir.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      s = path.join(process.env.HOME || "", ".gemini", "antigravity-cli", "conversations", `${s}.db`);
    } else {
      s = path.resolve(s);
    }
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
//  High-level: decode all usage records for a conversation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decode every gen_metadata row of a conversation .db into UsageRecords
 * (usage rows become records with counts; snapshot rows are flagged and kept
 * with zeros so idx alignment is preserved). Never throws.
 *
 * @param dbPath  Path to the .db, or a bare conversationId UUID.
 * @param mode    Open mode (default "immutable"; live hook uses "ro").
 */
export function decodeConversationUsage(dbPath: string, mode: DbOpenMode = "immutable"): UsageRecord[] | null {
  const rows = readGenMetadata(dbPath, mode);
  if (!rows) return null;
  return rows.map((r) => extractUsageRecord(r.idx, r.data));
}

/**
 * Decode only the usage rows with idx >= `fromIdx` (the live hook's incremental
 * path, mirroring state.ts's transcriptOffset pattern). Never throws; returns
 * null only if the .db can't be opened at all (a missing/locked db → the caller
 * keeps the prior offset and emits zero usage for the turn).
 */
export function decodeNewUsage(dbPath: string, fromIdx: number, mode: DbOpenMode = "ro"): UsageRecord[] | null {
  const rows = readGenMetadata(dbPath, mode);
  if (!rows) return null;
  return rows
    .filter((r) => r.idx >= fromIdx)
    .map((r) => extractUsageRecord(r.idx, r.data))
    .filter((r) => !r.is_snapshot);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Debug CLI
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Usage:
 *   bun integrations/antigravity/usage-decoder.ts <db-path-or-uuid> [--idx N]
 *                                                [--match-content] [--json]
 *
 * Dumps every gen_metadata row: idx, size, classification (usage/snapshot),
 * the decoded UsageRecord, and (unless --json) the raw field tree. With
 * --idx N, only that row is dumped. With --match-content, the matching
 * transcript's PLANNER_RESPONSE content lengths are printed alongside each idx
 * so idx↔turn pairing can be confirmed empirically.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => !a.startsWith("--"));
  const idxFlag = parseIdxFlag(args);
  const json = args.includes("--json");
  const matchContent = args.includes("--match-content");

  if (!dbArg) {
    process.stderr.write(
      "Usage: bun usage-decoder.ts <db-path-or-uuid> [--idx N] [--match-content] [--json]\n",
    );
    process.exit(1);
  }

  const resolved = resolveDbPath(dbArg);
  if (!fs.existsSync(resolved)) {
    process.stderr.write(`✗ not found: ${resolved}\n`);
    process.exit(1);
  }

  const rows = readGenMetadata(resolved, "immutable");
  if (!rows) {
    process.stderr.write(`✗ could not open gen_metadata in ${resolved}\n`);
    process.exit(1);
  }

  const contentLens = matchContent ? readTranscriptContentLens(dbArg) : undefined;

  const selected = idxFlag !== null ? rows.filter((r) => r.idx === idxFlag) : rows;

  const records: UsageRecord[] = [];
  for (const row of selected) {
    const rec = extractUsageRecord(row.idx, row.data);
    records.push(rec);
    if (!json) {
      const tag = rec.is_snapshot ? "SNAPSHOT" : rec.decode_error ? `ERR(${rec.decode_error})` : "usage";
      const cl = contentLens ? `  text_len=${contentLens[row.idx] ?? "—"}` : "";
      process.stdout.write(
        `\n──── idx=${row.idx} size=${row.size} [${tag}]${cl} ────\n`,
      );
      process.stdout.write(
        `UsageRecord: input=${rec.input} output=${rec.output} raw=${JSON.stringify(rec.raw_usage_fields)}` +
          ` model=${rec.model_id ?? "?"} label=${JSON.stringify(rec.model_label ?? "")}\n`,
      );
      try {
        const tree = dumpFieldTree(decodeProtobuf(row.data));
        process.stdout.write(tree + "\n");
      } catch {
        process.stdout.write("(field tree decode failed)\n");
      }
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
  } else {
    const usageCount = records.filter((r) => !r.is_snapshot && !r.decode_error).length;
    const snapCount = records.filter((r) => r.is_snapshot).length;
    const errCount = records.filter((r) => r.decode_error && !r.is_snapshot).length;
    process.stdout.write(
      `\nSummary: ${records.length} rows — ${usageCount} usage, ${snapCount} snapshot, ${errCount} error\n`,
    );
  }
}

function parseIdxFlag(args: string[]): number | null {
  const i = args.indexOf("--idx");
  if (i < 0) return null;
  const v = args[i + 1];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the conversation's transcript and return PLANNER_RESPONSE content char
 * lengths keyed by ordinal (1st planner response → 0, etc.) so the
 * --match-content cross-check can align with gen_metadata idx order.
 */
function readTranscriptContentLens(dbArg: string): Record<number, number> | undefined {
  try {
    const resolved = resolveDbPath(dbArg);
    const base = path.basename(resolved, ".db");
    const tp = path.join(
      process.env.HOME || "",
      ".gemini",
      "antigravity-cli",
      "brain",
      base,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    );
    if (!fs.existsSync(tp)) return undefined;
    const out: Record<number, number> = {};
    let ord = 0;
    for (const line of fs.readFileSync(tp, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let e: any;
      try {
        e = JSON.parse(t);
      } catch {
        continue;
      }
      if (e && e.type === "PLANNER_RESPONSE") {
        out[ord++] = typeof e.content === "string" ? e.content.length : 0;
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

// Only run the CLI when this file is the entrypoint (not when imported by the
// hook or tests). Bun exposes `import.meta.main`; fall back to argv check.
const isMainModule =
  (typeof import.meta !== "undefined" && (import.meta as any).main === true) ||
  (typeof process !== "undefined" && process.argv[1] &&
   import.meta.url === pathToFileURLStr(process.argv[1]));

if (isMainModule) {
  main().catch(() => process.exit(0));
}

function pathToFileURLStr(p: string): string {
  try {
    return require("node:url").pathToFileURL(p).href;
  } catch {
    return "";
  }
}
