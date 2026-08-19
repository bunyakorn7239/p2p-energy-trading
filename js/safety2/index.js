// ===========================================================================
// safety2/index.js — SAFETY LAYER 2 orchestrator
//
// SPLIT OF RESPONSIBILITY (this is the "แยกไฟล์ออกมา" part)
//   js/violationHandler.js          DETECT + CLASSIFY   (existing, UNCHANGED)
//   js/safety2/index.js             orchestrate + render the panel   (this file)
//   js/safety2/overVoltage.js       CASE 1 — active fix (zero-export)
//   js/safety2/underVoltage.js      CASE 2 — advisory only
//   js/safety2/lineOverload.js      CASE 3 — advisory only
//
// NO EDITS TO EXISTING FILES
//   The panel watches wf.step and injects itself into #tab-inputs whenever the
//   run is blocked. app.js re-renders that tab wholesale, so the panel is
//   re-created on demand — same self-healing pattern as liveRange.js.
//
// Each case module calls Safety2.register({ id, matches, render }) at load
// time. Adding a fourth case later = one new file + one <script> tag.
// ===========================================================================
(function () {
    "use strict";

    const POLL_MS = 400;

    const G = {
        wf: () => { try { return (typeof wf !== "undefined") ? wf : window.wf; } catch (_) { return window.wf; } },
        state: () => { try { return (typeof state !== "undefined") ? state : window.state; } catch (_) { return window.state; } },
        sellers: () => { try { return (typeof SELLERS !== "undefined") ? SELLERS : window.SELLERS; } catch (_) { return window.SELLERS; } },
        buyers: () => { try { return (typeof BUYERS !== "undefined") ? BUYERS : window.BUYERS; } catch (_) { return window.BUYERS; } },
        locs: () => { try { return (typeof PLAYER_LOCATIONS !== "undefined") ? PLAYER_LOCATIONS : window.PLAYER_LOCATIONS; } catch (_) { return window.PLAYER_LOCATIONS; } },
        backend: () => { try { return (typeof BACKEND !== "undefined" && BACKEND) ? BACKEND : ""; } catch (_) { return ""; } },
    };

    const S2 = {
        cases: [],
        result: null,      // last /api/violation/resolve response
        busy: false,
        G,
        register(c) { this.cases.push(c); },
        esc(s) {
            return String(s == null ? "" : s).replace(/[&<>"]/g, ch =>
                ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
        },
        f(v, d = 2) { return (typeof v === "number" && isFinite(v)) ? v.toFixed(d) : "—"; },
        card(color, title, bodyHtml) {
            return `<div style="margin-top:12px;padding:14px 16px;border-radius:10px;
        background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);
        border-left:4px solid ${color};">
        <div style="font-weight:700;color:${color};font-size:1em;margin-bottom:8px;">${title}</div>
        <div style="font-size:.89em;line-height:1.65;color:#e2e8f0;">${bodyHtml}</div>
      </div>`;
        },
    };
    window.Safety2 = S2;

    // ---- call the backend resolver -------------------------------------------
    S2.resolve = async function () {
        const w = G.wf(), st = G.state();
        if (!w || !w.apiResult || !st) return;
        if (S2.busy) return;
        S2.busy = true;
        S2.paint();
        try {
            const m = w.apiResult.matching || {};
            const trades = (m.logs || []).map(l => ({
                seller: l.seller, buyer: l.buyer, qty: l.qty, price: l.clearPrice,
            }));
            const res = await fetch(G.backend() + "/api/violation/resolve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sellers: G.sellers(), buyers: G.buyers(),
                    player_locations: G.locs(),
                    seller_energy_kwh: st.sellerKwh,
                    buyer_energy_kwh: st.buyerKwh,
                    seller_sold_kwh: m.soldKwh || {},
                    buyer_bought_kwh: m.boughtKwh || {},
                    // needed by PHASE 2 (re-matching the surviving participants) so the
                    // re-run uses the prices actually on the form, not the defaults
                    offering_price: st.offeringPrice || {},
                    bidding_price: st.biddingPrice || {},
                    apply_curtailment: true,   // phase 2: cancel curtailed trades, matching stays frozen
                    trades,
                }),
            });
            S2.result = await res.json();
            if (typeof logEvent === "function") {
                const cuts = (S2.result.curtailed || []).map(c => c.seller).join(", ");
                logEvent(S2.result.resolved
                    ? `🛡️ Safety 2 resolved: zero-export ${cuts || "(none needed)"} → Vmax ${S2.result.final.vmax}`
                    : `🛡️ Safety 2 could NOT clear the violation`);
            }
        } catch (e) {
            S2.result = { error: e.message };
        } finally {
            S2.busy = false;
            S2.paint();
        }
    };

    // ---- panel ---------------------------------------------------------------
    function ensurePanel() {
        let el = document.getElementById("safety2-panel");
        if (el && el.isConnected) return el;
        const host = document.getElementById("tab-inputs");
        if (!host) return null;
        el = document.createElement("div");
        el.id = "safety2-panel";
        el.style.margin = "14px 0";
        const anchor = host.querySelector(".wf-alert.alert-grid");
        if (anchor) anchor.insertAdjacentElement("afterend", el);
        else host.insertAdjacentElement("afterbegin", el);
        return el;
    }

    S2.paint = function () {
        const w = G.wf();
        const el = document.getElementById("safety2-panel");
        if (!w || w.step !== "blocked") { if (el) el.remove(); return; }
        const host = ensurePanel();
        if (!host) return;

        const post = (w.apiResult && w.apiResult.power_flow)
            ? w.apiResult.power_flow.post_match : null;
        const problems = w.pfProblems || [];
        const ctx = { post, problems, result: S2.result, busy: S2.busy };

        const bodies = S2.cases
            .filter(c => { try { return c.matches(ctx); } catch (_) { return false; } })
            .map(c => { try { return c.render(ctx); } catch (e) { return ""; } })
            .join("");

        host.innerHTML = `
      <div style="padding:16px 18px;border-radius:12px;background:rgba(15,27,45,.72);
                  border:1px solid rgba(255,255,255,.12);">
        <div style="font-weight:700;font-size:1.1em;color:#e2e8f0;">
          🛡️ Safety 2 — ชั้นแก้ไขปัญหาโครงข่าย (Violation Handler)
        </div>
        <div style="font-size:.82em;color:#94a3b8;margin-top:3px;">
          ทำงานหลังจับคู่แล้ว บนค่าที่วัดได้จริง — แก้เฉพาะชั้น power flow
          ไม่แตะผลการจับคู่ (CP matching) ของคู่ค้ารายอื่น
        </div>
        ${bodies || `<div style="margin-top:12px;color:#94a3b8;">
          ไม่พบเคสที่ Safety 2 รองรับ</div>`}
      </div>`;
    };

    // ---- watcher --------------------------------------------------------------
    let lastKey = null;
    setInterval(() => {
        const w = G.wf();
        if (!w) return;
        const key = JSON.stringify({
            step: w.step,
            probs: (w.pfProblems || []).map(p => p.type),
            res: S2.result ? (S2.result.final || S2.result.error) : null,
            busy: S2.busy,
        });
        const el = document.getElementById("safety2-panel");
        const missing = (w.step === "blocked") && (!el || !el.isConnected);
        if (key === lastKey && !missing) return;
        lastKey = key;
        if (w.step !== "blocked") S2.result = null;   // fresh run → drop stale result
        S2.paint();
    }, POLL_MS);
})();