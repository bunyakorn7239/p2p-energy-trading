// ===========================================================================
// safety2/overVoltage.js — CASE 1: OVER-VOLTAGE  (the only ACTIVE fix)
//
// PHASE 1  rank sellers by dVmax/dP -> zero-export the strongest -> re-run AC
//          power flow -> if still over-voltage, cut the next one. Repeat.
// PHASE 2  re-run the WHOLE analysis for the surviving participants (9 of 10)
//          and render it like a normal full analysis: matching, BASE /
//          PRE_MATCH / POST_MATCH, settlement, and a diff against the old match.
//
// THE ZERO-EXPORT MODELLING RULE (why the cut seller is still on screen)
//   A zero-exported house is NET ZERO at its connection point: it exports
//   nothing AND draws nothing, because its PV covers its own house load.
//   So it leaves the MATCHING POOL only; in the POWER FLOW it stays in the
//   seller list with sgen = 0 — that is what stops run_case() from creating an
//   ACTUAL_LOAD_DATA load at that bus. Every table below stamps that bus:
//        zero-export (no export to grid, self-consumption only!!!)
// ===========================================================================
(function () {
    "use strict";
    const S2 = window.Safety2;
    if (!S2) return;

    const RED = "#ef4444", GREEN = "#22c55e", AMBER = "#f59e0b",
        GREY = "#94a3b8", BLUE = "#3b82f6", VIOLET = "#a78bfa";

    const ZE_EN = "zero-export (no export to grid, self-consumption only!!!)";

    function zeBadge(compact) {
        return '<span title="' + ZE_EN + '" style="display:inline-block;padding:' +
            (compact ? "1px 6px" : "2px 8px") + ';border-radius:5px;' +
            'background:rgba(167,139,250,.16);border:1px solid rgba(167,139,250,.45);' +
            'color:' + VIOLET + ';font-size:' + (compact ? ".72em" : ".78em") +
            ';font-weight:700;white-space:nowrap;">&#9052; ZERO-EXPORT</span>';
    }

    function zeCallout(audit) {
        const buses = (audit && audit.buses) || [];
        if (!buses.length) return "";
        const rows = buses.map(b => `
      <tr>
        <td style="padding:4px 8px;"><b>Seller ${S2.esc(b.seller)}</b></td>
        <td style="padding:4px 8px;">Bus ${b.bus}</td>
        <td style="padding:4px 8px;text-align:right;font-family:monospace;">${S2.f(b.sgen_kw)} kW</td>
        <td style="padding:4px 8px;text-align:right;font-family:monospace;">${S2.f(b.load_kw)} kW</td>
        <td style="padding:4px 8px;text-align:right;font-family:monospace;color:${VIOLET};font-weight:700;">${S2.f(b.net_kw)} kW</td>
      </tr>
      <tr><td colspan="5" style="padding:0 8px 8px 8px;color:${GREY};font-size:.85em;">
        ${S2.esc(b.note_th || "")}</td></tr>`).join("");

        const cmp = (audit.vmax_if_modelled_as_consumer != null) ? `
      <div style="margin-top:9px;padding:8px 10px;border-radius:7px;
                  background:rgba(255,255,255,.04);font-size:.85em;">
        <b style="color:#e2e8f0;">ตรวจสอบว่าโมเดลถูกต้อง</b> — รันเทียบสองแบบที่บัสนี้:
        <div style="margin-top:5px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="padding:6px 8px;border-radius:6px;background:rgba(34,197,94,.09);">
            <div style="color:${GREY};font-size:.85em;">✅ net = 0 (ที่ใช้จริง)</div>
            <div style="font-weight:800;color:${GREEN};">Vmax ${S2.f(audit.vmax_correct_net_zero, 6)}</div>
          </div>
          <div style="padding:6px 8px;border-radius:6px;background:rgba(239,68,68,.09);">
            <div style="color:${GREY};font-size:.85em;">❌ ถอดออกจากลิสต์ = มีโหลดผี</div>
            <div style="font-weight:800;color:${RED};">Vmax ${S2.f(audit.vmax_if_modelled_as_consumer, 6)}</div>
          </div>
        </div>
        <div style="margin-top:6px;color:${GREY};">
          ต่าง ${S2.f(audit.delta, 6)} p.u. — ${S2.esc(audit.explanation_th || "")}
        </div>
      </div>` : "";

        return `
      <div style="margin-top:12px;padding:12px 14px;border-radius:9px;
                  background:rgba(167,139,250,.07);border:1px solid rgba(167,139,250,.35);">
        <div style="font-weight:700;color:${VIOLET};margin-bottom:3px;">
          ⭘ หมายเหตุบัสที่ถูกสั่ง Zero-Export</div>
        <div style="font-family:monospace;font-size:.86em;color:${VIOLET};margin-bottom:8px;">
          ${ZE_EN}</div>
        <table style="width:100%;border-collapse:collapse;font-size:.87em;color:#e2e8f0;">
          <thead><tr style="color:${GREY};font-size:.85em;">
            <th style="text-align:left;padding:3px 8px;">ผู้ขาย</th>
            <th style="text-align:left;padding:3px 8px;">บัส</th>
            <th style="text-align:right;padding:3px 8px;">sgen</th>
            <th style="text-align:right;padding:3px 8px;">load</th>
            <th style="text-align:right;padding:3px 8px;">net</th>
          </tr></thead><tbody>${rows}</tbody>
        </table>
        <div style="margin-top:6px;font-size:.85em;color:#cbd5e1;">
          ▸ <b>ยังอยู่ในลิสต์ power flow</b> (sgen = 0 และไม่มีการสร้างโหลดที่บัสนี้)
          &nbsp;·&nbsp; ▸ <b>ไม่อยู่ในกลุ่มจับคู่ P2P</b> (ไม่มีพลังงานให้ขาย)
        </div>
        ${cmp}
      </div>`;
    }

    function explainer() {
        return `
      <div style="padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.03);
                  border:1px dashed rgba(255,255,255,.15);margin-bottom:10px;">
        <b style="color:#e2e8f0;">วิธีแก้ของระบบ:</b>
        <ol style="margin:6px 0 0 18px;padding:0;">
          <li>จัดอันดับผู้ขายทุกรายด้วยค่าความไวแรงดัน
              <code>S = ∂Vmax/∂P</code> (p.u./kWh) จาก AC power flow จริง</li>
          <li>สั่ง <b>zero-export</b> (Export Control = 0 W) ที่ผู้ขายอันดับ 1
              — คู่ค้ารายอื่น<b>จับคู่เดิมต่อได้ทั้งหมด</b></li>
          <li>รัน power flow ซ้ำเพื่อ<b>ยืนยันว่าไม่เกิด over-voltage แล้ว</b></li>
          <li>ถ้ายังเกิดอยู่ → ตัดผู้ขายอันดับถัดไป วนจนกว่า Vmax ≤ 1.05 p.u.</li>
          <li><b>วิเคราะห์ใหม่ทั้งระบบด้วยผู้เข้าร่วมที่เหลือ</b>
              (จับคู่ + power flow 3 เคส + การคิดเงิน)</li>
        </ol>
        <div style="margin-top:8px;color:${GREY};font-size:.92em;">
          ทำไมไม่ตัด “ผู้ขายที่อยู่บนบัสที่แรงดันเกิน” — บัส 23/24 เป็นปลายตัน
          ที่<b>ไม่มีผู้ขายอยู่เลย</b> การจัดอันดับด้วย ∂Vmax/∂P จึงเป็นเกณฑ์เดียว
          ที่ใช้ได้เสมอ · รายละเอียด: <code>docs/01_zero_export.md</code>
        </div>
      </div>`;
    }

    function rankingTable(step) {
        const rows = step.ranking.map((r, i) => `
      <tr style="${i === 0 ? "background:rgba(239,68,68,.10);" : ""}">
        <td style="padding:4px 8px;">${i + 1}</td>
        <td style="padding:4px 8px;"><b>${S2.esc(r.seller)}</b>
          <span style="color:${GREY};"> Bus ${r.bus}</span></td>
        <td style="padding:4px 8px;text-align:right;">${S2.f(r.export_kwh)}</td>
        <td style="padding:4px 8px;text-align:right;font-family:monospace;">${r.dVmax_dP.toFixed(6)}</td>
        <td style="padding:4px 8px;color:${i === 0 ? RED : GREY};">
          ${i === 0 ? "⛔ ถูกตัด" : "คงเดิม"}</td>
      </tr>`).join("");
        return `<table style="width:100%;border-collapse:collapse;font-size:.85em;margin-top:6px;">
      <thead><tr style="color:${GREY};font-size:.85em;">
        <th style="text-align:left;padding:3px 8px;">#</th>
        <th style="text-align:left;padding:3px 8px;">Seller</th>
        <th style="text-align:right;padding:3px 8px;">ฉีด (kWh)</th>
        <th style="text-align:right;padding:3px 8px;">∂Vmax/∂P</th>
        <th style="text-align:left;padding:3px 8px;">ผล</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    }

    function notice(n) {
        const buyers = (n.affected_buyers || [])
            .map(a => `${S2.esc(a.buyer)} (${S2.f(a.qty_kwh)} kWh)`).join(", ");
        return `
      <div style="margin-top:10px;padding:12px 14px;border-radius:9px;
                  background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.32);">
        <div style="font-weight:700;color:${RED};margin-bottom:6px;">
          ${S2.esc(n.title_th)} ${zeBadge(true)}</div>
        <div style="font-size:.88em;line-height:1.7;">
          <div>▸ ${S2.esc(n.what_th)}</div>
          <div>▸ ${S2.esc(n.why_th)}</div>
          <div>▸ ${S2.esc(n.why_you_th)}</div>
          <div>▸ ${S2.esc(n.effect_th)}</div>
          ${buyers ? `<div>▸ ผู้ซื้อที่ได้รับผลกระทบ: ${buyers}
             — ส่วนที่ขาดจะซื้อจากกริดที่อัตรา ToU</div>` : ""}
          <div>▸ ${S2.esc(n.result_th)}</div>
          <div style="margin-top:6px;padding:7px 9px;border-radius:6px;
                      background:rgba(34,197,94,.08);color:${GREEN};">
            🏷️ ${S2.esc(n.settlement_flag)} — ${S2.esc(n.settlement_note_th)}</div>
        </div>
      </div>`;
    }

    // ---- PHASE 2 renderers ----------------------------------------------------
    function pfMini(label, pf) {
        if (!pf || !pf.converged) {
            return `<div style="padding:8px 10px;border-radius:7px;background:rgba(239,68,68,.08);">
        <div style="font-size:.75em;color:${GREY};">${S2.esc(label)}</div>
        <div style="color:${RED};font-size:.85em;">ไม่ลู่เข้า</div></div>`;
        }
        const m = pf.metrics || {}, v = pf.violations || {};
        const bad = (v.over || []).length + (v.under || []).length + (v.thermal || []).length;
        return `
      <div style="padding:8px 10px;border-radius:7px;background:rgba(255,255,255,.04);
                  border-left:3px solid ${bad ? AMBER : GREEN};">
        <div style="font-size:.75em;color:${GREY};">${S2.esc(label)}</div>
        <div style="font-size:.95em;font-weight:700;color:#e2e8f0;">
          Vmax ${S2.f(m.max_voltage_pu, 5)} · Vmin ${S2.f(m.min_voltage_pu, 5)}</div>
        <div style="font-size:.8em;color:${bad ? AMBER : GREEN};">
          ${bad ? `⚠️ ละเมิด ${bad} จุด` : "✅ ผ่านทุกเกณฑ์"} ·
          loss ${S2.f((m.total_loss_mw || 0) * 1000, 3)} kW</div>
      </div>`;
    }

    // ---- the frozen order book: every original pair, with a status flag ------
    function tradeTable(rm) {
        const book = rm.order_book || [];
        if (!book.length) return `<div style="color:${GREY};">ไม่มีคู่ซื้อขายในรอบนี้</div>`;
        let kept = 0, lost = 0;
        const rows = book.map((t, i) => {
            const cut = t.status === "CANCELLED";
            if (cut) lost += t.qty_kwh; else kept += t.qty_kwh;
            return `
      <tr style="${cut ? "background:rgba(167,139,250,.08);" : ""}">
        <td style="padding:4px 8px;color:${GREY};">${i + 1}</td>
        <td style="padding:4px 8px;${cut ? "text-decoration:line-through;opacity:.75;" : ""}">
          <b>${S2.esc(t.seller)}</b> → <b>${S2.esc(t.buyer)}</b></td>
        <td style="padding:4px 8px;text-align:right;${cut ? "text-decoration:line-through;opacity:.75;" : ""}">
          ${S2.f(t.qty_kwh)}</td>
        <td style="padding:4px 8px;text-align:right;color:${GREY};">${S2.f(t.price, 4)}</td>
        <td style="padding:4px 8px;text-align:right;${cut ? "text-decoration:line-through;opacity:.75;" : ""}">
          ${S2.f(t.value)}</td>
        <td style="padding:4px 8px;font-size:.9em;color:${cut ? VIOLET : GREEN};">
          ${cut ? "⛔ ยกเลิก (ผู้ขาย zero-export)" : "✅ ส่งมอบตามสัญญาเดิม"}</td>
      </tr>`;
        }).join("");
        return `<table style="width:100%;border-collapse:collapse;font-size:.86em;color:#e2e8f0;">
      <thead><tr style="color:${GREY};font-size:.85em;">
        <th style="text-align:left;padding:3px 8px;">#</th>
        <th style="text-align:left;padding:3px 8px;">คู่ซื้อขาย (ล็อกจากตอนป้อน input)</th>
        <th style="text-align:right;padding:3px 8px;">kWh</th>
        <th style="text-align:right;padding:3px 8px;">ราคา</th>
        <th style="text-align:right;padding:3px 8px;">มูลค่า</th>
        <th style="text-align:left;padding:3px 8px;">สถานะการส่งมอบ</th>
      </tr></thead><tbody>${rows}</tbody>
      <tfoot><tr style="border-top:1px solid rgba(255,255,255,.14);">
        <td colspan="2" style="padding:5px 8px;"><b>รวม</b></td>
        <td style="padding:5px 8px;text-align:right;">
          <b style="color:${GREEN};">${S2.f(kept)}</b>
          ${lost > 1e-9 ? ` <span style="color:${VIOLET};">(−${S2.f(lost)})</span>` : ""}</td>
        <td colspan="3"></td>
      </tr></tfoot></table>`;
    }

    function participantTable(rm) {
        const removed = new Set(rm.sellers_removed || []);
        const st = rm.settlement || {};
        const nAll = (rm.sellers_all || []).length + (rm.buyers || []).length;
        const sellers = (rm.sellers_all || []).map(s => {
            const cut = removed.has(s);
            return `<tr style="${cut ? "background:rgba(167,139,250,.08);" : ""}">
        <td style="padding:4px 8px;"><b>${S2.esc(s)}</b>
          <span style="color:${GREY};font-size:.85em;"> ผู้ขาย</span></td>
        <td style="padding:4px 8px;text-align:right;">
          ${cut ? `<span style="color:${VIOLET};">0.00</span>`
                    : S2.f((st.seller_sold_kwh || {})[s])}</td>
        <td style="padding:4px 8px;text-align:right;">
          ${cut ? `<span style="color:${VIOLET};">0.00</span>`
                    : S2.f((st.seller_unsold_kwh || {})[s])}</td>
        <td style="padding:4px 8px;">${cut ? zeBadge(true)
                    : `<span style="color:${GREEN};">✅ ส่งมอบตามคู่เดิม</span>`}</td>
      </tr>`;
        }).join("");
        const buyers = (rm.buyers || []).map(b => {
            const short = Number((st.buyer_unmet_kwh || {})[b]) || 0;
            return `<tr>
        <td style="padding:4px 8px;"><b>${S2.esc(b)}</b>
          <span style="color:${GREY};font-size:.85em;"> ผู้ซื้อ</span></td>
        <td style="padding:4px 8px;text-align:right;">${S2.f((st.buyer_bought_kwh || {})[b])}</td>
        <td style="padding:4px 8px;text-align:right;color:${short > 1e-9 ? AMBER : GREY};">
          ${S2.f(short)}</td>
        <td style="padding:4px 8px;">${short > 1e-9
                    ? `<span style="color:${AMBER};">⚠️ ได้ไม่ครบ — บันทึกปริมาณไว้ คิดชำระเงินภายหลัง</span>`
                    : `<span style="color:${GREEN};">✅ ได้ครบตามสัญญา</span>`}</td>
      </tr>`;
        }).join("");
        return `<table style="width:100%;border-collapse:collapse;font-size:.86em;color:#e2e8f0;">
      <thead><tr style="color:${GREY};font-size:.85em;">
        <th style="text-align:left;padding:3px 8px;">ผู้เข้าร่วม (${nAll} ราย)</th>
        <th style="text-align:right;padding:3px 8px;">ซื้อ/ขายได้ (kWh)</th>
        <th style="text-align:right;padding:3px 8px;">เหลือ/ขาด (kWh)</th>
        <th style="text-align:left;padding:3px 8px;">สถานะ</th>
      </tr></thead>
      <tbody>${sellers}<tr><td colspan="4" style="height:5px;"></td></tr>${buyers}</tbody>
    </table>`;
    }

    // ---- proof that no pair was re-arranged ----------------------------------
    function comparison(rm) {
        const c = rm.comparison || {};
        const line = (arr, color, icon, label) => (arr || []).length ? `
      <div style="margin-top:5px;color:${color};font-size:.86em;">
        ${icon} <b>${label} (${arr.length})</b>: ${arr.map(t =>
            S2.esc(t.seller) + "→" + S2.esc(t.buyer) + ` ${S2.f(t.qty_kwh)} kWh`).join(" · ")}
      </div>` : "";
        const clean = !(c.changed || []).length && !(c.added || []).length;
        return `
      <div style="margin-top:10px;padding:10px 12px;border-radius:8px;
                  background:rgba(255,255,255,.03);">
        <b style="color:#e2e8f0;font-size:.9em;">เทียบกับการจับคู่เดิม
          (${c.n_trades_before} → ${c.n_trades_after} คู่ที่ส่งมอบ)</b>
        ${line(c.unchanged, GREEN, "✅", "คงเดิมทุกประการ")}
        ${line(c.cancelled, VIOLET, "⛔", "ยกเลิก (ผู้ขายถูก zero-export)")}
        ${line(c.changed, AMBER, "🔄", "ปริมาณเปลี่ยน")}
        ${line(c.added, BLUE, "➕", "คู่ใหม่")}
        <div style="margin-top:7px;padding:7px 9px;border-radius:6px;font-size:.85em;
                    background:${clean ? "rgba(34,197,94,.08)" : "rgba(239,68,68,.10)"};
                    color:${clean ? GREEN : RED};">
          ${clean
                ? "✅ ไม่มีการจับคู่ใหม่ — ไม่มีคู่ไหนถูกเปลี่ยนปริมาณหรือเปลี่ยนคู่ค้า"
                : "❌ ผิดเงื่อนไข: พบการจัดคู่ใหม่ ทั้งที่ระบบต้องล็อกการจับคู่ไว้"}
        </div>
      </div>`;
    }

    // ---- PENDING ENERGY LEDGER — kWh ONLY ------------------------------------
    // Both tables show energy quantities and nothing else. No price column, no
    // baht column, no derived cost. The monetary settlement rule for either side
    // has not been decided, so the UI must not imply one exists.
    function settlementLedger(rm) {
        const st = rm.settlement || {};
        const claims = st.buyer_energy_shortfall || st.buyer_compensation_claims || [];
        const liabs = st.seller_energy_undelivered || st.seller_liabilities || [];
        if (!claims.length && !liabs.length) return "";

        const PENDING = st.pending_note_th || "จะทำการคิดการชำระเงินเพิ่มเติมภายหลัง";

        const claimRows = claims.map(x => `
      <tr style="border-top:1px solid rgba(255,255,255,.06);">
        <td style="padding:4px 8px;"><b>${S2.esc(x.buyer)}</b>
          <span style="color:${GREY};font-size:.85em;"> (คู่กับ ${S2.esc(x.seller)})</span></td>
        <td style="padding:4px 8px;text-align:right;color:${AMBER};">
          <b>${S2.f(x.shortfall_kwh)}</b></td>
        <td style="padding:4px 8px;font-size:.88em;color:${GREY};">${S2.esc(PENDING)}</td>
      </tr>`).join("");

        const liabRows = liabs.map(x => `
      <tr style="border-top:1px solid rgba(255,255,255,.06);">
        <td style="padding:4px 8px;"><b>${S2.esc(x.seller)}</b>
          <span style="color:${GREY};font-size:.85em;"> Bus ${x.bus}</span></td>
        <td style="padding:4px 8px;text-align:right;">${S2.f(x.declared_kwh)}</td>
        <td style="padding:4px 8px;text-align:right;color:${VIOLET};">${S2.f(x.delivered_kwh)}</td>
        <td style="padding:4px 8px;text-align:right;color:${VIOLET};">
          ${S2.f(x.undelivered_p2p_kwh != null ? x.undelivered_p2p_kwh : x.undelivered_kwh)}</td>
        <td style="padding:4px 8px;text-align:right;color:${VIOLET};">
          <b>${S2.f(x.undelivered_total_kwh != null ? x.undelivered_total_kwh : x.declared_kwh)}</b></td>
        <td style="padding:4px 8px;font-size:.88em;color:${GREY};">${S2.esc(PENDING)}</td>
      </tr>`).join("");

        return `
      <div style="margin-top:12px;padding:11px 13px;border-radius:9px;
                  background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.28);">
        <div style="font-weight:700;color:${AMBER};font-size:.94em;">
          📒 บัญชีพลังงานค้าง (ปริมาณเท่านั้น)</div>
        <div style="font-size:.82em;color:${GREY};margin-top:2px;">
          บันทึกไว้เป็น <b>kWh</b> อย่างเดียว — ไม่มีการคิดเงินในขั้นนี้
        </div>

        ${claims.length ? `
        <div style="margin-top:9px;font-weight:700;color:#e2e8f0;font-size:.88em;">
          🛒 ผู้ซื้อที่ได้พลังงานไม่ครบ</div>
        <table style="width:100%;border-collapse:collapse;font-size:.84em;color:#e2e8f0;">
          <thead><tr style="color:${GREY};font-size:.86em;">
            <th style="text-align:left;padding:3px 8px;">ผู้ซื้อ</th>
            <th style="text-align:right;padding:3px 8px;">พลังงานที่ขาด (kWh)</th>
            <th style="text-align:left;padding:3px 8px;">หมายเหตุ</th>
          </tr></thead><tbody>${claimRows}</tbody></table>` : `
        <div style="margin-top:9px;font-size:.86em;color:${GREEN};">
          ✅ รอบนี้ไม่มีผู้ซื้อได้รับผลกระทบ — ผู้ขายที่ถูกตัดไม่มีคู่ค้าที่ต้องส่งมอบ
        </div>`}

        <div style="margin-top:11px;font-weight:700;color:#e2e8f0;font-size:.88em;">
          ⚡ ผู้ขายที่ถูก zero-export</div>
        <table style="width:100%;border-collapse:collapse;font-size:.84em;color:#e2e8f0;">
          <thead><tr style="color:${GREY};font-size:.86em;">
            <th style="text-align:left;padding:3px 8px;">ผู้ขาย</th>
            <th style="text-align:right;padding:3px 8px;">ประกาศ (kWh)</th>
            <th style="text-align:right;padding:3px 8px;">ส่งมอบจริง (kWh)</th>
            <th style="text-align:right;padding:3px 8px;">ค้างส่งตามสัญญา P2P (kWh)</th>
            <th style="text-align:right;padding:3px 8px;">ไม่ได้ป้อนเข้าระบบรวม (kWh)</th>
            <th style="text-align:left;padding:3px 8px;">หมายเหตุ</th>
          </tr></thead><tbody>${liabRows}</tbody></table>

        <div style="margin-top:8px;padding:7px 9px;border-radius:6px;
                    background:rgba(245,158,11,.10);font-size:.85em;color:#e2e8f0;">
          📌 <b>${S2.esc(PENDING)}</b> — สถานะปัจจุบัน
          <code>PENDING_SETTLEMENT</code> · ระบบบันทึกเฉพาะปริมาณพลังงาน
        </div>
      </div>`;
    }

    function postCurtailmentBlock(rm) {
        if (!rm) return "";
        if (rm.error) {
            return `<div style="margin-top:12px;color:${RED};">
        ❌ ประมวลผลหลังตัดไม่สำเร็จ: ${S2.esc(rm.error)}</div>`;
        }
        const pf = rm.power_flow || {};
        const lbl = rm.case_labels || {};
        return `
      <div style="margin-top:14px;padding:14px 16px;border-radius:10px;
                  background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.30);">
        <div style="font-weight:700;color:${BLUE};font-size:1em;">
          🔁 ผลการส่งมอบหลังแก้ไข — ผู้เข้าร่วม ${rm.participants_after}/${rm.participants_before} ราย
        </div>
        <div style="font-size:.83em;color:${GREY};margin-top:2px;">
          ${S2.esc(rm.sellers_removed.join(", "))} ถูก zero-export จึงไม่ส่งมอบพลังงาน
          — ผู้ขายที่เหลือ ${S2.esc((rm.sellers_kept || []).join(", "))}
          และผู้ซื้อครบทั้ง ${(rm.buyers || []).length} ราย
        </div>

        <!-- the rule the user insisted on, stated where it cannot be missed -->
        <div style="margin-top:9px;padding:9px 11px;border-radius:8px;
                    background:rgba(34,197,94,.07);border-left:3px solid ${GREEN};
                    font-size:.85em;color:#e2e8f0;">
          🔒 <b style="color:${GREEN};">การจับคู่ถูกล็อกไว้ ไม่มีการจับคู่ใหม่</b> —
          การจับคู่เกิดขึ้นตั้งแต่ขั้นป้อน input ส่วน Safety 2 เป็นเหตุการณ์ตอน
          <b>ส่งพลังงานจริงบนสาย</b> จึงยกเลิกเฉพาะคู่ของผู้ขายที่ถูกตัด
          คู่ค้ารายอื่น<b>คงเดิมทุกประการ ทั้งคู่สัญญา ปริมาณ และราคา</b>
        </div>

        <div style="margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
          ${pfMini(lbl.BASE || "BASE", pf.base)}
          ${pfMini(lbl.PRE_MATCH || "PRE_MATCH", pf.pre_match)}
          ${pfMini(lbl.POST_MATCH || "POST_MATCH", pf.post_match)}
        </div>

        <div style="margin-top:12px;font-weight:700;color:#e2e8f0;font-size:.9em;">
          🔄 สมุดคำสั่งซื้อขาย (คู่เดิมทั้งหมด พร้อมสถานะการส่งมอบ)</div>
        <div style="margin-top:5px;">${tradeTable(rm)}</div>

        <div style="margin-top:12px;font-weight:700;color:#e2e8f0;font-size:.9em;">
          👥 สถานะผู้เข้าร่วมทุกราย</div>
        <div style="margin-top:5px;">${participantTable(rm)}</div>

        ${comparison(rm)}
        ${settlementLedger(rm)}
        ${zeCallout(rm.zero_export_audit)}
      </div>`;
    }

    function resultBlock(r) {
        if (r.error) {
            return `<div style="color:${RED};margin-top:10px;">
        ❌ เรียก Safety 2 ไม่สำเร็จ: ${S2.esc(r.error)}</div>`;
        }
        const head = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;">
        <div style="padding:9px 11px;border-radius:8px;background:rgba(239,68,68,.08);
                    border-left:3px solid ${RED};">
          <div style="font-size:.75em;color:${GREY};">ก่อนแก้ไข</div>
          <div style="font-size:1.25em;font-weight:800;color:${RED};">
            ${S2.f(r.initial.vmax, 5)} <span style="font-size:.5em;">p.u.</span></div>
          <div style="font-size:.82em;">บัสที่เกิน ${r.initial.n_over} จุด
            ${r.initial.over_buses.length ? "(" + r.initial.over_buses.join(", ") + ")" : ""}</div>
        </div>
        <div style="padding:9px 11px;border-radius:8px;background:rgba(34,197,94,.08);
                    border-left:3px solid ${r.resolved ? GREEN : AMBER};">
          <div style="font-size:.75em;color:${GREY};">หลังแก้ไข</div>
          <div style="font-size:1.25em;font-weight:800;color:${r.resolved ? GREEN : AMBER};">
            ${S2.f(r.final.vmax, 5)} <span style="font-size:.5em;">p.u.</span></div>
          <div style="font-size:.82em;">${r.resolved
                ? "✅ ไม่มีบัสแรงดันเกินแล้ว"
                : "⚠️ ยังเหลือ " + r.final.n_over + " จุด"}</div>
        </div>
      </div>`;

        const steps = (r.steps || []).map((st, i) => `
      <div style="margin-top:10px;">
        <div style="font-weight:700;color:#e2e8f0;font-size:.9em;">
          รอบที่ ${i + 1} — ตัด <span style="color:${RED};">${S2.esc(st.cut)}</span>
          <span style="font-weight:400;color:${GREY};">
            (Vmax ${S2.f(st.before.vmax, 5)} →
             ${st.after.converged ? S2.f(st.after.vmax, 5) : "ไม่ลู่เข้า"})</span>
        </div>
        ${rankingTable(st)}
      </div>`).join("");

        const d = r.dispatch || {};
        const dispatch = `
      <div style="margin-top:10px;font-size:.86em;color:#cbd5e1;">
        📦 <b>คำสั่งจ่ายพลังงานหลังแก้ไข</b> —
        คู่ซื้อขายที่เดินต่อ ${d.n_trades_after}/${d.n_trades_before} คู่ ·
        พลังงาน P2P ${S2.f(d.p2p_kwh_before)} → <b>${S2.f(d.p2p_kwh_after)}</b> kWh ·
        ใช้ AC power flow ${r.power_flows} ครั้ง (${r.elapsed_s} วินาที)
      </div>`;

        const notes = (r.notifications || []).map(notice).join("");
        const adv = (r.advisories || []).map(a => `
      <div style="margin-top:8px;padding:8px 10px;border-radius:7px;
                  background:rgba(245,158,11,.07);color:#e2e8f0;font-size:.85em;">
        ${S2.esc(a.headline_th)} — ดู <code>${S2.esc(a.doc)}</code></div>`).join("");

        return head + steps + dispatch + notes + adv + postCurtailmentBlock(r.post_curtailment || r.rematch);
    }

    S2.register({
        id: "over-voltage",
        matches: (ctx) => (ctx.problems || []).some(p => p.type === "over-voltage"),
        render: (ctx) => {
            const p = (ctx.problems || []).find(x => x.type === "over-voltage");
            const body = `
        <div style="margin-bottom:8px;">
          <b>ตรวจพบ:</b> ${S2.esc(p.detail)} · เกณฑ์ ${S2.esc(p.limit)}<br>
          <b>บัสที่เกิน:</b> ${(p.buses || []).join(", ") || "—"}
        </div>
        ${explainer()}
        ${ctx.result
                    ? resultBlock(ctx.result)
                    : `<button class="btn btn-primary" ${ctx.busy ? "disabled" : ""}
               onclick="Safety2.resolve()">
               ${ctx.busy ? "⏳ กำลังรัน power flow…"
                        : "▶ รัน Safety 2 (Zero-Export อัตโนมัติ)"}
             </button>`}`;
            return S2.card(RED, "🔺 เคสที่ 1 — Over-voltage (V > 1.05 p.u.) · แก้ไขอัตโนมัติ", body);
        },
    });
})();