/**
 * app.js  (v4 — pandapower backend)
 *
 * All heavy computation (matching + pandapower AC power flow) runs in the
 * Python Flask backend at http://localhost:5000.
 * This file manages UI state and renders results from API responses.
 *
 * WORKFLOW (same as Python script):
 *   Price Check → P2P Matching → BASE PF → PRE_MATCH PF → POST_MATCH PF
 *   → if POST_MATCH violations: Retry (round 1) or Grid Fallback (round 2)
 */
"use strict";

// ── Config ─────────────────────────────────────────────────────────────────
const BACKEND = (window.location.protocol === "file:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:5001"
  : ""; // When deployed, API paths are relative to the origin

const FIT_PRICE = 2.20;
const RETAIL_PRICE = 5.80;

const PLAYER_LOCATIONS = {
  A: "Bus2", B: "Bus11", G: "Bus17", H: "Bus20", J: "Bus29",
  C: "Bus14", D: "Bus25", E: "Bus32", F: "Bus35", I: "Bus7",
};
const SELLERS = ["C", "D", "E", "F", "I"];
const BUYERS = ["A", "B", "G", "H", "J"];

// Default values from Python constants
const DEFAULT_OFFERING = { C: 3.8364, D: 3.2683, E: 3.1671, F: 4.0388, I: 3.1638 };
const DEFAULT_BIDDING = { A: 4.7114, B: 5.3546, G: 5.0999, H: 3.8625, J: 5.80 };
const DEFAULT_SELLER_NRG = { C: 3.10, D: 2.90, E: 3.10, F: 2.90, I: 3.00 };
const DEFAULT_BUYER_NRG = { A: 3.10, B: 2.90, G: 3.10, H: 2.90, J: 3.00 };

// ค่า peak load จริงต่อราย (มาจาก ACTUAL_LOAD_DATA ในฝั่ง backend ที่บัสของแต่ละ player, หน่วย kW)
const PEAK_LOAD_KW = {
  A: 4.469, B: 7.769, G: 1.169, H: 1.169, J: 0.974,
  C: 0.779, D: 1.169, E: 0.779, F: 1.169, I: 1.169,
};

// ── Display names for the three power-flow cases ────────────────────────────
// Internal keys stay BASE / PRE_MATCH / POST_MATCH; these are what the UI shows.
const CASE_LABELS = {
  BASE: "No-PV Baseline",
  PRE_MATCH: "PRE_MATCH (injection ceiling)",
  POST_MATCH: "POST_MATCH (with P2P injection)",
};
const caseLabel = k => CASE_LABELS[k] || k;

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  offeringPrice: { ...DEFAULT_OFFERING },
  biddingPrice: { ...DEFAULT_BIDDING },
  sellerKwh: { ...DEFAULT_SELLER_NRG },
  buyerKwh: { ...DEFAULT_BUYER_NRG },
};

let wf = {
  step: "input",   // input | running | results | retry | grid
  round: 0,
  energyRange: null,
  backendOk: false,
  priceErrors: [],
  pfViolations: [],
  failedPlayers: { sellers: [], buyers: [], buses: [] },
  retryPlayers: new Set(),
  gridFallback: false,
  apiResult: null,      // last successful API response
  eventLog: [],
  pfTab: "base",
};

let R = {};  // results cache

// ── Format helpers ─────────────────────────────────────────────────────────
const f2 = n => (typeof n === "number" ? n.toFixed(2) : "—");
const f4 = n => (typeof n === "number" ? n.toFixed(4) : "—");
const f6 = n => (typeof n === "number" ? n.toFixed(6) : "—");
const f8 = n => (typeof n === "number" ? n.toFixed(8) : "—");
const fKw = n => (typeof n === "number" ? (n * 1000).toFixed(4) : "—");
const fKvar = n => (typeof n === "number" ? (n * 1000).toFixed(4) : "—");

function logEvent(msg) {
  wf.eventLog.push({ time: new Date().toLocaleTimeString(), msg });
}

// ── Backend health check ────────────────────────────────────────────────────
async function checkBackend() {
  try {
    const r = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    wf.backendOk = true;
    logEvent(`✅ Backend connected — pandapower ${d.pandapower}`);
    updateBackendBadge(true, d.pandapower);
  } catch (_) {
    wf.backendOk = false;
    logEvent("❌ Backend not reachable — run: bash start_backend.sh");
    updateBackendBadge(false);
  }
}

function updateBackendBadge(ok, version = "") {
  const el = document.getElementById("backend-badge");
  if (!el) return;
  if (ok) {
    el.textContent = `🐍 Backend OK — pandapower ${version}`;
    el.className = "header-badge backend-ok";
  } else {
    el.textContent = "⚠️ Backend offline — run start_backend.sh";
    el.className = "header-badge backend-off";
  }
}

// ── Randomized default energies (within feasible caps) ──────────────────────
function _rand2(min, max) { return Math.round((Math.random() * (max - min) + min) * 100) / 100; }

function _randomEnergies(players, maxPer, maxTotal) {
  const cap = Math.max(0.5, maxPer);
  const lo = Math.max(0.5, cap * 0.4);
  const vals = {};
  let total = 0;
  for (const p of players) { const v = _rand2(lo, cap); vals[p] = v; total += v; }
  const safe = Math.max(players.length, maxTotal * 0.95); // keep sum under cap
  if (total > safe && total > 0) {
    const k = safe / total;
    for (const p of players) vals[p] = Math.round(Math.max(0.5, vals[p] * k) * 100) / 100;
  }
  return vals;
}

// Randomize per-player energy so the TOTAL stays within max seller/buyer total
// (and each player within its per-slot cap). Uses the feasible range from the
// backend (/api/energy_range); falls back to safe caps if it is not loaded yet.
function applyRandomDefaults() {
  const er = wf.energyRange || {};
  const ok = v => (typeof v === "number" && v > 0 && v < 9000);
  const maxPerS = ok(er.max_kwh_per_seller) ? er.max_kwh_per_seller : 3.11;
  const maxTotS = ok(er.max_kwh_total_seller) ? er.max_kwh_total_seller : 15.55;
  const maxPerB = ok(er.max_kwh_per_buyer) ? er.max_kwh_per_buyer : 3.11;
  const maxTotB = ok(er.max_kwh_total_buyer) ? er.max_kwh_total_buyer : 15.55;
  state.sellerKwh = _randomEnergies(SELLERS, maxPerS, maxTotS);
  state.buyerKwh = _randomEnergies(BUYERS, maxPerB, maxTotB);
  const tS = SELLERS.reduce((a, s) => a + state.sellerKwh[s], 0);
  const tB = BUYERS.reduce((a, b) => a + state.buyerKwh[b], 0);
  logEvent(`\u{1F3B2} Random default energy — Seller total ${tS}/${maxTotS} kWh | Buyer total ${tB}/${maxTotB} kWh`);
}

// Re-roll handler (exposed for the 🎲 button).
function randomizeEnergies() {
  applyRandomDefaults();
  renderInputs();
  showToast("\u{1F3B2} สุ่มค่าพลังงานใหม่ (ไม่เกินเพดาน seller/buyer total)", "info");
}

// ── Energy range analysis (via backend) ────────────────────────────────────
async function runEnergyRangeAnalysis() {
  const banner = document.getElementById("energy-range-banner");
  if (banner) banner.innerHTML = `<div class="era-loading">⏳ Analysing feasible energy range via PRE_MATCH power flow (pandapower)…</div>`;
  try {
    const res = await fetch(`${BACKEND}/api/energy_range`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellers: SELLERS, player_locations: PLAYER_LOCATIONS }),
    });
    wf.energyRange = await res.json();
    logEvent(`📐 Energy limit: Seller ${wf.energyRange.max_kwh_per_seller} kWh/each | Buyer ${wf.energyRange.max_kwh_per_buyer} kWh/each`);
  } catch (_) {
    wf.energyRange = {
      max_kwh_per_seller: 9999, max_kwh_total_seller: 50000,
      max_kwh_per_buyer: 9999, max_kwh_total_buyer: 50000,
      min_kwh_per_seller: 0, min_kwh_per_buyer: 0,
      feasibility_note: "Backend not available — energy range analysis skipped",
    };
    logEvent("⚠️ Could not reach backend for energy range. Start start_backend.sh");
  }
  applyRandomDefaults();   // สุ่มพลังงาน default ภายในเพดานที่ backend คำนวณ
  renderEnergyRangeBanner();
  renderInputs();
}

// ── Core pipeline ───────────────────────────────────────────────────────────
async function runFullPipeline() {
  if (!wf.backendOk) {
    await checkBackend();
    if (!wf.backendOk) {
      showToast("❌ Backend offline — run: bash start_backend.sh", "error");
      return;
    }
  }

  wf.step = "running";
  renderAll();

  try {
    const res = await fetch(`${BACKEND}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellers: SELLERS,
        buyers: BUYERS,
        offering_price: state.offeringPrice,
        bidding_price: state.biddingPrice,
        seller_energy_kwh: state.sellerKwh,
        buyer_energy_kwh: state.buyerKwh,
        player_locations: PLAYER_LOCATIONS,
      }),
    });

    const data = await res.json();

    // ── Price errors ──────────────────────────────────────────────────────
    if (!data.success) {
      wf.priceErrors = data.price_errors || [];
      wf.step = "input";
      logEvent(`⛔ Price check failed (${wf.priceErrors.length} error(s))`);
      renderAll(); showTab("inputs");
      showToast("⛔ Price validation failed — see input page", "error");
      return;
    }

    wf.priceErrors = [];
    wf.apiResult = data;

    // ── Log matching summary ──────────────────────────────────────────────
    const logs = data.matching.logs || [];
    const total = logs.reduce((a, l) => a + l.qty, 0);
    logEvent(`🔄 Matching: ${logs.length} trade(s), ${total.toFixed(2)} kWh traded`);

    // ── PF case logging ───────────────────────────────────────────────────
    const pf = data.power_flow;
    const logPf = (label, r) => {
      if (r?.converged) logEvent(`⚡ ${label}: min V=${f6(r.metrics?.min_voltage_pu)} p.u., loss=${fKw(r.metrics?.total_loss_mw)} kW`);
      else logEvent(`❌ ${label}: ${r?.error || "did not converge"}`);
    };
    logPf("BASE", pf.base);
    logPf("PRE_MATCH", pf.pre_match);
    logPf("POST_MATCH", pf.post_match);

    // ── Voltage violation check on POST_MATCH ─────────────────────────────
    handlePowerFlowViolations(pf);

  } catch (err) {
    wf.step = "input";
    logEvent(`❌ Network error: ${err.message}`);
    renderAll();
    showToast("❌ Cannot reach backend. Is start_backend.sh running?", "error");
  }
}

function buildResultsCache() {
  const d = wf.apiResult;
  const m = d.matching;
  R = {
    // Matching
    trades: m.trades,
    logs: m.logs,
    qsRem: m.qsRem,
    qbRem: m.qbRem,
    cp: m.cp,
    df: m.df,
    pathMatrix: m.pathMatrix,
    soldKwh: m.soldKwh,
    boughtKwh: m.boughtKwh,
    feasibility: m.feasibility,
    midPrice: m.midPrice,
    // Power flow
    pfBase: d.power_flow.base,
    pfPre: d.power_flow.pre_match,
    pfPost: d.power_flow.post_match,
  };
}

// ── Handlers ────────────────────────────────────────────────────────────────
function onRunAnalysis() {
  collectFormValues();
  runFullPipeline();
}

function onResetDefaults() {
  state.offeringPrice = { ...DEFAULT_OFFERING };
  state.biddingPrice = { ...DEFAULT_BIDDING };
  state.sellerKwh = { ...DEFAULT_SELLER_NRG };
  state.buyerKwh = { ...DEFAULT_BUYER_NRG };
  wf.round = 0; wf.step = "input"; wf.priceErrors = [];
  wf.failedPlayers = { sellers: [], buyers: [], buses: [] };
  wf.retryPlayers = new Set(); wf.eventLog = []; wf.apiResult = null;
  renderAll(); showTab("inputs");
  showToast("↩ Reset to defaults", "info");
}

function collectFormValues() {
  for (const s of SELLERS) {
    const ofEl = document.getElementById(`offer-${s}`);
    const enEl = document.getElementById(`senergy-${s}`);
    if (ofEl) state.offeringPrice[s] = parseFloat(ofEl.value) || state.offeringPrice[s];
    if (enEl) state.sellerKwh[s] = parseFloat(enEl.value) || state.sellerKwh[s];
  }
  for (const b of BUYERS) {
    const bidEl = document.getElementById(`bid-${b}`);
    const enEl = document.getElementById(`benergy-${b}`);
    if (bidEl) state.biddingPrice[b] = parseFloat(bidEl.value) || state.biddingPrice[b];
    if (enEl) state.buyerKwh[b] = parseFloat(enEl.value) || state.buyerKwh[b];
  }
}

// ── Nav / Tab ────────────────────────────────────────────────────────────────
let activeTab = "inputs";

function showTab(tabId) {
  const resultsOnly = ["dashboard", "matching", "powerflow", "transactions"];
  if (resultsOnly.includes(tabId) && wf.step !== "results") {
    showToast("Run analysis first to unlock result tabs", "info"); tabId = "inputs";
  }
  activeTab = tabId;
  document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(el => el.classList.remove("active"));
  const el = document.getElementById(`tab-${tabId}`);
  const btn = document.getElementById(`nav-${tabId}`);
  if (el) el.classList.add("active");
  if (btn) btn.classList.add("active");
  renderTab(tabId);
}

function renderAll() {
  renderWorkflowBanner();
  renderTab(activeTab);
  updateNavState();
}

function renderTab(tabId) {
  switch (tabId) {
    case "inputs": renderInputs(); break;
    case "dashboard": if (wf.step === "results") renderDashboard(); break;
    case "matching": if (wf.step === "results") renderMatching(); break;
    case "powerflow": if (wf.step === "results") renderPowerFlow(); break;
    case "transactions": if (wf.step === "results") renderTransactions(); break;
    case "log": renderEventLog(); break;
  }
}

function updateNavState() {
  const has = wf.step === "results";
  ["dashboard", "matching", "powerflow", "transactions"].forEach(id => {
    const btn = document.getElementById(`nav-${id}`);
    if (btn) btn.classList.toggle("nav-locked", !has);
  });
  const badge = document.getElementById("trade-count");
  if (badge) badge.textContent = wf.apiResult ? (wf.apiResult.matching.logs?.length || 0) : "0";
}

// ── Workflow Banner ──────────────────────────────────────────────────────────
function renderWorkflowBanner() {
  const el = document.getElementById("workflow-banner");
  if (!el) return;
  const steps = [
    { label: "① Energy Analysis" },
    { label: "② Input Data" },
    { label: "③ P2P Matching" },
    { label: "④ Power Flow" },
    { label: "⑤ Results" },
  ];
  const order = ["analysis", "input", "matching", "pflow", "results"];
  const curMap = { input: "input", running: "matching", retry: "pflow", grid: "pflow", results: "results" };
  const curStep = curMap[wf.step] || "input";
  const ci = order.indexOf(curStep);
  const stepsHtml = steps.map((s, i) => {
    const cls = i < ci ? "step-done" : i === ci ? "step-active" : "step-pending";
    return `<div class="wf-step ${cls}">${s.label}</div>`;
  }).join(`<div class="wf-arrow">→</div>`);

  const statusMap = {
    input: { cls: "status-blue", icon: "📝", text: "Enter Input Data" },
    running: { cls: "status-yellow", icon: "⏳", text: "Running pandapower analysis…" },
    results: { cls: "status-green", icon: "✅", text: "P2P Trading Successful — 3 PF Cases (pandapower)" },
    retry: { cls: "status-orange", icon: "⚠️", text: `POST_MATCH PF Failed — Retry Round ${wf.round}/2` },
    grid: { cls: "status-red", icon: "❌", text: "Grid Fallback Active (P2P Abandoned)" },
  };
  const s = statusMap[wf.step] || statusMap.input;
  el.innerHTML = `
    <div class="wf-stepper">${stepsHtml}</div>
    <div class="wf-status ${s.cls}">${s.icon} ${s.text}</div>`;
}

// ── Energy Range Banner ──────────────────────────────────────────────────────
function renderEnergyRangeBanner() {
  const el = document.getElementById("energy-range-banner");
  if (!el) return;
  const er = wf.energyRange;
  if (!er) { el.innerHTML = `<div class="era-loading">⏳ Loading energy range from backend…</div>`; return; }

  const maxS = er.max_kwh_per_seller !== undefined ? er.max_kwh_per_seller.toLocaleString() : "—";
  const maxSTot = er.max_kwh_total_seller !== undefined ? er.max_kwh_total_seller.toLocaleString() : "—";
  const maxB = er.max_kwh_per_buyer !== undefined ? er.max_kwh_per_buyer.toLocaleString() : "—";
  const maxBTot = er.max_kwh_total_buyer !== undefined ? er.max_kwh_total_buyer.toLocaleString() : "—";

  el.innerHTML = `
    <div class="era-card">
      <div class="era-title">⚡ Power Flow Feasibility (pandapower AC) — Recommended Energy Range</div>
      <div class="era-grid">
        <div class="era-stat"><span class="era-label">Min / Seller</span>
          <span class="era-value green">0 kWh</span></div>
        <div class="era-stat"><span class="era-label">Max / Seller <span style="font-size:0.75em;opacity:0.8">(Overvoltage)</span></span>
          <span class="era-value orange">${maxS} kWh</span></div>
        <div class="era-stat"><span class="era-label">Max Seller Total</span>
          <span class="era-value blue">${maxSTot} kWh</span></div>
        <div class="era-stat"><span class="era-label">Voltage limits</span>
          <span class="era-value">0.95–1.05 p.u.</span></div>

        <div class="era-stat"><span class="era-label">Min / Buyer</span>
          <span class="era-value green">0 kWh</span></div>
        <div class="era-stat"><span class="era-label">Max / Buyer <span style="font-size:0.75em;opacity:0.8">(Undervoltage)</span></span>
          <span class="era-value orange">${maxB} kWh</span></div>
        <div class="era-stat"><span class="era-label">Max Buyer Total</span>
          <span class="era-value blue">${maxBTot} kWh</span></div>
        <div class="era-stat"></div>
      </div>
      <div class="era-note">
        <strong>ℹ️ ${er.feasibility_note}</strong><br>
        <span style="font-size:0.9em; color:#ff5252; opacity:0.9;">
          *หมายเหตุ: ค่าเหล่านี้มาจากระบบจำลองสถานการณ์สุดขั้ว (PRE_MATCH) โดยสั่งให้ผู้ขายทั้ง 5 ราย "ผลิตไฟเต็มพิกัดแล้วอัดเข้าไปในสายส่งพร้อมๆ กัน" โดยห้ามไม่ให้มีผู้ซื้อมาช่วยดึงไฟออกไปใช้เลย (มีแต่คนฉีดไฟเข้า แต่ไม่มีโหลดดูดไฟออก ไฟทั้งหมดจึงต้องวิ่งไปที่ Slack Bus ทำให้แรงดันทะลุ 1.05 p.u.) เพื่อหาเพดานความจุสูงสุดของสายส่ง แต่ในความเป็นจริงเมื่อมีการจับคู่ ผู้ซื้อจะช่วยดึงไฟไปใช้ในพื้นที่ ทำให้ระบบมักจะสามารถรองรับตัวเลขพลังงานที่สูงกว่าขีดจำกัดนี้ได้โดยไม่เกิน 1.05 p.u.
        </span>
      </div>
      <div class="era-warning">⚠️ Energy exceeding limits triggers overvoltage/undervoltage violations. Inputs are currently restricted to these strict bounds for maximum safety.</div>
    </div>`;
}

// ── RENDER: INPUTS ────────────────────────────────────────────────────────────
function renderInputs() {
  if (!wf.backendOk) {
    const offlineHtml = `
      <div class="wf-alert alert-grid" style="margin-bottom:16px">
        <div class="wf-alert-title">⚠️ Python Backend Not Running</div>
        <div class="wf-alert-body">
          <p>The web app requires the Python Flask backend with pandapower to run power flow calculations.</p>
          <p>Open a <strong>terminal</strong> and run:</p>
          <pre style="background:rgba(0,0,0,.4);padding:10px;border-radius:8px;font-family:monospace;margin:8px 0">bash start_backend.sh</pre>
          <p>This will install pandapower and start the API server at <strong>http://localhost:5000</strong>.</p>
          <button class="btn btn-secondary" style="margin-top:8px" onclick="checkBackend().then(()=>renderAll())">🔄 Retry Connection</button>
        </div>
      </div>`;
    document.getElementById("tab-inputs").innerHTML = `<div id="energy-range-banner"></div>${offlineHtml}${buildInputSection()}`;
    renderEnergyRangeBanner();
    requestAnimationFrame(attachPasteHandlers);
    return;
  }

  const el = document.getElementById("tab-inputs");
  if (!el) return;

  let alertHtml = "";
  if (wf.step === "retry") {
    const violBuses = wf.pfViolations.map(v =>
      `<span class="viol-bus">Bus ${v.bus} (${f6(v.vm_pu)} p.u. — ${v.bus < 1 ? "?" : v.vm_pu < 0.95 ? "UNDER" : "OVER"}VOLTAGE)</span>`
    ).join(" ");
    const fpNames = [
      ...wf.failedPlayers.sellers.map(s => `<span class="tag seller-tag">${s}</span>`),
      ...wf.failedPlayers.buyers.map(b => `<span class="tag buyer-tag">${b}</span>`),
    ].join(" ") || "—";
    alertHtml = `
      <div class="wf-alert alert-retry">
        <div class="wf-alert-title">⚠️ POST_MATCH Power Flow FAILED — Round 1 of 2 (pandapower)</div>
        <div class="wf-alert-body">
          <p><strong>Violated buses:</strong> ${violBuses}</p>
          <p><strong>Affected players (highlighted):</strong> ${fpNames}</p>
          <p>Reduce energy for highlighted players then re-run.
             <strong>Round 2 failure forces grid trading.</strong></p>
        </div>
      </div>`;
  }
  if (wf.step === "grid") {
    alertHtml = `
      <div class="wf-alert alert-grid">
        <div class="wf-alert-title">❌ P2P ABANDONED — Grid Fallback (Round 2 Failed)</div>
        <div class="wf-alert-body">${renderGridFallbackTable()}</div>
      </div>`;
  }

  let priceErrHtml = "";
  if (wf.priceErrors.length > 0) {
    const items = wf.priceErrors.map(e =>
      `<li><span class="tag ${e.role === "Seller" ? "seller-tag" : "buyer-tag"}">${e.player}</span>
       ${e.role} ${e.type}: <strong>${f4(e.price)}</strong> THB/kWh ∉ [${FIT_PRICE}, ${RETAIL_PRICE}]</li>`
    ).join("");
    priceErrHtml = `
      <div class="wf-alert alert-price-err">
        <div class="wf-alert-title">⛔ Price Out of Range — Trading Blocked</div>
        <ul class="price-err-list">${items}</ul>
      </div>`;
  }

  el.innerHTML = `<div id="energy-range-banner"></div>${alertHtml}${priceErrHtml}${buildInputSection()}`;
  renderEnergyRangeBanner();
  requestAnimationFrame(attachPasteHandlers);
}

function buildInputSection() {
  const isGrid = wf.step === "grid";
  const isRetry = wf.step === "retry";
  const btnLabel = isRetry ? "🔄 Re-run (Round 2 — Final Chance)" : "▶ Run Analysis (pandapower)";
  const actionBar = isGrid
    ? `<button class="btn btn-secondary" onclick="onResetDefaults()">↩ Reset &amp; Start Over</button>`
    : `<button class="btn btn-primary" onclick="onRunAnalysis()">${btnLabel}</button>
       <button class="btn btn-secondary" onclick="onResetDefaults()">↩ Reset Defaults</button>
       <button class="btn btn-secondary" onclick="randomizeEnergies()">🎲 สุ่มพลังงาน</button>
       ${isRetry ? `<span class="retry-round-indicator">Round ${wf.round} / 2</span>` : ""}`;

  const maxKwh = wf.energyRange ? wf.energyRange.max_kwh_per_seller : 9999;
  const failed = wf.retryPlayers;

  // Build unified table rows — Sellers first, then Buyers
  const sellerRows = SELLERS.map(s => {
    const hi = failed.has(s);
    const okP = state.offeringPrice[s] >= FIT_PRICE && state.offeringPrice[s] <= RETAIL_PRICE;
    const nw = state.sellerKwh[s] > maxKwh;
    return `<tr class="${hi ? 'row-retry' : ''}">
      <td><span class="tag seller-tag">${s}${hi ? ' ⚠️' : ''}</span></td>
      <td class="bus-cell">${PLAYER_LOCATIONS[s]}</td>
      <td class="role-cell seller-role">Seller</td>
      <td>
        <input type="number" id="offer-${s}" class="tbl-input ${okP ? '' : 'input-error'}"
          step="0.0001" min="${FIT_PRICE}" max="${RETAIL_PRICE}"
          value="${state.offeringPrice[s]}" oninput="onPriceInput(this)">
        <span class="validity-dot ${okP ? 'dot-ok' : 'dot-err'}">${okP ? '✓' : '✗'}</span>
      </td>
      <td>
        <input type="number" id="senergy-${s}" class="tbl-input ${nw ? 'input-warn' : ''}"
          step="0.01" min="0.01" value="${state.sellerKwh[s]}" oninput="onEnergyInput(this)">
        ${nw ? `<span class="nrg-warn" title="Exceeds recommended max">⚠️</span>` : ''}
      </td>
    </tr>`;
  }).join('');

  const buyerRows = BUYERS.map(b => {
    const hi = failed.has(b);
    const okP = state.biddingPrice[b] >= FIT_PRICE && state.biddingPrice[b] <= RETAIL_PRICE;
    return `<tr class="${hi ? 'row-retry' : ''}">
      <td><span class="tag buyer-tag">${b}${hi ? ' ⚠️' : ''}</span></td>
      <td class="bus-cell">${PLAYER_LOCATIONS[b]}</td>
      <td class="role-cell buyer-role">Buyer</td>
      <td>
        <input type="number" id="bid-${b}" class="tbl-input ${okP ? '' : 'input-error'}"
          step="0.0001" min="${FIT_PRICE}" max="${RETAIL_PRICE}"
          value="${state.biddingPrice[b]}" oninput="onPriceInput(this)">
        <span class="validity-dot ${okP ? 'dot-ok' : 'dot-err'}">${okP ? '✓' : '✗'}</span>
      </td>
      <td>
        <input type="number" id="benergy-${b}" class="tbl-input"
          step="0.01" min="0.01" value="${state.buyerKwh[b]}" oninput="onEnergyInput(this)">
      </td>
    </tr>`;
  }).join('');

  // Read-only rows for the No-PV Baseline block (peak load = ACTUAL_LOAD_DATA)
  const baselineRows = [...SELLERS, ...BUYERS].map(p => {
    const isSeller = SELLERS.includes(p);
    return `<tr>
      <td><span class="tag ${isSeller ? 'seller-tag' : 'buyer-tag'}">${p}</span></td>
      <td class="bus-cell">${PLAYER_LOCATIONS[p]}</td>
      <td class="role-cell ${isSeller ? 'seller-role' : 'buyer-role'}">${isSeller ? 'Seller' : 'Buyer'}</td>
      <td class="bus-cell">${(PEAK_LOAD_KW[p] ?? 0).toFixed(3)}</td>
    </tr>`;
  }).join('');

  const sumSellerKwh = SELLERS.reduce((a, s) => a + (parseFloat(state.sellerKwh[s]) || 0), 0);
  const sumBuyerKwh = BUYERS.reduce((a, b) => a + (parseFloat(state.buyerKwh[b]) || 0), 0);
  const sumSellerPeak = SELLERS.reduce((a, s) => a + (PEAK_LOAD_KW[s] || 0), 0);
  const sumBuyerPeak = BUYERS.reduce((a, b) => a + (PEAK_LOAD_KW[b] || 0), 0);

  return `
    <div class="input-section">
      <div class="section-header">
        <h3>📝 Market Input Data</h3>
        <div class="price-range-pill">Price: ${FIT_PRICE} – ${RETAIL_PRICE} THB/kWh</div>
      </div>

      <!-- Bulk paste from Excel -->
      <div class="bulk-paste-box" id="bulk-paste-box">
        <div class="bulk-paste-header" onclick="toggleBulkPaste()">
          <span>📋 Paste from Excel (วางข้อมูลทั้งตารางจาก Excel ทีเดียว)</span>
          <span class="bulk-paste-chevron" id="bulk-paste-chevron">▼</span>
        </div>
        <div class="bulk-paste-body" id="bulk-paste-body" style="display:none">
          <p class="bulk-paste-help">
            Copy ข้อมูลแล้ว Paste ลงในช่องด้านล่าง — รองรับ 2 รูปแบบ:<br>
            <strong>① Python output:</strong> <code>Seller C : Price = 2.5 THB/kWh | Energy = 73.9 kWh</code><br>
            <strong>② Excel TSV:</strong> <code>Player ⇥ Bus ⇥ Role ⇥ Price ⇥ Energy</code> หรือ <code>Price ⇥ Energy</code>
          </p>
          <textarea id="bulk-paste-textarea" class="bulk-paste-textarea"
            placeholder="วาง Python output หรือ Excel data ที่นี่ เช่น:&#10;&#10;Seller C : Price = 3.8364 THB/kWh  |  Energy =   26.0 kWh&#10;Seller D : Price = 3.2683 THB/kWh  |  Energy =   22.0 kWh&#10;...&#10;Buyer  A : Price = 4.7114 THB/kWh  |  Energy =   40.0 kWh&#10;&#10;หรือ Excel:&#10;C&#9;Bus14&#9;Seller&#9;3.8364&#9;26"></textarea>
          <div class="bulk-paste-actions">
            <button class="btn btn-primary btn-sm" onclick="applyBulkPaste()">✅ Apply Data</button>
            <button class="btn btn-secondary btn-sm" onclick="clearBulkPaste()">🗑 Clear</button>
            <span class="bulk-paste-status" id="bulk-paste-status"></span>
          </div>
        </div>
      </div>

      <!-- ===== Block 1: No-PV Baseline (read-only peak load) ===== -->
      <div class="case-block-title" style="margin:6px 0 8px;font-weight:700">
        🔵 No-PV Baseline — Peak Load (ACTUAL_LOAD_DATA)
      </div>
      <p class="bulk-paste-help" style="margin:0 0 8px">
        โหลดคงที่จากค่าที่วัดจริง ใช้รัน power flow กรณีอ้างอิง (ไม่มี PV ของผู้ขาย) — ค่าเหล่านี้แก้ไขไม่ได้
      </p>
      <div class="table-scroll" style="margin-bottom:18px">
        <table class="input-unified-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Bus</th>
              <th>Role</th>
              <th>Peak Load (kW)</th>
            </tr>
          </thead>
          <tbody>
            ${baselineRows}
            <tr class="input-total-row" style="border-top:2px solid var(--border, #334155)">
              <td colspan="3" style="text-align:right;font-weight:700">Σ Peak Load (No-PV Baseline)</td>
              <td style="font-weight:700">${(sumSellerPeak + sumBuyerPeak).toFixed(3)} kW</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ===== Block 2: POST_MATCH (with P2P injection) — editable input ===== -->
      <div class="case-block-title" style="margin:6px 0 8px;font-weight:700">
        🟠 POST_MATCH (with P2P injection) — กรอก Price &amp; Energy เอง
      </div>
      <p class="bulk-paste-help" style="margin:0 0 8px">
        ผู้ขายฉีด Σ Seller energy เป็น generation, ผู้ซื้อดึง Σ Buyer energy เป็นโหลด → ใช้ตัดสิน
        <strong>inject vs load</strong> (Σ inject &gt; Σ load ⇒ คาดว่าเกิด reverse power flow)
      </p>
      <div class="table-scroll" style="margin-bottom:16px">
        <table class="input-unified-table" id="input-unified-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Bus</th>
              <th>Role</th>
              <th>Price (THB/kWh) [${FIT_PRICE}–${RETAIL_PRICE}]</th>
              <th>Energy (kWh)</th>
            </tr>
          </thead>
          <tbody>
            ${sellerRows}
            <tr class="input-total-row">
              <td colspan="4" style="text-align:right;font-weight:600">Σ Seller energy (injection)</td>
              <td id="seller-energy-total" style="font-weight:600">${sumSellerKwh.toFixed(2)} kWh</td>
            </tr>
            <tr class="input-section-divider"><td colspan="5"></td></tr>
            ${buyerRows}
            <tr class="input-total-row">
              <td colspan="4" style="text-align:right;font-weight:600">Σ Buyer energy (demand / load)</td>
              <td id="buyer-energy-total" style="font-weight:600">${sumBuyerKwh.toFixed(2)} kWh</td>
            </tr>
            <tr class="input-total-row" style="border-top:2px solid var(--border, #334155)">
              <td colspan="4" style="text-align:right;font-weight:700">Σ รวมทั้งหมด (input)</td>
              <td id="all-energy-total" style="font-weight:700">${(sumSellerKwh + sumBuyerKwh).toFixed(2)} kWh</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="action-bar">${actionBar}</div>
    </div>`;
}

// Excel paste handler — attached per-input after rendering
function attachPasteHandlers() {
  // Full player list: sellers (price=offer, energy=senergy) then buyers (price=bid, energy=benergy)
  const allPlayers = [
    ...SELLERS.map(s => ({ priceId: `offer-${s}`, energyId: `senergy-${s}` })),
    ...BUYERS.map(b => ({ priceId: `bid-${b}`, energyId: `benergy-${b}` })),
  ];

  allPlayers.forEach(({ priceId, energyId }, startIdx) => {
    // Attach to PRICE input
    const pEl = document.getElementById(priceId);
    if (pEl) pEl.addEventListener('paste', buildPasteHandler(allPlayers, startIdx, 0));
    // Attach to ENERGY input
    const eEl = document.getElementById(energyId);
    if (eEl) eEl.addEventListener('paste', buildPasteHandler(allPlayers, startIdx, 1));
  });
}

function buildPasteHandler(allPlayers, startIdx, startCol) {
  return function (e) {
    const raw = (e.clipboardData || window.clipboardData).getData('text');
    // Only intercept if there are tabs or newlines (multi-cell paste from Excel/Sheets)
    if (!raw.includes('\t') && !raw.includes('\n')) return;
    e.preventDefault();

    // Parse TSV block (tab-separated columns, newline-separated rows)
    const rows = raw.trim().split(/\r?\n/).map(r => r.split('\t'));

    rows.forEach((cols, ri) => {
      const pi = startIdx + ri;
      if (pi >= allPlayers.length) return;
      const { priceId, energyId } = allPlayers[pi];

      cols.forEach((rawVal, ci) => {
        const colOffset = startCol + ci;
        // Strip thousands separators (commas) and parse
        const val = parseFloat(rawVal.trim().replace(/,/g, ''));
        if (isNaN(val)) return;

        if (colOffset === 0) {
          const inp = document.getElementById(priceId);
          if (inp) { inp.value = val; onPriceInput(inp); }
        } else if (colOffset === 1) {
          const inp = document.getElementById(energyId);
          if (inp) { inp.value = val; onEnergyInput(inp); }
        }
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Bulk Paste from Excel — toggle / apply / clear
// ---------------------------------------------------------------------------

function toggleBulkPaste() {
  const body = document.getElementById('bulk-paste-body');
  const chevron = document.getElementById('bulk-paste-chevron');
  if (!body) return;
  const show = body.style.display === 'none';
  body.style.display = show ? 'block' : 'none';
  if (chevron) chevron.textContent = show ? '▲' : '▼';
  // Auto-focus textarea when opening
  if (show) {
    const ta = document.getElementById('bulk-paste-textarea');
    if (ta) ta.focus();
  }
}

function clearBulkPaste() {
  const ta = document.getElementById('bulk-paste-textarea');
  if (ta) ta.value = '';
  const st = document.getElementById('bulk-paste-status');
  if (st) { st.textContent = ''; st.className = 'bulk-paste-status'; }
}

function applyBulkPaste() {
  const ta = document.getElementById('bulk-paste-textarea');
  const st = document.getElementById('bulk-paste-status');
  if (!ta) return;

  const raw = ta.value.trim();
  if (!raw) {
    if (st) { st.textContent = '⚠ ไม่มีข้อมูล'; st.className = 'bulk-paste-status status-err'; }
    return;
  }

  // All known player names
  const allPlayerNames = new Set([...SELLERS, ...BUYERS]);
  let applied = 0;

  // =========================================================================
  // FORMAT 1: Python output text
  //   "Seller C : Price = 2.5242 THB/kWh  |  Energy =   73.9 kWh"
  //   "Buyer  A : Price = 2.2270 THB/kWh  |  Energy =   24.7 kWh"
  // =========================================================================
  const pythonLineRe = /(?:Seller|Buyer)\s+([A-Z])\s*:\s*Price\s*=\s*([\d.]+)\s*THB\/kWh\s*\|\s*Energy\s*=\s*([\d.]+)\s*kWh/gi;
  const pythonMatches = [...raw.matchAll(pythonLineRe)];

  if (pythonMatches.length > 0) {
    for (const m of pythonMatches) {
      const player = m[1].toUpperCase();
      const price = parseFloat(m[2]);
      const energy = parseFloat(m[3]);
      if (!allPlayerNames.has(player)) continue;

      const isSeller = SELLERS.includes(player);

      // Apply price
      if (!isNaN(price)) {
        const priceId = isSeller ? `offer-${player}` : `bid-${player}`;
        const inp = document.getElementById(priceId);
        if (inp) { inp.value = price; onPriceInput(inp); }
      }
      // Apply energy
      if (!isNaN(energy)) {
        const energyId = isSeller ? `senergy-${player}` : `benergy-${player}`;
        const inp = document.getElementById(energyId);
        if (inp) { inp.value = energy; onEnergyInput(inp); }
      }
      applied++;
    }

    _bulkPasteFinish(st, applied);
    return;
  }

  // =========================================================================
  // FORMAT 2 & 3: TSV (tab-separated) — with or without header
  // =========================================================================
  const rows = raw.split(/\r?\n/).map(r => r.split('\t').map(c => c.trim()));
  if (rows.length === 0) return;

  const playerOrder = [...SELLERS, ...BUYERS];

  // Detect header row
  const firstRowLower = rows[0].map(c => c.toLowerCase());
  const headerKeywords = ['player', 'bus', 'role', 'price', 'energy', 'kwh', 'thb'];
  const hasHeader = headerKeywords.some(kw => firstRowLower.some(c => c.includes(kw)));

  let priceColIdx = -1, energyColIdx = -1, playerColIdx = -1;
  let dataRows = rows;

  if (hasHeader) {
    for (let i = 0; i < firstRowLower.length; i++) {
      const h = firstRowLower[i];
      if (h.includes('player') || h === 'name') playerColIdx = i;
      else if ((h.includes('price') || h.includes('thb')) && priceColIdx < 0) priceColIdx = i;
      else if ((h.includes('energy') || h.includes('kwh')) && energyColIdx < 0) energyColIdx = i;
    }
    dataRows = rows.slice(1);
  }

  // Auto-detect player column
  if (playerColIdx < 0) {
    for (let ci = 0; ci < (dataRows[0]?.length || 0); ci++) {
      const matches = dataRows.filter(r => r[ci] && allPlayerNames.has(r[ci].toUpperCase()));
      if (matches.length >= 3) { playerColIdx = ci; break; }
    }
  }

  // Auto-detect numeric columns
  if (priceColIdx < 0 || energyColIdx < 0) {
    const numericCols = [];
    for (let ci = 0; ci < (dataRows[0]?.length || 0); ci++) {
      if (ci === playerColIdx) continue;
      const numCount = dataRows.filter(r => r[ci] && !isNaN(parseFloat(r[ci].replace(/,/g, '')))).length;
      if (numCount >= Math.min(3, dataRows.length)) numericCols.push(ci);
    }
    if (numericCols.length >= 2) {
      if (priceColIdx < 0) priceColIdx = numericCols[numericCols.length - 2];
      if (energyColIdx < 0) energyColIdx = numericCols[numericCols.length - 1];
    } else if (numericCols.length === 1) {
      if (priceColIdx < 0) priceColIdx = numericCols[0];
    }
  }

  if (priceColIdx < 0 && energyColIdx < 0) {
    if (st) { st.textContent = '❌ ไม่พบคอลัมน์ตัวเลข (Price / Energy)'; st.className = 'bulk-paste-status status-err'; }
    return;
  }

  dataRows.forEach((cols, ri) => {
    let player = null;
    if (playerColIdx >= 0 && cols[playerColIdx]) {
      const candidate = cols[playerColIdx].toUpperCase().trim();
      if (allPlayerNames.has(candidate)) player = candidate;
    }
    if (!player && ri < playerOrder.length) player = playerOrder[ri];
    if (!player) return;

    const isSeller = SELLERS.includes(player);
    const isBuyer = BUYERS.includes(player);
    if (!isSeller && !isBuyer) return;

    if (priceColIdx >= 0 && cols[priceColIdx]) {
      const val = parseFloat(cols[priceColIdx].replace(/,/g, ''));
      if (!isNaN(val)) {
        const inp = document.getElementById(isSeller ? `offer-${player}` : `bid-${player}`);
        if (inp) { inp.value = val; onPriceInput(inp); }
      }
    }
    if (energyColIdx >= 0 && cols[energyColIdx]) {
      const val = parseFloat(cols[energyColIdx].replace(/,/g, ''));
      if (!isNaN(val)) {
        const inp = document.getElementById(isSeller ? `senergy-${player}` : `benergy-${player}`);
        if (inp) { inp.value = val; onEnergyInput(inp); }
      }
    }
    applied++;
  });

  _bulkPasteFinish(st, applied);
}

function _bulkPasteFinish(st, applied) {
  if (st) {
    if (applied > 0) {
      st.textContent = `✅ Applied ${applied} row(s) successfully`;
      st.className = 'bulk-paste-status status-ok';
      const tbl = document.getElementById('input-unified-table');
      if (tbl) {
        tbl.classList.add('flash-success');
        setTimeout(() => tbl.classList.remove('flash-success'), 800);
      }
    } else {
      st.textContent = '⚠ ไม่พบข้อมูลที่ตรงกับผู้เล่น (C,D,E,F,I,A,B,G,H,J)';
      st.className = 'bulk-paste-status status-err';
    }
  }
  render();
}


function renderGridFallbackTable() {
  const rows = BUYERS.map(b => {
    const cost = state.buyerKwh[b] * RETAIL_PRICE;
    return `<tr><td><span class="tag buyer-tag">${b}</span></td><td>${PLAYER_LOCATIONS[b]}</td>
      <td>${f2(state.buyerKwh[b])} kWh</td><td>${RETAIL_PRICE} THB/kWh</td>
      <td><strong>${f2(cost)} THB</strong></td></tr>`;
  }).join("");
  const tot = BUYERS.reduce((a, b) => a + state.buyerKwh[b] * RETAIL_PRICE, 0);
  return `<p style="margin-bottom:10px">Buyers purchase from grid at retail price <strong>${RETAIL_PRICE} THB/kWh</strong>.</p>
    <table class="data-table"><thead><tr><th>Buyer</th><th>Bus</th><th>Demand</th><th>Price</th><th>Cost</th></tr></thead>
    <tbody>${rows}<tr class="total-row"><td colspan="4"><strong>TOTAL</strong></td><td><strong>${f2(tot)} THB</strong></td></tr></tbody>
    </table>`;
}

function onPriceInput(el) {
  const val = parseFloat(el.value);
  if (isNaN(val)) return;
  const ok = val >= FIT_PRICE && val <= RETAIL_PRICE;
  el.classList.toggle("input-error", !ok);
  const dot = el.nextElementSibling;
  if (dot && dot.classList.contains("validity-dot")) {
    dot.textContent = ok ? "✓" : "✗";
    dot.className = `validity-dot ${ok ? "dot-ok" : "dot-err"}`;
  }
  if (el.id.startsWith("offer-")) state.offeringPrice[el.id.replace("offer-", "")] = val;
  else if (el.id.startsWith("bid-")) state.biddingPrice[el.id.replace("bid-", "")] = val;
}

function updateInputTotals() {
  const sS = SELLERS.reduce((a, s) => a + (parseFloat(state.sellerKwh[s]) || 0), 0);
  const sB = BUYERS.reduce((a, b) => a + (parseFloat(state.buyerKwh[b]) || 0), 0);
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set("seller-energy-total", sS.toFixed(2) + " kWh");
  set("buyer-energy-total", sB.toFixed(2) + " kWh");
  set("all-energy-total", (sS + sB).toFixed(2) + " kWh");
}

function onEnergyInput(el) {
  const val = parseFloat(el.value);
  if (isNaN(val)) return;
  if (el.id.startsWith("senergy-")) state.sellerKwh[el.id.replace("senergy-", "")] = val;
  else if (el.id.startsWith("benergy-")) state.buyerKwh[el.id.replace("benergy-", "")] = val;
  updateInputTotals();
}

// ── RENDER: DASHBOARD ─────────────────────────────────────────────────────────
function renderDashboard() {
  const el = document.getElementById("tab-dashboard");
  if (!el || wf.step !== "results") return;
  const { trades, logs, soldKwh, boughtKwh, pfBase, pfPost } = R;
  const totalTraded = logs.reduce((a, l) => a + l.qty, 0);
  const totalValue = logs.reduce((a, l) => a + l.tradeValue, 0);

  el.innerHTML = `
    <div class="dashboard-grid">
      <div class="kpi-card kpi-green"><div class="kpi-icon">✅</div>
        <div class="kpi-label">Market Status</div>
        <div class="kpi-value">P2P OK</div>
        <div class="kpi-sub">pandapower AC (3 cases)</div></div>
      <div class="kpi-card kpi-blue"><div class="kpi-icon">⚡</div>
        <div class="kpi-label">Energy Traded</div>
        <div class="kpi-value">${f2(totalTraded)} <span class="kpi-unit">kWh</span></div>
        <div class="kpi-sub">${logs.length} trade(s)</div></div>
      <div class="kpi-card kpi-purple"><div class="kpi-icon">💰</div>
        <div class="kpi-label">Trade Value</div>
        <div class="kpi-value">${f2(totalValue)} <span class="kpi-unit">THB</span></div>
        <div class="kpi-sub">Avg ${f4(totalTraded > 0 ? totalValue / totalTraded : 0)} THB/kWh</div></div>
      <div class="kpi-card kpi-orange"><div class="kpi-icon">🌞</div>
        <div class="kpi-label">DG Injection (POST)</div>
        <div class="kpi-value">${f6(pfPost?.metrics?.total_dg_mw || 0)} <span class="kpi-unit">MW</span></div>
        <div class="kpi-sub">No-PV Baseline: 0 MW</div></div>
      <div class="kpi-card kpi-teal"><div class="kpi-icon">📉</div>
        <div class="kpi-label">Total Loss (POST)</div>
        <div class="kpi-value">${fKw(pfPost?.metrics?.total_loss_mw || 0)} <span class="kpi-unit">kW</span></div>
        <div class="kpi-sub">No-PV Baseline: ${fKw(pfBase?.metrics?.total_loss_mw || 0)} kW</div></div>
      <div class="kpi-card kpi-indigo"><div class="kpi-icon">🔌</div>
        <div class="kpi-label">Min Voltage (POST)</div>
        <div class="kpi-value">${f6(pfPost?.metrics?.min_voltage_pu || 0)} <span class="kpi-unit">p.u.</span></div>
        <div class="kpi-sub">No-PV Baseline: ${f6(pfBase?.metrics?.min_voltage_pu || 0)} p.u.</div></div>
    </div>

    <div class="dash-section">
      <h3>👥 Player Summary</h3>
      <div class="player-grid">
        <div>
          <div class="player-group-title seller-title">🌞 Sellers</div>
          ${SELLERS.map(s => `<div class="player-card seller-card">
            <div class="player-name">${s}</div><div class="player-bus">${PLAYER_LOCATIONS[s]}</div>
            <div class="player-stats">
              <span>Offer: ${f4(state.offeringPrice[s])} THB/kWh</span>
              <span>Available: ${f2(state.sellerKwh[s])} kWh</span>
              <span class="traded-info">Sold: ${f2(soldKwh[s] || 0)} kWh</span>
            </div></div>`).join("")}
        </div>
        <div>
          <div class="player-group-title buyer-title">🛒 Buyers</div>
          ${BUYERS.map(b => `<div class="player-card buyer-card">
            <div class="player-name">${b}</div><div class="player-bus">${PLAYER_LOCATIONS[b]}</div>
            <div class="player-stats">
              <span>Bid: ${f4(state.biddingPrice[b])} THB/kWh</span>
              <span>Demand: ${f2(state.buyerKwh[b])} kWh</span>
              <span class="traded-info">Bought: ${f2(boughtKwh[b] || 0)} kWh</span>
            </div></div>`).join("")}
        </div>
      </div>
    </div>

    <div class="dash-section"><h3>⚡ Trade Log</h3>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Step</th><th>Seller</th><th>Buyer</th><th>kWh</th>
          <th>Offer</th><th>Bid</th><th>CP</th><th>Clearing (THB/kWh)</th><th>Value (THB)</th></tr></thead>
        <tbody>${logs.map(l => `<tr>
          <td>${l.step}</td>
          <td><span class="tag seller-tag">${l.seller}</span></td>
          <td><span class="tag buyer-tag">${l.buyer}</span></td>
          <td>${f2(l.qty)}</td><td>${f4(l.offer)}</td><td>${f4(l.bid)}</td>
          <td>${f4(l.cp)}</td><td><strong class="clear-price">${f4(l.clearPrice)}</strong></td>
          <td>${f4(l.tradeValue)}</td></tr>`).join("")}
        </tbody>
      </table></div>
    </div>`;
}

// ── RENDER: MATCHING ──────────────────────────────────────────────────────────
function matrixTable(title, sellers, buyers, getValue, fmtFn) {
  fmtFn = fmtFn || (v => f4(v));
  const ss = [...sellers].sort((a, b) => state.offeringPrice[a] - state.offeringPrice[b]);
  const bb = [...buyers].sort();
  let html = `<div class="matrix-wrap"><h3>${title}</h3><div class="table-scroll"><table class="matrix-table">
    <thead><tr><th>S\\B</th>${bb.map(b => `<th>${b}</th>`).join("")}</tr></thead><tbody>`;
  for (const s of ss) {
    html += `<tr><td class="row-header">${s}</td>`;
    for (const b of bb) {
      const val = getValue(s, b);
      const isBool = typeof val === "boolean";
      const cls = isBool ? (val ? "cell-pass" : "cell-fail") : "";
      html += `<td class="${cls}">${isBool ? (val ? "PASS" : "FAIL") : fmtFn(val)}</td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table></div></div>`;
}

function renderMatching() {
  const el = document.getElementById("tab-matching");
  if (!el || wf.step !== "results") return;
  const { trades, logs, qsRem, qbRem, cp, df, pathMatrix, feasibility, midPrice } = R;
  const totalTraded = logs.reduce((a, l) => a + l.qty, 0);

  el.innerHTML = `
    <div class="matching-section">
      <div class="matrix-grid">
        ${matrixTable("📐 Path Length (km)", SELLERS, BUYERS, (s, b) => pathMatrix?.[s]?.[b] ?? 0)}
        ${matrixTable("📊 Distance Factor (DF)", SELLERS, BUYERS, (s, b) => df?.[s]?.[b] ?? 0)}
        ${matrixTable("💲 Mid-Price (Bid+Offer)/2", SELLERS, BUYERS, (s, b) => midPrice?.[s]?.[b] ?? 0)}
        ${matrixTable("🎯 CP = DF × MidPrice", SELLERS, BUYERS, (s, b) => cp?.[s]?.[b] ?? 0)}
        ${matrixTable("✅ Feasibility (Bid≥Offer?)", SELLERS, BUYERS, (s, b) => feasibility?.[s]?.[b] ?? false)}
      </div>
      <div class="matching-steps">
        <h3>🔄 Matching Steps</h3>
        <p class="algo-note">Algorithm: Seller with lowest offering price → matched to buyer with lowest CP | CP = DF × (Bid + Offer) / 2</p>
        <div class="table-scroll"><table class="data-table">
          <thead><tr>
            <th>Step</th><th>Seller</th><th>Buyer</th><th>CP</th>
            <th>Offer (THB/kWh)</th><th>Bid (THB/kWh)</th>
            <th>S.Init (kWh)</th><th>B.Init (kWh)</th>
            <th>Traded (kWh)</th><th>S.Rem (kWh)</th><th>B.Rem (kWh)</th>
            <th>Value (THB)</th>
          </tr></thead>
          <tbody>${logs.map(l => `<tr>
            <td>${l.step}</td>
            <td><span class="tag seller-tag">${l.seller}</span></td>
            <td><span class="tag buyer-tag">${l.buyer}</span></td>
            <td>${f4(l.cp)}</td>
            <td>${f4(l.offer)}</td>
            <td>${f4(l.bid)}</td>
            <td class="num-col">${f4(l.sInit)}</td>
            <td class="num-col">${f4(l.bInit)}</td>
            <td class="num-col"><strong>${f4(l.qty)}</strong></td>
            <td class="num-col">${f4(l.sRem)}</td>
            <td class="num-col">${f4(l.bRem)}</td>
            <td>${f4(l.tradeValue)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </div>
      <div class="matching-steps">
        <h3>📦 Traded Energy Matrix (kWh)</h3>
        ${matrixTable("", SELLERS, BUYERS, (s, b) => {
    const v = trades[`${s}|${b}`] || 0; return v;
  }, v => v === 0 ? "—" : f2(v))}
      </div>
      ${renderEnergyFlowVisualization(trades, qsRem, qbRem)}
      <div class="matching-steps">
        <h3>📉 Remaining Energy</h3>
        <div class="remaining-grid">
          <div><h4 class="seller-title">Sellers (Unsold)</h4>
            ${SELLERS.map(s => {
    const rem = qsRem?.[s] || 0, avail = state.sellerKwh[s];
    const p = avail > 0 ? rem / avail * 100 : 0;
    return `<div class="energy-bar-row">
                <span class="player-lbl seller-lbl">${s}</span>
                <div class="energy-bar"><div class="energy-fill seller-fill" style="width:${p}%"></div></div>
                <span>${f2(rem)} kWh (${f2(p)}%)</span></div>`;
  }).join("")}
          </div>
          <div><h4 class="buyer-title">Buyers (Unmet)</h4>
            ${BUYERS.map(b => {
    const rem = qbRem?.[b] || 0, dem = state.buyerKwh[b];
    const p = dem > 0 ? rem / dem * 100 : 0;
    return `<div class="energy-bar-row">
                <span class="player-lbl buyer-lbl">${b}</span>
                <div class="energy-bar"><div class="energy-fill buyer-fill" style="width:${p}%"></div></div>
                <span>${f2(rem)} kWh (${f2(p)}%)</span></div>`;
  }).join("")}
          </div>
        </div>
        <div class="summary-stats">
          <div class="stat-item"><span>Total Traded</span><strong>${f2(totalTraded)} kWh</strong></div>
          <div class="stat-item"><span>Supply Util</span>
            <strong>${f2(SELLERS.reduce((a, s) => a + state.sellerKwh[s], 0) > 0 ? totalTraded / SELLERS.reduce((a, s) => a + state.sellerKwh[s], 0) * 100 : 0)}%</strong></div>
          <div class="stat-item"><span>Demand Sat</span>
            <strong>${f2(BUYERS.reduce((a, b) => a + state.buyerKwh[b], 0) > 0 ? totalTraded / BUYERS.reduce((a, b) => a + state.buyerKwh[b], 0) * 100 : 0)}%</strong></div>
        </div>
      </div>
    </div>`;
}

// ── RENDER: ENERGY FLOW VISUALIZATION ────────────────────────────────────────
function renderEnergyFlowVisualization(trades, qsRem, qbRem) {
  // Build list of active trade pairs
  const pairs = [];
  for (const s of SELLERS) {
    for (const b of BUYERS) {
      const qty = trades[`${s}|${b}`] || 0;
      if (qty > 0) pairs.push({ s, b, qty });
    }
  }
  if (pairs.length === 0) return "";

  // Per-pair SVG cards
  const pairCards = pairs.map(({ s, b, qty }) => `
    <div class="ef-pair-card">
      <div class="ef-node ef-prosumer">
        <div class="ef-icon">☀️🏠</div>
        <div class="ef-name">${s}</div>
        <div class="ef-bus">${PLAYER_LOCATIONS[s]}</div>
        <div class="ef-kwh">${f2(state.sellerKwh[s])} kWh avail</div>
      </div>
      <div class="ef-arrow-wrap">
        <svg class="ef-arrow-svg" viewBox="0 0 180 40" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrowhead-${s}-${b}" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#f97316"/>
            </marker>
          </defs>
          <line x1="8" y1="20" x2="162" y2="20" stroke="#f97316" stroke-width="2.5"
                stroke-dasharray="8,5" marker-end="url(#arrowhead-${s}-${b})" class="ef-flow-line"/>
          <text x="90" y="13" text-anchor="middle" fill="#fbbf24" font-size="11" font-family="Inter,sans-serif" font-weight="700">⚡ ${f2(qty)} kWh</text>
        </svg>
      </div>
      <div class="ef-node ef-consumer">
        <div class="ef-icon">🏠</div>
        <div class="ef-name">${b}</div>
        <div class="ef-bus">${PLAYER_LOCATIONS[b]}</div>
        <div class="ef-kwh">${f2(state.buyerKwh[b])} kWh demand</div>
      </div>
    </div>`).join("");

  // Overall summary SVG
  const totalSold = SELLERS.reduce((a, s) => a + (state.sellerKwh[s] - (qsRem?.[s] || 0)), 0);
  const totalBought = BUYERS.reduce((a, b) => a + (state.buyerKwh[b] - (qbRem?.[b] || 0)), 0);
  const totalResidual = SELLERS.reduce((a, s) => a + (qsRem?.[s] || 0), 0);

  // Build summary seller and buyer rows for the overview diagram
  const sellerRows = SELLERS.map((s, i) => {
    const sold = state.sellerKwh[s] - (qsRem?.[s] || 0);
    const rem = qsRem?.[s] || 0;
    return `<div class="ef-sum-seller"><span class="ef-sum-icon">☀️</span><strong>${s}</strong>
      <span class="ef-sum-bus">${PLAYER_LOCATIONS[s]}</span>
      <span class="ef-sum-sold">↗ ${f2(sold)} kWh sold</span>
      ${rem > 0.001 ? `<span class="ef-sum-rem">→ Pool: ${f2(rem)} kWh</span>` : ""}</div>`;
  }).join("");

  const buyerRows = BUYERS.map(b => {
    const bought = state.buyerKwh[b] - (qbRem?.[b] || 0);
    const unmet = qbRem?.[b] || 0;
    return `<div class="ef-sum-buyer"><span class="ef-sum-icon">🏠</span><strong>${b}</strong>
      <span class="ef-sum-bus">${PLAYER_LOCATIONS[b]}</span>
      <span class="ef-sum-bought">✅ ${f2(bought)} kWh received</span>
      ${unmet > 0.001 ? `<span class="ef-sum-unmet">⚠ ${f2(unmet)} kWh unmet</span>` : ""}</div>`;
  }).join("");

  return `
    <div class="matching-steps ef-section">
      <h3>⚡ Energy Flow Visualization</h3>
      <p class="algo-note">จำลองการถ่ายโอนพลังงานระหว่าง Prosumer (ผู้ผลิต + บริโภค) → Consumer (ผู้บริโภค) ผ่านโครงข่ายไฟฟ้า IEEE 33-bus</p>

      <div class="ef-pair-grid">${pairCards}</div>

      <!-- Overall Summary with Energy Pool -->
      <div class="ef-summary-wrap">
        <div class="ef-sum-title">🔁 ภาพรวมการส่ง-รับพลังงาน &amp; Energy Pool</div>
        <div class="ef-sum-layout">
          <!-- LEFT: Sellers -->
          <div class="ef-sum-col">
            <div class="ef-sum-col-title seller-title">🌞 Prosumers (Sellers)</div>
            ${sellerRows}
          </div>
          <!-- CENTER: Flow arrows -->
          <div class="ef-sum-center">
            <svg viewBox="0 0 60 240" xmlns="http://www.w3.org/2000/svg" class="ef-sum-arrows">
              <defs>
                <marker id="ah-buy" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                  <polygon points="0 0,7 2.5,0 5" fill="#3b82f6"/>
                </marker>
                <marker id="ah-pool" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                  <polygon points="0 0,7 2.5,0 5" fill="#a855f7"/>
                </marker>
              </defs>
              <line x1="4" y1="60" x2="56" y2="60" stroke="#3b82f6" stroke-width="2" stroke-dasharray="6,4" marker-end="url(#ah-buy)" class="ef-flow-line"/>
              <line x1="4" y1="100" x2="56" y2="100" stroke="#3b82f6" stroke-width="2" stroke-dasharray="6,4" marker-end="url(#ah-buy)" class="ef-flow-line"/>
              <line x1="4" y1="140" x2="56" y2="180" stroke="#a855f7" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#ah-pool)" class="ef-flow-line"/>
            </svg>
          </div>
          <!-- RIGHT: Buyers + Pool -->
          <div class="ef-sum-col">
            <div class="ef-sum-col-title buyer-title">🛒 Consumers (Buyers)</div>
            ${buyerRows}
            ${totalResidual > 0.001 ? `
            <div class="ef-pool-card">
              <div class="ef-pool-icon">🔌</div>
              <div class="ef-pool-name">ขายคืนกริด @ FIT</div>
              <div class="ef-pool-sub">(Residual → Grid export)</div>
              <div class="ef-pool-kwh">${f2(totalResidual)} kWh</div>
              <div class="ef-pool-note">≈ ${f2(totalResidual * FIT_PRICE)} THB @ ${FIT_PRICE} · inject เป็น sgen ใน POST_MATCH · provisional ปรับปรุงภายหลัง</div>
            </div>` : ""}
          </div>
        </div>
        <!-- Footer stats -->
        <div class="ef-sum-stats">
          <div class="ef-sum-stat"><span>Total Sent</span><strong class="pos">${f2(totalSold)} kWh</strong></div>
          <div class="ef-sum-stat"><span>Total Received</span><strong class="pos">${f2(totalBought)} kWh</strong></div>
          <div class="ef-sum-stat"><span>Residual → Grid @ FIT</span><strong style="color:var(--purple)">${f2(totalResidual)} kWh</strong></div>
          <div class="ef-sum-stat"><span>Trade Pairs</span><strong>${pairs.length}</strong></div>
        </div>
      </div>
    </div>`;
}

// ── RENDER: POWER FLOW (pandapower results) ────────────────────────────────────
function renderPfStatusCard(pfBase, pfPre, pfPost) {
  const checkCase = (pf, label) => {
    if (!pf || !pf.converged) return { pass: false, label, detail: pf?.error || "Did not converge" };
    const under = pf.violations?.under || [];
    const over = pf.violations?.over || [];
    const pass = under.length === 0 && over.length === 0;
    const detail = pass ? "All buses within [0.95, 1.05] p.u." :
      [...under.map(v => `Bus ${v.bus}: ${v.vm_pu.toFixed(4)} UNDER`),
      ...over.map(v => `Bus ${v.bus}: ${v.vm_pu.toFixed(4)} OVER`)].join(" | ");
    return { pass, label, detail };
  };
  const cases = [checkCase(pfBase, "BASE"), checkCase(pfPre, "PRE_MATCH"), checkCase(pfPost, "POST_MATCH")];
  const rows = cases.map(c => `
    <div class="pf-status-row">
      <span class="pf-status-label">${c.label === "BASE" ? "🔵" : c.label === "PRE_MATCH" ? "🟡" : "🟠"} ${caseLabel(c.label)}</span>
      <span class="pf-status-badge ${c.pass ? "badge-pass" : "badge-fail"}">${c.pass ? "✅ PASS" : "❌ FAIL"}</span>
      <span class="pf-status-detail">${c.detail}</span>
    </div>`).join("");
  return `<div class="pf-status-card">
    <div class="pf-status-title">🔍 Power Flow Validation (Voltage Limits: 0.95 – 1.05 p.u.)</div>
    ${rows}
  </div>`;
}

function renderHouseConsumptionTable() {
  const hc = wf.apiResult && wf.apiResult.house_consumption_kw;
  if (!hc) return "";
  const rows = Object.entries(hc).map(([p, kw]) => {
    const role = SELLERS.includes(p) ? "Seller" : "Buyer";
    const loc = PLAYER_LOCATIONS[p] || "";
    return `<tr><td>${p}</td><td>${role}</td><td>${loc}</td><td>${f4(kw)}</td></tr>`;
  }).join("");
  const total = Object.values(hc).reduce((a, v) => a + v, 0);
  return `
    <div class="pf-section" style="margin-top:20px">
      <h4 class="pf-sub-title">\u{1F3E0} \u0e1e\u0e25\u0e31\u0e07\u0e07\u0e32\u0e19\u0e1a\u0e23\u0e34\u0e42\u0e20\u0e04\u0e02\u0e2d\u0e07\u0e1a\u0e49\u0e32\u0e19 (ACTUAL_LOAD_DATA) — \u0e15\u0e32\u0e23\u0e32\u0e07\u0e2d\u0e49\u0e32\u0e07\u0e2d\u0e34\u0e07</h4>
      <p class="algo-note">POST_MATCH \u0e27\u0e34\u0e40\u0e04\u0e23\u0e32\u0e30\u0e2b\u0e4c\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e18\u0e38\u0e23\u0e01\u0e23\u0e23\u0e21 P2P \u0e44\u0e21\u0e48\u0e44\u0e14\u0e49\u0e23\u0e27\u0e21\u0e42\u0e2b\u0e25\u0e14\u0e1a\u0e49\u0e32\u0e19\u0e19\u0e35\u0e49 \u0e1c\u0e39\u0e49\u0e43\u0e0a\u0e49\u0e2b\u0e31\u0e01\u0e2d\u0e2d\u0e01\u0e40\u0e2d\u0e07\u0e44\u0e14\u0e49</p>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>House</th><th>Role</th><th>Bus</th><th>Consumption (kW)</th></tr></thead>
        <tbody>${rows}
          <tr style="font-weight:600"><td colspan="3">\u0e23\u0e27\u0e21</td><td>${f4(total)}</td></tr>
        </tbody>
      </table></div>
    </div>`;
}

function renderPowerFlow() {
  const el = document.getElementById("tab-powerflow");
  if (!el || wf.step !== "results") return;
  const { pfBase, pfPre, pfPost } = R;

  el.innerHTML = `
    <div class="pf-section">
      <h3>📊 System Metrics — No-PV Baseline &amp; POST_MATCH (with P2P injection) (pandapower AC Power Flow)</h3>
      <p class="algo-note">Newton-Raphson AC power flow via pandapower | IEEE 33-bus | 0.4 kV LV network with 22 kV/0.4 kV transformer</p>
      ${renderPfStatusCard(pfBase, pfPre, pfPost)}
      ${renderMetricsTable2(pfBase, pfPost)}
      ${renderHouseConsumptionTable()}
      <div class="pf-case-tabs" style="margin-top:24px">
        <div class="pf-tab-bar">
          <button class="pf-tab-btn ${wf.pfTab === "base" ? "active" : ""}"  onclick="setPfTab('base')">🔵 No-PV Baseline</button>
          <button class="pf-tab-btn ${wf.pfTab === "pre" ? "active" : ""}"  onclick="setPfTab('pre')">🟡 PRE_MATCH</button>
          <button class="pf-tab-btn ${wf.pfTab === "post" ? "active" : ""}"  onclick="setPfTab('post')">🟠 POST_MATCH (with P2P injection)</button>
          <button class="pf-tab-btn ${wf.pfTab === "comp" ? "active" : ""}"  onclick="setPfTab('comp')">📈 Comparison</button>
        </div>
        <div id="pf-case-content"></div>
      </div>
    </div>`;

  renderPfCaseContent();
}

function setPfTab(tab) {
  wf.pfTab = tab;
  document.querySelectorAll(".pf-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelector(`.pf-tab-btn[onclick="setPfTab('${tab}')"]`)?.classList.add("active");
  renderPfCaseContent();
}

function renderPfCaseContent() {
  const el = document.getElementById("pf-case-content");
  if (!el) return;
  const { pfBase, pfPre, pfPost } = R;
  switch (wf.pfTab) {
    case "base": el.innerHTML = renderCaseDetail(pfBase, caseLabel("BASE"), "base-accent"); break;
    case "pre": el.innerHTML = renderCaseDetail(pfPre, caseLabel("PRE_MATCH"), "post-accent"); break;
    case "post": el.innerHTML = renderCaseDetail(pfPost, caseLabel("POST_MATCH"), "post-accent"); break;
    case "comp": el.innerHTML = renderComparison2(pfBase, pfPost); break;
    default: el.innerHTML = renderCaseDetail(pfBase, caseLabel("BASE"), "base-accent"); break;
  }
  requestAnimationFrame(() => { drawVoltageChart2(pfBase, pfPost); drawLineLoadingChart(pfBase, pfPost); });
}

// Renders one PF case — matches Python display_bus_voltages / display_line_* / display_power_losses
function renderCaseDetail(pf, label, accentClass) {
  if (!pf || !pf.converged) {
    const err = pf?.error || "Power flow did not converge";
    return `<div class="pf-case-block ${accentClass}" style="margin-top:16px">
      <div class="wf-alert alert-grid"><div class="wf-alert-title">❌ ${label} — ${err}</div></div>
    </div>`;
  }
  const m = pf.metrics || {};
  const vstatus = s => {
    const cls = { OK: "ok", LOW: "low", HIGH: "high", Slack: "slack" }[s] || "ok";
    return `<span class="v-status ${cls}">${s}</span>`;
  };
  const lstatus = pct => {
    if (pct > 100) return `<span class="v-status low">OVERLOAD</span>`;
    if (pct > 80) return `<span class="v-status warn-s">WARN</span>`;
    if (pct > 0.01) return `<span class="v-status ok">OK</span>`;
    return `<span class="v-status slack">IDLE</span>`;
  };

  const trafoRows = (pf.trafoResults || []).map(t => `<tr>
    <td>${t.trafoIdx}</td><td>${t.hvBus}</td><td>${t.lvBus}</td>
    <td>${f6(t.loadingPct)}</td><td>${f6(t.plKw)}</td><td>${f6(t.qlKvar)}</td>
  </tr>`).join("");

  const loss_base = (m.total_load_mw || 0) + (m.total_sgen_mw || 0);
  const loss_pct = loss_base > 1e-12 ? ((m.total_loss_mw || 0) / loss_base * 100) : 0;

  return `
    <div class="pf-case-block ${accentClass}" style="margin-top:16px">
      <!-- System Power Balance (matches Python display_power_losses summary) -->
      <div class="pf-sys-summary">
        <div class="pf-sys-title">📋 ${label} — System Power Balance</div>
        <div class="pf-sys-grid">
          <div class="pf-sys-stat"><span>Min Voltage (LV)</span><strong>${f8(m.min_voltage_pu || 0)} p.u.</strong></div>
          <div class="pf-sys-stat"><span>Max Voltage (LV)</span><strong>${f8(m.max_voltage_pu || 0)} p.u.</strong></div>
          <div class="pf-sys-stat"><span>Total Load Demand</span><strong>${f6((m.total_load_mw || 0) * 1000)} kW</strong></div>
          <div class="pf-sys-stat"><span>Total DG (sgen)</span><strong>${f6((m.total_sgen_mw || 0) * 1000)} kW</strong></div>
          <div class="pf-sys-stat"><span>Grid Supply</span><strong>${f6((m.grid_supply_mw || 0) * 1000)} kW</strong></div>
          ${(m.total_sgen_mw || 0) > 1e-9 ? `<div class="pf-sys-stat" style="grid-column:1/-1"><span>Inject vs Load</span><strong style="color:${(m.total_sgen_mw || 0) > (m.total_load_mw || 0) ? "#ef4444" : "#16a34a"}">Σ inject ${f6((m.total_sgen_mw || 0) * 1000)} kW ${(m.total_sgen_mw || 0) > (m.total_load_mw || 0) ? ">" : "≤"} Σ load ${f6((m.total_load_mw || 0) * 1000)} kW → ${(m.total_sgen_mw || 0) > (m.total_load_mw || 0) ? "inject &gt; load (คาดว่าเกิด reverse to grid)" : "inject ≤ load (ไม่เกิด reverse)"}</strong></div>` : ""}
          <div class="pf-sys-stat"><span>Line Losses</span><strong>${f6((m.line_loss_mw || 0) * 1000)} kW</strong></div>
          <div class="pf-sys-stat"><span>Trafo Losses</span><strong>${f6((m.trafo_loss_mw || 0) * 1000)} kW</strong></div>
          <div class="pf-sys-stat"><span>Total Losses</span><strong>${f6((m.total_loss_mw || 0) * 1000)} kW (${f4(loss_pct)} %)</strong></div>
          <div class="pf-sys-stat"><span>Max Line Loading</span><strong style="${(m.max_line_loading_pct || 0) > 100 ? "color:#ef4444" : ""}">${f6(m.max_line_loading_pct || 0)} %${(m.max_line_loading_pct || 0) > 100 ? " ⚠️" : ""}</strong></div>
          <div class="pf-sys-stat"><span>Total DG Injection</span><strong>${f8(m.total_dg_mw || 0)} MW</strong></div>
          <div class="pf-sys-stat"><span>Total Buyer Load</span><strong>${f8(m.total_buyer_load_mw || 0)} MW</strong></div>
          <div class="pf-sys-stat"><span>Reactive Losses</span><strong>${f6((m.total_loss_mvar || 0) * 1000)} kVAR</strong></div>
          ${(m.total_dg_grid_mw || 0) > 1e-9 ? `<div class="pf-sys-stat"><span>DG: P2P / Grid-export</span><strong>${f6((m.total_dg_p2p_mw || 0) * 1000)} / ${f6((m.total_dg_grid_mw || 0) * 1000)} kW</strong></div>` : ""}
          <div class="pf-sys-stat"><span>Reverse to Grid</span><strong style="${m.is_reverse_to_grid ? "color:#ef4444" : ""}">${m.is_reverse_to_grid ? `ใช่ — export ${f6((m.grid_export_mw || 0) * 1000)} kW ⚠️` : "ไม่ (grid ยังจ่ายเข้า)"}</strong></div>
          <div class="pf-sys-stat"><span>Reverse-flow Lines</span><strong style="${(m.reverse_line_count || 0) > 0 ? "color:#f59e0b" : ""}">${m.reverse_line_count || 0} สาย</strong></div>
        </div>
        ${((m.reverse_line_count || 0) > 0 || m.is_reverse_to_grid) ? `
        <div class="pf-reverse-banner" style="margin-top:10px;padding:11px 13px;border-radius:8px;background:${m.is_reverse_to_grid ? "rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.35)" : "rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.35)"}">
          <strong style="color:${m.is_reverse_to_grid ? "#ef4444" : "#f59e0b"}">${m.is_reverse_to_grid ? "⚠️ Reverse Power Flow — ย้อนออกกริด" : "ℹ️ Local Reverse Flow — ย้อนภายในสาย"}</strong>

          <div style="margin-top:7px;font-size:.83rem;line-height:1.55;opacity:.92">
            <div><strong>Reverse to grid</strong> คือกรณีที่กำลังไฟไหลย้อนจากโครงข่ายขึ้นไปที่กริดหลัก (grid supply ติดลบ) เกิดเมื่อกำลัง inject รวม (P2P + ส่วนขายคืนกริด) มากกว่าโหลดทั้งระบบ ไฟส่วนเกินจึงไหลผ่านหม้อแปลงขึ้นกริด</div>
            <div style="margin-top:3px"><strong>Reverse flow line</strong> คือสายที่กระแสไหลสวนทิศปกติ (จากปลายสายกลับมาทางต้นทาง) เกิดได้แม้ยังไม่ย้อนออกกริด เมื่อ seller ฉีดกำลังเกินโหลดในละแวกนั้น ไฟเลยไหลย้อนไปเลี้ยงโหลดที่อยู่ทางต้นสาย</div>
          </div>

          ${m.is_reverse_to_grid ? `
          <div style="margin-top:8px;font-size:.86rem;line-height:1.5">
            ▸ <strong>ย้อนออกกริดที่:</strong> Bus ${m.grid_bus ?? 0} (กริดหลัก/slack) ผ่านหม้อแปลง ↑ จาก Bus ${m.pcc_bus ?? 1} (จุดเชื่อมต่อ PCC)<br>
            ▸ <strong>ปริมาณย้อนออก:</strong> ${f6((m.grid_export_mw || 0) * 1000)} kW
            &nbsp;(No-PV Baseline กริดจ่ายเข้า ${f6((R?.pfBase?.metrics?.grid_supply_mw || 0) * 1000)} kW → POST ${f6((m.grid_supply_mw || 0) * 1000)} kW)
          </div>` : `
          <div style="margin-top:8px;font-size:.86rem">
            กรณีนี้ <strong>ยังไม่ย้อนออกกริด</strong> (กริดยังจ่ายเข้า ${f6((m.grid_supply_mw || 0) * 1000)} kW) แต่มีไฟย้อนภายในสายด้านล่าง
          </div>`}

          ${(pf.reverseLines && pf.reverseLines.length) ? `
          <div style="margin-top:8px;font-size:.85rem">
            <strong>Reverse flow lines (${pf.reverseLines.length} สาย):</strong>
            <div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:6px">
              ${pf.reverseLines.map(l => {
    const bl = (R?.pfBase?.lineResults || []).find(x => x.from === l.from && x.to === l.to);
    const baseLoad = bl ? bl.loading : 0;
    const up = l.loading > baseLoad + 1e-6;
    const arrow = up ? "↑" : "↓";
    const col = up ? "rgba(239,68,68,.16)" : "rgba(245,158,11,.13)";
    return `<span style="padding:2px 8px;border-radius:5px;background:${col};font-size:.8rem" title="BASE ${f4(baseLoad)}% → POST ${f4(l.loading)}%">Bus ${l.from}→${l.to} · ${f4(l.pFromKw)} kW · load ${f4(baseLoad)}%→${f4(l.loading)}% ${arrow}</span>`;
  }).join("")}
            </div>
            <div style="margin-top:6px;opacity:.78;font-size:.78rem;line-height:1.5">
              หมายเหตุ: <strong>reverse flow = ทิศทางกลับด้าน</strong> (กำลังติดลบ = ไหลจากปลายสายกลับมาต้นสาย) ซึ่ง<strong>ไม่ใช่</strong>เรื่องเดียวกับ %loading เพิ่ม
              · ↑ = loading สูงกว่า BASE (กระแสย้อนใหญ่กว่ากระแสเดิม) · ↓ = กลับทิศแต่ loading <strong>ลดลง</strong> เพราะกระแสย้อนเล็กกว่ากระแสเดิม (เช่น Bus 3→4)
              ดังนั้นถ้าตรวจด้วยเกณฑ์ "%loading POST &gt; BASE" จะเห็นเฉพาะสายกลุ่ม ↑ เท่านั้น
            </div>
          </div>` : ""}

          <div style="margin-top:8px;font-size:.82rem;opacity:.85">
            <strong>ผลกระทบ:</strong> ${m.is_reverse_to_grid
        ? "แรงดันปลายสายอาจสูงขึ้น (เสี่ยง over-voltage) และ %line loading บางสายเพิ่ม การอ้างว่า P2P ช่วยลดภาระ feeder จะจริงเฉพาะช่วงที่ไม่ย้อนออกกริด ควรตรวจ thermal/voltage limit ประกอบ"
        : "เป็นการกระจายไฟภายใน (internal redistribution) ปกติ ภาพรวม loss/voltage ยังดีขึ้นได้ แต่ %line loading บางสายจะสูงกว่า BASE ไม่ใช่ทุกสายที่ลดลง"}
          </div>
        </div>` : ""}
      </div>

      <!-- 1. Bus Voltages (matches Python display_bus_voltages) -->
      <h4 class="pf-sub-title">1. Bus Voltages — Formula: V<sub>i,pu</sub> = V<sub>i,actual</sub> / V<sub>i,nominal</sub></h4>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Bus</th><th>V_nominal (kV)</th><th>V_actual (kV)</th>
          <th>V<sub>i,pu</sub></th><th>Angle (deg)</th><th>Status</th></tr></thead>
        <tbody>
          ${(pf.busVoltages || []).map(v => `
            <tr class="${v.status === "LOW" ? "row-warn" : v.status === "HIGH" ? "row-high" : ""}">
              <td>${v.bus === 0 ? "0 (HV Slack)" : v.bus}</td>
              <td>${f4(v.vnKv)}</td><td>${f6(v.vKv)}</td>
              <td>${f8(v.vm_pu)}</td><td>${f4(v.vaDeg)}</td>
              <td>${vstatus(v.status)}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>

      <!-- 2. Line Currents (matches Python display_line_currents) -->
      <h4 class="pf-sub-title" style="margin-top:20px">2. Line Currents — Formula: I = S<sub>3φ</sub>/(√3·V)</h4>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Line#</th><th>From</th><th>To</th>
          <th>I_from (kA)</th><th>I_to (kA)</th>
          <th>P_from (kW)</th><th>P_to (kW)</th>
          <th>Q_from (kVAR)</th><th>Q_to (kVAR)</th></tr></thead>
        <tbody>${(pf.lineResults || []).map(l => `<tr>
          <td>${l.lineIdx}</td><td>${l.from}</td><td>${l.to}</td>
          <td>${f8(l.iFromKa)}</td><td>${f8(l.iToKa)}</td>
          <td>${f4(l.pFromMw * 1000)}</td><td>${f4(l.pToMw * 1000)}</td>
          <td>${f4(l.qFromMvar * 1000)}</td><td>${f4(l.qToMvar * 1000)}</td>
        </tr>`).join("")}</tbody>
      </table></div>

      <!-- 3. Line Loading (matches Python display_line_loading) -->
      <h4 class="pf-sub-title" style="margin-top:20px">3. Line Loading — Loading% = (I_actual / I_max_thermal) × 100</h4>
      <div class="pf-note" style="margin:6px 0;font-size:.8rem;opacity:.82;line-height:1.5">
        หมายเหตุ: คอลัมน์ <strong>P_from (kW)</strong> คือกำลังจริงที่เข้าสายฝั่งต้นทาง (from-bus)
        · <strong style="color:#22c55e">ค่าเป็นบวก = ไหลปกติ</strong> (from → to ออกจากกริด)
        · <strong style="color:#ef4444">ค่าเป็นลบ = ไหลย้อน (reverse)</strong> (to → from กลับเข้าหากริด)
      </div>
      ${(m.max_line_loading_pct || 0) > 100 ? `
        <div class="wf-alert alert-grid" style="margin:8px 0">
          <div class="wf-alert-title">🔥 THERMAL LIMIT EXCEEDED — ระบบเกิด overload เกินขีดจำกัดความร้อนที่สายส่งรับได้</div>
          <div>Max Line Loading = ${f6(m.max_line_loading_pct)} % (เกิน 100%). กระแสในบางช่วงสายเกิน I_max_thermal สายส่งมีความเสี่ยง overheating การจับคู่/การฉีดกำลังในรอบนี้ไม่ผ่าน thermal constraint</div>
        </div>` : ""}
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Line#</th><th>From</th><th>To</th>
          <th>I_actual (kA)</th><th>I_max (kA)</th><th>P_from (kW)</th><th>Loading (%)</th><th>Status</th></tr></thead>
        <tbody>${(pf.lineResults || []).map(l => `<tr class="${l.loading > 100 ? "row-warn" : ""}">
          <td>${l.lineIdx}</td><td>${l.from}</td><td>${l.to}</td>
          <td>${f8(l.iFromKa)}</td><td>${f4(l.maxIKa)}</td>
          <td style="color:${l.reverse ? "#ef4444" : (l.pFromMw > 0 ? "#22c55e" : "")};white-space:nowrap">${f4(l.pFromMw * 1000)}${l.reverse ? " ⮌ ย้อน" : ""}</td>
          <td><div class="load-bar-wrap">
            <div class="load-bar" style="width:${Math.min(l.loading, 100) * 0.7}px;background:${l.loading > 80 ? "#ef4444" : "#22c55e"}"></div>
            <span>${f6(l.loading)}</span>
          </div></td>
          <td>${lstatus(l.loading)}</td>
        </tr>`).join("")}</tbody>
      </table></div>

      <!-- 4. Power Losses (matches Python display_power_losses) -->
      <h4 class="pf-sub-title" style="margin-top:20px">4. Power Losses — P<sub>loss</sub> = |I|² × R × L</h4>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Line#</th><th>From</th><th>To</th>
          <th>R (Ω/km)</th><th>Length (km)</th>
          <th>I (kA)</th><th>P_loss (kW)</th><th>Q_loss (kVAR)</th></tr></thead>
        <tbody>
          ${(pf.lineResults || []).filter(l => Math.abs(l.plMw) > 1e-12).map(l => `<tr>
            <td>${l.lineIdx}</td><td>${l.from}</td><td>${l.to}</td>
            <td>${f4(l.rOhmPerKm)}</td><td>${f4(l.L)}</td>
            <td>${f8(l.iFromKa)}</td>
            <td>${f6(l.plMw * 1000)}</td><td>${f6(l.qlMvar * 1000)}</td>
          </tr>`).join("")}
          <tr class="total-row"><td colspan="5"><strong>TOTAL LINES</strong></td>
            <td></td>
            <td><strong>${f6((m.line_loss_mw || 0) * 1000)}</strong></td>
            <td><strong>${f6((m.total_loss_mvar || 0) * 1000)}</strong></td>
          </tr>
        </tbody>
      </table></div>

      <!-- Transformer Losses -->
      ${(pf.trafoResults || []).length > 0 ? `
      <h4 class="pf-sub-title" style="margin-top:12px">Transformer Losses</h4>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Trafo#</th><th>HV Bus</th><th>LV Bus</th>
          <th>Loading (%)</th><th>P_loss (kW)</th><th>Q_loss (kVAR)</th></tr></thead>
        <tbody>${trafoRows}</tbody>
      </table></div>` : ""}

      <!-- Violations -->
      ${(() => {
      const u = pf.violations?.under || [], o = pf.violations?.over || [];
      if (u.length === 0 && o.length === 0)
        return `<div style="margin-top:12px;font-size:13px;color:var(--green)">✓ All LV buses within [0.95, 1.05] p.u.</div>`;
      return `<div style="margin-top:12px">
          ${u.map(v => `<span class="viol-bus">Bus ${v.bus}: ${f6(v.vm_pu)} p.u. UNDER (short ${f6(v.short || 0)})</span>`).join(" ")}
          ${o.map(v => `<span class="viol-bus">Bus ${v.bus}: ${f6(v.vm_pu)} p.u. OVER (excess ${f6(v.excess || 0)})</span>`).join(" ")}
        </div>`;
    })()}

      <!-- Voltage Chart -->
      <div class="pf-voltage-chart" style="margin-top:20px">
        <h4>📈 Bus Voltage Profile — All Cases</h4>
        <canvas id="voltageChart" width="900" height="260"></canvas>
      </div>
    </div>`;
}

// Metrics comparison table — BASE vs POST_MATCH only
function renderMetricsTable2(pfBase, pfPost) {
  const rows = [
    { label: "Min Voltage (p.u.)", key: "min_voltage_pu", fmt: f8 },
    { label: "Max Voltage (p.u.)", key: "max_voltage_pu", fmt: f8 },
    { label: "Total Loss (MW)", key: "total_loss_mw", fmt: f8 },
    { label: "Grid Supply (MW)", key: "grid_supply_mw", fmt: f8 },
    { label: "Max Line Loading (%)", key: "max_line_loading_pct", fmt: f8 },
    { label: "Total DG Injection (MW)", key: "total_dg_mw", fmt: f8 },
    { label: "Total Buyer Load (MW)", key: "total_buyer_load_mw", fmt: f8 },
    { label: "Loss Percent (%)", key: "loss_pct", fmt: f4 },
  ];
  const bm = pfBase?.metrics || {}, pom = pfPost?.metrics || {};
  const delta = (a, b) => {
    const d = b - a;
    const cls = Math.abs(d) < 1e-12 ? "" : d < 0 ? "pos" : "neg";
    return `<span class="${cls}">${d >= 0 ? "+" : ""}${f8(d)}</span>`;
  };
  return `
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Metric</th><th>🔵 No-PV Baseline</th><th>🟠 POST_MATCH (with P2P injection)</th>
        <th>Δ POST–Baseline</th></tr></thead>
      <tbody>${rows.map(r => {
    const b = bm[r.key] ?? 0, po = pom[r.key] ?? 0;
    return `<tr><td><strong>${r.label}</strong></td>
          <td>${r.fmt(b)}</td><td>${r.fmt(po)}</td>
          <td>${delta(b, po)}</td></tr>`;
  }).join("")}</tbody>
    </table></div>`;
}

// Keep old function name alias for backward compatibility
function renderMetricsTable(pfBase, pfPre, pfPost) { return renderMetricsTable2(pfBase, pfPost); }

// Comparison view — BASE vs POST_MATCH only  (charts FIRST, then tables)
function renderComparison2(pfBase, pfPost) {
  const byBus = arr => Object.fromEntries((arr || []).map(v => [v.bus, v]));
  const bm = byBus(pfBase?.busVoltages), pom = byBus(pfPost?.busVoltages);
  const busRows = (pfBase?.busVoltages || []).map(v => {
    const post = pom[v.bus] || v;
    const d1 = post.vm_pu - v.vm_pu;
    return `<tr class="${Math.abs(d1) > 1e-8 ? "row-high" : ""}">
      <td>${v.bus === 0 ? "0 (Slack)" : v.bus}</td>
      <td>${f8(v.vm_pu)}</td><td>${f8(post.vm_pu)}</td>
      <td class="${d1 >= 0 ? "pos" : "neg"}">${d1 >= 0 ? "+" : ""}${f8(d1)}</td>
    </tr>`;
  }).join("");

  const byLine = arr => Object.fromEntries((arr || []).map(l => [`${l.from}-${l.to}`, l]));
  const bL = byLine(pfBase?.lineResults), poL = byLine(pfPost?.lineResults);
  const lineRows = (pfBase?.lineResults || []).map(l => {
    const key = `${l.from}-${l.to}`, post = poL[key] || l;
    const d1 = post.loading - l.loading;
    return `<tr class="${post.loading > 100 ? "row-warn" : ""}">
      <td>${l.lineIdx}</td><td>${l.from}</td><td>${l.to}</td>
      <td>${f6(l.loading)}</td><td>${f6(post.loading)}</td>
      <td class="${d1 <= 0 ? "pos" : "neg"}">${d1 >= 0 ? "+" : ""}${f6(d1)}</td>
    </tr>`;
  }).join("");

  return `<div style="margin-top:16px">
    <!-- CHARTS FIRST -->
    <div class="pf-voltage-chart">
      <h4>📈 Bus Voltage Profile — BASE vs POST_MATCH</h4>
      <canvas id="voltageChart" width="900" height="260"></canvas>
    </div>
    <div class="pf-voltage-chart" style="margin-top:20px">
      <h4>📊 Line Loading (%) — BASE vs POST_MATCH</h4>
      <canvas id="lineLoadingChart" width="900" style="display:block;width:100%"></canvas>
    </div>
    <!-- DETAIL TABLES BELOW -->
    <h4 class="pf-sub-title" style="margin-top:28px">📈 Bus Voltage Comparison (BASE vs POST_MATCH)</h4>
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Bus</th><th>BASE (p.u.)</th><th>POST (p.u.)</th>
        <th>Δ POST–BASE</th></tr></thead>
      <tbody>${busRows}</tbody>
    </table></div>
    <h4 class="pf-sub-title" style="margin-top:20px">📊 Line Loading Comparison (%)</h4>
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Line#</th><th>From</th><th>To</th>
        <th>BASE (%)</th><th>POST (%)</th>
        <th>Δ POST–BASE</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table></div>
  </div>`;
}
// keep old alias
function renderComparison(pfBase, pfPre, pfPost) { return renderComparison2(pfBase, pfPost); }

// Voltage chart — BASE vs POST_MATCH
function drawVoltageChart2(pfBase, pfPost) {
  const canvas = document.getElementById("voltageChart");
  if (!canvas) return;
  const W = canvas.offsetWidth || 900; canvas.width = W; canvas.height = 260;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, 260);

  const lv = (pf) => (pf?.busVoltages || []).filter(v => v.bus !== 0).map(v => v.vm_pu);
  const vBase = lv(pfBase), vPost = lv(pfPost);
  const n = vBase.length; if (n === 0) return;
  const allV = [...vBase, ...vPost];
  const minV = Math.min(...allV, 0.92), maxV = Math.max(...allV, 1.06);
  const pL = 56, pR = 20, pT = 26, pB = 36, gW = W - pL - pR, gH = 260 - pT - pB;
  const toX = i => pL + (i / (n - 1 || 1)) * gW;
  const toY = v => pT + gH - ((v - minV) / (maxV - minV || 0.01)) * gH;

  for (let i = 0; i <= 5; i++) {
    const y = pT + (i / 5) * gH;
    ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
    const val = maxV - (i / 5) * (maxV - minV);
    ctx.fillStyle = "rgba(255,255,255,.4)"; ctx.font = "10px Inter";
    ctx.fillText(val.toFixed(4), 2, y + 4);
  }
  [[0.95, "#ef4444", "V_MIN=0.95"], [1.05, "#a855f7", "V_MAX=1.05"]].forEach(([v, c, lb]) => {
    const y = toY(v);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = c; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = c; ctx.font = "10px Inter";
    ctx.fillText(lb, pL + 2, y - 3);
  });

  [[vBase, "#3b82f6", "BASE"], [vPost, "#f97316", "POST_MATCH"]].forEach(([data, color]) => {
    if (!data.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath();
    data.forEach((v, i) => i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)));
    ctx.stroke();
    data.forEach((v, i) => { ctx.beginPath(); ctx.arc(toX(i), toY(v), 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); });
  });
  (pfBase?.busVoltages || []).filter(v => v.bus !== 0).forEach((v, i) => {
    if (i % 4 === 0 || i === n - 1) {
      ctx.fillStyle = "rgba(255,255,255,.3)"; ctx.font = "9px Inter";
      ctx.fillText("B" + v.bus, toX(i) - 8, 260 - 6);
    }
  });
  [[vBase, "#3b82f6", "BASE"], [vPost, "#f97316", "POST"]].forEach(([, c, lb], i) => {
    ctx.fillStyle = c; ctx.fillRect(pL + i * 110, 5, 12, 10);
    ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = "11px Inter";
    ctx.fillText(lb, pL + i * 110 + 16, 15);
  });
}
// Alias for backward compat
function drawVoltageChart(pfBase, pfPre, pfPost) { drawVoltageChart2(pfBase, pfPost); }

// Line Loading horizontal grouped bar chart — BASE vs POST_MATCH
function drawLineLoadingChart(pfBase, pfPost) {
  const canvas = document.getElementById("lineLoadingChart");
  if (!canvas) return;

  const baseLines = pfBase?.lineResults || [];
  const postByKey = Object.fromEntries(
    (pfPost?.lineResults || []).map(l => [`${l.from}-${l.to}`, l])
  );
  // Include only lines that have loading in at least one case
  const lines = baseLines.filter(
    l => l.loading > 0.001 || (postByKey[`${l.from}-${l.to}`]?.loading || 0) > 0.001
  );
  if (lines.length === 0) return;

  const n = lines.length;
  // Each "group" (one line) gets ROW_H px; two bars + gap inside it
  const ROW_H = 36;   // px per line group
  const BAR_H = 13;   // px per individual bar
  const BAR_GAP = 4;  // gap between BASE and POST bars
  const pL = 110;     // left padding for labels
  const pR = 72;      // right padding for value labels
  const pT = 44;      // top padding (legend + axis labels)
  const pB = 20;      // bottom padding

  const W = canvas.offsetWidth || 900;
  const H = pT + n * ROW_H + pB;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const gW = W - pL - pR;

  // Determine x-axis scale
  const allLoad = lines.flatMap(l => [l.loading, postByKey[`${l.from}-${l.to}`]?.loading || 0]);
  const maxLoad = Math.max(...allLoad, 10);
  // Round up to nearest 10 or 25
  const niceMax = maxLoad <= 10 ? 10 : Math.ceil(maxLoad / 25) * 25;
  const scaleX = v => pL + (v / niceMax) * gW;

  // ── Background grid lines ─────────────────────────────────────────────────
  const gridPcts = [];
  for (let p = 0; p <= niceMax; p += 25) gridPcts.push(p);
  if (!gridPcts.includes(100)) gridPcts.push(100);

  gridPcts.forEach(pct => {
    if (pct > niceMax) return;
    const x = scaleX(pct);
    const isHundred = pct === 100;
    ctx.save();
    ctx.strokeStyle = isHundred ? "rgba(239,68,68,.55)" : "rgba(255,255,255,.10)";
    ctx.lineWidth = isHundred ? 1.5 : 1;
    ctx.setLineDash(isHundred ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(x, pT - 10); ctx.lineTo(x, H - pB); ctx.stroke();
    ctx.restore();
    // Axis label at top
    ctx.fillStyle = isHundred ? "rgba(239,100,100,.9)" : "rgba(255,255,255,.40)";
    ctx.font = "9px Inter"; ctx.textAlign = "center";
    ctx.fillText(pct + "%", x, pT - 14);
  });

  // ── Draw bars ─────────────────────────────────────────────────────────────
  lines.forEach((l, i) => {
    const key = `${l.from}-${l.to}`;
    const bLoad = l.loading;
    const pLoad = postByKey[key]?.loading || 0;

    // Vertical center of the group row
    const rowTop = pT + i * ROW_H;
    const totalBarBlock = BAR_H * 2 + BAR_GAP;
    const yBase = rowTop + (ROW_H - totalBarBlock) / 2;   // y-start of BASE bar
    const yPost = yBase + BAR_H + BAR_GAP;                 // y-start of POST bar

    // Zebra row background for readability
    if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,.03)";
      ctx.fillRect(pL, rowTop, gW, ROW_H);
    }

    // BASE bar
    const bW = Math.max(scaleX(bLoad) - pL, 0);
    const bColor = bLoad > 100 ? "#dc2626" : bLoad > 80 ? "#ef4444" : bLoad > 50 ? "#f59e0b" : "#3b82f6";
    ctx.fillStyle = bColor + "d0";
    ctx.fillRect(pL, yBase, bW, BAR_H);
    // Thin bright top edge
    ctx.fillStyle = bColor;
    ctx.fillRect(pL, yBase, bW, 2);

    // POST bar
    const pW = Math.max(scaleX(pLoad) - pL, 0);
    const pColor = pLoad > 100 ? "#dc2626" : pLoad > 80 ? "#ef4444" : pLoad > 50 ? "#f59e0b" : "#f97316";
    ctx.fillStyle = pColor + "d0";
    ctx.fillRect(pL, yPost, pW, BAR_H);
    ctx.fillStyle = pColor;
    ctx.fillRect(pL, yPost, pW, 2);

    // ── Left label: "Bus A → Bus B" ──────────────────────────────────────
    ctx.fillStyle = "rgba(255,255,255,.65)";
    ctx.font = "bold 9px Inter";
    ctx.textAlign = "right";
    const midY = rowTop + ROW_H / 2 + 3;
    ctx.fillText(`${l.from}→${l.to}`, pL - 6, midY);

    // ── Right value labels ────────────────────────────────────────────────
    const xBaseEnd = scaleX(bLoad);
    const xPostEnd = scaleX(pLoad);
    ctx.font = "9px Inter"; ctx.textAlign = "left";
    // BASE value
    ctx.fillStyle = bColor;
    ctx.fillText(bLoad.toFixed(2) + "%", xBaseEnd + 4, yBase + BAR_H / 2 + 3);
    // POST value
    ctx.fillStyle = pColor;
    ctx.fillText(pLoad.toFixed(2) + "%", xPostEnd + 4, yPost + BAR_H / 2 + 3);
  });

  // ── Legend ───────────────────────────────────────────────────────────────
  const legendItems = [
    { color: "#3b82f6", label: "🔵 BASE" },
    { color: "#f97316", label: "🟠 POST_MATCH" },
  ];
  ctx.textAlign = "left";
  legendItems.forEach(({ color, label }, i) => {
    const lx = pL + i * 160;
    ctx.fillStyle = color + "d0";
    ctx.fillRect(lx, 10, 14, 10);
    ctx.fillStyle = color;
    ctx.fillRect(lx, 10, 14, 2);
    ctx.fillStyle = "rgba(255,255,255,.80)";
    ctx.font = "bold 11px Inter";
    ctx.fillText(label, lx + 18, 20);
  });

  // Axis title
  ctx.fillStyle = "rgba(255,255,255,.30)";
  ctx.font = "9px Inter";
  ctx.textAlign = "center";
  ctx.fillText("Line Loading (%)", pL + gW / 2, pT - 26);
}

// ── RENDER: TRANSACTIONS ──────────────────────────────────────────────────────
function renderTransactions() {
  const el = document.getElementById("tab-transactions");
  if (!el || wf.step !== "results") return;
  const { trades, logs, soldKwh, boughtKwh } = R;
  const totalTraded = logs.reduce((a, l) => a + l.qty, 0);
  const totalValue = logs.reduce((a, l) => a + l.tradeValue, 0);

  const sellerStats = {};
  for (const s of SELLERS) {
    let rev = 0, ps = 0;
    for (const [key, qty] of Object.entries(trades || {})) {
      const [ts, tb] = key.split("|"); if (ts !== s) continue;
      const clr = (state.offeringPrice[s] + state.biddingPrice[tb]) / 2;
      rev += qty * clr; ps += qty * (clr - state.offeringPrice[s]);
    }
    sellerStats[s] = { rev, ps };
  }
  const buyerStats = {};
  for (const b of BUYERS) {
    let cost = 0, cs = 0;
    for (const [key, qty] of Object.entries(trades || {})) {
      const [ts, tb] = key.split("|"); if (tb !== b) continue;
      const clr = (state.offeringPrice[ts] + state.biddingPrice[b]) / 2;
      cost += qty * clr; cs += qty * (state.biddingPrice[b] - clr);
    }
    buyerStats[b] = { cost, cs };
  }
  const totPS = SELLERS.reduce((a, s) => a + sellerStats[s].ps, 0);
  const totCS = BUYERS.reduce((a, b) => a + buyerStats[b].cs, 0);

  el.innerHTML = `
    <div class="tx-section">
      <h3>💰 Clearing Prices — All Trades</h3>
      <p class="algo-note">Clearing Price = (Offering + Bidding) / 2 | Trade Value = Clearing × Energy</p>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Step</th><th>Seller</th><th>Buyer</th>
          <th>Offer (THB/kWh)</th><th>Bid (THB/kWh)</th>
          <th>Formula</th><th>Clearing (THB/kWh)</th><th>Energy (kWh)</th><th>Value (THB)</th></tr></thead>
        <tbody>
          ${logs.map(l => `<tr>
            <td>${l.step}</td>
            <td><span class="tag seller-tag">${l.seller}</span></td>
            <td><span class="tag buyer-tag">${l.buyer}</span></td>
            <td>${f4(l.offer)}</td><td>${f4(l.bid)}</td>
            <td style="font-size:10px;font-family:monospace">(${f4(l.offer)}+${f4(l.bid)})/2</td>
            <td><strong class="clear-price">${f4(l.clearPrice)}</strong></td>
            <td>${f2(l.qty)}</td><td>${f4(l.tradeValue)}</td>
          </tr>`).join("")}
          <tr class="total-row"><td colspan="7"><strong>TOTAL (${logs.length} trades)</strong></td>
            <td><strong>${f2(totalTraded)}</strong></td><td><strong>${f4(totalValue)} THB</strong></td>
          </tr>
        </tbody>
      </table></div>

      <div class="tx-summary-grid">
        <div class="tx-summary-card">
          <div class="tx-card-title">🌞 Seller Revenue &amp; Surplus</div>
          ${SELLERS.map(s => `<div class="tx-stat"><label>${s} (${PLAYER_LOCATIONS[s]})</label>
            <value class="pos">${f4(sellerStats[s].rev)} THB</value></div>`).join("")}
          <div class="tx-stat divider"><label>Producer Surplus</label>
            <value class="pos highlight">${f4(totPS)} THB</value></div>
        </div>
        <div class="tx-summary-card">
          <div class="tx-card-title">🛒 Buyer Cost &amp; Surplus</div>
          ${BUYERS.map(b => `<div class="tx-stat"><label>${b} (${PLAYER_LOCATIONS[b]})</label>
            <value>${f4(buyerStats[b].cost)} THB</value></div>`).join("")}
          <div class="tx-stat divider"><label>Consumer Surplus</label>
            <value class="pos highlight">${f4(totCS)} THB</value></div>
        </div>
      </div>

      <div class="dash-section"><h3>📊 Social Welfare</h3>
        <div class="summary-stats">
          <div class="stat-item"><span>Producer Surplus</span><strong class="pos">${f4(totPS)} THB</strong></div>
          <div class="stat-item"><span>Consumer Surplus</span><strong class="pos">${f4(totCS)} THB</strong></div>
          <div class="stat-item"><span>Total Social Welfare</span><strong class="clear-price">${f4(totPS + totCS)} THB</strong></div>
          <div class="stat-item"><span>Avg Clearing Price</span><strong>${f4(totalTraded > 0 ? totalValue / totalTraded : 0)} THB/kWh</strong></div>
        </div>
      </div>
    </div>`;
}

// ── Event Log ─────────────────────────────────────────────────────────────────
function renderEventLog() {
  const el = document.getElementById("tab-log");
  if (!el) return;
  el.innerHTML = `
    <div class="dash-section"><h3>📋 System Event Log</h3>
      <div class="log-list">
        ${wf.eventLog.length === 0
      ? '<div class="log-empty">No events yet</div>'
      : [...wf.eventLog].reverse().map(e =>
        `<div class="log-entry"><span class="log-time">${e.time}</span><span class="log-msg">${e.msg}</span></div>`
      ).join("")}
      </div>
    </div>`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = "info") {
  const t = document.createElement("div");
  t.className = `toast toast-${type}`; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 4000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  renderWorkflowBanner();
  showTab("inputs");
  checkBackend().then(() => {
    if (wf.backendOk) runEnergyRangeAnalysis();
    else renderInputs();
  });
});