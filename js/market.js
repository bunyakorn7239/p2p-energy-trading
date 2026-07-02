/**
 * market.js — Hourly P2P Market (5 phases) add-on for the existing app.
 * ===================================================================
 * Load AFTER app.js. Does NOT modify app.js. It:
 *   1) renders a new "Hourly Market" tab (phases 2–5) that calls /api/market/*
 *   2) re-labels the energy-range panel to per-slot + reverse-flow / over-voltage caps
 *   3) hooks into showTab() so the market tab renders when opened
 *
 * Requires the backend to expose market routes (register_market_routes) and
 * run with ENERGY_WINDOW_HOURS = 1.0 (1-hour slots). Reuses globals from
 * app.js: BACKEND, SELLERS, BUYERS, PLAYER_LOCATIONS, FIT_PRICE, RETAIL_PRICE,
 * showToast, logEvent, wf.
 */
"use strict";
(function () {

  // ── Market slot state (own inputs, sized for a 1-hour slot) ───────────────
  const mkt = {
    slotId: "2026-06-16T13:00", hour: 13, pvReal: 0.7,
    offer: { C: 2.80, D: 2.80, E: 2.80, F: 2.80, I: 2.80 },
    bid: { A: 5.20, B: 5.20, G: 5.20, H: 5.20, J: 5.20 },
    sEnergy: { C: 12, D: 10, E: 13, F: 9, I: 11 },
    bEnergy: { A: 11, B: 8, G: 9, H: 12, J: 10 },
    preview: null, clearing: null, actual: null, settlement: null,
  };

  const num = v => (v == null || isNaN(v) ? "—"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const g = id => document.getElementById(id);

  // ── Backend calls ─────────────────────────────────────────────────────────
  function orders() {
    return {
      slot_id: mkt.slotId, hour: mkt.hour,
      sellers: SELLERS, buyers: BUYERS, player_locations: PLAYER_LOCATIONS,
      offering_price: mkt.offer, bidding_price: mkt.bid,
      seller_energy_kwh: mkt.sEnergy, buyer_energy_kwh: mkt.bEnergy,
    };
  }
  async function api(path, body) {
    const r = await fetch(`${BACKEND}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  function syncInputs() {
    if (g("mkt-slot")) mkt.slotId = g("mkt-slot").value.trim();
    if (g("mkt-hour")) mkt.hour = parseInt(g("mkt-hour").value) || 12;
    if (g("mkt-pv")) mkt.pvReal = parseFloat(g("mkt-pv").value);
    SELLERS.forEach(s => {
      if (g("ms-" + s)) mkt.sEnergy[s] = parseFloat(g("ms-" + s).value);
      if (g("mo-" + s)) mkt.offer[s] = parseFloat(g("mo-" + s).value);
    });
    BUYERS.forEach(b => {
      if (g("md-" + b)) mkt.bEnergy[b] = parseFloat(g("md-" + b).value);
      if (g("mb-" + b)) mkt.bid[b] = parseFloat(g("mb-" + b).value);
    });
  }
  const log = m => { try { logEvent(m); } catch (_) { } };

  async function mktPreview() {
    syncInputs();
    try { mkt.preview = await api("/api/market/preview", orders()); log("🕐 Market: price preview"); }
    catch (e) { showToast("❌ Preview: " + e.message, "error"); }
    renderMarket();
  }
  async function mktClear() {
    syncInputs();
    try {
      mkt.clearing = await api("/api/market/clear", orders());
      mkt.actual = null; mkt.settlement = null;
      log(`🕐 Market: clear ok=${mkt.clearing.ok}`);
    } catch (e) { showToast("❌ Clear: " + e.message, "error"); }
    renderMarket();
  }
  async function mktDeliver() {
    syncInputs();
    try {
      mkt.actual = await api("/api/market/deliver", { slot_id: mkt.slotId, pv_realization: mkt.pvReal });
      mkt.settlement = null; log("🕐 Market: delivered (pv=" + mkt.pvReal + ")");
    } catch (e) { showToast("❌ Deliver: " + e.message, "error"); }
    renderMarket();
  }
  async function mktSettle() {
    try { mkt.settlement = await api("/api/market/settle", { slot_id: mkt.slotId }); log("🕐 Market: settled"); }
    catch (e) { showToast("❌ Settle: " + e.message, "error"); }
    renderMarket();
  }
  // expose onclick handlers globally
  window.mktPreview = mktPreview; window.mktClear = mktClear;
  window.mktDeliver = mktDeliver; window.mktSettle = mktSettle;

  // ── Result renderers (reuse existing CSS classes) ─────────────────────────
  const noRun = t => `<div class="log-empty" style="margin-top:10px">${t || "ยังไม่ได้รัน"}</div>`;

  function renderPrev(p) {
    let hb = `<table class="data-table"><thead><tr><th>Buyer</th><th>ต้องการ</th><th>P2P</th><th>กริดล้วน</th><th>ผ่าน P2P</th><th>ประหยัด</th></tr></thead><tbody>`;
    for (const b in p.buyers) {
      const x = p.buyers[b];
      hb += `<tr><td><span class="tag buyer-tag">${b}</span></td><td>${num(x.want_kwh)}</td><td>${num(x.p2p_kwh)}</td><td>${num(x.cost_grid_only)}</td><td>${num(x.cost_p2p)}</td><td class="pos">${num(x.save)}</td></tr>`;
    }
    hb += `</tbody></table>`;
    let hs = `<table class="data-table"><thead><tr><th>Seller</th><th>เสนอ</th><th>P2P</th><th>กริดล้วน</th><th>ผ่าน P2P</th><th>เพิ่ม</th></tr></thead><tbody>`;
    for (const s in p.sellers) {
      const x = p.sellers[s];
      hs += `<tr><td><span class="tag seller-tag">${s}</span></td><td>${num(x.offer_kwh)}</td><td>${num(x.p2p_kwh)}</td><td>${num(x.rev_grid_only)}</td><td>${num(x.rev_p2p)}</td><td class="pos">${num(x.gain)}</td></tr>`;
    }
    hs += `</tbody></table>`;
    return `<p class="algo-note" style="margin-top:8px">ชั่วโมง ${p.hour} · ToU ${num(p.tou_rate)} บาท/kWh</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${hb}${hs}</div>`;
  }

  function renderClr(c) {
    if (c.price_errors && c.price_errors.length)
      return `<div class="wf-alert alert-price-err" style="margin-top:10px">
        <div class="wf-alert-title">⛔ ราคานอกกรอบ [${FIT_PRICE}, ${RETAIL_PRICE}]</div>
        <div>${c.price_errors.map(e => `${e.player}=${e.price}`).join(", ")}</div></div>`;
    const v = c.violations || {}, m = c.metrics || {};
    const traded = Object.values(c.sold || {}).reduce((a, x) => a + x, 0);
    let rows = "";
    for (const s in (c.sold || {})) rows += `<tr><td><span class="tag seller-tag">${s}</span></td><td>${num(c.sold[s])}</td></tr>`;
    return `<div style="margin-top:10px">
        <span class="pf-status-badge ${c.ok ? "badge-pass" : "badge-fail"}">${c.ok ? "✅ PASS power flow" : "❌ violation"}</span>
        <span style="margin-left:14px">เทรดรวม <strong>${num(traded)}</strong> kWh</span></div>
      <div class="summary-stats" style="margin-top:8px">
        <div class="stat-item"><span>Vmin</span><strong>${num(m.min_voltage_pu)}</strong></div>
        <div class="stat-item"><span>Vmax</span><strong>${num(m.max_voltage_pu)}</strong></div>
        <div class="stat-item"><span>โหลดสายสูงสุด</span><strong>${num(m.max_line_loading_pct)}%</strong></div>
        <div class="stat-item"><span>thermal</span><strong class="${(v.thermal || []).length ? "neg" : "pos"}">${(v.thermal || []).length}</strong></div>
        <div class="stat-item"><span>over/under V</span><strong class="${((v.over || []).length + (v.under || []).length) ? "neg" : "pos"}">${(v.over || []).length}/${(v.under || []).length}</strong></div>
      </div>
      <div class="table-scroll" style="margin-top:8px"><table class="data-table"><thead><tr><th>Seller</th><th>ขายได้ kWh</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderDel(a) {
    const v = a.violations || {};
    const tsold = Object.values(a.sold || {}).reduce((x, y) => x + y, 0);
    let r = `<table class="data-table"><thead><tr><th>Seller</th><th>factor</th><th>ส่งจริง kWh</th></tr></thead><tbody>`;
    for (const s in (a.sold || {})) r += `<tr><td><span class="tag seller-tag">${s}</span></td><td>${num(a.factor[s])}</td><td>${num(a.sold[s])}</td></tr>`;
    r += `</tbody></table>`;
    let rb = `<table class="data-table"><thead><tr><th>Buyer</th><th>รับจริง kWh</th></tr></thead><tbody>`;
    for (const b in (a.received || {})) rb += `<tr><td><span class="tag buyer-tag">${b}</span></td><td>${num(a.received[b])}</td></tr>`;
    rb += `</tbody></table>`;
    return `<div style="margin-top:10px">ส่งจริงรวม <strong>${num(tsold)}</strong> kWh ·
        PF actual thermal <strong class="${(v.thermal || []).length ? "neg" : "pos"}">${(v.thermal || []).length}</strong></div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:16px">${r}${rb}</div>`;
  }

  function renderStl(s) {
    let hb = `<table class="data-table"><thead><tr><th>Buyer</th><th>ต้องการ</th><th>รับจริง</th><th>ขาด(กริด)</th><th>จ่าย P2P</th><th>จ่ายกริด</th><th>รวมจ่าย</th></tr></thead><tbody>`;
    let hs = `<table class="data-table"><thead><tr><th>Seller</th><th>บอกขาย</th><th>ส่งจริง</th><th>ขาด</th><th>รายได้ P2P</th><th>ค่าปรับ</th><th>net</th></tr></thead><tbody>`;
    for (const k in s) {
      const x = s[k];
      if (x.role === "buyer")
        hb += `<tr><td><span class="tag buyer-tag">${k}</span></td><td>${num(x.want_kwh)}</td><td>${num(x.received_kwh)}</td><td>${num(x.grid_deficit_kwh)}</td><td>${num(x.pay_p2p)}</td><td>${num(x.pay_grid)}</td><td><strong>${num(x.pay_total)}</strong></td></tr>`;
      else
        hs += `<tr><td><span class="tag seller-tag">${k}</span></td><td>${num(x.claimed_kwh)}</td><td>${num(x.delivered_kwh)}</td><td class="neg">${num(x.shortfall_kwh)}</td><td>${num(x.revenue_p2p)}</td><td class="neg">${num(x.penalty)}</td><td><strong>${num(x.net)}</strong></td></tr>`;
    }
    hb += `</tbody></table>`; hs += `</tbody></table>`;
    return `<div class="table-scroll" style="margin-top:10px">${hb}</div>
            <div class="table-scroll" style="margin-top:12px">${hs}</div>`;
  }

  // ── Main tab renderer ──────────────────────────────────────────────────────
  function renderMarket() {
    const el = g("tab-market");
    if (!el) return;
    const p = mkt.preview, c = mkt.clearing, a = mkt.actual, s = mkt.settlement;

    const sRows = SELLERS.map(x => `<tr>
      <td><span class="tag seller-tag">${x}</span></td><td class="bus-cell">${PLAYER_LOCATIONS[x]}</td>
      <td><input id="ms-${x}" class="tbl-input" type="number" step="0.1" value="${mkt.sEnergy[x]}"></td>
      <td><input id="mo-${x}" class="tbl-input" type="number" step="0.01" value="${mkt.offer[x]}"></td></tr>`).join("");
    const bRows = BUYERS.map(x => `<tr>
      <td><span class="tag buyer-tag">${x}</span></td><td class="bus-cell">${PLAYER_LOCATIONS[x]}</td>
      <td><input id="md-${x}" class="tbl-input" type="number" step="0.1" value="${mkt.bEnergy[x]}"></td>
      <td><input id="mb-${x}" class="tbl-input" type="number" step="0.01" value="${mkt.bid[x]}"></td></tr>`).join("");

    el.innerHTML = `
      <div class="dash-section">
        <h3>🕐 Hourly Market — 1-Hour Slot (5 Phases)</h3>
        <p class="algo-note">ตลาดราย 1 ชม. · พลังงาน = kWh ต่อ slot · เพดานแข็ง (over-voltage) ≈12.3 kWh/seller · ไม่ย้อนกริดถ้า ≤3.11 kWh/seller · ราคา [${FIT_PRICE}, ${RETAIL_PRICE}]</p>
        <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;margin:8px 0 4px">
          <label style="font-size:12px;opacity:.7">slot_id<br><input id="mkt-slot" class="tbl-input" style="width:175px" value="${mkt.slotId}"></label>
          <label style="font-size:12px;opacity:.7">hour (0–23)<br><input id="mkt-hour" type="number" class="tbl-input" style="width:80px" value="${mkt.hour}"></label>
          <label style="font-size:12px;opacity:.7">PV realization (0–1)<br><input id="mkt-pv" type="number" step="0.05" class="tbl-input" style="width:90px" value="${mkt.pvReal}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:6px">
          <table class="data-table"><thead><tr><th>Seller</th><th>Bus</th><th>kWh/slot</th><th>Offer</th></tr></thead><tbody>${sRows}</tbody></table>
          <table class="data-table"><thead><tr><th>Buyer</th><th>Bus</th><th>kWh/slot</th><th>Bid</th></tr></thead><tbody>${bRows}</tbody></table>
        </div>
      </div>

      <div class="dash-section">
        <h3>② Price Preview</h3>
        <button class="btn btn-primary" onclick="mktPreview()">แสดงราคา grid vs P2P</button>
        ${p ? renderPrev(p) : noRun()}
      </div>
      <div class="dash-section">
        <h3>③ Clear + Power Flow Check</h3>
        <button class="btn btn-primary" onclick="mktClear()">จับคู่ + ตรวจ power flow</button>
        ${c ? renderClr(c) : noRun()}
      </div>
      <div class="dash-section">
        <h3>④ ส่งพลังงานจริง (Delivery)</h3>
        <button class="btn btn-primary" ${(c && c.ok) ? "" : "disabled"} onclick="mktDeliver()">ส่งจริง + power flow รอบ 2</button>
        ${a ? renderDel(a) : noRun("ต้อง clear ให้ผ่านก่อน")}
      </div>
      <div class="dash-section">
        <h3>⑤ Settlement</h3>
        <button class="btn btn-primary" ${a ? "" : "disabled"} onclick="mktSettle()">คิดเงินจริง + ชดเชย + ค่าปรับ</button>
        ${s ? renderStl(s) : noRun("ต้องส่งจริงก่อน")}
      </div>`;
  }
  window.renderMarket = renderMarket;

  // ── Hook into showTab so the market tab renders when opened ───────────────
  const _origShowTab = window.showTab;
  window.showTab = function (tabId) {
    if (typeof _origShowTab === "function") _origShowTab(tabId);
    if (tabId === "market") renderMarket();
  };

  // ── Energy-range banner ────────────────────────────────────────────────────
  // NOTE (fix): this file used to OVERRIDE window.renderEnergyRangeBanner with an
  // old 4-cell layout (Min / Max / Total / Limits). Because market.js loads AFTER
  // app.js, that override hid the labelled banner in app.js (ปลอดภัย 3.11 เขียว /
  // real edge 3.16 ส้ม / hard limit 12.35 แดง). The override has been REMOVED so
  // the single source of truth is renderEnergyRangeBanner() in app.js.
  // If the inputs tab is already on screen, refresh it with the app.js banner.
  if (g("energy-range-banner") && typeof window.renderEnergyRangeBanner === "function") {
    window.renderEnergyRangeBanner();
  }

})();