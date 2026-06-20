/**
 * app.js — Pi Observability v2→v3 UI: state, single-mode, SSE, keyboard nav.
 * Swimlane mode delegated to swimlane.js. IIFE-wrapped for scope isolation.
 */
(function() {

// ─── State ──────────────────────────────────────────────────────────────────

const STATE = {
  // V3 regression fix: token must come from ?token=… query param. The hash is
  // for shareable view-state only; we don't want the token in shared URLs.
  token: new URLSearchParams(location.search).get("token") ?? "",
  view: "single", mode: "form", pool: "", tag: "", search: "", sort: "latest", hideAfter: "30m", showHidden: false,
  typeFilter: new Set(), autoScroll: true,
  selectedSessionId: null, sessions: [], events: [], sessionsLoaded: false, hiddenSessions: loadHiddenSessions(),
  sidebarCollapsed: loadSidebarCollapsed(),
  focusedIdx: -1, lastEventTs: null,
  sseReconnectDelay: 1000, maxReconnectDelay: 10_000,
  renderDirty: true, seenIds: new Set(),
  sessionStats: {}, // sid → {total_cost,total_tokens,error_count}
  ackd: new Set(),
};

window.__OBS_STATE = STATE;

// ─── URL state ──────────────────────────────────────────────────────────────

function loadURLState() {
  const h = location.hash.replace(/^#/, "");
  if (!h) return;
  const p = new URLSearchParams(h);
  if (p.has("view")) STATE.view = p.get("view");
  if (!["single", "swimlane", "race"].includes(STATE.view)) STATE.view = "single";
  if (p.has("mode")) STATE.mode = p.get("mode");
  else { const stored = localStorage.getItem("obs-mode"); if (stored === "form" || stored === "function") STATE.mode = stored; }
  if (p.has("pool")) { STATE.pool = p.get("pool"); poolFilter.value = STATE.pool; }
  if (p.has("tag")) { STATE.tag = p.get("tag"); tagFilter.value = STATE.tag; }
  if (p.has("sort")) { STATE.sort = p.get("sort"); sortSelect.value = STATE.sort; }
  if (p.has("hide_after")) { STATE.hideAfter = p.get("hide_after"); hideAfterSelect.value = STATE.hideAfter; }
  if (p.has("show_hidden")) { STATE.showHidden = p.get("show_hidden") === "1"; showHiddenCB.checked = STATE.showHidden; }
  if (p.has("sid")) { STATE.selectedSessionId = p.get("sid"); STATE.ackd.add(STATE.selectedSessionId); }
  if (p.has("lanes")) {
    const lanes = p.get("lanes").split(",").filter(Boolean);
    window.__restoreLanes = lanes;
  }
  if (p.has("race_lanes")) {
    const lanes = p.get("race_lanes").split(",").filter(Boolean);
    window.__restoreRaceLanes = lanes;
  }
  if (p.has("eid")) window.__restoreRaceEventId = p.get("eid");
  if (p.has("auto_add")) {
    window.__restoreAutoAdd = p.get("auto_add") !== "0";
    autoAddCB.checked = window.__restoreAutoAdd;
  }
}

function saveURLState() {
  const p = new URLSearchParams();
  p.set("view", STATE.view);
  if (STATE.mode !== "form") p.set("mode", STATE.mode);
  if (STATE.pool) p.set("pool", STATE.pool);
  if (STATE.tag) p.set("tag", STATE.tag);
  if (STATE.sort !== "latest") p.set("sort", STATE.sort);
  if (STATE.hideAfter !== "30m") p.set("hide_after", STATE.hideAfter);
  if (STATE.showHidden) p.set("show_hidden", "1");
  if (STATE.view === "single" && STATE.selectedSessionId) p.set("sid", STATE.selectedSessionId);
  if (STATE.view === "swimlane") {
    const lanes = window.__swimlaneGetLanes?.();
    if (lanes && lanes.length) p.set("lanes", lanes.join(","));
    if (!autoAddLanes()) p.set("auto_add", "0");
  }
  if (STATE.view === "race") {
    const lanes = window.__raceGetLanes?.();
    if (lanes && lanes.length) p.set("race_lanes", lanes.join(","));
    const eid = window.__raceGetOpenEventId?.();
    if (eid) p.set("eid", eid);
    if (!autoAddLanes()) p.set("auto_add", "0");
  }
  const newHash = "#" + p.toString();
  if (location.hash !== newHash) history.replaceState(null, "", newHash);
}

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $ = s => document.querySelector(s);
const sessionSubnav = (() => { const el = document.querySelector("#session-subnav"); return el; })();
const poolFilter = $("#pool-filter");
const tagFilter = $("#tag-filter");
const sortSelect = $("#sort-select");
const hideAfterSelect = $("#hide-after-select");
const showHiddenCB = $("#show-hidden-sessions");
const sessionList = $("#session-list");
const eventView = $("#event-view");
const paneLabel = $("#pane-label");
const liveDot = $("#live-dot");
const liveLabel = $("#live-label");
const searchBox = $("#search-box");
const filterChips = $("#filter-chips");
const singlePane = $("#single-pane");
const swimlaneContainer = $("#swimlane-container");
const raceContainer = $("#race-container");
const autoAddRow = $("#auto-add-row");
const autoAddCB = $("#auto-add-lanes");
const headerBreadcrumb = $("#header-breadcrumb");
const btnExpandAll = $("#btn-expand-all");
const btnCollapseAll = $("#btn-collapse-all");
const pauseToastSingle = $("#pause-toast-single");
const helpOverlay = $("#help-overlay");

// ─── Rich rendering helpers ─────────────────────────────────────────────────

const ALL_TYPES = ["session_start","session_shutdown","agent_start","agent_end","turn_start","turn_end","user_message","assistant_message","tool_call","tool_result","thinking","model_change","compaction","branch_nav","error","custom"];
const CHIP_TYPES = ["user_message","assistant_message","thinking","tool_call","tool_result","model_change","compaction","branch_nav","error"];

function summaryFor(evt) {
  const p = evt.payload ?? {};
  switch (evt.type) {
    case "session_start": return `start · ${p.reason ?? "?"}`;
    case "session_shutdown": return `shutdown · ${p.reason ?? "?"}`;
    case "agent_start": {
      const opts = p.system_prompt_options ?? {};
      const parts = [`▶ ${trunc(p.prompt, 80)}`];
      const tools = opts.selected_tools?.length ?? 0;
      const skills = opts.skills?.length ?? 0;
      const files = opts.context_files?.length ?? 0;
      if (tools) parts.push(`${tools} tools`);
      if (skills) parts.push(`${skills} skills`);
      if (files) parts.push(`${files} ctx-files`);
      if (p.system_prompt_bytes) parts.push(`sys ${fmtBytes(p.system_prompt_bytes)}`);
      return parts.join(" · ");
    }
    case "agent_end": return `■ ${p.message_count ?? "?"} messages`;
    case "turn_start": return `turn #${p.turn_index ?? "?"}`;
    case "turn_end": return `turn #${p.turn_index ?? "?"}${p.usage ? " · " + p.usage.total_tokens + "tk" : ""}`;
    case "user_message": return `you: ${trunc(p.text, 100)}`;
    case "assistant_message": return `ai: ${trunc(p.text, 100)} · ${p.usage?.total_tokens ?? 0}tk · $${(p.usage?.cost_total ?? 0).toFixed(4)}${p.latency_ms ? " · " + p.latency_ms + "ms" : ""}`;
    case "thinking": return `〽 ${trunc(p.text, 100)}`;
    case "tool_call": return `→ ${p.tool_name}(${trunc(JSON.stringify(p.args ?? {}), 60)})`;
    case "tool_result": return `← ${p.tool_name} · ${p.is_error ? "✗" : "✓"} · ${trunc(p.content_text, 80)}`;
    case "model_change": return `model: ${p.previous_model ?? "?"} → ${p.provider}/${p.model}`;
    case "compaction": return `📦 compact · ${p.tokens_before ?? "?"} tk → "${trunc(p.summary_preview, 60)}"`;
    case "branch_nav": return `🌿 branch · ${shortId(p.from_id)} → ${shortId(p.to_id)}`;
    case "error": return `! ${trunc(p.message, 100)}`;
    case "custom": return `${p.custom_type ?? "custom"}`;
    default: return "";
  }
}

function summaryClass(evt) {
  if (evt.type === "thinking") return "italic dim";
  if (["session_shutdown","agent_end","turn_start","turn_end"].includes(evt.type)) return "dim";
  return "";
}

function renderDetailHTML(evt) {
  const chips = [];
  if (evt.type === "tool_result" && evt.payload?.details_summary?.exit_code !== undefined) {
    const ec = evt.payload.details_summary.exit_code;
    chips.push(`<span class="exit-chip ${ec !== 0 ? 'err' : 'ok'}">exit ${ec}</span>`);
  }
  if (evt.type === "assistant_message") {
    if (evt.payload?.stop_reason) chips.push(`<span class="exit-chip ok">${evt.payload.stop_reason}</span>`);
    if (evt.payload?.latency_ms) chips.push(`<span class="exit-chip ok">${evt.payload.latency_ms}ms</span>`);
    if (evt.payload?.turn_index !== undefined) chips.push(`<span class="exit-chip ok">turn ${evt.payload.turn_index}</span>`);
  }
  const cBtn = `<button class="copy-btn" onclick="event.stopPropagation();OBS.copyEvent('${evt.event_id}')">📋</button>`;
  const wBtn = `<button class="wrap-btn" onclick="event.stopPropagation();let p=this.parentElement.querySelector('pre');p.style.whiteSpace=p.style.whiteSpace==='pre-wrap'?'pre':'pre-wrap';this.textContent=p.style.whiteSpace==='pre-wrap'?'↩':'→'">→</button>`;
  return `${cBtn}${wBtn}${chips.join(" ")}<pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre>`;
}

// ─── API helpers ────────────────────────────────────────────────────────────

function authHeaders() {
  return STATE.token ? { "Authorization": `Bearer ${STATE.token}` } : {};
}
function apiUrl(path, params = {}) {
  const u = new URL(path, location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== "") u.searchParams.set(k, String(v)); });
  return u.toString();
}

// ─── Model context windows (approximate) ────────────────────────────
const MODEL_CONTEXT_WINDOWS = [
  // 1M-context Claude variants. Opus 4.8 ships with a 1M window by default;
  // some models also carry an explicit "[1m]" tag. These must precede the
  // generic claude rules below since getContextWindow returns on first match.
  [/\[1m\]/i, 1_000_000],
  [/^claude-opus-4-8/i, 1_000_000],
  [/^claude-(haiku|sonnet|opus|3|4|5)/i, 200_000],
  [/^claude-/i, 200_000],
  [/^gpt-5/i, 400_000],
  [/^gpt-4o/i, 128_000],
  [/^gpt-4/i, 128_000],
  [/^o[13]/i, 200_000],
  [/^gemini-1\.5-pro/i, 2_000_000],
  [/^gemini-(2|3)/i, 1_000_000],
  [/^gemini-1\.5/i, 1_000_000],
  [/^gemini-/i, 1_000_000],
  [/^z-ai\/glm-4\.6/i, 200_000],
  [/^glm-/i, 128_000],
  // DeepSeek: pi treats these as 64k in its own context bar (verified against
  // a live deepseek-v4-flash session showing 9% with input=5683 → 5683/64000
  // ≈ 8.9%). Even though DeepSeek's API can physically accept 128k+, pi caps
  // the user-facing window at 64k as a conservative budget. We mirror pi's
  // value to keep our context % aligned with what the user sees in terminal.
  [/^deepseek/i, 64_000],
];
const DEFAULT_CONTEXT_WINDOW = 128_000;
function getContextWindow(model) {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  for (const [re, n] of MODEL_CONTEXT_WINDOWS) if (re.test(model)) return n;
  return DEFAULT_CONTEXT_WINDOW;
}

// ─── Agent info computation ─────────────────────────────────────
function computeAgentInfo(sid) {
  const s = STATE.sessions.find(x => x.session_id === sid);
  if (!s) return null;
  const events = STATE.events.filter(e => e.session_id === sid);
  const stats = STATE.sessionStats[sid] || {};

  // Prefer server stats (new fields) when present; fall back to client compute.
  let inputTokens = stats.input_tokens ?? 0;
  let outputTokens = stats.output_tokens ?? 0;
  if (!stats.input_tokens && !stats.output_tokens) {
    for (const e of events) {
      if (e.type !== "assistant_message") continue;
      const u = e.payload?.usage;
      if (!u) continue;
      inputTokens += u.input ?? 0;
      outputTokens += u.output ?? 0;
    }
  }

  // Also accumulate cache_read / cache_write while we're at it (always client-side
  // for now — not in server stats endpoint).
  let cacheRead = 0, cacheWrite = 0;
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    const u = e.payload?.usage;
    if (!u) continue;
    cacheRead  += u.cache_read  ?? 0;
    cacheWrite += u.cache_write ?? 0;
  }

  // Latest assistant_message: context-used + perf metrics for the last turn.
  //
  // "Context used" = usage.input + usage.cache_read + usage.cache_write — the
  // full prefix sent to the model on the most recent turn. This matches pi's
  // terminal context bar across cached providers. For uncached providers
  // (e.g. deepseek) cache_read/cache_write are 0 so the sum collapses to
  // input. Cache volume stays separately visible on the cache r / cache w
  // pills for cost-attribution analysis. See apps/observability/db.ts getSessionContext
  // for the empirical verification (gemini-3.5-flash + deepseek-v4-flash).
  let latestInput = stats.latest_input ?? null;
  let latestPrefillMs = null, latestOutputTps = null, latestGenMs = null, latestLatencyMs = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "assistant_message") continue;
    const p = events[i].payload;
    const u = p?.usage;
    if (latestInput == null && u && (u.input || u.cache_read || u.cache_write)) {
      latestInput = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
    }
    if (latestPrefillMs == null && p?.prefill_ms != null) latestPrefillMs = p.prefill_ms;
    if (latestOutputTps == null && p?.output_tps != null) latestOutputTps = p.output_tps;
    if (latestGenMs == null && p?.generation_ms != null) latestGenMs = p.generation_ms;
    if (latestLatencyMs == null && p?.latency_ms != null) latestLatencyMs = p.latency_ms;
    if (latestInput != null && latestPrefillMs != null && latestOutputTps != null) break;
  }

  // Context window denominator: prefer the value captured from pi's
  // ctx.getContextUsage() at message_end (same source as /context), stored
  // on the assistant_message event and surfaced via stats.context_window.
  // Fall back to the MODEL_CONTEXT_WINDOWS regex table only for legacy
  // events recorded before the extension captured context_window.
  const storedContextWindow = stats.context_window ?? null;
  const contextTotal = storedContextWindow != null ? storedContextWindow : getContextWindow(s.model);
  const contextUsed = latestInput || 0;
  const contextRemaining = Math.max(0, contextTotal - contextUsed);
  const contextRemainingPct = contextTotal ? Math.round((contextRemaining / contextTotal) * 100) : 0;

  const start = new Date(s.first_ts).getTime();
  const end = new Date(s.last_ts).getTime();
  const durationMs = Math.max(0, end - start);

  return {
    name: s.agent_name ?? s.cwd?.split("/").pop() ?? shortId(sid),
    sid, shortSid: shortId(sid),
    model: s.model || "", provider: s.provider || "",
    tags: s.tags || [], pool: s.pool || "default",
    eventCount: s.event_count ?? events.length,
    durationMs, cost: stats.total_cost ?? 0,
    inputTokens, outputTokens, cacheRead, cacheWrite,
    totalTokens: stats.total_tokens ?? (inputTokens + outputTokens),
    contextUsed, contextTotal, contextRemaining, contextRemainingPct,
    latestPrefillMs, latestOutputTps, latestGenMs, latestLatencyMs,
  };
}

function fmtDuration(ms) {
  if (!ms || ms < 1000) return ms ? `${ms}ms` : "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderAgentSubnav() {
  if (!sessionSubnav) return;
  if (!STATE.selectedSessionId || STATE.view !== "single") {
    sessionSubnav.style.display = "none";
    return;
  }
  const info = computeAgentInfo(STATE.selectedSessionId);
  if (!info) { sessionSubnav.style.display = "none"; return; }
  sessionSubnav.style.display = "flex";
  const tagsHtml = info.tags.length
    ? info.tags.map(t => `<span class="snav-tag">${escapeHtml(t)}</span>`).join("")
    : `<span class="snav-tag dim">no tags</span>`;
  const ctxPctUsed = info.contextTotal ? Math.round((info.contextUsed / info.contextTotal) * 100) : 0;
  const ctxBarColor = ctxPctUsed > 90 ? "var(--red)" : ctxPctUsed > 70 ? "var(--orange)" : "var(--green)";
  sessionSubnav.innerHTML = `
    <div class="snav-group snav-identity">
      <div class="snav-name" title="${escapeHtml(info.sid)}">${escapeHtml(info.name)}</div>
      <div class="snav-sid"><code>${info.shortSid}</code>${info.model ? `<span class="snav-model">${escapeHtml(info.model)}</span>` : ""}</div>
      <div class="snav-tags"><span class="snav-pool">${escapeHtml(info.pool)}</span>${tagsHtml}</div>
    </div>
    <div class="snav-group snav-stats">
      <div class="snav-stat"><span class="snav-label">events</span><span class="snav-value">${info.eventCount}</span></div>
      <div class="snav-stat"><span class="snav-label">duration</span><span class="snav-value">${fmtDuration(info.durationMs)}</span></div>
      <div class="snav-stat snav-cost-pill"><span class="snav-label">cost</span><span class="snav-value snav-cost">$${info.cost.toFixed(4)}</span></div>
      <div class="snav-stat"><span class="snav-label">in</span><span class="snav-value">${fmtTokens(info.inputTokens)}</span></div>
      <div class="snav-stat"><span class="snav-label">out</span><span class="snav-value">${fmtTokens(info.outputTokens)}</span></div>
      <!-- Form mode: dual cache pills (per obv-flash). Function mode: single combined pill (CSS hides .snav-cache-r/.snav-cache-w and shows .snav-cache-combined). -->
      <div class="snav-stat snav-cache-r" title="cumulative input tokens served from cache"><span class="snav-label">cache r</span><span class="snav-value">${fmtTokens(info.cacheRead)}</span></div>
      <div class="snav-stat snav-cache-w" title="cumulative tokens written to cache this session"><span class="snav-label">cache w</span><span class="snav-value">${fmtTokens(info.cacheWrite)}</span></div>
      <div class="snav-stat snav-cache-combined" title="cache read / write tokens (cumulative)"><span class="snav-label">cache</span><span class="snav-value">${fmtTokens(info.cacheRead)}/${fmtTokens(info.cacheWrite)}</span></div>
      <!-- Latest-turn perf (TPS + prefill). em-dash when undefined (non-streaming turn or no assistant_message yet). -->
      <div class="snav-stat snav-perf" title="estimated output tokens/sec on the most recent assistant turn (post-prefill). Approximated from streaming delta timing — accurate within a single-batch arrival window; turns with gen_ms &lt; 50ms are suppressed to avoid measurement noise."><span class="snav-label">~TPS</span><span class="snav-value">${info.latestOutputTps != null ? info.latestOutputTps : "—"}</span></div>
      <div class="snav-stat snav-perf" title="prefill (time-to-first-token) on the most recent assistant turn"><span class="snav-label">prefill</span><span class="snav-value">${info.latestPrefillMs != null ? info.latestPrefillMs + "ms" : "—"}</span></div>
    </div>
    <div class="snav-group snav-context">
      <div class="snav-context-top">
        <span class="snav-label">context</span>
        <span class="snav-context-fig">${fmtTokens(info.contextUsed)} / ${fmtTokens(info.contextTotal)}</span>
        <span class="snav-context-pct">${info.contextRemainingPct}% remaining</span>
      </div>
      <div class="snav-context-bar"><div class="snav-context-bar-fill" style="width:${ctxPctUsed}%;background:${ctxBarColor}"></div></div>
    </div>
  `;
}

function setSingleSessionControlsVisible(visible) {
  const display = visible ? "inline-block" : "none";
  if (sessionSubnav) sessionSubnav.style.display = visible ? "" : "none";
  searchBox.style.display = display;
  btnExpandAll.style.display = display;
  btnCollapseAll.style.display = display;
  if (visible) buildFilterChips();
  else filterChips.innerHTML = "";
}

// ─── View toggle ────────────────────────────────────────────────────────────

// Apply form/function mode: body class + persistence + scroll-anchor recovery.
// Form = spacious dashboard feel (default). Function = dense/TUI feel.
window.setMode = function(mode) {
  if (mode !== "form" && mode !== "function") mode = "form";
  STATE.mode = mode;
  // obv-flash: skip redundant disk writes on boot / repeated clicks.
  if (localStorage.getItem("obs-mode") !== mode) localStorage.setItem("obs-mode", mode);
  document.body.classList.toggle("layout-form", mode === "form");
  document.body.classList.toggle("layout-function", mode === "function");
  const btnForm = $("#btn-form");
  const btnFunc = $("#btn-function");
  if (btnForm) btnForm.classList.toggle("active", mode === "form");
  if (btnFunc) btnFunc.classList.toggle("active", mode === "function");
  // obv-flash: row heights just changed under the user's feet, so re-anchor
  // every scrollable surface that was riding the bottom. Without this the
  // single timeline + sticky swimlane lanes briefly drift mid-page before the
  // 250 ms sticky interval mops up.
  requestAnimationFrame(() => {
    if (STATE.autoScroll && eventView) eventView.scrollTop = eventView.scrollHeight;
    window.__swimlaneReanchorAll?.();
  });
  saveURLState();
};

window.setView = function(mode) {
  if (!["single", "swimlane", "race"].includes(mode)) mode = "single";
  STATE.view = mode;
  localStorage.setItem("obs-view", mode);
  $("#btn-single").classList.toggle("active", mode === "single");
  $("#btn-swimlane").classList.toggle("active", mode === "swimlane");
  $("#btn-race")?.classList.toggle("active", mode === "race");
  singlePane.style.display = mode === "single" ? "" : "none";
  swimlaneContainer.classList.toggle("active", mode === "swimlane");
  raceContainer?.classList.toggle("active", mode === "race");
  if (mode !== "race") window.__raceCloseInspector?.();
  if (sessionSubnav) sessionSubnav.style.display = (mode === "single" && STATE.selectedSessionId) ? "flex" : "none";
  autoAddRow.style.display = mode === "swimlane" || mode === "race" ? "" : "none";
  renderSessions();
  if (mode === "swimlane") {
    if ((window.__swimlaneGetLanes?.() ?? []).length === 0 && STATE.selectedSessionId) {
      window.__swimlaneEnsureLane?.(STATE.selectedSessionId);
    }
    window.__swimlaneOnView?.();
  }
  if (mode === "race") {
    if ((window.__raceGetLanes?.() ?? []).length === 0 && STATE.selectedSessionId) {
      window.__raceEnsureLane?.(STATE.selectedSessionId);
    }
    window.__raceOnView?.();
  }
  if (mode === "single" && STATE.selectedSessionId) {
    setSingleSessionControlsVisible(true);
    loadSession(STATE.selectedSessionId);
  } else if (mode === "single") {
    setSingleSessionControlsVisible(false);
  }
  saveURLState();
};

// ─── Sessions ───────────────────────────────────────────────────────────────

async function fetchSessions() {
  try {
    const url = apiUrl("/sessions", { pool: STATE.pool, tag: STATE.tag, limit: 100 });
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    // Apply sort
    let sessions = data.sessions ?? [];
    if (STATE.sort === "errors") {
      sessions = sessions.filter(s => (STATE.sessionStats[s.session_id]?.error_count ?? 0) > 0);
    }
    if (STATE.sort === "expensive") {
      sessions.sort((a, b) => (STATE.sessionStats[b.session_id]?.total_cost ?? 0) - (STATE.sessionStats[a.session_id]?.total_cost ?? 0));
    }
    STATE.sessions = sessions;
    STATE.sessionsLoaded = true;
    renderSessions();
    updateBreadcrumb();
    if (STATE.view === "swimlane") window.__swimlaneOnSessions?.();
    if (STATE.view === "race") window.__raceOnSessions?.();
    // Fetch stats for all visible sessions
    for (const s of sessions) {
      if (!STATE.sessionStats[s.session_id]) fetchSessionStats(s.session_id);
    }
  } catch { /* poll retries */ }
}

async function fetchSessionStats(sid) {
  try {
    const url = apiUrl(`/sessions/${sid}/stats`);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const stats = await res.json();
    STATE.sessionStats[sid] = stats;
    // Re-render sidebar if this session is visible
    if (STATE.sessions.some(s => s.session_id === sid)) renderSessions();
    if (STATE.view === "swimlane") window.__swimlaneStatsUpdate?.(sid, stats);
    if (STATE.view === "race") window.__raceStatsUpdate?.(sid, stats);
    if (sid === STATE.selectedSessionId) renderAgentSubnav();
  } catch { /* ignore */ }
}

function isHiddenByAge(s) {
  if (!STATE.hideAfter || STATE.hideAfter === "never") return false;
  const limitMs = parseDuration(STATE.hideAfter);
  const elapsed = Date.now() - new Date(s.last_ts).getTime();
  return !Number.isFinite(elapsed) || elapsed > limitMs;
}

function visibleSessions() {
  if (STATE.showHidden) return [...STATE.sessions];
  return STATE.sessions.filter(s => !STATE.hiddenSessions.has(s.session_id) && !isHiddenByAge(s));
}

function saveHiddenSessions() {
  try { localStorage.setItem("obs-hidden-sessions", JSON.stringify([...STATE.hiddenSessions])); } catch {}
}

function hideSessionFromSidebar(sid) {
  STATE.hiddenSessions.add(sid);
  saveHiddenSessions();
  // Drop this session from any open swimlane / race lane so "hide" actually
  // hides it everywhere, not just the sidebar.
  if (window.__swimlaneIsSelected?.(sid)) window.__swimlaneToggle?.(sid);
  if (window.__raceIsSelected?.(sid)) window.__raceToggle?.(sid);
  if (STATE.view === "single" && STATE.selectedSessionId === sid && !STATE.showHidden) clearSelectedSession();
  else { renderSessions(); saveURLState(); }
}

function unhideSessionFromSidebar(sid) {
  STATE.hiddenSessions.delete(sid);
  saveHiddenSessions();
  renderSessions();
  saveURLState();
}

// Bulk-hide every currently-visible agent and clear any open selections in
// every view — single, swimlane, and race — so the main pane goes blank and
// the user sees the real-estate gain immediately. The existing "show hidden"
// toggle brings them back.
function hideAllVisibleSessions() {
  const visible = visibleSessions();
  if (!visible.length) return;
  for (const s of visible) STATE.hiddenSessions.add(s.session_id);
  saveHiddenSessions();

  for (const sid of (window.__swimlaneGetLanes?.() ?? []).slice()) window.__swimlaneToggle?.(sid);
  for (const sid of (window.__raceGetLanes?.() ?? []).slice()) window.__raceToggle?.(sid);

  if (STATE.view === "single" && STATE.selectedSessionId) clearSelectedSession();
  else { renderSessions(); saveURLState(); }
}

function clearSelectedSession() {
  STATE.selectedSessionId = null;
  STATE.events = [];
  STATE.focusedIdx = -1;
  STATE.renderDirty = true;
  STATE.seenIds = new Set();
  STATE.lastEventTs = null;
  paneLabel.textContent = "Select a session";
  eventView.innerHTML = '<div class="empty-state"><span class="icon">◈</span>Select a session from the sidebar</div>';
  setSingleSessionControlsVisible(false);
  renderSessions();
  updateAgeTicker();
  updateSSEFilter();
  saveURLState();
}

function renderSessions() {
  sessionList.innerHTML = "";
  const filtered = visibleSessions();
  if (STATE.sessionsLoaded && STATE.view === "single" && STATE.selectedSessionId && !filtered.some(s => s.session_id === STATE.selectedSessionId)) {
    clearSelectedSession();
    return;
  }
  if (!filtered.length) {
    if (!STATE.sidebarCollapsed) {
      sessionList.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:11px">no sessions</div>';
    }
    return;
  }
  if (STATE.sidebarCollapsed) {
    for (const s of filtered) sessionList.appendChild(buildMiniSessionItem(s));
    return;
  }
  for (const s of filtered) {
    const el = document.createElement("div");
    const isSel = STATE.view === "single"
      ? s.session_id === STATE.selectedSessionId
      : STATE.view === "swimlane"
        ? window.__swimlaneIsSelected?.(s.session_id)
        : window.__raceIsSelected?.(s.session_id);
    const hiddenByUser = STATE.hiddenSessions.has(s.session_id);
    const hiddenByAge = isHiddenByAge(s);
    el.className = "session-item" + (isSel ? " selected" : "") + ((hiddenByUser || hiddenByAge) ? " hidden-session" : "");
    const shortId = s.session_id.slice(0, 8);
    const stats = STATE.sessionStats[s.session_id];
    const costStr = stats ? `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk` : "";
    const hasErr = stats && stats.error_count > 0;
    const isAckd = STATE.ackd.has(s.session_id);
    const errDotHtml = hasErr ? ` <span class="err-dot${isAckd ? ' ackd' : ''}">●</span>` : '';
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? shortId;
    const hiddenNote = hiddenByUser ? ' <span class="session-hidden-note">hidden</span>' : (hiddenByAge ? ' <span class="session-hidden-note">aged</span>' : '');
    const relTime = fmtRel(s.last_ts);

    if (STATE.view === "swimlane" || STATE.view === "race") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = STATE.view === "swimlane" ? (window.__swimlaneIsSelected?.(s.session_id) ?? false) : (window.__raceIsSelected?.(s.session_id) ?? false);
      cb.addEventListener("change", () => STATE.view === "swimlane" ? window.__swimlaneToggle?.(s.session_id) : window.__raceToggle?.(s.session_id));
      el.appendChild(cb);
    }

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name">${escapeHtml(name)}${errDotHtml}${hiddenNote}</div><div class="uuid">${shortId}${s.model ? " · " + s.model : ""}</div><div class="meta">${s.pool} · ${s.event_count} events · ${relTime}</div>${costStr ? `<div class="cost">${costStr}</div>` : ""}`;

    if (STATE.view === "single") {
      el.addEventListener("click", () => selectSession(s.session_id));
    } else if (STATE.view === "swimlane") {
      info.addEventListener("click", () => window.__swimlaneToggle?.(s.session_id));
    } else {
      info.addEventListener("click", () => window.__raceToggle?.(s.session_id));
    }

    el.appendChild(info);

    const hideBtn = document.createElement("button");
    hideBtn.className = "session-hide-btn";
    hideBtn.type = "button";
    hideBtn.textContent = hiddenByUser ? "↺" : "×";
    hideBtn.title = hiddenByUser ? "Unhide this agent in the sidebar" : "Hide this agent from the sidebar";
    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hiddenByUser ? unhideSessionFromSidebar(s.session_id) : hideSessionFromSidebar(s.session_id);
    });
    el.appendChild(hideBtn);

    sessionList.appendChild(el);
  }
}

function buildMiniSessionItem(s) {
  const el = document.createElement("div");
  const isSel = STATE.view === "single"
    ? s.session_id === STATE.selectedSessionId
    : STATE.view === "swimlane"
      ? (window.__swimlaneIsSelected?.(s.session_id) ?? false)
      : (window.__raceIsSelected?.(s.session_id) ?? false);
  el.className = "session-mini" + (isSel ? " selected" : "");
  el.dataset.sid = s.session_id;
  const name = s.agent_name ?? s.cwd?.split("/").pop() ?? s.session_id;
  const stats = STATE.sessionStats[s.session_id];
  const costStr = stats ? ` · $${stats.total_cost.toFixed(4)}` : "";
  el.title = `${name}\n${s.session_id.slice(0, 8)} · ${s.event_count} events · ${fmtRel(s.last_ts)}${costStr}`;
  el.textContent = agentLetter(s);
  const dot = document.createElement("span");
  dot.className = "mini-dot " + activityStatus(s);
  el.appendChild(dot);
  if (STATE.view === "single") {
    el.addEventListener("click", () => selectSession(s.session_id));
  } else if (STATE.view === "swimlane") {
    el.addEventListener("click", () => window.__swimlaneToggle?.(s.session_id));
  } else {
    el.addEventListener("click", () => window.__raceToggle?.(s.session_id));
  }
  return el;
}

// 2 s tick to refresh the activity-window dot color without re-rendering the
// entire sidebar. Cheap DOM patch — only touches the dot's class list.
setInterval(() => {
  if (!STATE.sidebarCollapsed) return;
  document.querySelectorAll(".session-mini").forEach(el => {
    const sid = el.dataset.sid;
    const s = STATE.sessions.find(x => x.session_id === sid);
    if (!s) return;
    const dot = el.querySelector(".mini-dot");
    if (dot) dot.className = "mini-dot " + activityStatus(s);
  });
}, 2000);

function selectSession(sid) {
  STATE.ackd.add(sid);
  if (STATE.selectedSessionId === sid) {
    clearSelectedSession();
    return;
  }
  STATE.selectedSessionId = sid;
  STATE.events = [];
  STATE.focusedIdx = -1;
  STATE.renderDirty = true;
  STATE.seenIds = new Set();

  // Reset auto-scroll and hide pause toast on agent switch
  STATE.autoScroll = true;
  if (pauseToastSingle) pauseToastSingle.classList.remove("show");

  setSingleSessionControlsVisible(true);
  loadSession(sid);
  updateSSEFilter();
  saveURLState();
}

async function loadSession(sid) {
  const s = STATE.sessions.find(x => x.session_id === sid);
  paneLabel.textContent = s ? (s.agent_name ?? s.cwd?.split("/").pop() ?? shortId(sid)) : shortId(sid);
  const events = await fetchSessionEvents(sid);
  if (STATE.selectedSessionId !== sid) return;
  STATE.events = events || [];
  STATE.renderDirty = true;
  for (const e of STATE.events) STATE.seenIds.add(e.event_id);
  renderAllEvents();
  updateAgeTicker();
  if (s?.last_ts) STATE.lastEventTs = s.last_ts;
  fetchSessionStats(sid);
  renderAgentSubnav();
}

async function fetchSessionEvents(sid, sinceSeq) {
  try {
    const params = { limit: 1000 };
    if (sinceSeq !== undefined) params.since_seq = sinceSeq;
    const url = apiUrl(`/sessions/${sid}/events`, params);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.events ?? [];
  } catch { return []; }
}

// ─── Event rendering (single mode, append-only) ────────────────────────────

function getFilteredEvents() {
  let evts = STATE.events;
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    evts = evts.filter(e => (summaryFor(e) + JSON.stringify(e.payload ?? {})).toLowerCase().includes(q));
  }
  if (STATE.typeFilter.size > 0) evts = evts.filter(e => STATE.typeFilter.has(e.type));
  return evts;
}

function renderAllEvents() {
  eventView.innerHTML = "";
  const evts = getFilteredEvents();
  if (!evts.length) {
    eventView.innerHTML = '<div class="empty-state" style="font-size:12px">no matching events</div>';
    return;
  }
  for (let i = 0; i < evts.length; i++) {
    eventView.appendChild(buildEventRow(evts[i], i));
  }
  if (STATE.autoScroll) scrollEventViewToBottom();
  STATE.renderDirty = false;
  updateAgeTicker();
}

function appendEventSingle(evt) {
  if (!STATE.selectedSessionId || evt.session_id !== STATE.selectedSessionId) return;
  if (STATE.seenIds.has(evt.event_id)) return;
  STATE.seenIds.add(evt.event_id);
  STATE.events.push(evt);
  if (evt.ts) STATE.lastEventTs = evt.ts;

  if (STATE.renderDirty || !matchesFilters(evt)) {
    // Filters active or dirty — rebuild
    renderAllEvents();
  } else {
    const idx = STATE.events.length - 1;
    eventView.appendChild(buildEventRow(evt, idx, true));
    if (STATE.autoScroll) scrollEventViewToBottom();
    updateAgeTicker();
  }
  renderAgentSubnav();
}

function matchesFilters(evt) {
  if (STATE.search) {
    const q = STATE.search.toLowerCase();
    if (!(summaryFor(evt) + JSON.stringify(evt.payload ?? {})).toLowerCase().includes(q)) return false;
  }
  if (STATE.typeFilter.size > 0 && !STATE.typeFilter.has(evt.type)) return false;
  return true;
}

function buildEventRow(evt, idx, isLive = false) {
  const frag = document.createDocumentFragment();
  const row = document.createElement("div");
  row.className = "evt-row" + (idx === STATE.focusedIdx ? " focused" : "");
  row.dataset.idx = idx;
  row.innerHTML = `<span class="evt-ts">${fmtTs(evt.ts)}</span><span class="evt-type"><span class="pill ${evt.type}">${evt.type.replace(/_/g," ")}</span>${toolNamePillHTML(evt)}</span><span class="evt-summary ${summaryClass(evt)}">${summaryFor(evt)}</span>`;

  if (isLive && typeof window.__pulseColorFor === "function") {
    row.style.setProperty("--pulse-color", window.__pulseColorFor(evt.type));
    row.classList.add("evt-new");
    setTimeout(() => row.classList.remove("evt-new"), 1300);
  }

  const detail = document.createElement("div");
  detail.className = "evt-detail";
  detail.dataset.eventId = evt.event_id;
  detail.innerHTML = renderDetailHTML(evt);

  row.addEventListener("click", () => {
    detail.classList.toggle("open");
    STATE.focusedIdx = idx;
    refreshFocus();
  });

  frag.appendChild(row);
  frag.appendChild(detail);
  return frag;
}

function refreshFocus() {
  eventView.querySelectorAll(".evt-row").forEach((r, i) => {
    r.classList.toggle("focused", i === STATE.focusedIdx);
  });
}

function applyFilters() {
  STATE.renderDirty = true;
  renderAllEvents();
}

function scrollEventViewToBottom() {
  if (!eventView) return;
  const go = () => { eventView.scrollTop = eventView.scrollHeight; };
  go();
  requestAnimationFrame(go);
  setTimeout(go, 50);
  setTimeout(go, 120);
}

// Auto-scroll + pause toast
eventView.addEventListener("scroll", () => {
  if (STATE.view !== "single") return;
  const atBottom = eventView.scrollHeight - eventView.scrollTop - eventView.clientHeight < 40;
  if (!atBottom && STATE.autoScroll) {
    STATE.autoScroll = false;
    pauseToastSingle.classList.add("show");
  } else if (atBottom && !STATE.autoScroll) {
    STATE.autoScroll = true;
    pauseToastSingle.classList.remove("show");
  }
});

window.resumeSingleScroll = function() {
  STATE.autoScroll = true;
  scrollEventViewToBottom();
  pauseToastSingle.classList.remove("show");
};

// ─── Filter chips ──────────────────────────────────────────────────────────

function buildFilterChips() {
  filterChips.innerHTML = "";
  for (const t of CHIP_TYPES) {
    const chip = document.createElement("span");
    chip.className = "fchip" + (STATE.typeFilter.has(t) ? " on" : "");
    chip.textContent = t.replace(/_/g, " ");
    chip.addEventListener("click", () => {
      STATE.typeFilter.has(t) ? STATE.typeFilter.delete(t) : STATE.typeFilter.add(t);
      buildFilterChips();
      applyFilters();
    });
    filterChips.appendChild(chip);
  }
}

searchBox.addEventListener("input", () => {
  STATE.search = searchBox.value.trim().toLowerCase();
  applyFilters();
});

// ─── Expand/collapse all ───────────────────────────────────────────────────

btnExpandAll.addEventListener("click", () => {
  eventView.querySelectorAll(".evt-detail").forEach(d => d.classList.add("open"));
});
btnCollapseAll.addEventListener("click", () => {
  eventView.querySelectorAll(".evt-detail.open").forEach(d => d.classList.remove("open"));
});

// ─── Keyboard nav ──────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.key === "?") { e.preventDefault(); toggleHelp(); return; }
  if (e.key === "/" && STATE.view === "single" && STATE.selectedSessionId) {
    e.preventDefault(); searchBox.focus(); return;
  }
  if (STATE.view !== "single" || !STATE.selectedSessionId) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

  const evts = getFilteredEvents();
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault();
      STATE.focusedIdx = Math.min(STATE.focusedIdx + 1, evts.length - 1);
      refreshFocus(); scrollToFocused(); break;
    case "k": case "ArrowUp": e.preventDefault();
      STATE.focusedIdx = Math.max(STATE.focusedIdx - 1, 0);
      refreshFocus(); scrollToFocused(); break;
    case "Enter": case " ": e.preventDefault(); toggleFocusedDetail(); break;
    case "Escape": e.preventDefault(); collapseAll(); break;
    case "g": e.preventDefault(); STATE.focusedIdx = 0; refreshFocus(); scrollToFocused(); break;
    case "G": e.preventDefault(); STATE.focusedIdx = evts.length - 1; refreshFocus(); scrollToFocused(); break;
  }
});

function scrollToFocused() {
  const row = eventView.querySelector(`.evt-row[data-idx="${STATE.focusedIdx}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function toggleFocusedDetail() {
  const details = eventView.querySelectorAll(".evt-detail");
  if (STATE.focusedIdx >= 0 && STATE.focusedIdx < details.length) {
    details[STATE.focusedIdx].classList.toggle("open");
  }
}
function collapseAll() {
  eventView.querySelectorAll(".evt-detail.open").forEach(d => d.classList.remove("open"));
}

// ─── Help overlay ──────────────────────────────────────────────────────────

window.toggleHelp = function() {
  helpOverlay.classList.toggle("show");
};

// ─── Sidebar collapse (mini icon mode) ─────────────────────────────────────
// Collapses the left sidebar to a strip of single-letter agent chips with a
// status dot. Hides filters/search/sort/hide-after entirely. Works the same
// in single / swimlane / race views — only the click handler differs.
window.toggleSidebar = function() {
  STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
  localStorage.setItem("obs-sidebar-collapsed", STATE.sidebarCollapsed ? "1" : "0");
  applySidebarCollapsed();
  renderSessions();
};

function applySidebarCollapsed() {
  document.body.classList.toggle("sidebar-collapsed", STATE.sidebarCollapsed);
  const btn = document.getElementById("sidebar-toggle");
  if (btn) {
    btn.textContent = STATE.sidebarCollapsed ? "»" : "«";
    btn.title = STATE.sidebarCollapsed
      ? "Expand sidebar"
      : "Collapse sidebar (more room for the main view)";
  }
}

// ─── Copy JSON ─────────────────────────────────────────────────────────────

window.OBS = window.OBS || {};
window.OBS.copyEvent = function(eventId) {
  // Search single-mode events
  let evt = STATE.events.find(e => e.event_id === eventId);
  // Search swimlane lanes
  if (!evt) {
    for (const [, lane] of window.__swimlaneGetAll?.() ?? []) {
      evt = lane.events.find(e => e.event_id === eventId);
      if (evt) break;
    }
  }
  // Search race tracks
  if (!evt) {
    for (const [, lane] of window.__raceGetAll?.() ?? []) {
      evt = lane.events.find(e => e.event_id === eventId);
      if (evt) break;
    }
  }
  if (!evt) return;
  navigator.clipboard.writeText(JSON.stringify(evt.payload, null, 2)).catch(() => {});
};

// ─── Age ticker & Re-anchoring ──────────────────────────────────────────────

function updateAgeTicker() {
  // no-op, age-ticker removed from header
}

// 250ms periodic re-anchor to bottom for Single view mode (pin unless scrolled up)
setInterval(() => {
  if (STATE.view === "single" && STATE.autoScroll && eventView) {
    eventView.scrollTop = eventView.scrollHeight;
  }
}, 250);

// ─── Breadcrumb ─────────────────────────────────────────────────────────────

function updateBreadcrumb() {
  const parts = [];
  if (STATE.pool && STATE.pool !== "default") parts.push(`pool=${STATE.pool}`);
  if (STATE.tag) parts.push(`tag=${STATE.tag}`);
  headerBreadcrumb.textContent = parts.join(" · ");
}

// ─── SSE ────────────────────────────────────────────────────────────────────

let es = null;

function updateSSEFilter() {
  disconnectSSE();
  connectSSE();
}

function connectSSE() {
  const params = {};
  if (STATE.pool) params.pool = STATE.pool;
  if (STATE.tag) params.tag = STATE.tag;
  if (STATE.view === "single" && STATE.selectedSessionId) params.session_id = STATE.selectedSessionId;
  if (STATE.token) params.token = STATE.token;
  const url = apiUrl("/events/stream", params);

  es = new EventSource(url);
  es.addEventListener("hello", () => {
    setLive(true);
    STATE.sseReconnectDelay = 1000;
    if (STATE.view === "swimlane") window.__swimlaneOnReconnect?.();
    if (STATE.view === "race") window.__raceOnReconnect?.();
  });
  es.addEventListener("event", (msg) => {
    try {
      const evt = JSON.parse(msg.data);
      if (!evt?.event_id) return;
      if (STATE.view === "single") appendEventSingle(evt);
      else if (STATE.view === "swimlane") window.__swimlaneOnEvent?.(evt);
      else if (STATE.view === "race") window.__raceOnEvent?.(evt);
    } catch { /* ignore */ }
  });
  es.onerror = () => {
    setLive(false); es.close();
    setTimeout(connectSSE, STATE.sseReconnectDelay);
    STATE.sseReconnectDelay = Math.min(STATE.sseReconnectDelay * 2, STATE.maxReconnectDelay);
  };
}

function disconnectSSE() { if (es) { es.close(); es = null; } setLive(false); }
function setLive(on) { liveDot.className = on ? "green" : "red"; liveLabel.textContent = on ? "live" : "off"; }

// ─── Pool/tag/sort ──────────────────────────────────────────────────────────

function onFilterChange() {
  STATE.pool = poolFilter.value.trim();
  STATE.tag = tagFilter.value.trim();
  updateBreadcrumb();
  updateSSEFilter();
  fetchSessions();
  if (STATE.view === "swimlane") window.__swimlaneFilterChange?.();
  if (STATE.view === "race") window.__raceFilterChange?.();
  saveURLState();
}

poolFilter.addEventListener("input", onFilterChange);
tagFilter.addEventListener("input", onFilterChange);

sortSelect.addEventListener("change", () => {
  STATE.sort = sortSelect.value;
  fetchSessions();
  saveURLState();
});

hideAfterSelect.addEventListener("change", () => {
  STATE.hideAfter = hideAfterSelect.value;
  renderSessions();
  saveURLState();
});

showHiddenCB.addEventListener("change", () => {
  STATE.showHidden = showHiddenCB.checked;
  renderSessions();
  saveURLState();
});

autoAddCB.addEventListener("change", () => {
  window.__swimlaneAutoAddChange?.(autoAddCB.checked);
  window.__raceAutoAddChange?.(autoAddCB.checked);
  saveURLState();
});

document.getElementById("btn-hide-all")?.addEventListener("click", hideAllVisibleSessions);

window.autoAddLanes = () => autoAddCB.checked;

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadHiddenSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem("obs-hidden-sessions") || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : []);
  } catch { return new Set(); }
}

function loadSidebarCollapsed() {
  return localStorage.getItem("obs-sidebar-collapsed") === "1";
}

// Activity-window classification for the collapsed-sidebar status dot.
// Tracks last_ts so it works across all three views without per-view code.
function activityStatus(s) {
  if (!s?.last_ts) return "gray";
  const ageS = (Date.now() - new Date(s.last_ts).getTime()) / 1000;
  if (ageS <= 10) return "green";
  if (ageS <= 20) return "orange";
  return "gray";
}

function agentLetter(s) {
  const name = s.agent_name ?? s.cwd?.split("/").pop() ?? s.session_id ?? "?";
  const ch = String(name).trim().charAt(0).toUpperCase();
  return ch || "?";
}

function fmtTs(ts) {
  try { return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour:"2-digit", minute:"2-digit", second:"2-digit" }); }
  catch { return ts?.slice(11,19) ?? "?"; }
}
function fmtRel(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return s <= 0 ? "now" : `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
function fmtTokens(n) { return n >= 1000 ? (n/1000).toFixed(1) + "k" : String(n); }
function fmtBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "kB";
  return (n / (1024 * 1024)).toFixed(2) + "MB";
}
function trunc(s, n) { if (!s) return ""; s = String(s); return s.length > n ? s.slice(0,n) + "…" : s; }
function shortId(id) { return id?.slice(0,8) ?? "?"; }
function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function toolNameColors(name) {
  const h = hashString(name);
  const hue = h % 360;
  const sat = 58 + ((h >>> 8) % 14);
  return {
    bg: `hsl(${hue} ${sat}% 22%)`,
    border: `hsl(${hue} ${Math.min(86, sat + 12)}% 46%)`,
    fg: `hsl(${hue} 92% 88%)`,
  };
}
function toolNamePillHTML(evt) {
  if (evt.type !== "tool_call" && evt.type !== "tool_result") return "";
  const name = evt.payload?.tool_name;
  if (!name) return "";
  const c = toolNameColors(name);
  return `<span class="tool-name-pill" title="${escapeHtml(name)}" style="--tool-bg:${c.bg};--tool-border:${c.border};--tool-fg:${c.fg}">${escapeHtml(trunc(name, 36))}</span>`;
}
function parseDuration(str) {
  const m = str.match(/^(\d+)([mh])$/);
  if (!m) return 0;
  const val = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "m") return val * 60 * 1000;
  if (unit === "h") return val * 60 * 60 * 1000;
  return 0;
}

// ─── Exports to window.OBS ──────────────────────────────────────────────────

Object.assign(window.OBS, {
  getState: () => STATE, summaryFor, summaryClass, renderDetailHTML,
  fmtTs, trunc, shortId, fetchSessionEvents, renderSessions, apiUrl, authHeaders,
  fmtRel, fmtTokens, escapeHtml, toolNamePillHTML, saveURLState, updateBreadcrumb,
  getContextWindow, computeAgentInfo, fmtDuration,
});

// ─── Boot ───────────────────────────────────────────────────────────────────

loadURLState();
setMode(STATE.mode);
setView(STATE.view);
applySidebarCollapsed();
fetchSessions();
connectSSE();
setInterval(fetchSessions, 3000);
updateBreadcrumb();

// Restore lanes from URL state (after swimlane.js loads)
setTimeout(() => {
  if (window.__restoreLanes && STATE.view === "swimlane") {
    for (const sid of window.__restoreLanes) {
      window.__swimlaneToggle?.(sid);
      STATE.ackd.add(sid);
    }
    window.__restoreLanes = null;
  }
  if (window.__restoreRaceLanes && STATE.view === "race") {
    const visibleIds = new Set(visibleSessions().map(s => s.session_id));
    if (STATE.sessionsLoaded && !STATE.showHidden && window.__restoreRaceLanes.some(sid => !visibleIds.has(sid))) {
      STATE.showHidden = true;
      showHiddenCB.checked = true;
    }
    for (const sid of window.__restoreRaceLanes) {
      window.__raceToggle?.(sid);
      STATE.ackd.add(sid);
    }
    window.__restoreRaceLanes = null;
  }
  const restoredAutoAdd = window.__restoreAutoAdd !== undefined ? window.__restoreAutoAdd : autoAddCB.checked;
  autoAddCB.checked = restoredAutoAdd;
  window.__swimlaneAutoAddChange?.(restoredAutoAdd);
  window.__raceAutoAddChange?.(restoredAutoAdd);
  window.__restoreAutoAdd = undefined;
}, 200);

})();
