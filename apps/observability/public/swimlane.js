/**
 * swimlane.js — Pi Observability v3 swimlane mode.
 * IIFE-wrapped. Uses window.OBS helpers from app.js.
 */
(function() {

const STATE = window.__OBS_STATE;
const O = window.OBS;
const { summaryFor, summaryClass, renderDetailHTML, fmtTs, trunc, shortId, fetchSessionEvents, renderSessions, apiUrl, authHeaders, fmtRel, fmtTokens, saveURLState, resolveContextWindow, toolNamePillHTML } = O;

const LANES = new Map();
let autoAddLanes = true;
let swimlaneSSEResynced = false;

// ─── Live-event pulse styling ───────────────────────────────────────────────
// Each SSE-arrived row gets `.evt-new` for a one-shot slide-in + background
// pulse (see @keyframes lane-evt-enter in index.html). Two modes:
//   specificColorPulse=true  → pulse the event-type color (dim/muted types
//                              fall back to green so the cue is still visible)
//   specificColorPulse=false → always pulse a faint green
// Flip live from DevTools: __swimlaneSetPulseMode(false) / (true).
const PULSE_GREEN = "rgba(63,185,80,0.20)";
const PULSE_TYPE_COLORS = {
  user_message:      "rgba(88,166,255,0.18)",
  assistant_message: "rgba(88,166,255,0.18)",
  tool_call:         "rgba(210,153,29,0.20)",
  tool_result:       "rgba(227,179,65,0.20)",
  thinking:          "rgba(163,113,247,0.20)",
  error:             "rgba(248,81,73,0.22)",
  model_change:      "rgba(57,197,207,0.20)",
  compaction:        "rgba(210,164,46,0.22)",
  branch_nav:        "rgba(57,197,207,0.20)",
  // session_start / session_shutdown / agent_start / agent_end / turn_start /
  // turn_end / custom intentionally absent → fall through to PULSE_GREEN.
};
let specificColorPulse = true;
window.__swimlaneSetPulseMode = (v) => { specificColorPulse = !!v; };
window.__swimlaneGetPulseMode = () => specificColorPulse;
function pulseColorFor(type) {
  if (!specificColorPulse) return PULSE_GREEN;
  return PULSE_TYPE_COLORS[type] || PULSE_GREEN;
}
window.__pulseColorFor = pulseColorFor;

const swimlaneContainer = document.getElementById("swimlane-container");
const swimlaneEmpty = document.getElementById("swimlane-empty");

// ─── Hooks called from app.js ────────────────────────────────────────────────

window.__swimlaneOnView = function() {
  for (const [sid, lane] of LANES) {
    const sess = STATE.sessions.find(s => s.session_id === sid);
    if (sess) lane.session = sess;
  }
  renderAllLanes();
};

window.__swimlaneOnSessions = function() {
  for (const s of STATE.sessions) {
    if (LANES.has(s.session_id)) LANES.get(s.session_id).session = s;
  }
  renderAllLanes();
};

window.__swimlaneOnReconnect = function() {
  swimlaneSSEResynced = false;
  resyncAllLanes().then(() => { swimlaneSSEResynced = true; });
};

window.__swimlaneOnEvent = function(evt) { routeSSEEvent(evt); };

window.__swimlaneIsSelected = sid => LANES.has(sid);

window.__swimlaneToggle = function(sid) {
  if (LANES.has(sid)) {
    destroyLane(sid);
  } else {
    createLane(sid);
    window.__OBS_STATE?.ackd?.add(sid);
  }
  renderSessions();
  renderAllLanes();
  saveURLState();
};

window.__swimlaneEnsureLane = function(sid) {
  if (!sid || LANES.has(sid)) return;
  createLane(sid);
  renderSessions();
  renderAllLanes();
  saveURLState();
};

window.__swimlaneGetLanes = () => Array.from(LANES.keys());

window.__swimlaneStatsUpdate = function(sid, stats) {
  const lane = LANES.get(sid);
  if (!lane) return;
  lane.costStr = `$${stats.total_cost.toFixed(4)} · ${fmtTokens(stats.total_tokens)} tk`;
  updateLaneHeader(sid);
};

window.__swimlaneFilterChange = function() {};

window.__swimlaneAutoAddChange = function(val) { autoAddLanes = val; };

// Expose lanes for cross-IIFE access (copyEvent)
window.__swimlaneGetAll = () => LANES;

// Re-pin every sticky lane to its bottom. Called by app.js after a layout-mode
// flip changes row heights underfoot. Cheap to call — a no-op for non-sticky
// lanes, idempotent for sticky ones.
window.__swimlaneReanchorAll = function() {
  for (const lane of LANES.values()) {
    if (lane.stickToBottom !== false) scrollLaneToBottom(lane);
  }
};

// ─── Lane management ─────────────────────────────────────────────────────────

function createLane(sid) {
  const sess = STATE.sessions.find(s => s.session_id === sid);
  const name = sess?.agent_name ?? sess?.cwd?.split("/").pop() ?? shortId(sid);

  const col = document.createElement("div");
  col.className = "lane-column";
  col.id = `lane-${sid}`;

  const header = document.createElement("div");
  header.className = "lane-header";
  const costStr = (STATE.sessionStats[sid]?.total_cost !== undefined) ? `$${STATE.sessionStats[sid].total_cost.toFixed(4)}` : "";
  header.innerHTML = `
    <span class="lane-dot off" id="lane-dot-${sid}"></span>
    <span class="lane-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <span class="lane-model">${sess?.model ?? ""}</span>
    <span class="lane-cost" id="lane-cost-${sid}">${costStr}</span>
    <span id="lane-age-${sid}" style="color:var(--muted);font-size:8px;margin-left:auto;"></span>
    <button class="lane-close" title="Close lane" onclick="event.stopPropagation();window.__swimlaneToggle('${sid}')">×</button>
  `;

  // Compressed metrics line under the main header: events · in · out · ctx %
  const header2 = document.createElement("div");
  header2.className = "lane-header-row2";
  header2.id = `lane-row2-${sid}`;

  const body = document.createElement("div");
  body.className = "lane-body";
  body.id = `lane-body-${sid}`;

  const content = document.createElement("div");
  content.className = "lane-content";
  body.appendChild(content);

  // Pause toast
  const toast = document.createElement("div");
  toast.className = "pause-toast";
  toast.id = `pause-toast-${sid}`;
  toast.textContent = "↓ paused — click to resume";
  toast.addEventListener("click", () => {
    const lane = LANES.get(sid);
    if (lane) scrollLaneToBottom(lane);
    if (lane) lane.paused = false;
    toast.classList.remove("show");
  });
  body.appendChild(toast);

  body.addEventListener("scroll", () => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
    const lane = LANES.get(sid);
    if (!lane || lane.autoScrolling) return;
    lane.stickToBottom = atBottom;
    if (!atBottom && !lane.paused) {
      lane.paused = true;
      toast.classList.add("show");
    } else if (atBottom && lane.paused) {
      lane.paused = false;
      toast.classList.remove("show");
    }
  });

  col.appendChild(header);
  col.appendChild(header2);
  col.appendChild(body);
  swimlaneContainer.appendChild(col);

  const observer = new MutationObserver(() => {
    const lane = LANES.get(sid);
    if (lane?.stickToBottom !== false) scrollLaneToBottom(lane);
  });
  observer.observe(content, { childList: true });

  LANES.set(sid, { session: sess, events: [], lastSeq: -1, paused: false, stickToBottom: true, autoScrolling: false, col, body, content, observer, costStr: costStr });

  loadLaneEvents(sid);
  updateLaneAge(sid);
  if (swimlaneEmpty) swimlaneEmpty.style.display = "none";
}

function destroyLane(sid) {
  const lane = LANES.get(sid);
  if (!lane) return;
  lane.observer?.disconnect?.();
  if (lane.col?.parentNode) lane.col.parentNode.removeChild(lane.col);
  LANES.delete(sid);
  if (LANES.size === 0 && swimlaneEmpty) swimlaneEmpty.style.display = "";
}

async function loadLaneEvents(sid) {
  const lane = LANES.get(sid);
  if (!lane) return;
  const events = await fetchSessionEvents(sid);
  if (events?.length) {
    lane.events = events;
    lane.lastSeq = events[events.length - 1].seq;
    renderLaneBody(sid);
    updateLaneAge(sid);
  }
}

async function resyncAllLanes() {
  const ps = [];
  for (const [sid, lane] of LANES) {
    if (lane.lastSeq >= 0) {
      ps.push(fetchSessionEvents(sid, lane.lastSeq).then(events => {
        if (events?.length) {
          for (const evt of events) {
            if (evt.seq > lane.lastSeq) { lane.events.push(evt); lane.lastSeq = evt.seq; appendLaneDOM(sid, evt); }
          }
        }
      }));
    } else { ps.push(loadLaneEvents(sid)); }
  }
  await Promise.allSettled(ps);
  for (const [sid] of LANES) updateLaneAge(sid);
}

// ─── SSE routing ────────────────────────────────────────────────────────────

function routeSSEEvent(evt) {
  if (!LANES.has(evt.session_id)) {
    if (autoAddLanes) createLane(evt.session_id);
    else return;
  }
  const lane = LANES.get(evt.session_id);
  if (!lane || evt.seq <= lane.lastSeq) return;
  lane.events.push(evt);
  lane.lastSeq = evt.seq;
  appendLaneDOM(evt.session_id, evt, true);
  updateLaneAge(evt.session_id);
  updateLaneRow2(evt.session_id);
  const dot = document.getElementById(`lane-dot-${evt.session_id}`);
  if (dot) dot.className = "lane-dot green";
}

// ─── Lane rendering ─────────────────────────────────────────────────────────

function renderLaneBody(sid) {
  const lane = LANES.get(sid);
  if (!lane) return;
  lane.content.innerHTML = "";
  for (const evt of lane.events) appendLaneDOM(sid, evt);
  if (lane.stickToBottom !== false) scrollLaneToBottom(lane);
}

function appendLaneDOM(sid, evt, isLive = false) {
  const lane = LANES.get(sid);
  if (!lane) return;

  const row = document.createElement("div");
  row.className = "lane-evt";
  row.innerHTML = `<span class="lane-evt-ts">${fmtTs(evt.ts)}</span><span class="lane-evt-type"><span class="pill ${evt.type}">${evt.type.replace(/_/g," ")}</span>${toolNamePillHTML(evt)}</span><span class="lane-evt-summary ${summaryClass(evt)}">${summaryFor(evt)}</span>`;

  if (isLive) {
    row.style.setProperty("--pulse-color", pulseColorFor(evt.type));
    row.classList.add("evt-new");
    // Drop the class once the animation completes so reflow/state isn't held.
    setTimeout(() => row.classList.remove("evt-new"), 1300);
  }

  const detail = document.createElement("div");
  detail.className = "lane-evt-detail";
  const cBtn = `<button class="copy-btn" onclick="event.stopPropagation();OBS.copyEvent('${evt.event_id}')">📋</button>`;
  detail.innerHTML = `${cBtn}<pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre>`;

  row.addEventListener("click", () => detail.classList.toggle("open"));

  lane.content.appendChild(row);
  lane.content.appendChild(detail);

  if (lane.stickToBottom !== false) scrollLaneToBottom(lane);
}

function scrollLaneToBottom(lane) {
  const go = () => { lane.body.scrollTop = lane.body.scrollHeight; };
  lane.autoScrolling = true;
  lane.stickToBottom = true;
  lane.paused = false;
  lane.body.querySelector(".pause-toast")?.classList.remove("show");
  go();
  requestAnimationFrame(go);
  clearTimeout(lane.scrollTimer);
  lane.scrollTimer = setTimeout(() => {
    go();
    lane.autoScrolling = false;
  }, 75);
}

// Refresh lane header metadata in place. Do NOT detach/re-attach lane columns
// — that triggers a layout reflow on every event row and is the source of the
// "swimlane glitches every 3s" issue (fetchSessions ticks every 3s and used
// to ripple a detach+attach through every lane regardless of activity). Lane
// order is already stable from createLane insertion. updateLaneAge is skipped
// here because the dedicated 2s age ticker below already handles it.
function renderAllLanes() {
  for (const sid of LANES.keys()) updateLaneHeader(sid);
}

function updateLaneHeader(sid) {
  const lane = LANES.get(sid);
  if (!lane?.col) return;
  const nameEl = lane.col.querySelector(".lane-name");
  const modelEl = lane.col.querySelector(".lane-model");
  const costEl = lane.col.querySelector(".lane-cost");
  if (nameEl && lane.session) {
    const n = lane.session.agent_name ?? lane.session.cwd?.split("/").pop() ?? shortId(sid);
    nameEl.textContent = n; nameEl.title = n;
  }
  if (modelEl && lane.session) modelEl.textContent = lane.session.model ?? "";
  if (costEl) costEl.textContent = lane.costStr ?? "";
  updateLaneRow2(sid);
}

// Compute + render the compressed metrics row under the lane header.
function updateLaneRow2(sid) {
  const lane = LANES.get(sid);
  if (!lane?.col) return;
  const row2 = document.getElementById(`lane-row2-${sid}`);
  if (!row2) return;
  const events = lane.events || [];
  let inTok = 0, outTok = 0, latestInput = null;
  for (const e of events) {
    if (e.type !== "assistant_message") continue;
    const u = e.payload?.usage;
    if (!u) continue;
    inTok += u.input ?? 0;
    outTok += u.output ?? 0;
  }
  // "Context used" = usage.input + usage.cache_read + usage.cache_write
  // (same as app.js / db.ts). The full prefix sent to the model on the latest
  // turn — matches pi's terminal context bar across cached and uncached
  // providers. Cache breakdown stays visible on the dedicated cache pills.
  for (let i = events.length - 1; i >= 0; i--) {
    const u = events[i].type === "assistant_message" ? events[i].payload?.usage : null;
    if (u && (u.input || u.cache_read || u.cache_write)) {
      latestInput = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
      break;
    }
  }
  const model = lane.session?.model || "";
  // Legacy-session fallback: resolve the window once per model via the server
  // endpoint (shared/model-metadata.ts), cached in app.js. Re-render this lane
  // when it resolves so the bar reflects the real denominator (e.g. 1M for
  // glm-5.2, not the old /^glm-/i → 128k regex default).
  const ctxTotal = (typeof resolveContextWindow === "function")
    ? resolveContextWindow(model, () => updateLaneRow2(sid))
    : 128000;
  const ctxUsed = latestInput || 0;
  const ctxPctUsed = ctxTotal ? Math.round((ctxUsed / ctxTotal) * 100) : 0;
  const ctxPctRemaining = 100 - ctxPctUsed;
  const barColor = ctxPctUsed > 90 ? "var(--red)" : ctxPctUsed > 70 ? "var(--orange)" : "var(--green)";
  row2.innerHTML = `
    <span>${events.length} ev</span><span class="sep">·</span>
    <span>in ${fmtTokens(inTok)}</span><span class="sep">·</span>
    <span>out ${fmtTokens(outTok)}</span><span class="sep">·</span>
    <span title="context: ${ctxUsed.toLocaleString()} / ${ctxTotal.toLocaleString()}">ctx ${ctxPctRemaining}%</span>
    <span class="ctx-bar"><span class="ctx-bar-fill" style="width:${ctxPctUsed}%;background:${barColor};display:block"></span></span>
  `;
}

function updateLaneAge(sid) {
  const lane = LANES.get(sid);
  if (!lane) return;
  const ageEl = document.getElementById(`lane-age-${sid}`);
  if (!ageEl) return;
  const evts = lane.events;
  if (!evts.length) { ageEl.textContent = ""; return; }
  ageEl.textContent = fmtRel(evts[evts.length - 1].ts);

  const dot = document.getElementById(`lane-dot-${sid}`);
  const s = evts.length ? Math.round((Date.now() - new Date(evts[evts.length - 1].ts).getTime()) / 1000) : 999;
  if (dot && s > 10 && dot.className === "lane-dot green") dot.className = "lane-dot off";
}

setInterval(() => { for (const sid of LANES.keys()) updateLaneAge(sid); }, 2000);

// ─── Helpers (mirrored from app.js since we're in an IIFE) ──────────────────

function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

})();
