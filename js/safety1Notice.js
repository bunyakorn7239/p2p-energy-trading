// ===========================================================================
// safety1Notice.js — SAFETY LAYER 1 (ex-ante soft cap)
//
// WHAT IT ADDS
//   The binary-search cap (hard_per, from /api/energy_range) is already shown
//   in the red cell of the existing banner, but nothing tells the seller what
//   that number MEANS or what happens if they type past it. This panel does
//   exactly that, per seller, and nothing else.
//
// SOFT CAP — BY DESIGN
//   The number is a WARNING, not a hard block. The input keeps accepting a
//   larger value on purpose, because the whole point of Safety Layer 2 is to
//   demonstrate what the network does when a declaration is too large. If this
//   panel blocked the input, Safety 2 could never be exercised.
//
// SELF-CONTAINED
//   No edits to app.js, violationHandler.js, server.py or any existing file.
//   One <script> tag in index.html. The panel re-injects itself below
//   #energy-range-banner whenever app.js re-renders the Inputs tab — same
//   pattern liveRange.js already uses.
// ===========================================================================
(function () {
    "use strict";

    const POLL_MS = 400;
    const GREEN = "#22c55e", AMBER = "#f59e0b", RED = "#ef4444", GREY = "#94a3b8";

    // app.js declares its globals with let/const, so they are NOT properties of
    // `window` — but the bare identifier is reachable. Guarded reads only, exactly
    // like liveRange.js does (that was the bug that once broke the live panel).
    const G = {
        state: () => { try { return (typeof state !== "undefined") ? state : window.state; } catch (_) { return window.state; } },
        wf: () => { try { return (typeof wf !== "undefined") ? wf : window.wf; } catch (_) { return window.wf; } },
        sellers: () => { try { return (typeof SELLERS !== "undefined") ? SELLERS : window.SELLERS; } catch (_) { return window.SELLERS; } },
        locs: () => { try { return (typeof PLAYER_LOCATIONS !== "undefined") ? PLAYER_LOCATIONS : window.PLAYER_LOCATIONS; } catch (_) { return window.PLAYER_LOCATIONS; } },
    };
    const f2 = (v) => (typeof v === "number" && isFinite(v)) ? v.toFixed(2) : "—";

    function snapshot() {
        const st = G.state(), w = G.wf(), sellers = G.sellers();
        if (!st || !st.sellerKwh || !w || !sellers) return null;
        const er = w.energyRange || {};
        const cap = (typeof er.hard_per === "number" && isFinite(er.hard_per))
            ? er.hard_per : null;
        return {
            cap,
            capTotal: (typeof er.hard_total === "number") ? er.hard_total : null,
            sellers: sellers.slice(),
            kwh: { ...st.sellerKwh },
            locs: G.locs() || {},
        };
    }

    function ensurePanel() {
        let el = document.getElementById("safety1-panel");
        if (el && el.isConnected) return el;
        const anchor = document.getElementById("energy-range-banner");
        if (!anchor) return null;
        el = document.createElement("div");
        el.id = "safety1-panel";
        el.style.marginTop = "12px";
        anchor.insertAdjacentElement("afterend", el);
        return el;
    }

    function render(s) {
        const el = ensurePanel();
        if (!el) return;
        if (!s || s.cap == null) {
            el.innerHTML = `<div style="padding:14px;border-radius:12px;
        background:rgba(15,27,45,.6);border:1px solid rgba(255,255,255,.10);
        color:#cbd5e1;">⏳ กำลังโหลดค่าเพดาน Safety 1 จาก backend…</div>`;
            return;
        }

        const rows = s.sellers.map((p) => {
            const v = parseFloat(s.kwh[p]) || 0;
            const over = v > s.cap + 1e-9;
            const pct = s.cap > 0 ? (v / s.cap) * 100 : 0;
            const col = over ? RED : pct >= 90 ? AMBER : GREEN;
            return `<tr>
        <td style="padding:5px 8px;"><b style="color:#e2e8f0;">${p}</b>
          <span style="color:${GREY};font-size:.82em;"> ${s.locs[p] || ""}</span></td>
        <td style="padding:5px 8px;text-align:right;color:${col};font-weight:700;">${f2(v)}</td>
        <td style="padding:5px 8px;text-align:right;color:${GREY};">${f2(s.cap)}</td>
        <td style="padding:5px 8px;text-align:right;color:${col};font-weight:700;">${pct.toFixed(0)}%</td>
        <td style="padding:5px 8px;color:${col};font-size:.85em;">
          ${over ? `⛔ เกินเพดาน ${f2(v - s.cap)} kWh — ต้องผ่าน Safety 2`
                    : pct >= 90 ? "⚠️ ใกล้เพดาน" : "✅ อยู่ในเกณฑ์"}</td>
      </tr>`;
        }).join("");

        const totalIn = s.sellers.reduce((a, p) => a + (parseFloat(s.kwh[p]) || 0), 0);
        const nOver = s.sellers.filter(p => (parseFloat(s.kwh[p]) || 0) > s.cap + 1e-9).length;
        const banner = nOver
            ? `<div style="padding:10px 12px;border-radius:8px;margin-bottom:12px;
           background:rgba(239,68,68,.10);border-left:4px solid ${RED};color:${RED};
           font-weight:700;">
           ⛔ มีผู้ขาย ${nOver} ราย ป้อนค่าเกินเพดาน Safety 1 —
           ระบบยังยอมให้รันต่อได้ แต่จะถูกส่งต่อให้ Safety 2 ตรวจและแก้ไขอัตโนมัติ
         </div>`
            : `<div style="padding:10px 12px;border-radius:8px;margin-bottom:12px;
           background:rgba(34,197,94,.08);border-left:4px solid ${GREEN};color:${GREEN};
           font-weight:700;">✅ ทุกรายอยู่ในเพดาน Safety 1</div>`;

        el.innerHTML = `
      <div style="padding:16px 18px;border-radius:12px;background:rgba(15,27,45,.6);
                  border:1px solid rgba(255,255,255,.10);">
        <div style="font-weight:700;font-size:1.08em;color:#e2e8f0;margin-bottom:3px;">
          🛡️ Safety 1 — เพดานพลังงานต่อผู้ขาย (Binary Search)
        </div>
        <div style="font-size:.82em;color:${GREY};margin-bottom:12px;">
          ค่าที่ได้จากการรัน AC power flow ซ้ำ ๆ แบบ binary search จนถึงจุดที่
          Vmax = 1.05 p.u. พอดี → <b style="color:${RED};">${f2(s.cap)} kWh/ราย</b>
          (รวมทั้งระบบ ${f2(s.capTotal)} kWh)
        </div>

        ${banner}

        <table style="width:100%;border-collapse:collapse;font-size:.9em;">
          <thead><tr style="color:${GREY};font-size:.8em;text-transform:uppercase;">
            <th style="text-align:left;padding:4px 8px;">Seller</th>
            <th style="text-align:right;padding:4px 8px;">ป้อนจริง (kWh)</th>
            <th style="text-align:right;padding:4px 8px;">เพดาน (kWh)</th>
            <th style="text-align:right;padding:4px 8px;">ใช้ไป</th>
            <th style="text-align:left;padding:4px 8px;">สถานะ</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr style="border-top:1px solid rgba(255,255,255,.10);">
            <td style="padding:6px 8px;color:${GREY};">รวม</td>
            <td style="padding:6px 8px;text-align:right;font-weight:700;color:#e2e8f0;">${f2(totalIn)}</td>
            <td style="padding:6px 8px;text-align:right;color:${GREY};">${f2(s.capTotal)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>

        <!-- ── the note the seller must read ─────────────────────────────── -->
        <div style="margin-top:14px;padding:12px 14px;border-radius:9px;
                    background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.30);
                    font-size:.88em;line-height:1.65;color:#e2e8f0;">
          <div style="font-weight:700;color:${AMBER};margin-bottom:6px;">
            📌 หมายเหตุถึงผู้ขาย (Seller) — โปรดอ่านก่อนป้อนค่า
          </div>
          <ul style="margin:0 0 0 18px;padding:0;">
            <li><b>ค่า ${f2(s.cap)} kWh/ราย คืออะไร</b> — เป็นค่าที่ระบบรัน power flow
                ล่วงหน้าแล้วยืนยันว่า “ปลอดภัยในระดับแรก” คือไม่ทำให้แรงดันบัสใด
                หลุดกรอบ 0.95–1.05 p.u. <b style="color:${RED};">ห้ามป้อนเกินค่านี้</b></li>
            <li><b>ระบบยอมให้พิมพ์เกินได้</b> เพื่อการทดสอบ/จำลองเท่านั้น —
                แต่ค่าที่เกินจะไม่ได้รับการรับประกันว่าจะถูกส่งมอบครบ</li>
            <li><b style="color:${RED};">ถ้าป้อนเกินความเป็นจริง คุณอาจเสียผลประโยชน์</b> —
                เมื่อเกิด over-voltage ระบบจะสั่ง <b>zero-export</b> ที่ผู้ขายซึ่งมี
                อิทธิพลต่อแรงดันสูงสุดก่อน ผลคือ
                <b>อาจไม่ได้รับการจับคู่ซื้อขายเลยในรอบนั้น</b>
                และอาจถูก<b>คิดค่าธรรมเนียม/ค่าปรับเพิ่มเติม</b>
                กรณีที่พลังงานส่งมอบจริงต่างจากที่ประกาศไว้เกินกรอบ ±10%</li>
            <li>พลังงานที่ประกาศ = <b>กำลังไฟส่วนเกินสุทธิที่จุดเชื่อมต่อบ้าน</b>
                (net surplus at the connection point) หลังหักโหลดในบ้านแล้ว
                ไม่ใช่กำลังผลิตรวมของแผง PV</li>
          </ul>
        </div>
      </div>`;
    }

    // ---- watcher --------------------------------------------------------------
    let lastKey = null;
    setInterval(() => {
        const s = snapshot();
        if (!s) return;
        const key = JSON.stringify(s);
        const el = document.getElementById("safety1-panel");
        if (key === lastKey && el && el.isConnected) return;
        lastKey = key;
        render(s);
    }, POLL_MS);

    window.safety1Refresh = () => render(snapshot());
})();