// ===========================================================================
// liveRange.js — LIVE feasible-range panel
//
// Self-contained. It does NOT modify app.js, state, or any existing function.
// It watches window.state.sellerKwh / buyerKwh on a timer and re-queries
// /api/energy_range_live whenever the numbers actually change.
//
// Install: ONE <script> tag in index.html, after app.js. The panel injects
// itself directly below #energy-range-banner and re-creates itself whenever
// app.js re-renders the inputs tab. Nothing else changes.
//
// The fixed banner (#energy-range-banner, from /api/energy_range) keeps showing
// the reference caps computed for an EQUAL split. This panel shows the caps for
// the distribution the user has actually typed, which is generally different:
// energy concentrated at the feeder end hits the voltage limit sooner.
// ===========================================================================
(function () {
    "use strict";

    const DEBOUNCE_MS = 600;     // wait until typing stops
    const POLL_MS = 400;     // how often to look for a change
    const EP = "/api/energy_range_live";

    let lastKey = null, timer = null, busy = false, seq = 0;

    const backend = () =>
        (typeof BACKEND !== "undefined" && BACKEND) ? BACKEND : "";

    const f2 = (v) =>
        (typeof v === "number" && isFinite(v)) ? v.toFixed(2) : "—";

    // app.js declares its globals with `let` / `const`, NOT `var`. Those create
    // bindings in the global LEXICAL environment and are therefore NOT properties
    // of `window`: `window.state` is undefined even though the bare identifier
    // `state` is perfectly reachable from this script. Reading `window.state` was
    // the bug that stopped this panel from ever appearing - snapshot() returned
    // null on every tick, so the watcher never fired and the panel was never
    // created. Read the bare identifier instead, guarded in case app.js is absent.
    function findState() {
        try {
            if (typeof state !== "undefined" && state && state.sellerKwh) return state;
        } catch (_) { }
        if (window.state && window.state.sellerKwh) return window.state;
        return null;
    }

    function snapshot() {
        const st = findState();
        if (!st || !st.sellerKwh || !st.buyerKwh) return null;
        return { seller: { ...st.sellerKwh }, buyer: { ...st.buyerKwh } };
    }

    // ---- rendering ----------------------------------------------------------
    const GREEN = "#22c55e", AMBER = "#f59e0b", RED = "#ef4444", GREY = "#94a3b8";

    function bar(used, cap, color) {
        const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
        return `<div style="height:7px;border-radius:4px;background:rgba(255,255,255,.10);overflow:hidden;margin-top:6px;">
      <div style="height:100%;width:${pct.toFixed(1)}%;background:${color};"></div></div>`;
    }

    function sideBlock(title, icon, used, cap, headroom, util, perCap, limitLabel) {
        const color = util == null ? GREY : util >= 100 ? RED : util >= 85 ? AMBER : GREEN;
        const rows = Object.keys(perCap || {}).map((k) => {
            const c = perCap[k];
            return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:.82em;padding:2px 0;">
        <span style="color:#cbd5e1;">${k}</span>
        <span style="color:${color};font-weight:700;">${f2(c)}<span style="color:${GREY};font-weight:500;"> kWh max</span></span>
      </div>`;
        }).join("");
        return `
      <div style="padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.04);
                  border:1px solid rgba(255,255,255,.08);border-left:4px solid ${color};">
        <div style="font-weight:700;color:#e2e8f0;margin-bottom:2px;">${icon} ${title}</div>
        <div style="font-size:.72em;color:${GREY};margin-bottom:8px;">${limitLabel}</div>
        <div style="font-size:1.45em;font-weight:800;color:${color};line-height:1.1;">
          ${f2(used)} <span style="font-size:.5em;color:${GREY};font-weight:600;">/ ${f2(cap)} kWh</span>
        </div>
        ${bar(used, cap, color)}
        <div style="font-size:.82em;color:#cbd5e1;margin-top:7px;">
          เหลือ <b style="color:${color};">${f2(headroom)}</b> kWh
          ${util != null ? ` · ใช้ไป <b>${util.toFixed(1)}%</b>` : ""}
        </div>
        <div style="margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07);">${rows}</div>
      </div>`;
    }

    // The banner lives inside #tab-inputs, which app.js re-renders wholesale, so
    // the panel is (re-)created on demand instead of being hard-coded in the HTML.
    function ensurePanel() {
        let el = document.getElementById("live-range-panel");
        if (el && el.isConnected) return el;
        const anchor = document.getElementById("energy-range-banner");
        if (!anchor) return null;
        el = document.createElement("div");
        el.id = "live-range-panel";
        el.style.marginTop = "12px";
        anchor.insertAdjacentElement("afterend", el);
        return el;
    }

    function render(d) {
        const el = ensurePanel();
        if (!el) return;

        if (d === "loading") {
            el.innerHTML = `<div style="padding:14px;border-radius:12px;background:rgba(15,27,45,.6);
        border:1px solid rgba(255,255,255,.10);color:#cbd5e1;">
        ⏳ กำลังรัน binary search ใหม่ตามค่าที่ป้อน…</div>`;
            return;
        }
        if (d === "error") {
            el.innerHTML = `<div style="padding:14px;border-radius:12px;background:rgba(15,27,45,.6);
        border:1px solid rgba(255,255,255,.10);color:#fca5a5;">
        ⚠️ ไม่สามารถคำนวณ live range ได้ (backend ไม่ตอบ)</div>`;
            return;
        }

        const now = d.now || {};
        const bad = (now.n_over || 0) + (now.n_under || 0) + (now.n_thermal || 0);
        const statusColor = bad ? RED : GREEN;
        const statusText = bad
            ? `❌ ละเมิด — ${d.binding}${(now.over_buses || []).length ? " ที่บัส " + now.over_buses.join(", ") : ""}${(now.under_buses || []).length ? " ที่บัส " + now.under_buses.join(", ") : ""}`
            : "✅ ผ่านทุกเงื่อนไข";

        el.innerHTML = `
      <div style="padding:16px 18px;border-radius:12px;background:rgba(15,27,45,.6);
                  border:1px solid rgba(255,255,255,.10);">
        <div style="display:flex;justify-content:space-between;align-items:baseline;
                    flex-wrap:wrap;gap:8px;margin-bottom:4px;">
          <div style="font-weight:700;font-size:1.1em;color:#e2e8f0;">
            🔄 Live Feasible Range — คำนวณใหม่จากค่าที่ป้อนจริง
          </div>
          <div style="font-size:.75em;color:${GREY};">
            ${d.power_flows} power flows${d.cached ? " · cached" : ""}
          </div>
        </div>
        <div style="font-size:.8em;color:${GREY};margin-bottom:12px;">
          ต่างจากแถบด้านบน: แถบบนคิดจากการ<b>แบ่งเท่ากัน</b> ส่วนแถบนี้คิดจาก<b>สัดส่วนที่ป้อนจริง</b>
        </div>

        <div style="padding:9px 12px;border-radius:8px;margin-bottom:12px;
                    background:rgba(255,255,255,.04);border-left:4px solid ${statusColor};
                    color:${statusColor};font-weight:700;font-size:.92em;">
          ${statusText}
          <span style="color:#cbd5e1;font-weight:500;margin-left:10px;">
            Vmax ${(now.vmax ?? 0).toFixed(5)} · Vmin ${(now.vmin ?? 0).toFixed(5)}
            · loading ${(now.loading ?? 0).toFixed(1)}%
          </span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          ${sideBlock("ผู้ขาย (Seller)", "🔆",
            d.seller_input_total, d.live_max_total_seller,
            d.seller_headroom_total, d.seller_utilisation_pct,
            d.live_max_per_seller, "เพดาน over-voltage · Vmax = 1.05 p.u.")}
          ${sideBlock("ผู้ซื้อ (Buyer)", "🏠",
                d.buyer_input_total, d.live_max_total_buyer,
                d.buyer_headroom_total, d.buyer_utilisation_pct,
                d.live_max_per_buyer, "เพดาน under-voltage · Vmin = 0.95 p.u.")}
        </div>
      </div>`;
    }

    // ---- fetching -----------------------------------------------------------
    async function refresh(snap) {
        const mine = ++seq;
        busy = true;
        render("loading");
        try {
            const res = await fetch(backend() + EP, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sellers: typeof SELLERS !== "undefined" ? SELLERS : undefined,
                    buyers: typeof BUYERS !== "undefined" ? BUYERS : undefined,
                    player_locations: typeof PLAYER_LOCATIONS !== "undefined" ? PLAYER_LOCATIONS : undefined,
                    seller_energy_kwh: snap.seller,
                    buyer_energy_kwh: snap.buyer,
                }),
            });
            const data = await res.json();
            if (mine === seq) {                     // ignore out-of-order replies
                render(data);
                window.liveRange = data;              // expose for other code / debugging
            }
        } catch (_) {
            if (mine === seq) render("error");
        } finally {
            busy = false;
        }
    }

    // Manual trigger, for debugging from the browser console: liveRangeRefresh()
    window.liveRangeRefresh = function () {
        const s = snapshot();
        console.log("[liveRange] snapshot:", s);
        if (s) refresh(s);
        else console.warn("[liveRange] cannot reach app.js state - is app.js loaded?");
        return s;
    };

    // ---- watcher ------------------------------------------------------------
    setInterval(() => {
        const snap = snapshot();
        if (!snap) return;
        const key = JSON.stringify(snap);
        if (key === lastKey) {
            // app.js may have re-rendered the tab and removed our panel; put it back.
            const el = document.getElementById("live-range-panel");
            if ((!el || !el.isConnected) && window.liveRange) render(window.liveRange);
            return;
        }
        lastKey = key;
        clearTimeout(timer);
        timer = setTimeout(() => { if (!busy) refresh(snap); }, DEBOUNCE_MS);
    }, POLL_MS);
})();