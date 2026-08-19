// ===========================================================================
// safety2/overVoltage.js — CASE 1: OVER-VOLTAGE  (the only ACTIVE fix)
//
// RULE
//   V > 1.05 p.u.  ->  zero-export the seller with the LARGEST dVmax/dP,
//                      keep every other matched pair trading unchanged,
//                      re-run AC power flow, and if it is still over-voltage
//                      cut the NEXT most influential seller. Repeat.
//
// The loop itself runs in the backend (backend/violation_handler.py); this file
// only triggers it and renders the audit trail + the seller notification.
// ===========================================================================
(function () {
    "use strict";
    const S2 = window.Safety2;
    if (!S2) return;

    const RED = "#ef4444", GREEN = "#22c55e", AMBER = "#f59e0b", GREY = "#94a3b8";

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
        </ol>
        <div style="margin-top:8px;color:${GREY};font-size:.92em;">
          ทำไมไม่ตัด “ผู้ขายที่อยู่บนบัสที่แรงดันเกิน” — บัส 23/24 เป็นปลายตัน
          ที่<b>ไม่มีผู้ขายอยู่เลย</b> การจัดอันดับด้วย ∂Vmax/∂P จึงเป็นเกณฑ์เดียว
          ที่ใช้ได้เสมอ และเป็นเกณฑ์ที่ถูกต้องทางฟิสิกส์
          · รายละเอียด zero-export: <code>docs/01_zero_export.md</code>
        </div>
      </div>`;
    }

    function rankingTable(step) {
        const rows = step.ranking.map((r, i) => `
      <tr style="${i === 0 ? `background:rgba(239,68,68,.10);` : ""}">
        <td style="padding:4px 8px;">${i + 1}</td>
        <td style="padding:4px 8px;"><b>${S2.esc(r.seller)}</b>
          <span style="color:${GREY};"> Bus ${r.bus}</span></td>
        <td style="padding:4px 8px;text-align:right;">${S2.f(r.export_kwh)}</td>
        <td style="padding:4px 8px;text-align:right;font-family:monospace;">
          ${r.dVmax_dP.toFixed(6)}</td>
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
          ${S2.esc(n.title_th)}</div>
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
            ${r.initial.over_buses.length ? `(${r.initial.over_buses.join(", ")})` : ""}</div>
        </div>
        <div style="padding:9px 11px;border-radius:8px;background:rgba(34,197,94,.08);
                    border-left:3px solid ${r.resolved ? GREEN : AMBER};">
          <div style="font-size:.75em;color:${GREY};">หลังแก้ไข</div>
          <div style="font-size:1.25em;font-weight:800;color:${r.resolved ? GREEN : AMBER};">
            ${S2.f(r.final.vmax, 5)} <span style="font-size:.5em;">p.u.</span></div>
          <div style="font-size:.82em;">${r.resolved
                ? "✅ ไม่มีบัสแรงดันเกินแล้ว"
                : `⚠️ ยังเหลือ ${r.final.n_over} จุด`}</div>
        </div>
      </div>`;

        const steps = (r.steps || []).map((st, i) => `
      <div style="margin-top:10px;">
        <div style="font-weight:700;color:#e2e8f0;font-size:.9em;">
          รอบที่ ${i + 1} — ตัด <span style="color:${RED};">${S2.esc(st.cut)}</span>
          <span style="font-weight:400;color:${GREY};">
            (Vmax ${S2.f(st.before.vmax, 5)} → ${st.after.converged ? S2.f(st.after.vmax, 5) : "ไม่ลู่เข้า"})</span>
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

        return head + steps + dispatch + notes + adv;
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
               ${ctx.busy ? "⏳ กำลังรัน power flow…" : "▶ รัน Safety 2 (Zero-Export อัตโนมัติ)"}
             </button>`}`;
            return S2.card(RED, "🔺 เคสที่ 1 — Over-voltage (V > 1.05 p.u.) · แก้ไขอัตโนมัติ", body);
        },
    });
})();