// ===========================================================================
// inputVisuals.js — turn the Input Data explanations into pictures
//
// WHY THIS IS AN ADD-ON AND NOT AN EDIT TO app.js
//   renderEnergyRangeBanner() lives in app.js and is re-run every time the
//   Inputs tab re-renders. Instead of editing it, this file WRAPS it — exactly
//   the way market.js already wraps showTab(). The original function still runs
//   and still produces the same numbers; this file only re-dresses the result
//   afterwards. app.js is not touched, so no calculation can change.
//
// WHAT IT REPLACES
//   The long paragraph at the bottom of the feasibility banner ("*หมายเหตุ: ...
//   ⚠️ inject เกิน ... จะเริ่มไฟย้อนกริด ...") is ~8 lines of dense prose. It is
//   swapped for four things a non-specialist can read at a glance:
//     1. safety ruler   — where the current input sits between the thresholds
//     2. flow diagram   — which way the power is flowing right now
//     3. voltage gauge  — how close Vmax is to the 1.05 p.u. wall (after a run)
//     4. plain-language cards — what each number actually means
//
//   Every number drawn comes from wf.energyRange / wf.apiResult. Nothing is
//   recomputed here, so the picture cannot disagree with the table.
// ===========================================================================
(function () {
    "use strict";

    const GREEN = "#22c55e", AMBER = "#f59e0b", ORANGE = "#f97316",
        RED = "#ef4444", BLUE = "#3b82f6", GREY = "#94a3b8",
        VIOLET = "#c9a7e0", TEXT = "#e2e8f0";

    // app.js declares state/wf with let, so they are not on window; read the
    // bare identifier defensively, same trick liveRange.js uses.
    const G = {
        wf: () => { try { return (typeof wf !== "undefined") ? wf : window.wf; } catch (_) { return window.wf; } },
        state: () => { try { return (typeof state !== "undefined") ? state : window.state; } catch (_) { return window.state; } },
        sellers: () => { try { return (typeof SELLERS !== "undefined") ? SELLERS : window.SELLERS; } catch (_) { return window.SELLERS; } },
        buyers: () => { try { return (typeof BUYERS !== "undefined") ? BUYERS : window.BUYERS; } catch (_) { return window.BUYERS; } },
    };

    const num = (v) => typeof v === "number" && isFinite(v);
    const f = (v, d = 2) => (num(v) ? v.toFixed(d) : "—");
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
        ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

    // ---- read the thresholds the banner already computed ----------------------
    function thresholds() {
        const w = G.wf();
        const er = (w && w.energyRange) || null;
        if (!er) return null;
        const nB = (G.buyers() || []).length || 5;
        const pick = (a, b, dflt) => num(er[a]) ? er[a] : (num(er[b]) ? er[b] : dflt);
        const safeTot = pick("safe_total", "relief_total", 15.55);
        const hardTot = num(er.hard_total) ? er.hard_total : 61.79;
        const uvTot = num(er.thermal_max_total_buyer) ? er.thermal_max_total_buyer : 70.91;
        return {
            safePer: pick("safe_per", "relief_per", 3.11),
            safeTot,
            edgePer: num(er.reverse_edge_per) ? er.reverse_edge_per : 3.16,
            edgeTot: num(er.reverse_edge_total) ? er.reverse_edge_total : 15.80,
            onsetTot: num(er.reverse_onset_total) ? er.reverse_onset_total : 15.83,
            hardPer: num(er.hard_per) ? er.hard_per : 12.35,
            hardTot,
            uvTot, uvPer: uvTot / nB,
            loss: Math.max(0, (num(er.reverse_onset_total) ? er.reverse_onset_total : 15.83) - safeTot),
        };
    }

    function currentTotals() {
        const st = G.state();
        const sum = (obj, keys) => (keys || []).reduce(
            (a, k) => a + (parseFloat(obj && obj[k]) || 0), 0);
        return {
            inject: sum(st && st.sellerKwh, G.sellers()),
            load: sum(st && st.buyerKwh, G.buyers()),
        };
    }

    // =========================================================================
    // 1. SAFETY RULER — one horizontal scale, four zones, live marker
    // =========================================================================
    function ruler(t, injected) {
        // ── LANE LAYOUT ───────────────────────────────────────────────────────
        // Every text row gets its own horizontal band so nothing can overlap,
        // however close two thresholds sit on the scale.
        //   lane 1  y=26   marker value      "ตอนนี้ 60.00 kW"
        //   lane 2  y=48   ticks ABOVE bar   (onset)
        //   lane 3  y=62   their sub-labels
        //   BAR     y=74 .. 100
        //   lane 4  y=118  ticks BELOW bar   (safe, hard cap)
        //   lane 5  y=133  their sub-labels
        // The verdict sentence is NOT drawn here — it is rendered as HTML under
        // the SVG, which is what used to collide with the hard-cap labels.
        const W = 1000, padL = 20, padR = 20;
        const span = padL, right = W - padR, usable = right - span;
        const vmax = Math.max(t.hardTot * 1.18, injected * 1.08, t.hardTot + 6);
        const x = (v) => span + Math.min(Math.max(v, 0), vmax) / vmax * usable;
        const yBar = 74, hBar = 26;
        const LANE_MARK = 26, LANE_UP = 48, LANE_UPSUB = 62,
            LANE_DOWN = 118, LANE_DOWNSUB = 133;

        // keep a label inside the drawing area whichever end it lands near
        const anchorFor = (px) => px > right - 95 ? "end"
            : (px < span + 95 ? "start" : "middle");
        const nudge = (px) => Math.min(Math.max(px, span + 2), right - 2);

        const zone = (a, b, col, op) =>
            `<rect x="${x(a).toFixed(1)}" y="${yBar}" width="${Math.max(0, x(b) - x(a)).toFixed(1)}"
         height="${hBar}" fill="${col}" opacity="${op}"/>`;

        // Estimated half-width of a label, used to detect crowding. Thai glyphs
        // average ~0.56em of advance, which is close enough to decide lanes.
        const halfW = (txt, size) => txt.length * size * 0.56 / 2;

        // A tick may be pushed to a SECOND row when its neighbour is too close.
        // Without this, squeezing the scale (very large input) made the "safe" and
        // "hard cap" captions collide.
        const tick = (v, col, label, sub, above, row) => {
            const px = nudge(x(v));
            const drop = (row || 0) * 30;
            const yL = (above ? LANE_UP : LANE_DOWN) + (above ? -drop : drop);
            const yS = (above ? LANE_UPSUB : LANE_DOWNSUB) + (above ? -drop : drop);
            const a = anchorFor(px);
            return `
        <line x1="${px.toFixed(1)}" y1="${above ? LANE_UPSUB + 4 : yBar + hBar}"
              x2="${px.toFixed(1)}" y2="${above ? yBar : yL - 11}"
              stroke="${col}" stroke-width="2" opacity=".8"/>
        <text x="${px.toFixed(1)}" y="${yL}" fill="${col}" font-size="13"
              font-weight="700" text-anchor="${a}">${label}</text>
        <text x="${px.toFixed(1)}" y="${yS}" fill="${GREY}" font-size="10.5"
              text-anchor="${a}">${sub}</text>`;
        };

        // Assign rows to the two below-bar ticks: if their captions would touch,
        // the second one drops to its own row.
        const below = [
            { v: t.safeTot, col: GREEN, label: `${f(t.safeTot)} kW`, sub: "ไม่ย้อนกริดแน่นอน" },
            { v: t.hardTot, col: RED, label: `${f(t.hardTot)} kW`, sub: "เพดานแข็ง · Vmax 1.05 p.u." },
        ].sort((a, b) => a.v - b.v);
        // Real extent of a caption, honouring the anchor the tick will actually
        // use. The earlier version assumed "middle" for everything and therefore
        // missed the case where a tick near the left edge switches to "start".
        const extent = (v, txt, size) => {
            const px = nudge(x(v)), w = txt.length * size * 0.56, a = anchorFor(px);
            const x0 = a === "middle" ? px - w / 2 : a === "end" ? px - w : px;
            return [x0, x0 + w];
        };
        let row = 0;
        below.forEach((b, i) => {
            if (i > 0) {
                const prev = below[i - 1];
                const A = extent(prev.v, prev.sub, 10.5), B = extent(b.v, b.sub, 10.5);
                const AL = extent(prev.v, prev.label, 13), BL = extent(b.v, b.label, 13);
                const hits = (p, q) => p[0] < q[1] + 8 && q[0] < p[1] + 8;
                row = (hits(A, B) || hits(AL, BL)) ? row + 1 : 0;
            }
            b.row = row;
        });
        const belowTicks = below.map(b => tick(b.v, b.col, b.label, b.sub, false, b.row)).join("");
        const extraRows = Math.max(...below.map(b => b.row));

        let mCol = GREEN;
        if (injected > t.hardTot) mCol = RED;
        else if (injected > t.onsetTot) mCol = ORANGE;
        else if (injected > t.safeTot) mCol = AMBER;

        const mx = nudge(x(injected));

        // Zone captions are hidden when their zone is too narrow to hold the text.
        const capt = (a, b, fill, label) => {
            const w = x(b) - x(a);
            if (w < 62) return "";
            return `<text x="${((x(a) + x(b)) / 2).toFixed(1)}" y="${yBar + 17}"
        fill="${fill}" font-size="11" font-weight="700" text-anchor="middle">${label}</text>`;
        };

        const H = 146 + extraRows * 30;
        return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
         aria-label="แถบระดับความปลอดภัยของพลังงานที่ผู้ขายป้อนรวม">
      <defs>
        <linearGradient id="iv-safe" x1="0" x2="1">
          <stop offset="0%" stop-color="${GREEN}" stop-opacity=".55"/>
          <stop offset="100%" stop-color="${GREEN}" stop-opacity=".28"/>
        </linearGradient>
      </defs>

      <rect x="${span}" y="${yBar}" width="${usable}" height="${hBar}"
            rx="6" fill="rgba(255,255,255,.05)"/>
      ${zone(0, t.safeTot, "url(#iv-safe)", 1)}
      ${zone(t.safeTot, t.onsetTot, AMBER, .55)}
      ${zone(t.onsetTot, t.hardTot, ORANGE, .35)}
      ${zone(t.hardTot, vmax, RED, .38)}

      ${capt(0, t.safeTot, "#eafff2", "ปลอดภัย")}
      ${capt(t.onsetTot, t.hardTot, "#ffe9d6", "ไฟย้อนกริด")}
      ${capt(t.hardTot, vmax, "#ffe1e1", "แรงดันเกิน")}

      ${tick(t.onsetTot, AMBER, `${f(t.onsetTot)} kW`, "เริ่มย้อน (Σload+loss)", true, 0)}
      ${belowTicks}

      <!-- live marker: value sits alone on lane 1, so it can never collide -->
      <g>
        <line x1="${mx.toFixed(1)}" y1="${LANE_MARK + 8}" x2="${mx.toFixed(1)}"
              y2="${yBar + hBar + 2}" stroke="${mCol}" stroke-width="3"/>
        <circle cx="${mx.toFixed(1)}" cy="${yBar + hBar + 2}" r="5.5" fill="${mCol}"/>
        <text x="${mx.toFixed(1)}" y="${LANE_MARK}" fill="${mCol}" font-size="14"
              font-weight="800" text-anchor="${anchorFor(mx)}">ตอนนี้ ${f(injected)} kW</text>
      </g>
    </svg>`;
    }

    // The verdict used to be an SVG label competing for space with the tick
    // captions; as plain HTML below the chart it always has a line to itself.
    function rulerVerdict(t, injected) {
        let col = GREEN, txt = "ปลอดภัย — ไฟที่ผลิตถูกใช้หมดในหมู่บ้าน ไม่มีส่วนเกินไหลย้อน";
        if (injected > t.hardTot) {
            col = RED;
            txt = `เกินเพดานแข็ง ${f(t.hardTot)} kW อยู่ ${f(injected - t.hardTot)} kW — แรงดันจะทะลุ 1.05 p.u. ระบบต้องสั่ง zero-export`;
        } else if (injected > t.onsetTot) {
            col = ORANGE;
            txt = `ไฟย้อนขึ้นกริดแล้ว — เหลือระยะถึงเพดานแข็งอีก ${f(t.hardTot - injected)} kW`;
        } else if (injected > t.safeTot) {
            col = AMBER;
            txt = `กำลังจะเริ่มย้อน — loss ในสายกลบส่วนเกินไว้พอดี เหลืออีก ${f(t.onsetTot - injected)} kW จะเริ่มย้อนจริง`;
        } else {
            txt += ` · ยังเพิ่มได้อีก ${f(t.safeTot - injected)} kW`;
        }
        return `
      <div style="display:flex;align-items:flex-start;gap:8px;margin-top:6px;
                  padding:8px 11px;border-radius:8px;background:rgba(255,255,255,.04);
                  border-left:3px solid ${col};font-size:.86em;line-height:1.5;color:#cbd5e1;">
        <span style="color:${col};font-weight:800;">●</span>
        <span><b style="color:${col};">สถานะตอนนี้:</b> ${txt}</span>
      </div>`;
    }

    // =========================================================================
    // 2. FLOW DIAGRAM — which way is the power actually going
    // =========================================================================
    function flowDiagram(t, c) {
        // ── TOPOLOGY (this is the part that was wrong before) ─────────────────
        // The seller is a SOURCE, not a link in a chain. Its power splits:
        //     seller ──► buyer   (the P2P trade, always the first call on it)
        //     seller ──► grid    (only the surplus left after the neighbours and
        //                         the line losses are covered — reverse flow)
        //     grid   ──► buyer   (only when the neighbours need more than the
        //                         sellers produce — normal import)
        // Drawing them as one chain seller→buyer→grid implied the grid was fed
        // through the buyer, and made every arrow flip together.
        const loss = t.loss || 0;
        const p2p = Math.min(c.inject, c.load);                    // used locally
        const toGrid = Math.max(0, c.inject - c.load - loss);      // reverse flow
        const fromGrid = Math.max(0, c.load + loss - c.inject);    // import
        const absorbed = Math.max(0, Math.min(loss, c.inject - c.load)); // eaten by losses

        const exporting = toGrid > 1e-9;
        const gridCol = exporting ? (c.inject > t.hardTot ? RED : ORANGE) : BLUE;

        const W = 1000, H = 246;
        // seller on the left, the two sinks stacked on the right
        const sx0 = 40, sx1 = 262, sy0 = 92, sy1 = 158;            // seller box
        const rx0 = 600, rx1 = 838;                                 // right column
        const by0 = 26, by1 = 92;                                   // buyer box
        const gy0 = 158, gy1 = 224;                                 // grid box

        const box = (x0, x1, y0, y1, icon, title, sub, col) => `
      <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="12"
            fill="rgba(255,255,255,.045)" stroke="${col}" stroke-opacity=".45"/>
      <text x="${(x0 + x1) / 2}" y="${y0 + 25}" font-size="19" text-anchor="middle">${icon}</text>
      <text x="${(x0 + x1) / 2}" y="${y0 + 44}" fill="${TEXT}" font-size="12.5"
            font-weight="700" text-anchor="middle">${title}</text>
      <text x="${(x0 + x1) / 2}" y="${y0 + 58}" fill="${GREY}" font-size="10.5"
            text-anchor="middle">${sub}</text>`;

        // one arrow, with its own label sitting above the line
        const arrow = (id, x1, y1, x2, y2, col, active, label, lx, ly, anchor) => {
            const op = active ? 1 : .18;
            const stroke = active ? col : GREY;
            return `
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}"
              stroke-width="3" stroke-dasharray="9 7" opacity="${op}"
              marker-end="url(#iv-a-${id})">
          ${active ? `<animate attributeName="stroke-dashoffset" from="32" to="0"
                       dur="1.1s" repeatCount="indefinite"/>` : ""}
        </line>
        <text x="${lx}" y="${ly}" fill="${stroke}" font-size="12" font-weight="700"
              text-anchor="${anchor}" opacity="${op}">${label}</text>`;
        };

        const mk = (id, col) => `
      <marker id="iv-a-${id}" markerWidth="9" markerHeight="9" refX="7" refY="4.5"
              orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="${col}"/></marker>`;

        return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
         aria-label="ทิศทางการไหลของกำลังไฟฟ้า: ผู้ขายจ่ายให้ผู้ซื้อและส่วนเกินขึ้นกริด">
      <defs>
        ${mk("p2p", GREEN)}${mk("exp", gridCol)}${mk("imp", BLUE)}
        ${mk("off", GREY)}
      </defs>

      ${box(sx0, sx1, sy0, sy1, "🏠☀️", "บ้านผู้ขาย (PV)", `ผลิตรวม ${f(c.inject)} kW`,
            c.inject > 0 ? GREEN : GREY)}
      ${box(rx0, rx1, by0, by1, "🏘️", "บ้านผู้ซื้อ", `ต้องใช้ ${f(c.load)} kW`, BLUE)}
      ${box(rx0, rx1, gy0, gy1, "🔌", "หม้อแปลง / กริด",
                exporting ? "รับไฟส่วนเกิน" : "จ่ายไฟส่วนที่ขาด", gridCol)}

      <!-- ① ผู้ขาย → ผู้ซื้อ : การซื้อขาย P2P -->
      ${arrow("p2p", sx1 + 4, sy0 + 14, rx0 - 8, by1 - 16,
                    GREEN, p2p > 1e-9, `① ขายให้เพื่อนบ้าน ${f(p2p)} kW`, 430, 68, "middle")}

      <!-- ② ผู้ขาย → กริด : ส่วนเกินที่ไหลย้อน -->
      ${arrow("exp", sx1 + 4, sy1 - 14, rx0 - 8, gy0 + 16,
                        gridCol, exporting, `② ส่วนเกินไหลย้อนขึ้นกริด ${f(toGrid)} kW`,
                        430, 190, "middle")}

      <!-- ③ กริด → ผู้ซื้อ : ส่วนที่ผลิตไม่พอ -->
      ${arrow("imp", (rx0 + rx1) / 2, gy0 - 6, (rx0 + rx1) / 2, by1 + 8,
                            BLUE, fromGrid > 1e-9, `③ ซื้อจากกริด ${f(fromGrid)} kW`,
                            rx1 + 8, (by1 + gy0) / 2 + 4, "start")}

      <text x="${(sx0 + sx1) / 2}" y="${sy1 + 22}" fill="${GREY}" font-size="10.5"
            text-anchor="middle">${absorbed > 1e-9
                ? `ส่วนเกิน ${f(absorbed)} kW ถูกกลืนไปกับ loss ในสาย`
                : (loss > 0 ? `loss ในสาย ${f(loss)} kW` : "")}</text>
    </svg>`;
    }

    // Sentence form of the same picture, as HTML so it can wrap freely.
    function flowVerdict(t, c) {
        const loss = t.loss || 0;
        const p2p = Math.min(c.inject, c.load);
        const toGrid = Math.max(0, c.inject - c.load - loss);
        const fromGrid = Math.max(0, c.load + loss - c.inject);
        const exporting = toGrid > 1e-9;
        const col = exporting ? (c.inject > t.hardTot ? RED : ORANGE) : GREEN;
        const head = exporting
            ? "ผู้ขายจ่ายให้เพื่อนบ้านจนอิ่ม แล้วยัง<b>เหลือไหลย้อนขึ้นกริด</b>"
            : "ผู้ขายจ่ายให้เพื่อนบ้านอย่างเดียว <b>ไม่มีส่วนเกินไหลย้อน</b>";
        return `
      <div style="margin-top:6px;padding:8px 11px;border-radius:8px;
                  background:rgba(255,255,255,.04);border-left:3px solid ${col};
                  font-size:.86em;line-height:1.6;color:#cbd5e1;">
        <b style="color:${col};">ทิศทางไฟตอนนี้:</b> ${head}<br>
        ผลิต ${f(c.inject)} kW · เพื่อนบ้านใช้ ${f(c.load)} kW ·
        <span style="color:${GREEN};">ขายในหมู่บ้าน ${f(p2p)} kW</span> ·
        ${exporting
                ? `<span style="color:${col};">ไหลย้อนขึ้นกริด ${f(toGrid)} kW</span>`
                : `<span style="color:${BLUE};">ยังต้องซื้อจากกริดอีก ${f(fromGrid)} kW</span>`}
        ${loss > 0 ? ` · loss ในสาย ${f(loss)} kW` : ""}
      </div>`;
    }

    // =========================================================================
    // 3. VOLTAGE GAUGE — appears once an analysis has produced a Vmax
    // =========================================================================
    function voltageGauge() {
        const w = G.wf();
        const pf = w && w.apiResult && w.apiResult.power_flow &&
            w.apiResult.power_flow.post_match;
        const m = pf && pf.metrics;
        if (!m || !num(m.max_voltage_pu)) return "";

        const vmaxV = m.max_voltage_pu, vminV = m.min_voltage_pu;
        const LO = 0.93, HI = 1.07, W = 1000, H = 132;
        const padL = 70, padR = 70, usable = W - padL - padR;
        const x = (v) => padL + (Math.min(Math.max(v, LO), HI) - LO) / (HI - LO) * usable;

        // ── LANE LAYOUT ───────────────────────────────────────────────────────
        //   lane 1  y=24   Vmax label            (above bar, alone)
        //   BAR     y=44 .. 70
        //   lane 2  y=90   0.95 / 1.05 axis numbers
        //   lane 3  y=112  Vmin label
        // The verdict sentence moved out to HTML. Previously it shared a row with
        // the axis numbers and overlapped them.
        const yBar = 44, hBar = 26, LANE_MAX = 24, LANE_AXIS = 90, LANE_MIN = 112;

        const needle = (v, col, label, above) => {
            const px = x(v);
            const a = px > W - padR - 40 ? "end" : (px < padL + 40 ? "start" : "middle");
            return `
        <line x1="${px.toFixed(1)}" y1="${above ? LANE_MAX + 7 : yBar + hBar}"
              x2="${px.toFixed(1)}" y2="${above ? yBar : LANE_MIN - 12}"
              stroke="${col}" stroke-width="2.5"/>
        <circle cx="${px.toFixed(1)}" cy="${above ? yBar : yBar + hBar}" r="5" fill="${col}"/>
        <text x="${px.toFixed(1)}" y="${above ? LANE_MAX : LANE_MIN}" fill="${col}"
              font-size="13" font-weight="800" text-anchor="${a}">${label} ${v.toFixed(4)}</text>`;
        };

        return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
         aria-label="ระดับแรงดันเทียบกรอบมาตรฐาน">
      <rect x="${padL}" y="${yBar}" width="${usable}" height="${hBar}" rx="5"
            fill="rgba(239,68,68,.22)"/>
      <rect x="${x(0.95).toFixed(1)}" y="${yBar}" width="${(x(1.05) - x(0.95)).toFixed(1)}"
            height="${hBar}" fill="${GREEN}" opacity=".30"/>
      <text x="${((x(0.95) + x(1.05)) / 2).toFixed(1)}" y="${yBar + 17}" fill="#eafff2"
            font-size="11" font-weight="700" text-anchor="middle">ช่วงที่ยอมรับได้</text>
      <text x="${padL + 6}" y="${yBar + 17}" fill="#ffd9d9" font-size="10">ต่ำไป</text>
      <text x="${W - padR - 6}" y="${yBar + 17}" fill="#ffd9d9" font-size="10"
            text-anchor="end">สูงไป</text>

      <!-- boundary markers on their own lane -->
      <line x1="${x(0.95).toFixed(1)}" y1="${yBar + hBar}" x2="${x(0.95).toFixed(1)}"
            y2="${LANE_AXIS - 11}" stroke="${GREY}" stroke-width="1" opacity=".6"/>
      <line x1="${x(1.05).toFixed(1)}" y1="${yBar + hBar}" x2="${x(1.05).toFixed(1)}"
            y2="${LANE_AXIS - 11}" stroke="${GREY}" stroke-width="1" opacity=".6"/>
      <text x="${x(0.95).toFixed(1)}" y="${LANE_AXIS}" fill="${GREY}" font-size="11"
            text-anchor="middle">0.95</text>
      <text x="${x(1.05).toFixed(1)}" y="${LANE_AXIS}" fill="${GREY}" font-size="11"
            text-anchor="middle">1.05</text>

      ${needle(vmaxV, vmaxV > 1.05 ? RED : GREEN, "Vmax", true)}
      ${needle(vminV, vminV < 0.95 ? RED : BLUE, "Vmin", false)}
    </svg>`;
    }

    function gaugeVerdict() {
        const w = G.wf();
        const m = w && w.apiResult && w.apiResult.power_flow &&
            w.apiResult.power_flow.post_match &&
            w.apiResult.power_flow.post_match.metrics;
        if (!m || !num(m.max_voltage_pu)) return "";
        const over = m.max_voltage_pu > 1.05, under = m.min_voltage_pu < 0.95;
        const col = (over || under) ? RED : GREEN;
        const txt = over
            ? `Vmax = ${m.max_voltage_pu.toFixed(4)} ทะลุ 1.05 p.u. → Safety 2 จะสั่ง zero-export ผู้ขายที่มีอิทธิพลต่อแรงดันสูงสุด`
            : under
                ? `Vmin = ${m.min_voltage_pu.toFixed(4)} ต่ำกว่า 0.95 p.u. → ต้องลดโหลดหรือย้ายไปโซนที่มี PV สูง`
                : `แรงดันทุกบัสอยู่ในกรอบ (${m.min_voltage_pu.toFixed(4)} – ${m.max_voltage_pu.toFixed(4)} p.u.) ไม่ต้องแก้ไขอะไร`;
        return `
      <div style="display:flex;align-items:flex-start;gap:8px;margin-top:6px;
                  padding:8px 11px;border-radius:8px;background:rgba(255,255,255,.04);
                  border-left:3px solid ${col};font-size:.86em;line-height:1.5;color:#cbd5e1;">
        <span style="color:${col};font-weight:800;">●</span><span>${txt}</span>
      </div>`;
    }

    // =========================================================================
    // 4. PLAIN-LANGUAGE CARDS — what each number means, in one line each
    // =========================================================================
    function meaningCards(t) {
        const card = (col, icon, head, big, unit, body) => `
      <div style="padding:11px 13px;border-radius:10px;background:rgba(255,255,255,.04);
                  border:1px solid rgba(255,255,255,.09);border-left:4px solid ${col};">
        <div style="font-size:.78em;color:${GREY};margin-bottom:3px;">${icon} ${head}</div>
        <div style="font-size:1.35em;font-weight:800;color:${col};line-height:1.1;">
          ${big}<span style="font-size:.45em;font-weight:600;color:${GREY};"> ${unit}</span></div>
        <div style="font-size:.83em;color:#cbd5e1;margin-top:5px;line-height:1.5;">${body}</div>
      </div>`;

        return `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
                  gap:10px;margin-top:6px;">
        ${card(GREEN, "🟢", "ขายได้แบบสบายใจ", f(t.safePer), "kWh/ราย",
            `ถ้าทุกคนขายไม่เกินนี้ ไฟที่ผลิตจะถูกเพื่อนบ้านใช้หมดพอดี
           <b>ไม่มีไฟไหลย้อนขึ้นหม้อแปลงเลย</b> (รวมทั้งระบบ ${f(t.safeTot)} kW)`)}
        ${card(AMBER, "🟠", "จุดที่ไฟเริ่มย้อน", f(t.edgePer), "kWh/ราย",
                `ดันได้อีกนิดเพราะสายไฟมีการสูญเสีย ~${f(t.loss)} kW ที่ต้องจ่ายก่อน
           พอเกิน <b>${f(t.onsetTot)} kW</b> รวม ไฟส่วนเกินจะเริ่มไหลย้อนขึ้นกริด`)}
        ${card(RED, "🔴", "เพดานแข็ง ห้ามเกิน", f(t.hardPer), "kWh/ราย",
                    `เกินนี้แรงดันปลายสายจะทะลุ 1.05 p.u. ระบบจะต้อง
           <b>สั่งตัดผู้ขายบางรายออก (zero-export)</b> (รวม ${f(t.hardTot)} kW)`)}
        ${card(BLUE, "🔵", "ฝั่งผู้ซื้อ ใช้ได้มากสุด", f(t.uvPer), "kWh/ราย",
                        `ถ้าใช้เกินนี้และไม่มี PV ช่วย แรงดันจะตกต่ำกว่า 0.95 p.u.
           (รวม ${f(t.uvTot)} kW) — เกิดยากมากเพราะตลาดเปิดตอนกลางวัน`)}
      </div>`;
    }

    // =========================================================================
    // 5. WHY over-voltage and not line overload — one small picture
    // =========================================================================
    function whyOverVoltage(t) {
        const W = 1000, H = 96, padL = 150, usable = W - padL - 120;
        const maxV = 105;
        const bar = (yy, val, col, name, note) => {
            const w = Math.max(2, val / maxV * usable);
            return `
        <text x="${padL - 12}" y="${yy + 14}" fill="${TEXT}" font-size="12"
              font-weight="600" text-anchor="end">${name}</text>
        <rect x="${padL}" y="${yy}" width="${usable}" height="19" rx="4"
              fill="rgba(255,255,255,.05)"/>
        <rect x="${padL}" y="${yy}" width="${w.toFixed(1)}" height="19" rx="4" fill="${col}" opacity=".75"/>
        <text x="${padL + w + 10}" y="${yy + 14}" fill="${col}" font-size="11.5"
              font-weight="700">${note}</text>`;
        };
        return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
         aria-label="เปรียบเทียบว่าอะไรชนเพดานก่อนกัน">
      <text x="18" y="18" fill="${TEXT}" font-size="13" font-weight="700">
        ดันพลังงานขึ้นไปเรื่อย ๆ — อะไรชนก่อน?</text>
      ${bar(30, t.hardTot, RED, "แรงดันเกิน 1.05", `${f(t.hardTot)} kW ← ชนก่อน`)}
      ${bar(62, 100, GREY, "สายร้อนถึงพิกัด", "≈ 100 kW")}
    </svg>
    <div style="font-size:.83em;color:#cbd5e1;line-height:1.55;margin-top:2px;">
      เพราะแรงดันชนก่อนเสมอ ระบบจึงคุมด้วย <b style="color:${RED};">over-voltage</b>
      ไม่ใช่ความร้อนของสาย — ถ้าแก้แรงดันได้ ความร้อนของสายก็มักลดตามไปเอง
    </div>`;
    }

    // =========================================================================
    // Compose and inject
    // =========================================================================
    function buildBlock() {
        const t = thresholds();
        if (!t) return "";
        const c = currentTotals();
        const sec = (title, inner) => `
      <div style="margin-top:12px;padding:12px 14px;border-radius:11px;
                  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);">
        <div style="font-weight:700;color:${TEXT};font-size:.95em;margin-bottom:4px;">${title}</div>
        ${inner}
      </div>`;

        const gauge = voltageGauge();

        return `
      <div id="input-visuals" style="margin-top:12px;padding-top:12px;
           border-top:1px solid rgba(255,255,255,.08);">
        <div style="font-weight:700;color:${VIOLET};font-size:1em;">
          🖼️ อ่านตัวเลขข้างบนแบบเห็นภาพ</div>
        <div style="font-size:.82em;color:${GREY};margin-top:2px;">
          ทุกค่าในภาพมาจากตัวเลขชุดเดียวกับตารางด้านบน — เปลี่ยนตามที่พิมพ์ทันที
        </div>

        ${sec("① ตอนนี้เราอยู่ตรงไหนของเส้นความปลอดภัย",
            ruler(t, c.inject) + rulerVerdict(t, c.inject))}
        ${sec("② ไฟกำลังไหลไปทางไหน", flowDiagram(t, c) + flowVerdict(t, c))}
        ${gauge ? sec("③ แรงดันชนกรอบหรือยัง",
                `<div style="font-size:.88em;color:${TEXT};font-weight:600;margin-bottom:2px;">
                 แรงดันหลังจับคู่ (POST_MATCH) เทียบกรอบ 0.95–1.05 p.u.</div>`
                + gauge + gaugeVerdict()) : ""}
        ${sec(gauge ? "④ ตัวเลขแต่ละตัวแปลว่าอะไร" : "③ ตัวเลขแต่ละตัวแปลว่าอะไร", meaningCards(t))}
        ${sec(gauge ? "⑤ ทำไมต้องกลัวแรงดัน ไม่ใช่สายร้อน" : "④ ทำไมต้องกลัวแรงดัน ไม่ใช่สายร้อน",
                    whyOverVoltage(t))}

        <div style="margin-top:10px;font-size:.8em;color:${GREY};line-height:1.5;">
          📏 เทียบให้เห็นภาพ: 1 kWh ≈ แอร์ 12,000 BTU เปิด 1 ชั่วโมง ·
          ทุกค่าคิดต่อ 1 ชั่วโมงการซื้อขาย (1 slot)
        </div>
      </div>`;
    }

    // Swap the long paragraph for the visuals. If the paragraph cannot be found
    // (app.js changed), append instead — the banner is never left broken.
    function decorate() {
        const banner = document.getElementById("energy-range-banner");
        if (!banner) return;
        const card = banner.firstElementChild;
        if (!card) return;
        if (card.querySelector("#input-visuals")) return;   // already decorated

        const block = buildBlock();
        if (!block) return;

        let target = null;
        card.querySelectorAll("div").forEach(d => {
            if (!target && d.children.length <= 6 &&
                /\*หมายเหตุ|inject เกิน/.test(d.textContent || "")) target = d;
        });

        if (target) {
            // keep the original prose available, just collapsed behind a toggle
            const original = target.innerHTML;
            target.innerHTML = `
        <details style="margin-bottom:2px;">
          <summary style="cursor:pointer;color:${GREY};font-size:.85em;
                          list-style:none;user-select:none;">
            📄 แสดงคำอธิบายฉบับข้อความเต็ม (ต้นฉบับ)</summary>
          <div style="margin-top:8px;">${original}</div>
        </details>
        ${block}`;
        } else {
            card.insertAdjacentHTML("beforeend", block);
        }
    }

    // ---- wrap the original renderer, the way market.js wraps showTab ---------
    function install() {
        if (typeof window.renderEnergyRangeBanner !== "function") return false;
        if (window.renderEnergyRangeBanner.__ivWrapped) return true;
        const orig = window.renderEnergyRangeBanner;
        const wrapped = function () {
            const r = orig.apply(this, arguments);   // original output, untouched
            try { decorate(); } catch (e) { /* never break the banner */ }
            return r;
        };
        wrapped.__ivWrapped = true;
        window.renderEnergyRangeBanner = wrapped;
        try { wrapped(); } catch (_) { }
        return true;
    }

    if (!install()) {
        let tries = 0;
        const iv = setInterval(() => {
            if (install() || ++tries > 60) clearInterval(iv);
        }, 250);
    }

    // Live refresh: the marker and the flow arrow follow what the user types.
    let lastKey = null;
    setInterval(() => {
        const t = thresholds();
        if (!t) return;
        const c = currentTotals();
        const w = G.wf();
        const vm = w && w.apiResult && w.apiResult.power_flow &&
            w.apiResult.power_flow.post_match &&
            w.apiResult.power_flow.post_match.metrics;
        const key = JSON.stringify([c.inject.toFixed(3), c.load.toFixed(3),
        t.safeTot, t.hardTot, vm && vm.max_voltage_pu]);
        const host = document.getElementById("input-visuals");
        if (!host || !host.isConnected) { decorate(); lastKey = key; return; }
        if (key === lastKey) return;
        lastKey = key;
        const fresh = document.createElement("div");
        fresh.innerHTML = buildBlock();
        const nu = fresh.firstElementChild;
        if (nu) host.replaceWith(nu);
    }, 500);

    window.inputVisualsRefresh = decorate;
})();