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
  const num4 = v => (v == null || isNaN(v) ? "—"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 }));
  const sTag = x => `<span class="tag seller-tag">${x}</span>`;
  const bTag = x => `<span class="tag buyer-tag">${x}</span>`;
  const PENDING_NOTE = "จะทำการคิดการชำระเงินเพิ่มเติมภายหลัง";
  // Defaults = server._DEFAULT_ER (hard_per / hard_total); replaced by the
  // values the backend echoes in "safety1" once preview/clear has run.
  const S1_DEFAULT = { per: 10.86, total: 54.30 };
  const statusCell = st => st === "PENDING_SETTLEMENT"
    ? `<span class="neg">⏳ PENDING</span>` : `<span class="pos">FINAL</span>`;

  // Safety 1 — soft cap: warn only, never blocks
  function renderS1(s1) {
    if (!s1) return "";
    const head = `Safety 1 (soft cap ${num(s1.cap_per_kwh)} kWh/ราย · รวม ${num(s1.cap_total_kwh)} kWh)`;
    if (!(s1.warnings_th || []).length)
      return `<p class="algo-note" style="margin-top:8px">🛡️ ${head}: ผ่าน — รวมเสนอ ${num(s1.total_offer_kwh)} kWh</p>`;
    const over = (s1.sellers_over || [])
      .map(x => `${sTag(x.seller)} ${num(x.offer_kwh)} kWh (เกิน ${num(x.excess_kwh)})`).join(" · ");
    return `<div class="wf-alert alert-retry" style="margin-top:10px">
      <div class="wf-alert-title">⚠️ ${head} — เตือนเท่านั้น ไม่ block</div>
      <div class="wf-alert-body">${s1.warnings_th.map(w => `<p>${w}</p>`).join("")}
        ${over ? `<p>${over}</p>` : ""}</div></div>`;
  }

  // Safety 2 — over-voltage → zero-export, frozen match, kWh ledger
  function renderS2(s2, pfi, pff, where) {
    if (!s2 || !s2.triggered)
      return `<p class="algo-note" style="margin-top:8px">🛡️ Safety 2 ${where}: ไม่ทำงาน — ไม่พบ over-voltage</p>`;
    pfi = pfi || {}; pff = pff || {};
    const cut = s2.curtailed || [];
    const cutRows = cut.map(c => `<tr><td>${c.order}</td><td>${sTag(c.seller)}</td>
      <td class="bus-cell">${c.bus}</td><td>${num4(c.dVmax_dP)}</td><td>${num(c.declared_kwh)}</td>
      <td>${num(c.lost_p2p_kwh)}</td><td>${num(c.lost_fit_kwh)}</td>
      <td>${num4(c.vmax_before)} → ${num4(c.vmax_after)}</td></tr>`).join("");
    const cx = (s2.trades_cancelled || []).map(t => `<tr><td>${sTag(t.seller)}</td><td>${bTag(t.buyer)}</td>
      <td>${num(t.qty_kwh)}</td><td>${num(t.price)}</td><td class="neg">${t.status_th || "ยกเลิก"}</td></tr>`).join("");
    const note = (s2.energy_ledger && s2.energy_ledger.note_th) || PENDING_NOTE;
    return `<div class="wf-alert alert-grid" style="margin-top:10px">
      <div class="wf-alert-title">🛡️ Safety 2 ${where} — over-voltage → zero-export ${cut.map(c => c.seller).join(", ") || "—"}
        ${s2.resolved ? "· ✅ แก้ได้แล้ว" : "· ❌ ยังแก้ไม่หมด"}</div>
      <div class="wf-alert-body">
        <p>Vmax <strong>${num4(pfi.vmax)}</strong> (over ${pfi.n_over ?? "—"} บัส${(pfi.over_buses || []).length ? ": " + pfi.over_buses.join(", ") : ""})
          → <strong>${num4(pff.vmax)}</strong> (over ${pff.n_over ?? "—"}) · รัน PF ${s2.power_flows ?? "—"} ครั้ง · ${s2.elapsed_s ?? "—"} s</p>
        <p>การจับคู่: <strong>${s2.matching_policy || "FROZEN_NO_REMATCH"}</strong> — คู่เดิมไม่ re-match ยกเลิกเฉพาะคู่ของผู้ขายที่ถูกตัด</p>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>#</th><th>Seller</th><th>Bus</th><th>dVmax/dP</th>
          <th>เสนอ kWh</th><th>เสีย P2P kWh</th><th>เสีย FIT kWh</th><th>Vmax ก่อน → หลัง</th></tr></thead><tbody>${cutRows}</tbody></table></div>
        ${cx ? `<div class="table-scroll" style="margin-top:8px"><table class="data-table"><thead><tr><th>Seller</th><th>Buyer</th>
          <th>kWh</th><th>ราคา</th><th>สถานะ</th></tr></thead><tbody>${cx}</tbody></table></div>`
        : `<p>ผู้ขายที่ถูกตัดไม่มีคู่ P2P — ไม่มีสัญญาถูกยกเลิก</p>`}
        <p>⏳ พลังงานที่ค้างบันทึกเป็น kWh (PENDING_SETTLEMENT) — ${note}</p>
      </div></div>`;
  }

  // Under-voltage / line overload — advisory only (same as the main page)
  function renderAdv(list) {
    return (list || []).map(a => `<div class="wf-alert alert-retry" style="margin-top:10px">
      <div class="wf-alert-title">${a.headline_th || a.case} · ADVISORY (ไม่ตัดผู้ขาย)</div>
      <div class="wf-alert-body"><p>${a.why_rare_th || a.why_th || ""}</p>${a.where_th ? `<p>${a.where_th}</p>` : ""}
        ${(a.fix_th || []).length ? `<ul>${a.fix_th.map(f => `<li>${f}</li>`).join("")}</ul>` : ""}</div></div>`).join("");
  }

  function pfStats(v, m) {
    v = v || {}; m = m || {};
    const nV = (v.over || []).length + (v.under || []).length;
    return `<div class="summary-stats" style="margin-top:8px">
        <div class="stat-item"><span>Vmin</span><strong>${num4(m.min_voltage_pu)}</strong></div>
        <div class="stat-item"><span>Vmax</span><strong>${num4(m.max_voltage_pu)}</strong></div>
        <div class="stat-item"><span>โหลดสายสูงสุด</span><strong>${num(m.max_line_loading_pct)}%</strong></div>
        <div class="stat-item"><span>thermal</span><strong class="${(v.thermal || []).length ? "neg" : "pos"}">${(v.thermal || []).length}</strong></div>
        <div class="stat-item"><span>over/under V</span><strong class="${nV ? "neg" : "pos"}">${(v.over || []).length}/${(v.under || []).length}</strong></div>
      </div>`;
  }
  const passBadge = (ok, s2) => `<span class="pf-status-badge ${ok ? "badge-pass" : "badge-fail"}">${ok ? (s2 && s2.triggered ? "✅ PASS หลัง Safety 2" : "✅ PASS power flow") : "❌ violation"}</span>`;

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
      ${renderS1(p.safety1)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px">${hb}${hs}</div>`;
  }

  function renderClr(c) {
    if (c.price_errors && c.price_errors.length)
      return `<div class="wf-alert alert-price-err" style="margin-top:10px">
        <div class="wf-alert-title">⛔ ราคานอกกรอบ [${FIT_PRICE}, ${RETAIL_PRICE}]</div>
        <div>${c.price_errors.map(e => `${e.player}=${e.price}`).join(", ")}</div></div>`;
    const traded = Object.values(c.sold || {}).reduce((a, x) => a + x, 0);
    const toFit = Object.values(c.unsold || {}).reduce((a, x) => a + x, 0);
    const cut = new Set(c.curtailed_sellers || []);
    let rows = "";
    for (const s in (c.sold || {})) {
      const st = cut.has(s) ? `<span class="neg">⛔ zero-export</span>` : `<span class="pos">ส่งตามสัญญา</span>`;
      rows += `<tr><td>${sTag(s)}</td><td>${num(c.sold[s])}</td><td>${num((c.unsold || {})[s])}</td><td>${st}</td></tr>`;
    }
    return `<div style="margin-top:10px">${passBadge(c.ok, c.safety2)}
        <span style="margin-left:14px">เทรด P2P รวม <strong>${num(traded)}</strong> kWh · ขายกริด FIT <strong>${num(toFit)}</strong> kWh</span></div>
      ${renderS1(c.safety1)}
      ${renderS2(c.safety2, c.pf_initial, c.pf_final, "(เฟส 3 clearing)")}
      ${renderAdv(c.advisories)}
      ${pfStats(c.violations, c.metrics)}
      <div class="table-scroll" style="margin-top:8px"><table class="data-table"><thead><tr><th>Seller</th><th>P2P ขายได้ kWh</th>
        <th>ขายกริด FIT kWh</th><th>สถานะ</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${c.ok ? "" : `<p class="algo-note neg" style="margin-top:8px">ยังมี violation หลังตรวจ power flow — ปุ่มส่งจริง (เฟส 4) จะถูกปิดไว้</p>`}`;
  }

  function renderDel(a) {
    const tsold = Object.values(a.sold || {}).reduce((x, y) => x + y, 0);
    const cutNow = new Set(a.curtailed_at_delivery || []);
    const cutAll = new Set(a.curtailed_sellers || []);
    let r = `<table class="data-table"><thead><tr><th>Seller</th><th>factor</th><th>ฉีดจริง kWh</th><th>P2P ส่ง kWh</th>
      <th>กริด FIT kWh</th><th>สถานะ</th></tr></thead><tbody>`;
    for (const s in (a.sold || {})) {
      const st = cutNow.has(s) ? `<span class="neg">⛔ zero-export (ตอนส่ง)</span>`
        : cutAll.has(s) ? `<span class="neg">⛔ zero-export (ตั้งแต่เฟส 3)</span>`
          : `<span class="pos">ส่งแล้ว</span>`;
      const inj = cutAll.has(s) ? 0 : (a.export_kwh || {})[s];
      r += `<tr><td>${sTag(s)}</td><td>${num((a.factor || {})[s])}</td><td>${num(inj)}</td><td>${num(a.sold[s])}</td>
        <td>${num((a.unsold || {})[s])}</td><td>${st}</td></tr>`;
    }
    r += `</tbody></table>`;
    let rb = `<table class="data-table"><thead><tr><th>Buyer</th><th>รับ P2P จริง kWh</th></tr></thead><tbody>`;
    for (const b in (a.received || {})) rb += `<tr><td>${bTag(b)}</td><td>${num(a.received[b])}</td></tr>`;
    rb += `</tbody></table>`;
    return `<div style="margin-top:10px">${passBadge(a.ok, a.safety2)}
        <span style="margin-left:14px">ส่ง P2P จริงรวม <strong>${num(tsold)}</strong> kWh</span></div>
      ${renderS2(a.safety2, a.pf_initial, a.pf_final, "(เฟส 4 delivery)")}
      ${renderAdv(a.advisories)}
      ${pfStats(a.violations, a.metrics)}
      <div style="margin-top:8px;display:grid;grid-template-columns:3fr 2fr;gap:16px">${r}${rb}</div>`;
  }

  function renderStl(s) {
    let hb = `<table class="data-table"><thead><tr><th>Buyer</th><th>สัญญา P2P</th><th>รับจริง</th><th>ขาด(กริด ToU)</th>
      <th>จ่าย P2P</th><th>จ่ายกริด</th><th>รวมจ่าย</th><th>ค้าง zero-export kWh</th><th>สถานะ</th></tr></thead><tbody>`;
    let hs = `<table class="data-table"><thead><tr><th>Seller</th><th>บอกขาย</th><th>ส่งจริง</th><th>ขาด</th><th>กริด FIT kWh</th>
      <th>รายได้ P2P</th><th>เครดิต FIT</th><th>ค่าปรับ</th><th>net</th><th>สถานะ</th></tr></thead><tbody>`;
    let anyPending = false;
    for (const k in s) {
      const x = s[k];
      if (x.settlement_status === "PENDING_SETTLEMENT") anyPending = true;
      if (x.role === "buyer")
        hb += `<tr><td>${bTag(k)}</td><td>${num(x.want_kwh)}</td><td>${num(x.received_kwh)}</td><td>${num(x.grid_deficit_kwh)}</td>
          <td>${num(x.pay_p2p)}</td><td>${num(x.pay_grid)}</td><td><strong>${num(x.pay_total)}</strong></td>
          <td class="${x.curtailed_shortfall_kwh ? "neg" : ""}">${num(x.curtailed_shortfall_kwh)}</td><td>${statusCell(x.settlement_status)}</td></tr>`;
      else if (x.zero_exported)
        hs += `<tr><td>${sTag(k)}</td><td colspan="8" class="neg">⛔ zero-export โดย Safety 2 — ค้าง P2P ${num(x.undelivered_p2p_kwh)} kWh ·
          ค้างรวม ${num(x.undelivered_total_kwh)} kWh · ยังไม่คิดเงินรอบนี้</td><td>${statusCell(x.settlement_status)}</td></tr>`;
      else
        hs += `<tr><td>${sTag(k)}</td><td>${num(x.claimed_kwh)}</td><td>${num(x.delivered_kwh)}</td><td class="neg">${num(x.shortfall_kwh)}</td>
          <td>${num(x.unsold_kwh)}</td><td>${num(x.revenue_p2p)}</td><td>${num(x.grid_credit)}</td><td class="neg">${num(x.penalty)}</td>
          <td><strong>${num(x.net)}</strong></td><td>${statusCell(x.settlement_status)}</td></tr>`;
    }
    hb += `</tbody></table>`; hs += `</tbody></table>`;
    return `${anyPending ? `<div class="wf-alert alert-retry" style="margin-top:10px">
        <div class="wf-alert-title">⏳ PENDING_SETTLEMENT — พลังงานที่ถูก zero-export</div>
        <div class="wf-alert-body"><p>บันทึกเป็น kWh เท่านั้น ไม่คิดเป็นค่าซื้อกริดหรือค่าปรับในรอบนี้ — ${PENDING_NOTE}</p></div></div>` : ""}
      <div class="table-scroll" style="margin-top:10px">${hb}</div>
      <div class="table-scroll" style="margin-top:12px">${hs}</div>`;
  }

  // ── Main tab renderer ──────────────────────────────────────────────────────
  function renderMarket() {
    const el = g("tab-market");
    if (!el) return;
    const p = mkt.preview, c = mkt.clearing, a = mkt.actual, s = mkt.settlement;
    const s1 = (c && c.safety1) || (p && p.safety1);
    const capPer = s1 ? s1.cap_per_kwh : S1_DEFAULT.per;
    const capTot = s1 ? s1.cap_total_kwh : S1_DEFAULT.total;

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
        <p class="algo-note">ตลาดราย 1 ชม. · พลังงาน = kWh ต่อ slot · Safety 1 soft cap ${num(capPer)} kWh/seller (รวม ${num(capTot)} kWh — เตือนเท่านั้น) · over-voltage จริงตัดสินด้วย PF verify + Safety 2 (zero-export) · ไม่ย้อนกริดถ้า ≤3.11 kWh/seller · ราคา [${FIT_PRICE}, ${RETAIL_PRICE}]</p>
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
        <h3>③ Clear + Power Flow Check + Safety 1/2</h3>
        <button class="btn btn-primary" onclick="mktClear()">จับคู่ + ตรวจ power flow + Safety 2</button>
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