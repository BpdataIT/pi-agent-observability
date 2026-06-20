# Implementation Plan: Shared Single-Source-of-Truth Model Metadata

## Metadata

**ID:** feature-7b2e9d
**Created:** 2026-06-20
**Total Stories:** 9
**Estimated Phases:** 5

## Feature Description

Reconcile the now-duplicated model-metadata knowledge that the observability
stack maintains in **four** separate places so a single edit fixes every
consumer. Today:

- **Context window (4 copies):** the pi extension reads the real window at
  runtime from `ctx.getContextUsage().contextWindow` (`extension/pi-observability.ts`,
  `message_end` handler — no static table); the agy integration keeps a
  human-label-keyed regex helper (`integrations/antigravity/model-context.ts` →
  `contextWindowForLabel`); the claude-code integration keeps a
  canonical-id-keyed helper (`integrations/claude-code/model-context.ts` →
  `contextWindowForModel`); and the UI ships a hardcoded regex table
  `MODEL_CONTEXT_WINDOWS` (`apps/observability/public/app.js:183-207`) used as
  the **fallback** for legacy events with no stored `context_window`.
- **Pricing (3 copies):** pi stamps `cost_total` from the model's own `usage.cost.total`
  (no price table); agy has a Gemini (+Claude) price table
  (`integrations/antigravity/model-prices.ts`, keyed on space-normalized
  labels like `"gemini 3.5 flash"`); claude-code has a Claude (+GLM) price
  table (`integrations/claude-code/model-prices.ts`, keyed on canonical ids
  like `"claude-opus-4-8"`). Plus a `providerForModel` helper hard-coded in
  `integrations/claude-code/obs-hook.ts`.

This drift is concrete and already biting: `glm-5.2`'s 1M window had to be
pinned in `claude-code/model-context.ts` **and** would be mis-sized by the UI
regex table (`/^glm-/i → 128_000` — only saved because new sessions carry the
stamped `context_window`). Provider derivation is copied. Pricing constants are
duplicated across the two integrations.

The plan introduces **`shared/model-metadata.ts`** as the single source of
truth for (a) model → context window, (b) model → per-million price
(input/output/cache_read/cache_write), and (c) model → provider id. A single
normalizer, `normalizeModelKey(raw)`, collapses the **three** key forms in play —
agy's human display label (`"Gemini 3.5 Flash (High)"`), claude-code's
canonical id (`"glm-5.2"`, `"zai-org/GLM-5.2"`), and the UI's
regex-on-name (`/^claude-opus-4-8/i`) — into one canonical bare-id key
(`"glm-5.2"`, `"gemini-3.5-flash"`) so one table answers all callers. The agy
and claude-code local modules become **thin wrappers** that preserve their
existing function signatures (so call sites are untouched) and delegate to the
shared module. The UI's regex fallback is **retired in favor of a server
endpoint** backed by the shared module, eliminating the last drift surface for
legacy sessions. A validation script + `just` target asserts the shared table
agrees with the models.dev registry and with the effective window the UI
*would* show for models seen in live sessions.

The pi extension is **intentionally left runtime-driven** for `context_window`
(it must not regress to a static table — `ctx.getContextUsage()` is strictly
better), and is left on pi's own `usage.cost.total` for cost (no price table
change). It is the one consumer that does *not* adopt the shared context table.

## Users

### Primary User
- **Persona:** Maintainer of this repo (the operator running `just obs` +
  `pi install git:github.com/BpdataIT/...@main` + the agy/cc bridges).
- **Goal:** When a provider ships a new context window or price (e.g. Google
  bumps Gemini 3.x to 2M, Anthropic reprices Opus 4.8), edit **one** file and
  have pi, agy, claude-code, and the UI all agree — with a CI-runnable check
  that catches drift against the models.dev registry.
- **Context:** Already burned by the glm-5.2 1M-vs-128k split and by copy-pasted
  price constants between the two integrations.

### Secondary Users
- **Reviewer / future builder:** Needs the shared table to be the obvious place
  to look, the normalizer rules to be documented and tested against the real
  agy label corpus, and the wrapper-signature compatibility to hold so a
  migration phase doesn't ripple into every call site.
- **Dashboard user:** Should notice nothing except fewer mis-sized context bars
  on legacy sessions (the UI fallback now consults the shared table via the
  server, so `/^glm-/i → 128k` stops under-sizing legacy glm-5.2 sessions).

## User Journey

1. A provider ships a new window. The maintainer opens `shared/model-metadata.ts`,
   edits one row in the `MODEL_TABLE`, and runs `just model-metadata-validate`,
   which fetches models.dev's `api.json`, diffs the tracked entries, and reports
   green. They commit.
2. `pi install git:github.com/BpdataIT/...@main` pushes the new `shared/model-metadata.ts`
   to the pi-installed clone; the next agy/claude-code hook process imports it
   through the thin local wrappers and stamps the corrected `context_window` /
   `cost_total` — no per-integration edit needed.
3. The dashboard, for a legacy session that predates `context_window` capture,
   hits `storedContextWindow == null`, fetches
   `GET /models/context-window?model=glm-5.2`, and renders the correct 1M bar
   instead of the old 128k regex fallback.
4. A future builder adding a new provider (e.g. `qwen-3-max`) adds one
   `MODEL_TABLE` entry; the shared `providerForModelKey`, `contextWindowForModelKey`,
   `getModelPrice`, and `computeCost` all pick it up, and both integration
   wrappers and the UI endpoint serve it with no further edits.

## User Stories

### Phase 1: Shared module + normalizers + validation harness

**Delivers:** `shared/model-metadata.ts` as the single source of truth, plus a
`just`-runnable validation harness that guards it against models.dev and
against the UI's effective behavior.
**Prerequisites:** None.

#### Story 1.1: Create `shared/model-metadata.ts` (normalizers + union table + lookups + computeCost)
**As a** maintainer
**I want to** one file (`shared/model-metadata.ts`) that owns model → context
window, model → price, and model → provider id, queryable by human label OR
canonical id through a single normalizer
**So that** the agy label table, the claude-code id table, the UI regex table,
and the two price tables collapse into a single editable source.

**Acceptance Criteria:**
- [ ] New module `shared/model-metadata.ts` exports:
  - `interface ModelPrice { input_per_million; output_per_million; cache_read_per_million; cache_write_per_million }`
    (same shape as both integrations' `ModelPrice`).
  - `interface ModelMeta { context_window: number; price: ModelPrice; provider: string }`.
  - `normalizeModelKey(raw: string | undefined): string` producing the canonical
    lowercase bare-id key. Algorithm (documented in a header comment):
    1. lowercase; 2. strip `org/` prefix via `.replace(/^.*\//, "")` (so
    `zai-org/GLM-5.2` and `z-ai/glm-4.6` → bare id); 3. strip trailing
    `(<effort>)` via `.replace(/\s*\([^)]*\)\s*$/, "")`; 4. unify separators
    `.replace(/[-_\s]+/g, "-")` (so `"gemini 3.5 flash"` and `"gemini-3.5-flash"`
    collide); 5. strip trailing date stamps `.replace(/-(\d{8})$/,"")`
    (`claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`); 6. repeatedly strip
    trailing id-noise tokens `-a|-thinking|-preview|-latest|-snapshot`
    (`gemini-3-flash-a` → `gemini-3-flash`); 7. collapse `--+`→`-` and trim.
  - `const MODEL_TABLE: Record<string, ModelMeta>` keyed by canonical key,
    holding the **union** of every model across the four current sources:
    Claude (opus-4-8/opus-4/sonnet-4-6/sonnet-4/haiku-4-5/haiku-4/3-opus/
    3-5-sonnet/3-5-haiku/3-haiku), GLM (5.2/5.1/5/4.7/4.6), Gemini
    (1.5-pro/1.5-flash/2.0-flash/2.5-flash/2.5-pro/3-flash/3-pro/3.1-pro/3.5-flash),
    GPT (5/4o/4), o1/o3, DeepSeek, plus **new** Qwen and Kimi(Moonshot) entries
    added from models.dev. Header comment records the registry source and
    consult date (`models.dev api.json, consulted 2026-06-20`).
  - `contextWindowForModelKey(raw): number | undefined` — exact-match on
    `normalizeModelKey`, then **both-direction prefix match** (mirror agy/cc
    `getModelPrice`) so `"glm-5.2-0215"` still hits `glm-5.2`. Returns
    `undefined` for unknown (never a default — callers/UI decide the default).
  - `getModelPrice(raw): ModelPrice & { unknown: boolean }` with the same
    exact-then-prefix resolution and an `UNKNOWN_PRICE` (all-zero) sentinel.
  - `providerForModelKey(raw): string | undefined` — `MODEL_TABLE` lookup of the
    `provider` field, exact-then-prefix; `undefined` when unknown (callers
    keep their existing fallbacks, e.g. claude-code → `"anthropic"`).
  - `computeCost(usage, raw): { cost_total; unknown_model }` — identical shape
    and never-throws contract to both integrations' `computeCost`.
  - `DEFAULT_CONTEXT_WINDOW = 128_000` exported for UI/server reuse (currently
    duplicated as a literal in `app.js`).
- [ ] GLM rows keep `cache_write_per_million: 0` (honest — Z.AI reports no
  cache-write billing) and the documented Z.AI coding-tier rates
  (`input 1.4 / output 4.4 / cache_read 0.26`).
- [ ] Gemini rows keep `cache_write_per_million: 0` (Google implicit caching —
  hourly storage, no per-token write fee), matching the agy price table.
- [ ] The module has **no** import of `shared/types.ts` types beyond the plain
  number/string interfaces it needs (it must stay importable by both the Bun
  server and the Bun hook scripts with zero friction — same constraint
  `shared/types.ts` already satisfies).
- [ ] A header comment states the single-source-of-truth convention and points
  to `shared/model-metadata.md` (Story 5.1).

**Complexity:** L
**Dependencies:** None

---

#### Story 1.2: Validation harness `scripts/model-metadata-validate.ts` + `just` target
**As a** maintainer
**I want to** run `just model-metadata-validate` to confirm the shared table
agrees with the models.dev registry and with the effective window the UI would
show for models that actually appear in live sessions
**So that** drift is caught before a provider change ships half-applied.

**Acceptance Criteria:**
- [ ] New script `scripts/model-metadata-validate.ts` following the
  `agy-usage-validate.ts` pattern (shebang `#!/usr/bin/env bun`, a `main()` that
  never throws, tables to stdout, a VERDICT block). Two checks:
  1. **Registry check:** fetch `https://models.dev/api.json` (with a short
     timeout + graceful skip-on-network-error that prints a WARNING, never
     fails the gate for offline runs), and for each `MODEL_TABLE` entry whose
     key matches a models.dev slug, assert the `context_window` and the price
     fields agree (tolerance: price equality to the cent; window exact).
     Report mismatches as a table. Models present in `MODEL_TABLE` but absent
     from the registry are listed but not fatal.
  2. **Live-session check:** open `db/obs.db` read-only (reuse the
     `apps/observability/db.ts` open pattern / `bun:sqlite`), select `DISTINCT
     model` from the `sessions` table (and/or `assistant_message` payloads),
     resolve each via the shared `contextWindowForModelKey`, and compare against
     the **current UI behavior** (import/embed the existing `MODEL_CONTEXT_WINDOWS`
     regex list + `getContextWindow` logic, or call the shared module's view of
     it). Flag any model where the shared window ≠ the UI-regex window — these
     are exactly the legacy-session regressions the endpoint (Phase 4) fixes.
- [ ] New `justfile` target `model-metadata-validate` running
  `bun scripts/model-metadata-validate.ts`, placed adjacent to
  `agy-usage-validate` in the EXTRA section.
- [ ] Exit code 0 on full agreement (or registry-unreachable); non-zero only on
  a hard mismatch in the live-session check.
- [ ] The script documents, in its header, that the agy display-label corpus
  (`~/.gemini/antigravity-cli/conversations/*.db` `model_label` column, via the
  existing `usage-decoder.ts`) and claude-code transcripts are the ground-truth
  pairs for the lossy label→id normalizer — see Story 2.2 / 3.3.

**Complexity:** M
**Dependencies:** 1.1

---

### Phase 2: Migrate agy to consume the shared module

**Delivers:** agy resolves windows/prices from `shared/model-metadata.ts`;
local `model-context.ts`/`model-prices.ts` become thin wrappers. Exact same
`context_window`/`cost_total` values as before.
**Prerequisites:** Phase 1.

#### Story 2.1: Thin agy `model-context.ts` + `model-prices.ts` to wrappers
**As a** reviewer
**I want to** the agy integration to delegate to the shared module without
changing any call-site signature
**So that** the migration is a body-swap, not a rewrite of `transcript.ts` /
`obs-hook.ts`.

**Acceptance Criteria:**
- [ ] `integrations/antigravity/model-context.ts`: `contextWindowForLabel(label)`
  keeps its exact signature (`(label: string | undefined) => number | undefined`)
  and call site (`transcript.ts:buildAssistantMessagePayload`), but its body
  becomes `return contextWindowForModelKey(label);` re-exported from
  `shared/model-metadata.ts`. The header comment is replaced with a pointer to
  the shared module + the agy-specific note that human labels flow through the
  same normalizer.
- [ ] `integrations/antigravity/model-prices.ts`: `getModelPrice`,
  `computeCost`, and the `ModelPrice` / `UsageForCost` types keep their exact
  signatures (used by `obs-hook.ts:decodeUsageForTurns`). Bodies delegate to
  the shared `getModelPrice` / `computeCost`. The local `normalizeModelLabel`
  is removed (the shared `normalizeModelKey` supersedes it) OR kept as a thin
  re-export if any external reference remains.
- [ ] `integrations/antigravity/transcript.ts` and `obs-hook.ts` **import lines
  are unchanged** (still `from "./model-context.ts"` / `"./model-prices.ts"`) —
  the migration must not require touching call sites.
- [ ] The agy `PROVIDER = "google"` constant in `obs-hook.ts` is left as-is
  (agy is Google-only; wiring the shared provider table is optional and not
  required here).

**Complexity:** S
**Dependencies:** 1.1

---

#### Story 2.2: Regression test — agy label corpus still resolves correctly
**As a** maintainer
**I want to** an assertion that agy's lossy human-label → canonical-id
normalization still resolves every label in the real agy corpus to the right
window and price after the move
**So that** a normalization bug can't silently flip e.g. "Gemini 3.5 Flash (High)"
from 1M to undefined or 128k.

**Acceptance Criteria:**
- [ ] Add a test (a `scripts/`-style or `*.test.ts` runner consistent with how
  the repo would run one; if no test runner exists, a `just`-invoked script
  `scripts/model-metadata-selftest.ts`) that exercises the shared module
  directly with the **known-lossy pairs**:
  - `"Gemini 3.5 Flash (High)"` → key `gemini-3.5-flash`, window `1_000_000`.
  - `"gemini-3-flash-a"` (real agy model_id per the price-table comment) → key
    `gemini-3-flash`, window `1_000_000` — and the test asserts **both** the
    label and the id resolve (they normalize to *different* keys, so both
    `gemini-3-flash` and `gemini-3.5-flash` must exist in `MODEL_TABLE`; this
    is the flagged lossy edge).
  - `"Gemini 3 Pro"`, `"Gemini 2.5 Flash"`, `"Gemini 1.5 Pro"` →
    `1_000_000` / `1_000_000` / `2_000_000`.
  - `"claude-opus-4-6-thinking"` (agy corpus example) → `claude-opus-4-6`,
    provider `anthropic`, non-zero price.
  - `"zai-org/GLM-5.2"` → `glm-5.2`, window `1_000_000`, provider `zhipuai`.
- [ ] The test asserts `computeCost` returns the same `cost_total` for
  `(usage, "Gemini 3.5 Flash (High)")` as the pre-migration agy table did
  (snapshot the Gemini 3.5 Flash rate `in 1.5 / out 9.0`).
- [ ] Gate: failure here blocks the Phase 2 merge.

**Complexity:** S
**Dependencies:** 1.1, 2.1

---

### Phase 3: Migrate claude-code to consume the shared module

**Delivers:** claude-code resolves windows/prices/provider from the shared
module; local modules become wrappers; `providerForModel` delegates too.
**Prerequisites:** Phase 1.

#### Story 3.1: Thin claude-code `model-context.ts` + `model-prices.ts` to wrappers
**As a** reviewer
**I want to** the claude-code integration to delegate to the shared module
without changing call-site signatures
**So that** `transcript.ts` / `obs-hook.ts` imports stay identical.

**Acceptance Criteria:**
- [ ] `integrations/claude-code/model-context.ts`: `contextWindowForModel(modelId)`
  keeps signature + call site (`transcript.ts:buildAssistantMessagePayload`),
  body becomes `return contextWindowForModelKey(modelId);`. The org/-prefix
  normalization (`zai-org/GLM-5.2` → `glm-5.2`) now lives in the shared
  normalizer; the header comment says so.
- [ ] `integrations/claude-code/model-prices.ts`: `getModelPrice`, `computeCost`,
  `ModelPrice`, `UsageForCost` keep signatures (used by `transcript.ts`); bodies
  delegate to the shared module.
- [ ] `integrations/claude-code/transcript.ts` imports unchanged.
- [ ] The Claude legacy aliases (`claude-3-5-sonnet-20241022`,
  `claude-3-opus-20240229`, `claude-3-haiku-20240307`, `claude-haiku-4`,
  `claude-opus-4`, `claude-sonnet-4`) are all present in the shared
  `MODEL_TABLE` (date-stamp + alias stripping in the normalizer is what makes
  the legacy dated ids resolve).

**Complexity:** S
**Dependencies:** 1.1

---

#### Story 3.2: Route claude-code `providerForModel` through the shared provider table
**As a** maintainer
**I want to** the `providerForModel` helper in `obs-hook.ts` to consult the
shared provider table
**So that** provider derivation for non-Anthropic models (glm→zhipuai,
gemini→google, gpt→openai, deepseek, qwen, kimi→moonshotai) isn't a third copy.

**Acceptance Criteria:**
- [ ] `integrations/claude-code/obs-hook.ts:providerForModel` keeps its
  signature and its `"anthropic"` fallback (preserving prior behavior for
  Claude models), but delegates the lookup to `providerForModelKey` from
  `shared/model-metadata.ts`, falling back to `"anthropic"` only when the shared
  lookup returns `undefined`.
- [ ] No behavior change for any model currently routed: `glm-*`→`zhipuai`,
  `gemini-*`→`google`, `gpt-*`/`o1`/`o3`→`openai`, `deepseek*`→`deepseek`,
  `qwen*`→`qwen`, `kimi*`→`moonshotai`, everything else →`anthropic`.

**Complexity:** S
**Dependencies:** 1.1

---

#### Story 3.3: Regression test — claude-code transcript corpus still resolves correctly
**As a** maintainer
**I want to** an assertion that every canonical id in claude-code transcripts
(incl. the `zai-org/` org form and dated aliases) still resolves to the same
window/price/provider after the move
**So that** the glm-5.2 1M fix and the Claude pricing don't silently regress.

**Acceptance Criteria:**
- [ ] Extend the self-test from Story 2.2 (same runner) with claude-code pairs:
  - `"glm-5.2"` → window `1_000_000`, provider `zhipuai`, price
    `in 1.4 / out 4.4 / cache_read 0.26 / cache_write 0`.
  - `"zai-org/GLM-5.2"` → same as above (org-prefix strip).
  - `"glm-4.6"` → window `204_800`.
  - `"claude-opus-4-8"` / `"claude-opus-4-8-20250514"` → window `1_000_000`,
    provider `anthropic`, price `in 15 / out 75`.
  - `"claude-sonnet-4-6"` → window `1_000_000`.
  - `"claude-3-5-sonnet-20241022"` → window `200_000`, dated-id strip works.
- [ ] Asserts `computeCost` on `(usage, "claude-opus-4-8")` equals the
  pre-migration snapshot (`in 15 / out 75 / cache_read 1.5 / cache_write 18.75`).

**Complexity:** S
**Dependencies:** 1.1, 3.1

---

### Phase 4: Reconcile the UI fallback (retire `MODEL_CONTEXT_WINDOWS`)

**Delivers:** the UI's legacy-session fallback consults the shared table via a
new server endpoint; the hardcoded regex table stops being a drift surface.
**Prerequisites:** Phase 1.

#### Story 4.1: Server endpoint `GET /models/context-window?model=...`
**As a** dashboard
**I want to** a server endpoint that returns the context window for a model
name, backed by the shared table
**So that** the UI's legacy-session fallback reads the same source of truth as
the integrations instead of a divergent regex table.

**Acceptance Criteria:**
- [ ] `apps/observability/server.ts` adds `GET /models/context-window?model=<raw>`
  returning `{ "context_window": <number> }` (using `DEFAULT_CONTEXT_WINDOW` when
  the shared lookup returns `undefined`), importing
  `contextWindowForModelKey` + `DEFAULT_CONTEXT_WINDOW` from
  `shared/model-metadata.ts`. Auth matches the other GETs (token-gated if
  `OBS_AUTH_TOKEN` is set, same as `/sessions`).
- [ ] Endpoint is unauthenticated-friendly for the model lookup (or shares the
  existing `/health`-style gate — pick whichever matches current `/sessions`
  auth so the UI's existing fetch headers work).
- [ ] **Recommendation rationale recorded in the story/PR:** the endpoint is
  chosen over build-time codegen of the regex array because (a) the UI is plain
  browser JS that cannot import the TS shared module without a bundler step the
  repo doesn't have; (b) the server already imports `shared/*`; (c) codegen
  would still drift if the build isn't re-run, whereas the endpoint always
  reflects HEAD; (d) it also lets `DEFAULT_CONTEXT_WINDOW` live in one place.

**Complexity:** S
**Dependencies:** 1.1

---

#### Story 4.2: UI `computeAgentInfo` uses the endpoint when `storedContextWindow` is null
**As a** dashboard user with legacy sessions
**I want to** the context bar for old sessions (no stamped `context_window`) to
use the shared table instead of the stale `/^glm-/i → 128k` regex
**So that** legacy glm-5.2 sessions render a 1M bar, not 128k.

**Acceptance Criteria:**
- [ ] `apps/observability/public/app.js`: `getContextWindow(model)` and the
  `MODEL_CONTEXT_WINDOWS` regex array are **removed** (or reduced to the
  `DEFAULT_CONTEXT_WINDOW` constant imported conceptually / inlined). The
  legacy-fallback branch in `computeAgentInfo` (`storedContextWindow != null ?
  storedContextWindow : getContextWindow(s.model)`) becomes: when
  `storedContextWindow == null`, lazily `fetch(
  \`${API}/models/context-window?model=${encodeURIComponent(s.model)}\`)` once
  per session (cache the result on the session stats object so it doesn't
  refetch per render), falling back to `DEFAULT_CONTEXT_WINDOW` (128k, same as
  today's terminal fallback) on fetch failure or pending state.
- [ ] No regression for sessions that DO carry `storedContextWindow` (the
  common case for any session recorded after the extension started stamping) —
  they never hit the network.
- [ ] The legacy `/^glm-/i → 128_000` and `/^z-ai\/glm-4\.6/i → 200_000` regexes
  are gone; their replacements live in `MODEL_TABLE`.
- [ ] The exported `getContextWindow` symbol on `window.obs` (line ~1145) is
  removed or aliased to the fetch helper so any console poking doesn't throw.

**Complexity:** M
**Dependencies:** 4.1

---

### Phase 5: Docs

**Delivers:** the single-source-of-truth convention is documented; the three
integration READMEs stop claiming local ownership of the tables.
**Prerequisites:** Phases 2-4.

#### Story 5.1: Document the convention + update the three READMEs
**As a** future builder
**I want to** a `shared/model-metadata.md` explaining the convention + the
normalizer rules, and the integration READMEs updated to point at it
**So that** I know to edit one file and trust the normalizer.

**Acceptance Criteria:**
- [ ] New `shared/model-metadata.md` documents: the single-source-of-truth
  rule, the `normalizeModelKey` algorithm step-by-step with the lossy cases
  (label→id space→hyphen; `gemini-3-flash` vs `gemini-3.5-flash` divergence;
  org/ strip; date + `-a/-thinking/-preview` tail strip), how to add a model,
  how to run `just model-metadata-validate`, and the explicit decision that the
  **pi extension stays runtime-driven** for `context_window` (the shared table
  is a fallback for the out-of-process integrations and the UI, NOT a
  replacement for `ctx.getContextUsage()`).
- [ ] `integrations/antigravity/README.md` and
  `integrations/claude-code/README.md` "how it works" / cost sections updated:
  replace "local price table" / "local context-window table" language with a
  pointer to `shared/model-metadata.ts` as the source, noting the local files
  are now thin wrappers preserved for signature compatibility.
- [ ] The header comments in the four former-source files (agy + cc
  `model-context.ts`/`model-prices.ts`) point at `shared/model-metadata.md`.

**Complexity:** S
**Dependencies:** 2.1, 3.1, 4.2

---

## Technical Context

### Existing Patterns
- `shared/types.ts`: the precedent for a `shared/` module imported by the
  extension, both hook scripts, and the server. `shared/model-metadata.ts` must
  satisfy the same import-from-everywhere constraint (no DOM-only or Node-only APIs).
- `integrations/{antigravity,claude-code}/model-prices.ts`: identical
  `ModelPrice` / `computeCost` / `getModelPrice` shapes (exact-then-prefix
  match, `UNKNOWN_PRICE` sentinel, never-throw). The shared module generalizes
  both; the wrappers keep these signatures verbatim.
- `apps/observability/db.ts:getSessionContext`: already extracts the stamped
  `context_window` via a SQL subquery (latest `assistant_message` carrying it),
  NULL for legacy. The UI's `computeAgentInfo` already prefers
  `stats.context_window` over its regex table — the regex is purely the legacy
  fallback. This means Phase 4 only touches the fallback branch.
- `justfile` `agy-usage-validate` → `bun scripts/agy-usage-validate.ts`: the
  template for `model-metadata-validate`.
- `scripts/agy-usage-validate.ts`: the template for the validation script
  (shebang, `main()` that never throws, tables-to-stdout, VERDICT block,
  graceful per-file error handling).
- `integrations/antigravity/usage-decoder.ts` `UsageRecord` carries both
  `model_label` and `model_id` — these are the ground-truth label↔id pairs for
  validating the lossy normalizer.

### New Components
- `shared/model-metadata.ts` — the single source of truth (Story 1.1).
- `scripts/model-metadata-validate.ts` — registry + live-session drift gate
  (Story 1.2).
- `scripts/model-metadata-selftest.ts` (or equivalent) — lossy-normalizer
  regression pairs (Stories 2.2 / 3.3).
- `GET /models/context-window` in `apps/observability/server.ts` (Story 4.1).

### Integration Points
- `integrations/antigravity/transcript.ts` → `contextWindowForLabel` (unchanged
  import after Story 2.1).
- `integrations/antigravity/obs-hook.ts:decodeUsageForTurns` → `computeCost`
  (unchanged import after Story 2.1).
- `integrations/claude-code/transcript.ts` → `computeCost` +
  `contextWindowForModel` (unchanged imports after Story 3.1).
- `integrations/claude-code/obs-hook.ts:providerForModel` (Story 3.2) +
  `handleStop` turn info provider (unchanged behavior).
- `apps/observability/public/app.js:computeAgentInfo` legacy-fallback branch
  (Story 4.2).
- `apps/observability/server.ts` new route (Story 4.1).
- The pi extension is **deliberately not** an integration point for the shared
  context table — see Decision below.

### Decision: the pi extension stays runtime-driven (no shared-table adoption)
The pi extension reads `contextUsage?.contextWindow ?? ctx.model?.contextWindow`
at `message_end` (`extension/pi-observability.ts`). This is strictly more
accurate than any static table (it reflects the real window pi is enforcing,
including provider-side caps and `--context-window` overrides). Adopting the
shared table as the extension's source would be a **regression**. Cost for pi
sessions comes from `event.message.usage.cost?.total` (pi computes it from the
model's own cost fields) — also left alone. The shared table is the fallback
for the **out-of-process** integrations (agy, claude-code) and the UI legacy
path, NOT a replacement for pi's runtime values. No pi code change is in scope.
If, later, pi ever needs a price/provider fallback (e.g. a model pi doesn't
know), the shared module is the place to consume — but that is out of scope here.

### Builder Notes
- **Lossy label→id normalization is the #1 risk.** The agy display label
  `"Gemini 3.5 Flash (High)"` and the real agy model_id `gemini-3-flash-a`
  normalize to **different** canonical keys (`gemini-3.5-flash` vs
  `gemini-3-flash`). The shared `MODEL_TABLE` MUST therefore carry BOTH keys
  (both = 1M), and the self-test (Story 2.2) MUST assert both resolve. A naive
  "one Gemini entry + prefix match" would let the 3.5 label miss and fall to
  `undefined` → UI shows 128k default. The space→hyphen rule is what makes the
  label form collide with the id form when the version numbers agree; it
  cannot reconcile label/id version disagreement (3.5 vs 3) — only explicit
  table entries can.
- **`zai-org/GLM-5.2` org-prefix case** — handled by step 2 of the normalizer
  (`.replace(/^.*\//, "")`). Also catches the UI's older `z-ai/glm-4.6` spelling.
  Both must reduce to the bare `glm-*` key.
- **Backward-compat wrapper signatures are load-bearing.** `contextWindowForLabel`,
  `contextWindowForModel`, `getModelPrice`, `computeCost`, and
  `providerForModel` all keep their current names + arities + return types so
  Phases 2/3 are pure body-swaps with zero call-site edits. Only the bodies
  change to delegate. Do not "clean up" the signatures during the migration —
  that turns a 1-file PR into a 5-file PR.
- **GLM `cache_write = 0` is intentional.** Z.AI reports no cache-write billing;
  the claude-code transcript reports `cache_creation_input_tokens` as 0 for GLM.
  Keep it 0 in the shared table — do not copy Claude's 1.0×/1.25× cache-write rates.
- **Gemini `cache_write = 0` is intentional** (Google implicit caching bills
  hourly storage, not per-token writes). Keep 0.
- **UI legacy path matters.** Events recorded before any integration stamped
  `context_window` rely on the fallback. Phase 4 must not break them: the
  endpoint must always return a number (defaulting to `DEFAULT_CONTEXT_WINDOW`),
  and the UI must fall back to that same default on fetch failure so a dead
  server doesn't blank the bar.
- **Regression risk = a flipped window.** A normalization bug that sends
  glm-5.2 from 1M → 128k is the exact failure this plan exists to prevent
  *and* the exact failure a sloppy migration could introduce. The self-test
  (Stories 2.2/3.3) gating Phases 2/3 is non-negotiable.
- **models.dev as registry oracle.** `https://models.dev/api.json` is the
  authoritative cross-provider catalog (already cited in the existing
  `model-context.ts`/`model-prices.ts` comments). The validation harness
  treats it as ground truth for windows/prices but must degrade gracefully
  offline (the `agy-usage-validate` precedent: never hard-fail on environment).
- **No new runtime dependency.** The shared module + wrappers add no npm
  packages; the validation script uses `fetch` (Bun/global) + `bun:sqlite`
  (already used by `db.ts`).

## Definition of Done

- [ ] All acceptance criteria met across Stories 1.1–5.1.
- [ ] `shared/model-metadata.ts` is the only place model→window/price/provider
  knowledge lives; the four former sources either delegate (agy/cc wrappers),
  are served by it (UI via endpoint), or are intentionally exempt (pi runtime).
- [ ] `just model-metadata-validate` passes against models.dev (or warns
  offline) and against the live-session model set.
- [ ] The lossy-normalizer self-test (Stories 2.2/3.3) passes — including the
  `gemini-3-flash` vs `gemini-3.5-flash` divergence and the `zai-org/GLM-5.2`
  org-prefix case.
- [ ] No call-site signature changes in `transcript.ts` / `obs-hook.ts` for
  either integration (Phases 2/3 are body-swaps).
- [ ] The pi extension still reads `context_window` from
  `ctx.getContextUsage()` at runtime — no static-table regression.
- [ ] Legacy UI sessions (no stamped `context_window`) still render a sane
  context bar via the new endpoint, defaulting to 128k on failure.
- [ ] GLM and Gemini rows keep `cache_write_per_million: 0`.
- [ ] Follows existing codebase patterns (`shared/` importability, `scripts/` +
  `justfile` validation pattern, `shared/types.ts` header-comment convention,
  never-throw `computeCost`).
