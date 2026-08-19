// ===========================================================================
// safety2/lineOverload.js — CASE 3: LINE OVERLOAD  (ADVISORY ONLY)
//
// No automatic action. On this feeder over-voltage ALWAYS binds first on the
// PV-export side (verified: over-V at 11 kWh/seller vs thermal at ~20 kWh/seller,
// by which point 17 buses are already over-voltage). Full reasoning + the
// parameter-scaling proof: docs/03_line_overload.md
// ===========================================================================
(function () {
    "use strict";
    const S2 = window.Safety2;
    if (!S2) return;

    const AMBER = "#f59e0b", GREY = "#94a3b8";

    S2.register({
        id: "line-overload",
        matches: (ctx) => (ctx.problems || []).some(
            p => p.type === "line-overload" || p.type === "transformer-overload"),
        render: (ctx) => {
            const p = (ctx.problems || []).find(
                x => x.type === "line-overload" || x.type === "transformer-overload");
            const body = `
        <div style="margin-bottom:8px;">
          <b>ตรวจพบ:</b> ${S2.esc(p.detail)} · เกณฑ์ ${S2.esc(p.limit)}
          <ul style="margin:5px 0 0 18px;font-size:.9em;color:#cbd5e1;">
            ${(p.items || []).slice(0, 6).map(i => `<li>${S2.esc(i)}</li>`).join("")}
          </ul>
        </div>

        <div style="padding:10px 12px;border-radius:8px;background:rgba(245,158,11,.07);
                    border:1px dashed rgba(245,158,11,.35);margin-bottom:10px;">
          <b style="color:${AMBER};">สถานะ: แจ้งเตือนอย่างเดียว (advisory) —
          ระบบไม่แก้ไขอัตโนมัติ</b>
          <div style="margin-top:6px;color:#cbd5e1;">
            ในระบบนี้ <b>over-voltage ชนก่อน line overload เสมอ</b> —
            ดันการฉีดแบบเท่ากันทุกราย over-voltage เกิดที่ ~11 kWh/ราย
            ส่วน line loading แตะ 100% ที่ ~20 kWh/ราย ซึ่งตอนนั้น
            มี 17 บัสแรงดันเกินไปแล้ว
            <br>ดังนั้นถ้า Safety 2 แก้ over-voltage สำเร็จ
            โหลดของสายมักจะ<b>ลดลงตามไปด้วยโดยอัตโนมัติ</b>
          </div>
        </div>

        <b style="color:#e2e8f0;">ถ้าเกิดขึ้นจริง จะเกิดที่ไหน</b>
        <div style="margin-top:5px;color:#cbd5e1;">
          ระบบ radial จะเกิด line overload ที่ <b>ต้นสาย</b> เสมอ คือสายที่ออกจาก
          <b>หม้อแปลง</b> (Line 0: Bus 1 → Bus 2) เพราะกระแสย้อนของผู้ขาย
          <b>ทุกราย</b>ไหลมารวมกันบนสายต้นทางเส้นเดียวก่อนขึ้นหม้อแปลง
          สายกิ่ง (lateral) แบกเฉพาะกระแสของตัวเองจึงไม่เคยเป็นเส้นที่เกินก่อน
        </div>

        <b style="display:block;margin-top:9px;color:#e2e8f0;">แนวทางแก้ (ถ้าจะทำ)</b>
        <ul style="margin:5px 0 0 18px;padding:0;color:#cbd5e1;">
          <li>ตั้งเพดานการส่งออกรวมที่จุด PCC / หม้อแปลง แล้วลดสัดส่วนผู้ขายแบบ
              <b>เท่า ๆ กัน</b> — เพราะค่าความไว <code>∂loading/∂P</code>
              ของผู้ขายทุกรายเกือบเท่ากัน (1.189–1.245 %/kWh)
              การถ่วงน้ำหนักตามตำแหน่งจึงไม่คุ้มความซับซ้อน (ต่างจากเคส over-voltage)</li>
        </ul>
        <div style="margin-top:8px;color:${GREY};font-size:.9em;">
          รายละเอียดเต็ม: <code>docs/03_line_overload.md</code>
        </div>`;
            return S2.card(AMBER, "🔌 เคสที่ 3 — Line / Transformer overload (>100%) · แจ้งเตือนอย่างเดียว", body);
        },
    });
})();