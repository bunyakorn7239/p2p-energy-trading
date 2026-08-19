"""
violation_handler.py — SAFETY LAYER 2 (corrective layer)
=========================================================

WHY THIS IS A SEPARATE FILE
  server.py already DETECTS violations (violations = {under, over, thermal})
  but it does not RESOLVE them. This module adds the corrective action and
  nothing else. server.py, matching.py, market.py and ieee33bus_network.py are
  NOT modified — this file only READS run_case() from server.py and returns a
  resolution plan.

  Layer separation (kept deliberately strict):
      market layer  = matching.py  (CP, clearing price)     -> UNTOUCHED
      network layer = server.run_case + this module         -> the fix lives here

WHAT IT DOES
  Case 1  OVER-VOLTAGE   -> ACTIVE FIX (iterative per-bus zero-export)
  Case 2  UNDER-VOLTAGE  -> ADVISORY ONLY (see docs/02_under_voltage.md)
  Case 3  LINE OVERLOAD  -> ADVISORY ONLY (see docs/03_line_overload.md)

OVER-VOLTAGE ALGORITHM (the only case that changes the dispatch)
  step 0  run POST_MATCH power flow on the matched result
  step 1  if no bus > V_MAX -> done, nothing changes
  step 2  rank every still-exporting seller by voltage sensitivity
              S_s = dVmax / dP_s      [p.u. / kWh]
          computed numerically: inject +DELTA kWh at seller s, re-run the AC
          power flow, take (Vmax_perturbed - Vmax_now) / DELTA.
  step 3  ZERO-EXPORT the seller with the LARGEST S_s
              sold[s] = 0 and unsold[s] = 0   (inverter export setpoint = 0 W)
          Every OTHER matched pair keeps trading exactly as matched — the
          matching result is not recomputed.
  step 4  re-run POST_MATCH. Still over-voltage? -> back to step 2 and cut the
          NEXT most influential seller. Loop until Vmax <= V_MAX.

WHY "MOST INFLUENTIAL SELLER" AND NOT "A SELLER ON THE VIOLATED BUS"
  On this feeder buses 23 and 24 are a dead-end lateral downstream of Bus 25
  and carry NO seller at all, so "cut the seller on the violated bus" has no
  seller to cut. Sensitivity ranking always has a target and is the physically
  correct one: dVmax/dP is exactly how much that seller moves the worst bus.

PF BUDGET
  one resolution round = (#active sellers) + 1 power flows.
  With 5 sellers that is 6 AC power flows, ~2.5-3 s — inside the 8-min
  Resolution window of the market clock, and inside a 15-min Safety-Guard-2
  sub-interval.

REGISTER (2 lines in server.py, nothing else changes):
    from violation_handler import bp_safety2
    app.register_blueprint(bp_safety2)
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

bp_safety2 = Blueprint("violation_handler", __name__)

# --------------------------------------------------------------------------- #
# Deferred binding to server.py
#
# Same reason as energy_range_live.py: when the app is started with
# `python server.py`, server.py is __main__, so a module-level
# `from server import run_case` would load a SECOND copy of server.py and
# create a circular import. Symbols are resolved on the first request instead.
# --------------------------------------------------------------------------- #
SELLERS = BUYERS = PLAYER_LOCATIONS = None
V_MIN = V_MAX = MAX_LINE_LOADING = None
FIT_PRICE = RETAIL_PRICE = None
run_case = None


def _ensure() -> None:
    global SELLERS, BUYERS, PLAYER_LOCATIONS
    global V_MIN, V_MAX, MAX_LINE_LOADING, FIT_PRICE, RETAIL_PRICE, run_case
    if run_case is not None:
        return
    import sys, importlib
    mod = sys.modules.get("server")
    if mod is None or not hasattr(mod, "run_case"):
        main = sys.modules.get("__main__")
        mod = main if (main is not None and hasattr(main, "run_case")) \
            else importlib.import_module("server")
    SELLERS = mod.SELLERS
    BUYERS = mod.BUYERS
    PLAYER_LOCATIONS = mod.PLAYER_LOCATIONS
    V_MIN, V_MAX = mod.V_MIN, mod.V_MAX
    MAX_LINE_LOADING = mod.MAX_LINE_LOADING
    FIT_PRICE, RETAIL_PRICE = mod.FIT_PRICE, mod.RETAIL_PRICE
    run_case = mod.run_case


# --------------------------------------------------------------------------- #
# Tunables
# --------------------------------------------------------------------------- #
SENS_DELTA_KWH = 1.0    # perturbation used for the numeric dVmax/dP
MAX_CUTS = 5            # never cut more sellers than this in one round
PF_BUDGET = 40          # hard ceiling on power flows for one resolve call

# Fallback ranking used only when a numeric sensitivity cannot be computed
# (power flow fails to converge on the perturbed case). Verified on the
# committed network at the all-sellers operating point, in p.u./kWh.
FALLBACK_VSENS: Dict[str, float] = {
    "D": 0.001467,   # Bus25 — feeder end, strongest
    "F": 0.001007,   # Bus35
    "E": 0.000814,   # Bus32
    "I": 0.000627,   # Bus7
    "C": 0.000210,   # Bus14 — feeder head, weakest
}


def _f(d: Optional[Dict[str, float]], keys: List[str]) -> Dict[str, float]:
    d = d or {}
    return {k: max(float(d.get(k, 0.0) or 0.0), 0.0) for k in keys}


def _pf_summary(pf: dict) -> dict:
    """Compact view of one power-flow result (the bit the UI needs)."""
    if not isinstance(pf, dict) or not pf.get("converged"):
        return {"converged": False,
                "error": (pf or {}).get("error", "power flow did not converge")}
    m = pf.get("metrics", {}) or {}
    v = pf.get("violations", {}) or {}
    return {
        "converged": True,
        "vmax": round(float(m.get("max_voltage_pu", 0.0)), 6),
        "vmin": round(float(m.get("min_voltage_pu", 0.0)), 6),
        "max_loading_pct": round(float(m.get("max_line_loading_pct", 0.0)), 4),
        "n_over": len(v.get("over", [])),
        "n_under": len(v.get("under", [])),
        "n_thermal": len(v.get("thermal", [])),
        "over_buses": [int(x["bus"]) for x in v.get("over", [])],
        "under_buses": [int(x["bus"]) for x in v.get("under", [])],
        "thermal_lines": [int(x["line"]) for x in v.get("thermal", [])],
        "grid_export_kw": round(float(m.get("grid_export_mw", 0.0)) * 1000.0, 4),
        "grid_import_kw": round(float(m.get("grid_import_mw", 0.0)) * 1000.0, 4),
        "is_reverse_to_grid": bool(m.get("is_reverse_to_grid", False)),
    }


def _vmax_of(pf: dict) -> float:
    return float(((pf or {}).get("metrics", {}) or {}).get("max_voltage_pu", 0.0))


# --------------------------------------------------------------------------- #
# The resolver
# --------------------------------------------------------------------------- #
def resolve_over_voltage(
    sellers: List[str],
    buyers: List[str],
    player_locations: Dict[str, str],
    seller_energy_kwh: Dict[str, float],
    buyer_energy_kwh: Dict[str, float],
    seller_sold_kwh: Dict[str, float],
    buyer_bought_kwh: Dict[str, float],
    seller_unsold_kwh: Dict[str, float],
    trades: Optional[List[dict]] = None,
) -> dict:
    """
    Iterative per-bus zero-export. Returns the full audit trail so the web app
    can show WHY each seller was cut and prove the final state is clean.
    """
    _ensure()
    t0 = time.time()
    pf_count = 0

    sold = dict(seller_sold_kwh)
    unsold = dict(seller_unsold_kwh)
    trades = [dict(t) for t in (trades or [])]

    def _solve() -> dict:
        nonlocal pf_count
        pf_count += 1
        return run_case("POST_MATCH", sellers, buyers, player_locations,
                        seller_energy_kwh=seller_energy_kwh,
                        buyer_energy_kwh=buyer_energy_kwh,
                        seller_sold_kwh=sold,
                        buyer_bought_kwh=buyer_bought_kwh,
                        seller_unsold_kwh=unsold)

    pf_initial = _solve()
    if not pf_initial.get("converged"):
        return {"resolved": False, "case": "over-voltage",
                "error": pf_initial.get("error", "initial power flow failed"),
                "curtailed": [], "steps": [], "power_flows": pf_count}

    initial = _pf_summary(pf_initial)
    if initial["n_over"] == 0:
        # Nothing to fix. The response keeps the SAME shape as the corrective
        # path so the frontend never has to special-case it.
        return {
            "resolved": True, "case": "over-voltage", "action_taken": False,
            "initial": initial, "final": initial,
            "curtailed": [], "steps": [], "notifications": [],
            "dispatch": {
                "seller_sold_kwh": {k: round(v, 4) for k, v in sold.items()},
                "seller_unsold_kwh": {k: round(v, 4) for k, v in unsold.items()},
                "surviving_trades": trades,
                "n_trades_before": len(trades), "n_trades_after": len(trades),
                "p2p_kwh_before": round(sum(float(t.get("qty", 0.0)) for t in trades), 4),
                "p2p_kwh_after": round(sum(float(t.get("qty", 0.0)) for t in trades), 4),
            },
            "power_flows": pf_count,
            "elapsed_s": round(time.time() - t0, 3),
        }

    steps: List[dict] = []
    curtailed: List[dict] = []
    pf_now = pf_initial

    while _pf_summary(pf_now)["n_over"] > 0 and len(curtailed) < MAX_CUTS:
        if pf_count >= PF_BUDGET:
            break

        vmax_now = _vmax_of(pf_now)

        # ---- rank the still-exporting sellers by dVmax/dP -------------------
        active = [s for s in sellers
                  if (sold.get(s, 0.0) + unsold.get(s, 0.0)) > 1e-9]
        if not active:
            break

        ranking: List[dict] = []
        for s in active:
            probe_unsold = dict(unsold)
            probe_unsold[s] = probe_unsold.get(s, 0.0) + SENS_DELTA_KWH
            pf_count += 1
            try:
                pf_p = run_case("POST_MATCH", sellers, buyers, player_locations,
                                seller_energy_kwh=seller_energy_kwh,
                                buyer_energy_kwh=buyer_energy_kwh,
                                seller_sold_kwh=sold,
                                buyer_bought_kwh=buyer_bought_kwh,
                                seller_unsold_kwh=probe_unsold)
                if pf_p.get("converged"):
                    sens = (_vmax_of(pf_p) - vmax_now) / SENS_DELTA_KWH
                    src = "numeric"
                else:
                    sens, src = FALLBACK_VSENS.get(s, 0.0), "fallback"
            except Exception:
                sens, src = FALLBACK_VSENS.get(s, 0.0), "fallback"
            ranking.append({
                "seller": s,
                "bus": int(player_locations[s].replace("Bus", "")),
                "export_kwh": round(sold.get(s, 0.0) + unsold.get(s, 0.0), 4),
                "dVmax_dP": round(sens, 8),
                "source": src,
            })
        ranking.sort(key=lambda r: r["dVmax_dP"], reverse=True)
        target = ranking[0]["seller"]

        # ---- zero-export the most influential seller ------------------------
        lost_p2p = sold.get(target, 0.0)
        lost_fit = unsold.get(target, 0.0)
        affected = [
            {"buyer": t.get("buyer"), "qty_kwh": round(float(t.get("qty", 0.0)), 4),
             "price": t.get("price")}
            for t in trades if t.get("seller") == target
        ]
        sold[target] = 0.0
        unsold[target] = 0.0

        pf_before = _pf_summary(pf_now)
        pf_now = _solve()
        if not pf_now.get("converged"):
            steps.append({"cut": target, "ranking": ranking,
                          "before": pf_before,
                          "after": {"converged": False,
                                    "error": pf_now.get("error", "")}})
            break
        pf_after = _pf_summary(pf_now)

        curtailed.append({
            "seller": target,
            "bus": ranking[0]["bus"],
            "order": len(curtailed) + 1,
            "dVmax_dP": ranking[0]["dVmax_dP"],
            "declared_kwh": round(float(seller_energy_kwh.get(target, 0.0)), 4),
            "lost_p2p_kwh": round(lost_p2p, 4),
            "lost_fit_kwh": round(lost_fit, 4),
            "affected_buyers": affected,
            "inverter_setpoint_w": 0,
            "vmax_before": pf_before["vmax"],
            "vmax_after": pf_after["vmax"],
            "delta_vmax": round(pf_after["vmax"] - pf_before["vmax"], 6),
            "cleared": pf_after["n_over"] == 0,
            "reason_code": "OVER_VOLTAGE_ZERO_EXPORT",
        })
        steps.append({"cut": target, "ranking": ranking,
                      "before": pf_before, "after": pf_after})

    final = _pf_summary(pf_now)
    survivors = [t for t in trades
                 if t.get("seller") not in {c["seller"] for c in curtailed}]

    return {
        "resolved": final.get("n_over", 1) == 0,
        "case": "over-voltage",
        "action_taken": bool(curtailed),
        "initial": initial,
        "final": final,
        "curtailed": curtailed,
        "steps": steps,
        "dispatch": {
            "seller_sold_kwh": {k: round(v, 4) for k, v in sold.items()},
            "seller_unsold_kwh": {k: round(v, 4) for k, v in unsold.items()},
            "surviving_trades": survivors,
            "n_trades_before": len(trades),
            "n_trades_after": len(survivors),
            "p2p_kwh_before": round(sum(float(t.get("qty", 0.0)) for t in trades), 4),
            "p2p_kwh_after": round(sum(float(t.get("qty", 0.0)) for t in survivors), 4),
        },
        "notifications": [_seller_notice(c, final) for c in curtailed],
        "power_flows": pf_count,
        "elapsed_s": round(time.time() - t0, 3),
    }


def _seller_notice(c: dict, final: dict) -> dict:
    """The message shown to the seller who was zero-exported (Thai + English)."""
    s = c["seller"]
    return {
        "seller": s,
        "bus": c["bus"],
        "severity": "critical",
        "title_th": f"⛔ Seller {s} (Bus {c['bus']}) ถูกสั่ง Zero-Export ในรอบนี้",
        "title_en": f"Seller {s} (Bus {c['bus']}) has been set to zero export",
        "what_th": (
            f"คำสั่ง: ตั้งค่า Export Control ของอินเวอร์เตอร์ = 0 W "
            f"ตลอดรอบนี้ (บ้านของคุณใช้ไฟเองได้ตามปกติ — self-consumption "
            f"เท่านั้น แต่ไม่มีการขายไฟเข้าตลาด P2P)"
        ),
        "why_th": (
            f"สาเหตุ: แรงดันที่ปลายฟีดเดอร์ขึ้นถึง {c['vmax_before']:.5f} p.u. "
            f"ซึ่งเกินขีดจำกัด 1.05 p.u. ระบบคำนวณค่าความไว "
            f"dVmax/dP ของผู้ขายทุกราย และพบว่าการฉีดกำลังของคุณมีอิทธิพลต่อ "
            f"แรงดันสูงที่สุด (S = {c['dVmax_dP']:.6f} p.u./kWh) "
            f"การตัดคุณออกจึงลดแรงดันได้มากที่สุดต่อ 1 kWh ที่เสียไป"
        ),
        "why_you_th": (
            f"ทำไมต้องเป็นคุณ: คุณอยู่ที่ Bus {c['bus']} ซึ่งอยู่ปลายสาย "
            f"อิมพีแดนซ์สะสมจากหม้อแปลงถึงจุดของคุณสูงที่สุด กำลังที่ฉีด 1 kW "
            f"จากจุดนี้จึงดันแรงดันขึ้นมากกว่าผู้ขายที่อยู่ต้นสาย "
            f"(ΔV ≈ (R·P + X·Q) / V — R สะสมยิ่งมาก ΔV ยิ่งมาก)"
        ),
        "effect_th": (
            f"ผลกระทบต่อคุณ: ยกเลิกการขาย P2P {c['lost_p2p_kwh']:.2f} kWh"
            + (f" และส่วนเหลือขายเข้ากริด (FiT) {c['lost_fit_kwh']:.2f} kWh"
               if c["lost_fit_kwh"] > 0 else "")
            + ". คู่ค้ารายอื่นทุกคู่ยังซื้อขายตามที่จับคู่ไว้เดิมทุกประการ"
        ),
        "result_th": (
            f"ผลลัพธ์หลังดำเนินการ: Vmax = {c['vmax_after']:.5f} p.u. "
            + ("✅ กลับเข้ากรอบแล้ว" if c["cleared"]
               else "⚠️ ยังเกินอยู่ — ระบบจะตัดผู้ขายที่มีอิทธิพลรายถัดไป")
        ),
        "settlement_flag": "NO_FAULT_CURTAILMENT",
        "settlement_note_th": (
            "การตัดครั้งนี้เป็นคำสั่งด้านความมั่นคงของโครงข่าย ไม่ใช่ความผิด "
            "ของผู้ขาย (no-fault) จึงไม่คิดค่าปรับผิดสัญญาส่งมอบ "
            "แต่จะไม่มีรายได้จากพลังงานส่วนที่ถูกตัด"
        ),
        "affected_buyers": c["affected_buyers"],
        "final_vmax": final.get("vmax"),
    }


# --------------------------------------------------------------------------- #
# Advisory text for the two cases that are NOT actively fixed
# --------------------------------------------------------------------------- #
def advise_under_voltage(pf_summary: dict) -> dict:
    return {
        "case": "under-voltage",
        "action_taken": False,
        "policy": "ADVISORY_ONLY",
        "doc": "docs/02_under_voltage.md",
        "headline_th": "🔻 Under-voltage (V < 0.95 p.u.) — พบได้ยากมากในระบบนี้",
        "why_rare_th": (
            "ตลาด P2P เปิดเฉพาะช่วงกลางวันที่ PV ผลิตไฟ พลังงานจึงถูกฉีดเข้า"
            "ใกล้จุดโหลด กระแสที่ไหลจากหม้อแปลงลดลง แรงดันตกคร่อมสายจึงลดลงตาม "
            "ผลคือ P2P ยก Vmin ขึ้น ไม่ใช่กดลง จากการทดสอบต้องใช้โหลดผู้ซื้อ "
            "ประมาณ 10 เท่าของโปรไฟล์จริง (Σload ≈ 61.9 kWh) จึงจะแตะ 0.95 p.u."
        ),
        "fix_th": [
            "จำกัดการใช้โหลด (load limiting / demand response) ที่บัสที่แรงดันต่ำสุด",
            "ย้าย/จับคู่การซื้อไปยังโซนที่มี PV สูง เพื่อให้แหล่งจ่ายอยู่ใกล้โหลด",
        ],
        "observed": pf_summary,
    }


def advise_line_overload(pf_summary: dict) -> dict:
    return {
        "case": "line-overload",
        "action_taken": False,
        "policy": "ADVISORY_ONLY",
        "doc": "docs/03_line_overload.md",
        "headline_th": "🔌 Line overload (loading > 100%) — ในระบบนี้ over-voltage ชนก่อนเสมอ",
        "why_th": (
            "ทดสอบบนเน็ตเวิร์กที่ commit ไว้: ดันการฉีดแบบเท่ากันทุกราย "
            "over-voltage เกิดที่ 11 kWh/ราย ส่วน line loading ถึง 100% ที่ ~20 kWh/ราย "
            "และตอนนั้นมี 17 บัสที่แรงดันเกินไปแล้ว จึงไม่มีทางที่ความร้อนสายจะชนก่อน"
        ),
        "where_th": (
            "ถ้าเกิดขึ้นจริง ตำแหน่งคือ 'ต้นสาย' เสมอ — สายที่ออกจากหม้อแปลง "
            "(Line0 Bus1→Bus2) เพราะระบบ radial ทุกกระแสย้อนของผู้ขายทุกราย "
            "ไหลมารวมกันที่สายต้นทางเส้นเดียว"
        ),
        "observed": pf_summary,
    }


# --------------------------------------------------------------------------- #
# HTTP endpoint
# --------------------------------------------------------------------------- #
@bp_safety2.route("/api/violation/resolve", methods=["POST"])
def violation_resolve():
    """
    POST body (all optional except the energy dicts):
      sellers, buyers, player_locations,
      seller_energy_kwh, buyer_energy_kwh,
      seller_sold_kwh, buyer_bought_kwh, seller_unsold_kwh,
      trades: [{seller, buyer, qty, price}, ...]
    """
    _ensure()
    data = request.json or {}
    sellers = data.get("sellers") or SELLERS
    buyers = data.get("buyers") or BUYERS
    locs = data.get("player_locations") or PLAYER_LOCATIONS

    s_energy = _f(data.get("seller_energy_kwh"), sellers)
    b_energy = _f(data.get("buyer_energy_kwh"), buyers)
    sold = _f(data.get("seller_sold_kwh"), sellers)
    bought = _f(data.get("buyer_bought_kwh"), buyers)
    unsold = data.get("seller_unsold_kwh")
    if unsold is None:   # derive it the same way /api/analyze does
        unsold = {s: max(0.0, s_energy.get(s, 0.0) - sold.get(s, 0.0))
                  for s in sellers}
    unsold = _f(unsold, sellers)

    out = resolve_over_voltage(
        sellers, buyers, locs, s_energy, b_energy, sold, bought, unsold,
        trades=data.get("trades") or [],
    )

    final = out.get("final") or {}
    advisories = []
    if final.get("n_under", 0) > 0:
        advisories.append(advise_under_voltage(final))
    if final.get("n_thermal", 0) > 0:
        advisories.append(advise_line_overload(final))
    out["advisories"] = advisories
    out["limits"] = {"V_MIN": V_MIN, "V_MAX": V_MAX,
                     "MAX_LINE_LOADING": MAX_LINE_LOADING}
    return jsonify(out)