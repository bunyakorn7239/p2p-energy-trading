// ===========================================================================
// safety2/underVoltage.js — CASE 2: UNDER-VOLTAGE  (ADVISORY ONLY)
//
// No automatic action is taken. On this feeder under-voltage is a very
// low-probability event: the P2P market only runs while PV is generating, and
// that generation sits NEXT TO the load, so it RAISES Vmin instead of lowering
// it. Full reasoning: docs/02_under_voltage.md
// ===========================================================================
(function () {
    "use strict";
    const S2 = window.Safety2;
    if (!S2) return;

    const BLUE = "#3b82f6", GREY = "#94a3b8";

    S2.register({
        id: "under-voltage",
        matches: (ctx) => (ctx.problems || []).some(p => p.type === "under-voltage"),
        render: (ctx) => {
            const p = (ctx.problems || []).find(x => x.type === "under-voltage");
            const body = `
        <div style="margin-bottom:8px;">
          <b>ตรวจพบ:</b> ${S2.esc(p.detail)} · เกณฑ์ ${S2.esc(p.limit)}<br>
          <b>บัสที่ต่ำกว่าเกณฑ์:</b> ${(p.buses || []).join(", ") || "—"}
        </div>

        <div style="padding:10px 12px;border-radius:8px;background:rgba(59,130,246,.07);
                    border:1px dashed rgba(59,130,246,.35);margin-bottom:10px;">
          <b style="color:${BLUE};">สถานะ: แจ้งเตือนอย่างเดียว (advisory) —
          ระบบไม่แก้ไขอัตโนมัติ</b>
          <div style="margin-top:6px;color:#cbd5e1;">
            เคสนี้<b>เกิดขึ้นได้ยากมาก</b>ในระบบ P2P นี้ เพราะตลาดเปิดเฉพาะช่วง
            กลางวันที่ PV ผลิตไฟ พลังงานถูกฉีดเข้า<b>ใกล้จุดโหลด</b>
            กระแสที่ต้องไหลมาจากหม้อแปลงจึงลดลง แรงดันตกคร่อมสาย
            (<code>ΔV ≈ (R·P + X·Q)/V</code>) ลดตาม
            ผลคือการซื้อขาย P2P <b>ยก Vmin ให้สูงขึ้น</b> ไม่ใช่กดให้ต่ำลง
            <br>จากการทดสอบบนเน็ตเวิร์กนี้ ต้องใช้โหลดผู้ซื้อราว
            <b>10 เท่าของโปรไฟล์จริง</b> (Σload ≈ 61.9 kWh, ไม่มี PV เลย)
            แรงดันจึงจะแตะ 0.95 p.u. โดยจุดที่ต่ำสุดคือปลายกิ่ง Bus 18/19/20/22
          </div>
        </div>

        <b style="color:#e2e8f0;">ถ้าเกิดขึ้นจริง แก้ไขอย่างไร</b>
        <ul style="margin:6px 0 0 18px;padding:0;">
          <li><b>จำกัดการใช้โหลด (load limiting / demand response)</b> ที่บัส
              ซึ่งแรงดันต่ำสุด — ลดกำลังที่ดึงลงจนแรงดันกลับเข้ากรอบ</li>
          <li><b>ย้ายการจับคู่ไปยังโซนที่มี PV สูง</b> ให้แหล่งจ่ายอยู่ใกล้โหลด
              ลดระยะทางไฟฟ้า (electrical distance) ที่กระแสต้องเดินทาง</li>
        </ul>
        <div style="margin-top:8px;color:${GREY};font-size:.9em;">
          รายละเอียดเต็ม: <code>docs/02_under_voltage.md</code>
        </div>`;
            return S2.card(BLUE, "🔻 เคสที่ 2 — Under-voltage (V < 0.95 p.u.) · แจ้งเตือนอย่างเดียว", body);
        },
    });
})();