"""
server.py  –  P2P Energy Trading Backend
==========================================
Flask API that wraps pandapower for accurate Newton-Raphson AC power flow.

Endpoints:
  GET  /health                – health check
  POST /api/energy_range      – binary-search feasible injection range (PRE_MATCH)
  POST /api/analyze           – full pipeline: price check → matching → 3 PF cases
  POST /api/powerflow_case    – run a single PF case (BASE / PRE_MATCH / POST_MATCH)

Run:
  python server.py
  → http://localhost:5000
"""
from __future__ import annotations

import sys, json, os
from typing import Any, Dict, List, Optional, Tuple

import pandapower as pp
from flask import Flask, jsonify, request
from flask_cors import CORS

from ieee33bus_network import create_network, run_power_flow
from matching import build_graph, generate_path_matrix, match_p2p

frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
app = Flask(__name__, static_folder=frontend_dir, static_url_path='')
CORS(app)  # allow all origins (frontend at :3838 calls backend at :5000)

@app.route("/")
def serve_index():
    return app.send_static_file("index.html")


# =============================================================================
# Constants (mirror Python powerflow_CP_average_final.py)
# =============================================================================

V_MIN               = 0.95
V_MAX               = 1.05
ENERGY_WINDOW_HOURS = 24.0
FIT_PRICE           = 2.20
RETAIL_PRICE        = 5.80

SELLERS = ["C", "D", "E", "F", "I"]
BUYERS  = ["A", "B", "G", "H", "J"]

PLAYER_LOCATIONS: Dict[str, str] = {
    "A": "Bus2",  "B": "Bus11", "G": "Bus17", "H": "Bus20", "J": "Bus29",
    "C": "Bus14", "D": "Bus25", "E": "Bus32", "F": "Bus35", "I": "Bus7",
}

ACTUAL_LOAD_DATA: Dict[int, Tuple[float, float]] = {
    2:  (0.004469, 0.000566),
    7:  (0.001169, 0.000566),
    11: (0.007769, 0.000566),
    14: (0.000779, 0.000377),
    17: (0.001169, 0.000566),
    20: (0.001169, 0.000566),
    25: (0.001169, 0.000566),
    29: (0.000974, 0.000472),
    32: (0.000779, 0.000377),
    35: (0.001169, 0.000566),
}

DEFAULT_OFFERING_PRICE: Dict[str, float] = {
    "C": 3.8364, "D": 3.2683, "E": 3.1671, "F": 4.0388, "I": 3.1638,
}
DEFAULT_BIDDING_PRICE: Dict[str, float] = {
    "A": 4.7114, "B": 5.3546, "G": 5.0999, "H": 3.8625, "J": 5.80,
}
DEFAULT_SELLER_ENERGY: Dict[str, float] = {
    "C": 26.0, "D": 22.0, "E": 39.0, "F": 29.0, "I": 17.0,
}
DEFAULT_BUYER_ENERGY: Dict[str, float] = {
    "A": 40.0, "B":  9.0, "G": 14.0, "H": 33.0, "J": 44.0,
}


# =============================================================================
# Helpers
# =============================================================================

def kwh_to_mw(kwh: float) -> float:
    return kwh / ENERGY_WINDOW_HOURS / 1000.0


def bus_idx(loc: str) -> int:
    return int(loc.replace("Bus", ""))


# =============================================================================
# Core: run one PF case  (matches run_case() in Python powerflow script)
# =============================================================================

def run_case(
    mode: str,
    sellers: List[str],
    buyers: List[str],
    player_locations: Dict[str, str],
    seller_energy_kwh: Optional[Dict[str, float]] = None,
    buyer_energy_kwh:  Optional[Dict[str, float]] = None,
    seller_sold_kwh:   Optional[Dict[str, float]] = None,
    buyer_bought_kwh:  Optional[Dict[str, float]] = None,
) -> dict:
    """
    mode = "BASE"       – every bus uses ACTUAL_LOAD_DATA; no DG
    mode = "PRE_MATCH"  – sellers inject at full capacity; no loads anywhere
    mode = "POST_MATCH" – buyers keep their full ACTUAL_LOAD_DATA load (they still
                          consume the same amount; the trade only changes the
                          source from grid to peer PV). Sellers place no load and
                          inject their sold surplus (sold_kwh) as sgen. Other buses
                          keep their ACTUAL_LOAD_DATA load.
    """
    net = create_network()

    buyer_bus  = {bus_idx(player_locations[b]): b for b in buyers}
    seller_bus = {bus_idx(player_locations[s]): s for s in sellers}

    total_dg_mw      = 0.0
    total_buyer_load = 0.0

    # ── Loads ────────────────────────────────────────────────────────────────
    for bidx, (orig_p, orig_q) in ACTUAL_LOAD_DATA.items():

        if mode == "BASE":
            pp.create_load(net, bus=bidx, p_mw=orig_p, q_mvar=orig_q,
                           name=f"Load_Bus{bidx}")

        elif mode == "PRE_MATCH":
            pass  # No loads anywhere — only DG sgen below

        elif mode == "POST_MATCH":
            if bidx in seller_bus:
                pass  # Seller bus: the seller's PV covers its own load and only
                      # the surplus is exported, so the surplus is injected as
                      # sgen below and no load is placed here.

            elif bidx in buyer_bus:
                # The buyer still consumes its full actual load. P2P trading only
                # changes where that energy comes from (a peer's PV instead of the
                # grid), not how much the buyer uses, so the load must remain in
                # the power flow for the BASE and POST_MATCH cases to be comparable.
                buyer = buyer_bus[bidx]
                pp.create_load(net, bus=bidx, p_mw=orig_p, q_mvar=orig_q,
                               name=f"Load_Buyer{buyer}")
                total_buyer_load += orig_p
            else:
                # Other buses (not a player): use actual measured load
                pp.create_load(net, bus=bidx, p_mw=orig_p, q_mvar=orig_q,
                               name=f"Load_Other{bidx}")

    # ── DG / sgen ────────────────────────────────────────────────────────────
    if mode in ("PRE_MATCH", "POST_MATCH"):
        for s in sellers:
            sidx = bus_idx(player_locations[s])
            if mode == "PRE_MATCH":
                p_mw = kwh_to_mw((seller_energy_kwh or {})[s])
            else:
                p_mw = kwh_to_mw((seller_sold_kwh or {}).get(s, 0.0))
            if p_mw > 1e-12:
                total_dg_mw += p_mw
                pp.create_sgen(net, bus=sidx, p_mw=p_mw, q_mvar=0.0,
                               name=f"DG_Seller{s}")

    # ── Run power flow ────────────────────────────────────────────────────────
    converged = run_power_flow(net)
    if not converged:
        return {"converged": False, "error": f"Power flow did not converge: {mode}"}

    # ── Extract bus voltages ──────────────────────────────────────────────────
    bus_voltages = []
    for idx in net.res_bus.index:
        vn_kv  = float(net.bus.at[idx, "vn_kv"])
        vm_pu  = float(net.res_bus.at[idx, "vm_pu"])
        va_deg = float(net.res_bus.at[idx, "va_degree"])
        v_kv   = vm_pu * vn_kv

        if idx == 0:
            status = "Slack"
        elif vm_pu < V_MIN:
            status = "LOW"
        elif vm_pu > V_MAX:
            status = "HIGH"
        else:
            status = "OK"

        bus_voltages.append({
            "bus":    int(idx),
            "vnKv":   vn_kv,
            "vKv":    round(v_kv, 6),
            "vm_pu":  round(vm_pu, 6),
            "vaDeg":  round(va_deg, 4),
            "status": status,
        })

    # ── Extract line results ──────────────────────────────────────────────────
    line_results = []
    for i in net.res_line.index:
        line_results.append({
            "lineIdx":   int(i),
            "from":      int(net.line.at[i, "from_bus"]),
            "to":        int(net.line.at[i, "to_bus"]),
            "L":         float(net.line.at[i, "length_km"]),
            "rOhmPerKm": float(net.line.at[i, "r_ohm_per_km"]),
            "xOhmPerKm": float(net.line.at[i, "x_ohm_per_km"]),
            "maxIKa":    float(net.line.at[i, "max_i_ka"]),
            # Currents (kA)
            "iFromKa":   round(float(net.res_line.at[i, "i_from_ka"]),   8),
            "iToKa":     round(float(net.res_line.at[i, "i_to_ka"]),     8),
            # Active power (MW)
            "pFromMw":   round(float(net.res_line.at[i, "p_from_mw"]),   8),
            "pToMw":     round(float(net.res_line.at[i, "p_to_mw"]),     8),
            # Reactive power (MVAR)
            "qFromMvar": round(float(net.res_line.at[i, "q_from_mvar"]), 8),
            "qToMvar":   round(float(net.res_line.at[i, "q_to_mvar"]),   8),
            # Losses
            "plMw":      round(float(net.res_line.at[i, "pl_mw"]),       8),
            "qlMvar":    round(float(net.res_line.at[i, "ql_mvar"]),     8),
            # Loading
            "loading":   round(float(net.res_line.at[i, "loading_percent"]), 6),
        })

    # ── Extract transformer results ───────────────────────────────────────────
    trafo_results = []
    total_trafo_loss_mw   = 0.0
    total_trafo_loss_mvar = 0.0
    for i in net.res_trafo.index:
        pl_mw   = float(net.res_trafo.at[i, "pl_mw"])
        ql_mvar = float(net.res_trafo.at[i, "ql_mvar"])
        total_trafo_loss_mw   += pl_mw
        total_trafo_loss_mvar += ql_mvar
        trafo_results.append({
            "trafoIdx":   int(i),
            "hvBus":      int(net.trafo.at[i, "hv_bus"]),
            "lvBus":      int(net.trafo.at[i, "lv_bus"]),
            "loadingPct": round(float(net.res_trafo.at[i, "loading_percent"]), 6),
            "plMw":       round(pl_mw, 8),
            "qlMvar":     round(ql_mvar, 8),
            "plKw":       round(pl_mw * 1000, 6),
            "qlKvar":     round(ql_mvar * 1000, 6),
        })

    # ── Metrics ───────────────────────────────────────────────────────────────
    total_line_loss_mw   = sum(l["plMw"]   for l in line_results)
    total_line_loss_mvar = sum(l["qlMvar"] for l in line_results)
    total_loss_mw        = total_line_loss_mw + total_trafo_loss_mw
    total_loss_mvar      = total_line_loss_mvar + total_trafo_loss_mvar

    lv_buses = [v for v in bus_voltages if v["bus"] != 0]
    min_v    = min((v["vm_pu"] for v in lv_buses), default=1.0)
    max_v    = max((v["vm_pu"] for v in lv_buses), default=1.0)
    max_load = max((l["loading"] for l in line_results), default=0.0)

    grid_supply_mw = float(net.res_ext_grid.p_mw.sum()) if len(net.res_ext_grid) else 0.0
    total_load_mw  = float(net.load.p_mw.sum())         if len(net.load)        else 0.0
    total_sgen_mw  = float(net.sgen.p_mw.sum())         if len(net.sgen)        else 0.0

    loss_base   = total_load_mw + total_sgen_mw
    loss_pct    = (total_loss_mw / loss_base * 100.0) if loss_base > 1e-12 else 0.0

    # ── Violations ────────────────────────────────────────────────────────────
    violations_under = [
        {"bus": v["bus"], "vm_pu": v["vm_pu"],
         "short": round(V_MIN - v["vm_pu"], 6)}
        for v in lv_buses if v["vm_pu"] < V_MIN
    ]
    violations_over = [
        {"bus": v["bus"], "vm_pu": v["vm_pu"],
         "excess": round(v["vm_pu"] - V_MAX, 6)}
        for v in lv_buses if v["vm_pu"] > V_MAX
    ]

    return {
        "converged":    True,
        "busVoltages":  bus_voltages,
        "lineResults":  line_results,
        "trafoResults": trafo_results,
        "metrics": {
            "min_voltage_pu":       round(min_v, 8),
            "max_voltage_pu":       round(max_v, 8),
            "total_loss_mw":        round(total_loss_mw, 8),
            "line_loss_mw":         round(total_line_loss_mw, 8),
            "trafo_loss_mw":        round(total_trafo_loss_mw, 8),
            "total_loss_mvar":      round(total_loss_mvar, 8),
            "grid_supply_mw":       round(grid_supply_mw, 8),
            "max_line_loading_pct": round(max_load, 8),
            "total_dg_mw":          round(total_dg_mw, 8),
            "total_buyer_load_mw":  round(total_buyer_load, 8),
            "total_load_mw":        round(total_load_mw, 8),
            "total_sgen_mw":        round(total_sgen_mw, 8),
            "loss_pct":             round(loss_pct, 4),
        },
        "violations": {
            "under": violations_under,
            "over":  violations_over,
        },
        "totalDgMw":         round(total_dg_mw, 8),
        "totalBuyerLoadMw":  round(total_buyer_load, 8),
    }


# =============================================================================
# API Routes
# =============================================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "pandapower": pp.__version__,
                    "message": "P2P Energy Trading Backend running"})


# ---------------------------------------------------------------------------
# /api/energy_range  –  binary-search max feasible injection per seller
# ---------------------------------------------------------------------------
@app.route("/api/energy_range", methods=["POST"])
def energy_range():
    data = request.json or {}
    sellers          = data.get("sellers", SELLERS)
    player_locations = data.get("player_locations", PLAYER_LOCATIONS)
    n = len(sellers)
    if n == 0:
        return jsonify({"max_kwh_per_seller": 0, "max_kwh_total": 0,
                        "feasibility_note": "No sellers configured."})

    def test_seller_total(total_kwh: float) -> bool:
        per = total_kwh / n
        try:
            res = run_case("PRE_MATCH", sellers, [], player_locations,
                           seller_energy_kwh={s: per for s in sellers})
            if not res.get("converged"):
                return False
            v = res.get("violations", {})
            return len(v.get("under", [])) == 0 and len(v.get("over", [])) == 0
        except Exception:
            return False

    def test_buyer_total(total_kwh: float) -> bool:
        n_b = len(buyers)
        per = total_kwh / n_b
        try:
            res = run_case("POST_MATCH", [], buyers, player_locations,
                           buyer_energy_kwh={b: per for b in buyers},
                           buyer_bought_kwh={})
            if not res.get("converged"):
                return False
            v = res.get("violations", {})
            return len(v.get("under", [])) == 0 and len(v.get("over", [])) == 0
        except Exception:
            return False

    UPPER = 30_000.0
    
    # --- Sellers Binary Search ---
    lo_s, hi_s = 0.0, UPPER
    for _ in range(40):
        mid = (lo_s + hi_s) / 2.0
        if test_seller_total(mid):
            lo_s = mid
        else:
            hi_s = mid

    # --- Buyers Binary Search ---
    lo_b, hi_b = 0.0, UPPER
    for _ in range(40):
        mid = (lo_b + hi_b) / 2.0
        if test_buyer_total(mid):
            lo_b = mid
        else:
            hi_b = mid

    return jsonify({
        "max_kwh_per_seller": int(lo_s / n),
        "max_kwh_total_seller": int(lo_s),
        "max_kwh_per_buyer": int(lo_b / len(buyers)) if len(buyers) > 0 else 0,
        "max_kwh_total_buyer": int(lo_b),
        "min_kwh_per_seller": 0,
        "min_kwh_per_buyer": 0,
        "feasibility_note": (
            f"Binary-search result (voltage ∈ [{V_MIN}, {V_MAX}] p.u.)"
        ),
    })


# ---------------------------------------------------------------------------
# /api/powerflow_case  –  run a single power flow case
# ---------------------------------------------------------------------------
@app.route("/api/powerflow_case", methods=["POST"])
def powerflow_case():
    data = request.json or {}
    mode             = data.get("mode", "BASE")
    sellers          = data.get("sellers", SELLERS)
    buyers           = data.get("buyers", BUYERS)
    player_locations = data.get("player_locations", PLAYER_LOCATIONS)
    try:
        result = run_case(
            mode=mode, sellers=sellers, buyers=buyers,
            player_locations=player_locations,
            seller_energy_kwh=data.get("seller_energy_kwh"),
            buyer_energy_kwh =data.get("buyer_energy_kwh"),
            seller_sold_kwh  =data.get("seller_sold_kwh"),
            buyer_bought_kwh =data.get("buyer_bought_kwh"),
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({"converged": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# /api/analyze  –  FULL PIPELINE:  price-check → matching → 3 PF cases
# ---------------------------------------------------------------------------
@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.json or {}

    sellers           = data.get("sellers",           SELLERS)
    buyers            = data.get("buyers",            BUYERS)
    offering_price    = data.get("offering_price",    DEFAULT_OFFERING_PRICE)
    bidding_price     = data.get("bidding_price",     DEFAULT_BIDDING_PRICE)
    seller_energy_kwh = data.get("seller_energy_kwh", DEFAULT_SELLER_ENERGY)
    buyer_energy_kwh  = data.get("buyer_energy_kwh",  DEFAULT_BUYER_ENERGY)
    player_locations  = data.get("player_locations",  PLAYER_LOCATIONS)

    # ── 1. Price range check ─────────────────────────────────────────────────
    price_errors = []
    for s in sellers:
        p = offering_price.get(s, 0.0)
        if not (FIT_PRICE <= p <= RETAIL_PRICE):
            price_errors.append({"player": s, "role": "Seller",
                                  "price": p, "type": "offering"})
    for b in buyers:
        p = bidding_price.get(b, 0.0)
        if not (FIT_PRICE <= p <= RETAIL_PRICE):
            price_errors.append({"player": b, "role": "Buyer",
                                  "price": p, "type": "bidding"})

    if price_errors:
        return jsonify({"success": False, "price_errors": price_errors})

    # ── 2. P2P Matching ───────────────────────────────────────────────────────
    graph       = build_graph()
    path_matrix = generate_path_matrix(graph, sellers, buyers, player_locations)

    match_res = match_p2p(
        path_matrix=path_matrix,
        sellers=sellers, buyers=buyers,
        bidding_price=bidding_price, offering_price=offering_price,
        seller_energy_kwh=seller_energy_kwh, buyer_energy_kwh=buyer_energy_kwh,
    )

    sold_kwh   = match_res["soldKwh"]
    bought_kwh = match_res["boughtKwh"]

    # ── 3. Power flow – BASE ──────────────────────────────────────────────────
    try:
        pf_base = run_case("BASE", sellers, buyers, player_locations)
    except Exception as e:
        pf_base = {"converged": False, "error": str(e)}

    # ── 4. Power flow – PRE_MATCH ─────────────────────────────────────────────
    try:
        pf_pre = run_case("PRE_MATCH", sellers, buyers, player_locations,
                          seller_energy_kwh=seller_energy_kwh)
    except Exception as e:
        pf_pre = {"converged": False, "error": str(e)}

    # ── 5. Power flow – POST_MATCH ────────────────────────────────────────────
    try:
        pf_post = run_case("POST_MATCH", sellers, buyers, player_locations,
                           seller_energy_kwh=seller_energy_kwh,
                           buyer_energy_kwh =buyer_energy_kwh,
                           seller_sold_kwh  =sold_kwh,
                           buyer_bought_kwh =bought_kwh)
    except Exception as e:
        pf_post = {"converged": False, "error": str(e)}

    return jsonify({
        "success":     True,
        "price_errors": [],
        "matching":    match_res,
        "power_flow": {
            "base":       pf_base,
            "pre_match":  pf_pre,
            "post_match": pf_post,
        },
    })


# =============================================================================
# Entry point
# =============================================================================
if __name__ == "__main__":
    print("=" * 60)
    print("  P2P Energy Trading Backend  (pandapower AC power flow)")
    print(f"  pandapower version : {pp.__version__}")
    print("  Endpoints:")
    print("    GET  /health")
    print("    POST /api/energy_range")
    print("    POST /api/analyze")
    print("    POST /api/powerflow_case")
    print("  Listening on http://0.0.0.0:5001")
    print("=" * 60)
    app.run(host="0.0.0.0", port=5001, debug=False)