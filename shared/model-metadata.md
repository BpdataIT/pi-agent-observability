# Shared Model Metadata — single source of truth

`shared/model-metadata.ts` is the **one place** model → context window,
model → price, and model → provider knowledge lives for the observability
stack. Edit a row there and every consumer picks it up.

> 📍 **Edit one file:** `shared/model-metadata.ts`.
> ✅ **Verify it:** `just model-metadata-validate` (and `just model-metadata-selftest`).

---

## Who consumes it

| Consumer | How | Reads |
|---|---|---|
| **agy bridge** (`integrations/antigravity/`) | `model-context.ts` + `model-prices.ts` are **thin wrappers** that delegate to the shared module (signatures preserved → no call-site edits) | window, price |
| **claude-code bridge** (`integrations/claude-code/`) | `model-context.ts` + `model-prices.ts` thin wrappers; `obs-hook.ts:providerForModel` delegates to `providerForModelKey` with an `"anthropic"` fallback | window, price, provider |
| **observability UI** (`apps/observability/public/app.js`) | legacy-session fallback fetches `GET /models/context-window?model=…` (backed by the shared module); new sessions use the stamped value, never the network | window |
| **observability server** (`apps/observability/server.ts`) | serves that endpoint directly from the shared module | window |

### Who does NOT consume it — the pi extension

**The pi extension (`extension/pi-observability.ts`) stays runtime-driven** for
`context_window`: it reads `ctx.getContextUsage().contextWindow` at `message_end`,
which is strictly more accurate than any static table (it reflects the real
window pi is enforcing, including provider-side caps and `--context-window`
overrides). Adopting the shared table there would be a **regression**. Cost for
pi sessions comes from `event.message.usage.cost?.total` (pi computes it) — also
left alone.

**The shared table is the fallback for the out-of-process integrations and the
UI legacy path, NOT a replacement for pi's runtime values.** Do not wire the pi
extension to the shared context table.

---

## The normalizer — `normalizeModelKey(raw)`

Three key forms flow into one canonical lowercase bare-id key so a single table
answers every caller:

1. **agy human display label** — `"Gemini 3.5 Flash (High)"`
2. **claude-code canonical id** — `"glm-5.2"`, `"zai-org/GLM-5.2"`, `"claude-opus-4-8-20250514"`
3. **UI / registry slug** — `"gemini-3.5-flash"`

Algorithm (step-by-step):

1. **lowercase**
2. **strip `org/` prefix** — `.replace(/^.*\//, "")`
   → `zai-org/GLM-5.2` and `z-ai/glm-4.6` become bare ids
3. **strip trailing `(<effort>)`** — `.replace(/\s*\([^)]*\)\s*$/, "")`
   → `"Gemini 3.5 Flash (High)"` loses `"(High)"`
4. **unify separators** — `.replace(/[-_\s]+/g, "-")`
   → `"gemini 3.5 flash"` and `"gemini-3.5-flash"` collide (space ↔ hyphen).
   **`.` is intentionally NOT unified**, so `3.5` stays `3.5`.
5. **strip trailing date stamp** — `.replace(/-(\d{8})$/, "")`
   → `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`
6. **repeatedly strip trailing id-noise** — `-a | -thinking | -preview | -latest | -snapshot`
   → `gemini-3-flash-a` → `gemini-3-flash`; `claude-opus-4-6-thinking` → `claude-opus-4-6`
7. **collapse `--+` → `-`** and **trim** leading/trailing `-`

Resolution is **exact-match first, then both-direction prefix match** (so
`glm-5.2-0215` still hits `glm-5.2`). Mirrors the pre-migration
`getModelPrice` resolution.

---

## ⚠️ The lossy-pair caveat (the #1 risk)

The normalizer **cannot** reconcile a label/id **version disagreement**. The
canonical example, taken from the live agy corpus:

| form | string | normalizes to |
|---|---|---|
| agy display label | `"Gemini 3.5 Flash (High)"` | `gemini-3.5-flash` |
| agy internal model_id | `gemini-3-flash-a` | `gemini-3-flash` |

These are **the same model** but normalize to **different keys** (`3.5` vs `3`,
because the label says "3.5" while the id says "3"). The space→hyphen rule
(step 4) makes the label collide with the id form **only when the version
numbers agree** — it cannot fix a 3.5-vs-3 disagreement.

**Resolution:** the `MODEL_TABLE` carries **both** keys explicitly when they
diverge (here: both `gemini-3.5-flash` and `gemini-3-flash`, both = 1M). The
self-test (`scripts/model-metadata-selftest.ts`, Stories 2.2/3.3) asserts both
resolve. A naive "one Gemini entry + prefix match" would let the 3.5 label miss
and fall to `undefined` → the UI shows the 128k default. Don't go back to that.

Notes on the `gemini-3-flash` key:
- agy **always** supplies the label alongside the id, and the agy bridge
  computes cost from the **label** (`rec.model_label`), so `gemini-3.5-flash`
  (1.5/9) is what's used in practice for "Gemini 3.5 Flash" sessions.
- `gemini-3-flash` is **also** Google's canonical slug for the cheaper
  "Gemini 3 Flash" model (in 0.5/out 3). The bare id only ever reaches the
  price resolver via claude-code's canonical-id path, where Gemini 3 Flash
  rates are correct.

Other normalization cases the table handles by carrying explicit keys:
- `Claude Opus 4.6 (Thinking)` (label, → `claude-opus-4.6`) vs
  `claude-opus-4-6-thinking` (id, → `claude-opus-4-6`) — both resolve via the
  `claude-opus-4` anchor + prefix match (the `.` vs `-` diverges, but the
  shared `claude-opus-4` prefix catches both).
- `gemini-2-flash` (agy label) vs `gemini-2.0-flash` (canonical id) — an
  explicit alias entry reconciles these.

---

## How to add a model

1. Pick the canonical key — usually the registry slug (e.g. `qwen3.7-max`).
2. Add one row to `MODEL_TABLE` in `shared/model-metadata.ts`:
   ```ts
   "qwen3.7-max": {
     context_window: 1_000_000,
     price: { input_per_million: 2.5, output_per_million: 7.5,
              cache_read_per_million: 0.5, cache_write_per_million: 3.125 },
     provider: "qwen",
   },
   ```
3. If the model is reachable by a **label form that diverges** from the id form
   (see the lossy-pair caveat), add an **explicit alias row** for the
   label-derived key too.
4. Run `just model-metadata-validate`. It cross-checks against
   [models.dev](https://models.dev/api.json) and the live-session model set,
   and runs the lossy-pair self-test inline.
5. Done — no per-integration edits. `pi install` refreshes the wrappers; the
   UI endpoint reads HEAD.

### Provider ids

The provider strings must match what the integrations stamp on envelopes:
`anthropic`, `zhipuai` (GLM / Z.AI), `google`, `openai`, `deepseek`, `qwen`
(Alibaba), `moonshotai` (Kimi). `providerForModelKey` returns the `provider`
field; the claude-code wrapper falls back to `"anthropic"` when undefined.

### Pricing conventions

- Prices are **per-million tokens, USD**.
- **GLM `cache_write = 0`** is intentional — Z.AI reports no cache-write
  billing; the claude-code transcript reports `cache_creation_input_tokens` as
  0 for GLM. Do not copy Claude's cache-write rates.
- **Gemini `cache_write = 0`** is intentional — Google's implicit caching bills
  hourly storage, not per-token writes.
- **GPT / o-series / DeepSeek** are carried with `UNKNOWN_PRICE` (all-zero) —
  they're in the table for window + provider coverage only, preserving the
  pre-migration "cost_total: 0" behavior for those families. `getModelPrice`
  treats an all-zero entry as `unknown: true`. Wire real prices in only if you
  accept the cost-attribution change.

### `DEFAULT_CONTEXT_WINDOW`

`128_000`, exported from the shared module. The server endpoint returns it when
a model is unrecognized (so the UI always gets a sane denominator); the UI also
uses it as the pending/failure fallback for the legacy fetch.

---

## Validation

| Command | What it does |
|---|---|
| `just model-metadata-selftest` | Lossy-pair + cost-snapshot gate (Stories 2.2/3.3). Exits non-zero on any failure. |
| `just model-metadata-validate` | Runs the self-test, cross-checks `MODEL_TABLE` against the models.dev registry (offline → WARNING + skip, exit 0), and against the distinct model set in `db/obs.db`. Exits non-zero only on a self-test failure. |

**Registry drift is informational, not fatal.** The shared table intentionally
reproduces the pre-migration integration tables for legacy models (the Phase 2/3
no-op constraint). For example `claude-opus-4-8` keeps `15/75` though the
registry lists `5/25`; the validator reports that drift so a maintainer sees it,
but does not fail. New models (Qwen, Kimi) must match the registry.

**Registry source:** `https://models.dev/api.json`, consulted 2026-06-20. The
validator caches it to `/tmp/models-dev-api.json` for the run; set
`NO_CACHE_REGISTRY=1` to force a fresh fetch.

---

## Why a server endpoint (not build-time codegen) for the UI

The UI is plain browser JS that cannot import the TS shared module without a
bundler step the repo doesn't have. The server already imports `shared/*`, so
`GET /models/context-window` always reflects HEAD (codegen would drift if the
build weren't re-run) and lets `DEFAULT_CONTEXT_WINDOW` live in one place. The
UI fetches it **once per legacy session** (cached on the stats object) and falls
back to `DEFAULT_CONTEXT_WINDOW` on failure, so a dead server never blanks the
context bar. Sessions that carry a stamped `context_window` (the common case)
never hit the network.
