# agy `gen_metadata` usage decoder — empirical field map

This note records how the reverse-engineered protobuf field map in
[`usage-decoder.ts`](./usage-decoder.ts) (`GEN_METADATA_FIELD_MAP`) was derived
and validated against the live conversation corpus. agy ships **no `.proto`
schema**, so this map is empirical. Re-run `just agy-usage-validate` after an
agy version bump and re-derive with `bun usage-decoder.ts <db>` if the verdict
below regresses.

**Verified against agy 1.0.10** (48 conversation `.db` files,
2 275 `gen_metadata` rows, 2 226 usage rows).

---

## Where the data lives

agy writes one SQLite database per conversation at
`~/.gemini/antigravity-cli/conversations/<conversationId>.db`. The
`gen_metadata` table is `(idx INTEGER, data BLOB, size INTEGER)`; each `data`
blob is a protobuf message. Most rows are small (~1 KB) **per-call usage**
rows; a few are large (100 KB – 2 MB) **context/tool snapshot** dumps
(periodic full-context snapshots that also embed a copy of the usage
submessage). The decoder treats rows > 8 KB as snapshots and skips them when
pairing rows to transcript turns.

The hooks and the JSONL transcript carry **no** token usage, cost, or timing —
this table is the only source.

## Confirmed field map

A usage row's protobuf tree (top-level fields, then the nested usage submessage):

```
f4            conversation/session UUID        "5d1ba9b7-…"
f1            request/usage envelope (submsg)
  f1.f4       per-call UsageMetadata-like submsg (also duplicated at f1.f17.f2)
    f1.f4.f1  ~const base/modality count       1132 (Gemini) / 1026 (Claude)
    f1.f4.f5  prompt / INPUT tokens            ← INPUT (context prefix)
    f1.f4.f10 candidates / OUTPUT tokens       ← OUTPUT (generated response)
    f1.f4.f9  thoughts / thinking tokens       (Gemini High effort; absent for Claude)
    f1.f4.f3  total generated = f9 + f10       ← invariant (see below)
    f1.f4.f2  per-call generated sub-count     (not surfaced; not the total)
    f1.f4.f6  ~const overhead count            24 (Gemini) / 26 (Claude)
  f1.f19      canonical model id               "gemini-3-flash-a"
  f1.f21      human model label                "Gemini 3.5 Flash (High)"
```

So in `GEN_METADATA_FIELD_MAP`:

| UsageRecord key | path        | meaning                                            |
| --------------- | ----------- | -------------------------------------------------- |
| `input`         | `f1.f4.f5`  | prompt / context prefix sent on the call           |
| `output`        | `f1.f4.f10` | candidates — the model's generated response        |
| `cache_read`    | —           | 0 (agy does not report cached content separately)  |
| `cache_write`   | —           | 0                                                  |
| `session_id`    | `f4`        | conversation UUID                                  |
| `model_id`      | `f1.f19`    | canonical model id                                 |
| `model_label`   | `f1.f21`    | human label (same string `contextWindowForLabel` keys on) |

### Why this is trustworthy

- **Invariant `f3 == f9 + f10` holds in 100 % of rows** (2 226 / 2 226, 0
  violations). This pins the output/thinking split: f10 is the candidates
  count and f9 is the thinking count, summing to the generated total f3. For
  Claude (a thinking model whose thinking is reported elsewhere) f9 is absent
  and f3 == f10.
- **f5 is the input/context prefix.** For Claude Opus 4.6 it grows strictly
  turn-over-turn (e.g. 17 874 → 21 944 → 28 166 → 31 528), which only an
  input/prompt count does. It is the only candidate that behaves this way.
- **f1, f6 are constants** (~1 132/1 026 and ~24/26 respectively) across the
  whole corpus — fixed per-request base/overhead counts, not per-turn usage.

### The monotonicity caveat (Gemini)

`agy-usage-validate` reports per-file INPUT monotonicity at **18 / 48** files.
This does **not** refute `f5 = input`. The non-monotonic files are all Gemini
sessions: an agy conversation spans multiple **sub-trajectories** (the
`trajectory_meta` / `cascade_id` tables), each with its own context window, so
f5 resets/clusters at trajectory boundaries (e.g. a session bounces between
~12 k, ~65 k, ~86 k, ~98 k prefixes). Within a sub-trajectory f5 is still
non-decreasing. For the dashboard's context bar this is exactly right: the
numerator (`getSessionContext` = latest `usage.input + cache_read +
cache_write`) uses the **most recent** turn's f5, which is that turn's real
prompt size regardless of historical monotonicity.

## Cost note (thinking tokens are decoded but not billed)

Gemini 3.5 Flash (High) does a lot of thinking — f9 is often larger than f10.
Thinking bills at the output rate, but the decoder intentionally keeps
`output = f10` (candidates only) so the "output tokens" column matches the
Claude Code bridge convention (response tokens). **Cost is therefore a
conservative lower bound for thinking-heavy turns.** `f9` and `f3` are still
decoded into `raw_usage_fields` for inspection. If accurate thinking-inclusive
cost is needed later, bill `f5·in + (f9+f10)·out`.

## Open SQLite read strategy

Two read-only open modes, both strictly non-writing (never creates/touches
`-wal`/`-shm`):

- **`immutable=1`** (decoder CLI + validator + historical reads): a consistent
  snapshot of committed data. Robust for **both** actively-written WAL dbs and
  checkpointed historical dbs whose `-wal`/`-shm` are gone (those fail plain
  `mode=ro` with `SQLITE_CANTOPEN`). With `immutable=1` the validator opened
  **100 %** of the 48 corpus files.
- **`mode=ro`** (live hook): WAL-aware — reads the freshest committed data
  including not-yet-checkpointed WAL frames. The live hook tries `mode=ro`
  first (correct for the active conversation) and falls back to `immutable=1`
  if the file lacks `-wal`/`-shm`.

All access is via `bun:sqlite` (Bun is the hook runtime), with an automatic
`sqlite3 --readonly` subprocess fallback if `bun:sqlite` is unavailable. Every
failure path (locked / corrupt / missing db, malformed blob, unknown tree)
degrades to a zero `UsageRecord` + a `decode_error` string — the decoder never
throws, so a hook can never block agy.

## Corpus coverage (agy 1.0.10)

| metric                              | value        |
| ----------------------------------- | ------------ |
| conversation `.db` files            | 48           |
| opened OK (`immutable=1`)           | 48 (100 %)   |
| `gen_metadata` rows                 | 2 275        |
| usage rows (decoded)                | 2 226        |
| snapshot rows (> 8 KB, skipped)     | 46           |
| decode-error rows                   | 3            |
| wild varints (> 1e9)                | 0            |
| `f3 == f9+f10` invariant violations | 0 / 2 226    |

### Model / effort variance observed

- **Gemini 3.5 Flash (High)** — 2 211 usage rows, model id
  `gemini-3-flash-a`. f9 (thinking) present and often dominant.
- **Claude Opus 4.6 (Thinking)** — 293 usage rows (across a few sessions),
  model id `claude-opus-4-6-thinking`. f9 absent; f3 == f10 (candidates).

One session (`ee0c5ad1`) switched model mid-run and shows both labels. No
field-tree variance was observed between the two model families beyond the
presence/absence of f9 — the map holds for both.

## Unexplained / out-of-scope rows

- **3 decode-error rows** across the corpus — blobs that did not carry the
  usage submessage + model label (likely a non-standard step type agy logged
  into `gen_metadata`). Flagged `not_a_usage_row`, zeroed, never thrown.
- **46 snapshot rows** — large context/tool dumps; correctly classified and
  skipped for turn pairing. They embed a usage submessage whose f5 ≈ the last
  real usage row's f5 (a useful consistency check, e.g. 57 075 → 57 077).
- **f2** — a per-call generated sub-count that is **not** the total (f5 > f2
  in ~99 % of rows) and not needed for input/output/cost. Left in
  `raw_usage_fields` for future analysis.

## Re-deriving after an agy bump

1. `just agy-usage-validate` — check the `INVARIANT f3 == f9+f10` line still
   says `✓ HOLDS` and the `VERDICT` confirms INPUT/OUTPUT. If the invariant
   breaks, the field tree has shifted.
2. `bun integrations/antigravity/usage-decoder.ts <db> --idx 0` — dump the
   full field tree of one usage row and re-locate the input (monotonic for a
   Claude session) and output (the field that with f9 sums to the f3-style
   total) fields.
3. Update `GEN_METADATA_FIELD_MAP` and this note.
