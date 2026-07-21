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

import sys, json, os, hashlib
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
MAX_LINE_LOADING    = 100.0   # % thermal limit ต่อสาย (ตั้ง 80 ได้ถ้าต้องการ margin)
ENERGY_WINDOW_HOURS = 1.0
FIT_PRICE           = 2.20
RETAIL_PRICE        = 5.80

# Human-readable case names shown in the UI (internal mode keys stay BASE /
# PRE_MATCH / POST_MATCH so existing logic and response keys do not change).
CASE_DISPLAY_NAMES = {
    "BASE":       "No-PV Baseline",
    "PRE_MATCH":  "PRE_MATCH (injection ceiling)",
    "POST_MATCH": "POST_MATCH (with P2P injection)",
}

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
    "C": 3.10, "D": 2.90, "E": 3.10, "F": 2.90, "I": 3.00,
}
DEFAULT_BUYER_ENERGY: Dict[str, float] = {
    "A": 3.10, "B": 2.90, "G": 3.10, "H": 2.90, "J": 3.00,
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
    seller_unsold_kwh: Optional[Dict[str, float]] = None,
) -> dict:
    """
    mode = "BASE"       – No-PV Baseline: every bus uses ACTUAL_LOAD_DATA (the
                          measured / peak feeder load) and there is NO seller PV
                          injection. The whole feeder is supplied by the grid.
                          This is the voltage/loss reference case.
    mode = "PRE_MATCH"  – sellers inject at full capacity; no loads anywhere
    mode = "POST_MATCH" – "POST_MATCH (with P2P injection)". Sellers place no load
                          and inject TWO separate sgen blocks:
                            (1) P2P sold energy  (seller_sold_kwh)   -> DG_Seller{s}_P2P
                            (2) unsold residual  (seller_unsold_kwh) -> DG_Seller{s}_GRID
                          so total injection = the seller energy the user entered.
                          Each BUYER bus now carries a load equal to the demand the
                          buyer entered (buyer_energy_kwh), NOT the fixed
                          ACTUAL_LOAD_DATA value. Consequently the power flow reacts
                          directly to the user's input and the comparison
                            Σ injection (seller)  vs  Σ load (buyer demand)
                          is what decides reverse power flow: inject > load pushes
                          the surplus back toward the grid (is_reverse_to_grid), and
                          the metrics block reports it explicitly.
                          NOTE: the sold/unsold split is a settlement (economic)
                          concept; physically the full seller energy is injected and
                          the full buyer demand is drawn, with the grid balancing the
                          difference. Selling the unsold residual to the grid at FIT
                          is a provisional rule, to be refined later.
    mode = "BUYER_TEST" – mirror of PRE_MATCH for the buyer side: place a variable
                          load (buyer_energy_kwh) at each buyer bus, with no other
                          loads and no DG, then scale it up to find the
                          under-voltage limit. Used only by /api/energy_range so
                          the buyer feasible range responds to demand, since the
                          POST_MATCH buyer load is fixed to ACTUAL_LOAD_DATA.
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

        elif mode == "BUYER_TEST":
            # Mirror of PRE_MATCH for the buyer side: a variable load is placed at
            # each buyer bus (no other loads, and no DG below) and scaled up to
            # find the under-voltage limit. Used only by /api/energy_range.
            if bidx in buyer_bus:
                b = buyer_bus[bidx]
                p_mw = kwh_to_mw((buyer_energy_kwh or {}).get(b, 0.0))
                if p_mw > 1e-12:
                    pp.create_load(net, bus=bidx, p_mw=p_mw, q_mvar=0.0,
                                   name=f"LoadTest_Buyer{b}")
                    total_buyer_load += p_mw

        elif mode == "POST_MATCH":
            if bidx in seller_bus:
                pass  # Seller bus: the seller's PV covers its own load and only
                      # the surplus is exported, so the surplus is injected as
                      # sgen below and no load is placed here.

            elif bidx in buyer_bus:
                # POST_MATCH (with P2P injection): the buyer's PHYSICAL load is the
                # demand it entered in the auction (buyer_energy_kwh), NOT the fixed
                # ACTUAL_LOAD_DATA peak value. This makes the power flow respond to
                # the user's input directly, so the on-screen comparison
                #     Σ injection (seller) vs Σ load (buyer demand)
                # is exactly what determines reverse flow / "inject > load".
                # (ACTUAL_LOAD_DATA peak load is used only by the No-PV Baseline.)
                buyer = buyer_bus[bidx]
                p_mw = kwh_to_mw((buyer_energy_kwh or {}).get(buyer, 0.0))
                if p_mw > 1e-12:
                    pp.create_load(net, bus=bidx, p_mw=p_mw, q_mvar=0.0,
                                   name=f"Load_Buyer{buyer}")
                    total_buyer_load += p_mw
            else:
                # Other buses (not a player): use actual measured load
                pp.create_load(net, bus=bidx, p_mw=orig_p, q_mvar=orig_q,
                               name=f"Load_Other{bidx}")

    # ── DG / sgen ────────────────────────────────────────────────────────────
    # Track P2P-sold and grid-export (unsold residual) separately so the API can
    # report how much of the injection is genuine peer delivery vs grid export.
    total_dg_p2p_mw  = 0.0
    total_dg_grid_mw = 0.0
    if mode in ("PRE_MATCH", "POST_MATCH"):
        for s in sellers:
            sidx = bus_idx(player_locations[s])
            if mode == "PRE_MATCH":
                p_mw = kwh_to_mw((seller_energy_kwh or {})[s])
                if p_mw > 1e-12:
                    total_dg_mw += p_mw
                    total_dg_p2p_mw += p_mw
                    pp.create_sgen(net, bus=sidx, p_mw=p_mw, q_mvar=0.0,
                                   name=f"DG_Seller{s}")
            else:  # POST_MATCH
                # (1) energy actually matched & delivered peer-to-peer
                p2p_mw = kwh_to_mw((seller_sold_kwh or {}).get(s, 0.0))
                if p2p_mw > 1e-12:
                    total_dg_mw += p2p_mw
                    total_dg_p2p_mw += p2p_mw
                    pp.create_sgen(net, bus=sidx, p_mw=p2p_mw, q_mvar=0.0,
                                   name=f"DG_Seller{s}_P2P")
                # (2) unsold residual exported back to the grid at FIT
                grid_mw = kwh_to_mw((seller_unsold_kwh or {}).get(s, 0.0))
                if grid_mw > 1e-12:
                    total_dg_mw += grid_mw
                    total_dg_grid_mw += grid_mw
                    pp.create_sgen(net, bus=sidx, p_mw=grid_mw, q_mvar=0.0,
                                   name=f"DG_Seller{s}_GRID")

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
            # Reverse flow: LINE_DATA is ordered from upstream (grid side) to
            # downstream, so p_from_mw < 0 means power flows back toward the grid.
            # A small tolerance (1e-6 MW = 0.001 kW) avoids flagging numerical noise
            # on lines that carry virtually no power (dead-end stubs).
            "reverse":   bool(float(net.res_line.at[i, "p_from_mw"]) < -1e-6),
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

        # ── Through-power at the HV (grid) side + rating comparison ────────────
        # p_hv_mw is signed: positive = power flows grid → feeder (import);
        # negative = power flows feeder → grid (reverse power flow / RPF).
        # loading_percent (pandapower) is |S|/sn_mva*100 — a magnitude, so it does
        # NOT reveal direction on its own; the sign of p_hv_mw does.
        p_hv_mw    = float(net.res_trafo.at[i, "p_hv_mw"])
        q_hv_mvar  = float(net.res_trafo.at[i, "q_hv_mvar"])
        sn_mva     = float(net.trafo.at[i, "sn_mva"])
        s_hv_mva   = (p_hv_mw ** 2 + q_hv_mvar ** 2) ** 0.5   # apparent power through trafo
        sn_kva     = sn_mva * 1000.0
        is_reverse = p_hv_mw < -1e-9
        # RPF magnitude = active power pushed back toward the grid (0 when importing)
        rpf_kw     = (abs(p_hv_mw) * 1000.0) if is_reverse else 0.0
        # "RPF = X kW vs rating 100 kVA = Y %": active-power-over-rating ratio,
        # exactly the comparison requested for the RPF-vs-design-rating check.
        rpf_pct    = (abs(p_hv_mw) / sn_mva * 100.0) if sn_mva > 1e-12 else 0.0

        trafo_results.append({
            "trafoIdx":   int(i),
            "hvBus":      int(net.trafo.at[i, "hv_bus"]),
            "lvBus":      int(net.trafo.at[i, "lv_bus"]),
            "loadingPct": round(float(net.res_trafo.at[i, "loading_percent"]), 6),
            "plMw":       round(pl_mw, 8),
            "qlMvar":     round(ql_mvar, 8),
            "plKw":       round(pl_mw * 1000, 6),
            "qlKvar":     round(ql_mvar * 1000, 6),
            # ── NEW: direction + through-power + rating comparison ────────────
            "pHvKw":            round(p_hv_mw * 1000, 6),   # signed (+import / −reverse)
            "qHvKvar":          round(q_hv_mvar * 1000, 6),
            "sThroughKva":      round(s_hv_mva * 1000, 6),  # |S| crossing the trafo
            "snKva":            round(sn_kva, 6),           # transformer rating (100 kVA)
            "isReverse":        bool(is_reverse),           # True = RPF to grid
            "rpfKw":            round(rpf_kw, 6),            # active power reversed
            "rpfPctOfRating":   round(rpf_pct, 4),          # RPF kW / rating kVA * 100
            "loadHeadroomKva":  round(sn_kva - s_hv_mva * 1000, 6),  # margin left
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

    # ── Reverse power flow detection ──────────────────────────────────────────
    # grid_supply_mw is the slack (grid) injection. Positive = grid supplies the
    # feeder (normal import). Negative = surplus is pushed back into the grid
    # (reverse flow at the substation / transformer).
    grid_import_mw    = max(0.0, grid_supply_mw)
    grid_export_mw    = max(0.0, -grid_supply_mw)
    is_reverse_to_grid = grid_supply_mw < -1e-6
    # Where the reverse-to-grid happens: power crosses the transformer from the
    # LV point-of-common-coupling (PCC) bus up to the external-grid (slack) bus.
    grid_bus = int(net.ext_grid.bus.iloc[0]) if len(net.ext_grid) else 0
    pcc_bus  = int(net.trafo.lv_bus.iloc[0]) if len(net.trafo)    else 1
    # Lines whose power flows toward the grid (opposite the nominal direction).
    reverse_lines = [
        {"line": l["lineIdx"], "from": l["from"], "to": l["to"],
         "pFromMw": l["pFromMw"], "pFromKw": round(l["pFromMw"] * 1000, 4),
         "loading": l["loading"]}
        for l in line_results if l["reverse"]
    ]
    reverse_line_count = len(reverse_lines)

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
    violations_thermal = [
        {"line": l["lineIdx"], "from": l["from"], "to": l["to"],
         "loading": l["loading"], "excess": round(l["loading"] - MAX_LINE_LOADING, 4)}
        for l in line_results if l["loading"] > MAX_LINE_LOADING
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
            "total_dg_p2p_mw":      round(total_dg_p2p_mw, 8),
            "total_dg_grid_mw":     round(total_dg_grid_mw, 8),
            "total_buyer_load_mw":  round(total_buyer_load, 8),
            "total_load_mw":        round(total_load_mw, 8),
            "total_sgen_mw":        round(total_sgen_mw, 8),
            "loss_pct":             round(loss_pct, 4),
            # Reverse power flow
            "grid_import_mw":       round(grid_import_mw, 8),
            "grid_export_mw":       round(grid_export_mw, 8),
            "is_reverse_to_grid":   is_reverse_to_grid,
            "reverse_line_count":   reverse_line_count,
            "grid_bus":             grid_bus,
            "pcc_bus":              pcc_bus,
        },
        "reverseLines": reverse_lines,
        "violations": {
            "under":   violations_under,
            "over":    violations_over,
            "thermal": violations_thermal,
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
#                       and max feasible withdrawal per buyer
# ---------------------------------------------------------------------------
# ----------------------------------------------------------------------------
# /api/energy_range  –  feasible energy window (cached + reverse-flow toggle)
# ----------------------------------------------------------------------------
_DEFAULT_ER = {
    "load_cap_total":           15.55,   # op_total = buyer physical load
    "relief_total":             15.55,   # grid-relief cap (no reverse flow) = Σload
    "relief_per":               3.11,    # = 15.55 / 5  (SAFE: Σinject = Σload)
    # Real edge before reverse power flow. Because the network losses (~0.28 kW)
    # must also be supplied before power flows back to the grid, the true no-reverse
    # limit is Σinject <= Σload + loss (grid_supply >= 0), NOT Σinject <= Σload.
    #   reverse_edge_per   = largest per-seller step (2-dp) still pre-reverse
    #   reverse_edge_total = 3.16 x 5 = 15.80  (grid_supply ~ +0.03 kW, still import)
    #   reverse_onset_total= exact onset where grid_supply = 0 (= Σload + loss)
    "reverse_edge_per":         3.16,
    "reverse_edge_total":       15.80,
    "reverse_onset_total":      15.83,
    # ── OVER-VOLTAGE hard cap ────────────────────────────────────────────────
    # CORRECTED (was 61.79 / 12.35, which VIOLATES: Vmax = 1.05245, 3 buses over).
    # The POST_MATCH limit depends on buyer demand, which is USER INPUT, so it
    # cannot be cached as a constant. The cap that is valid for ANY buyer demand
    # is the zero-load worst case, which equals the PRE_MATCH limit.
    #   verified by binary search: 54.3065 kWh total, Vmax = 1.05000 exactly.
    "hard_total":               54.30,   # worst case, valid for any buyer demand
    "hard_per":                 10.86,   # = 54.30 / 5
    "hard_total_premaatch":     54.30,   # PRE_MATCH limit (identical, kept for the UI)
    # Reference-load limit — ONLY valid when Sigma buyer load == 15.55 kWh.
    # Shown for information; never enforced as an input cap.
    "hard_total_at_ref_load":   58.84,   # verified: 58.8450, Vmax = 1.05000
    "hard_per_at_ref_load":     11.76,
    # ── UNDER-VOLTAGE cap (buyer side, BUYER_TEST) ───────────────────────────
    # verified by binary search: 70.9115 kWh total, Vmin = 0.95000 exactly.
    # NOTE the binding constraint here is VOLTAGE, not thermal (loading 93.84%).
    "undervolt_total_buyer":    70.91,
    "undervolt_per_buyer":      14.18,   # = 70.91 / 5
    "thermal_max_total_seller": 54.30,
    "thermal_max_total_buyer":  70.91,
}

_ER_CACHE = {}

def _is_default(sellers, buyers, player_locations):
    return (sorted(sellers) == sorted(SELLERS) and
            sorted(buyers)  == sorted(BUYERS) and
            player_locations == PLAYER_LOCATIONS)

def _build_response(relief_per, relief_total, hard_per, hard_total,
                    op_total, allow_reverse,
                    reverse_edge_per=None, reverse_edge_total=None,
                    reverse_onset_total=None, extra=None,
                    buyer_per=None, buyer_total=None):
    if allow_reverse:
        cap_per, cap_total = hard_per, hard_total
        mode = "hosting-capacity (reverse flow allowed)"
    else:
        cap_per, cap_total = relief_per, relief_total
        mode = "grid-relief (no reverse flow)"
    # Fall back to the safe (relief) values if the real edge was not supplied.
    r_edge_per   = reverse_edge_per   if reverse_edge_per   is not None else relief_per
    r_edge_total = reverse_edge_total if reverse_edge_total is not None else relief_total
    r_onset_tot  = reverse_onset_total if reverse_onset_total is not None else r_edge_total
    out = {
        "allow_reverse_flow": allow_reverse,
        "mode": mode,
        # active cap the UI should enforce on inputs:
        "max_kwh_per_seller":   cap_per,
        "max_kwh_total_seller": cap_total,
        # BUG FIX: the buyer cap used to be a copy of the SELLER cap, which has
        # nothing to do with under-voltage. It is now the buyer-side
        # under-voltage limit from the BUYER_TEST binary search.
        "max_kwh_per_buyer":    buyer_per   if buyer_per   is not None else cap_per,
        "max_kwh_total_buyer":  buyer_total if buyer_total is not None else cap_total,
        "undervolt_per_buyer":   buyer_per,
        "undervolt_total_buyer": buyer_total,
        # both caps, always provided so a UI toggle needs no refetch:
        "relief_per": relief_per, "relief_total": relief_total,
        "hard_per": hard_per,     "hard_total": hard_total,
        # SAFE (no reverse, Σinject <= Σload) vs REAL EDGE (Σinject <= Σload + loss):
        "safe_per":    relief_per,   "safe_total":    relief_total,
        "reverse_edge_per":    r_edge_per,   "reverse_edge_total": r_edge_total,
        "reverse_onset_total": r_onset_tot,
        "load_cap_total": op_total,
        "min_kwh_per_seller": 0, "min_kwh_per_buyer": 0,
        "feasibility_note": (
            f"{mode}: active input cap = {cap_total:.2f} kW ({cap_per:.2f}/each). "
            f"SAFE = {relief_total:.2f} kW total ({relief_per:.2f}/each, "
            f"\u03a3inject = \u03a3load, no reverse guaranteed) \u00b7 "
            f"real edge before reverse = {r_edge_total:.2f} kW ({r_edge_per:.2f}/each, "
            f"\u03a3load + loss) \u00b7 reverse-flow onset ~{r_onset_tot:.2f} kW \u00b7 "
            f"hard over-voltage limit {hard_total:.2f} kW ({hard_per:.2f}/each, Vmax = 1.05, "
            f"worst case = zero buyer load, valid for any demand)"
            + (f" \u00b7 under-voltage limit {buyer_total:.2f} kW ({buyer_per:.2f}/buyer, "
               f"Vmin = 0.95)." if buyer_total is not None else ".")
        ),
    }
    if extra:
        out.update(extra)
    return out


@app.route("/api/energy_range", methods=["POST"])
def energy_range():
    data = request.json or {}
    sellers = data.get("sellers", SELLERS)
    buyers  = data.get("buyers",  BUYERS)
    player_locations = data.get("player_locations", PLAYER_LOCATIONS)
    allow_reverse = bool(data.get("allow_reverse_flow", False))
    n, n_b = len(sellers), len(buyers)
    if n == 0:
        return jsonify({"max_kwh_per_seller": 0, "max_kwh_total_seller": 0,
                        "feasibility_note": "No sellers configured."})

    # 1) Instant path for the default layout.
    if _is_default(sellers, buyers, player_locations):
        d = _DEFAULT_ER
        return jsonify(_build_response(
            d["relief_per"], d["relief_total"], d["hard_per"], d["hard_total"],
            d["load_cap_total"], allow_reverse,
            reverse_edge_per=d["reverse_edge_per"],
            reverse_edge_total=d["reverse_edge_total"],
            reverse_onset_total=d["reverse_onset_total"],
            buyer_per=d["undervolt_per_buyer"],
            buyer_total=d["undervolt_total_buyer"],
            extra={"thermal_max_total_seller":  d["thermal_max_total_seller"],
                   "thermal_max_total_buyer":   d["thermal_max_total_buyer"],
                   "hard_total_at_ref_load":    d["hard_total_at_ref_load"],
                   "hard_per_at_ref_load":      d["hard_per_at_ref_load"],
                   "hard_total_premaatch":      d["hard_total_premaatch"]}))

    # 2) Custom layout: compute + cache (keyed on layout, not on the flag).
    key = hashlib.md5(json.dumps(
        [sorted(sellers), sorted(buyers), sorted(player_locations.items())],
        sort_keys=True).encode()).hexdigest()
    if key not in _ER_CACHE:
        def seller_ok(total):
            per = total / n
            try:
                r = run_case("PRE_MATCH", sellers, [], player_locations,
                             seller_energy_kwh={s: per for s in sellers})
                if not r.get("converged"): return False
                v = r["violations"]
                return len(v["under"])==0 and len(v["over"])==0 and len(v["thermal"])==0
            except Exception:
                return False
        lo_s, hi_s = 0.0, 300.0
        for _ in range(40):
            mid = (lo_s + hi_s) / 2.0
            lo_s, hi_s = (mid, hi_s) if seller_ok(mid) else (lo_s, mid)

        # Buyer-side UNDER-voltage limit. This was missing entirely: the custom
        # branch used to return the SELLER cap as the buyer cap.
        def buyer_ok(total):
            per = total / max(n_b, 1)
            try:
                r = run_case("BUYER_TEST", sellers, buyers, player_locations,
                             buyer_energy_kwh={b: per for b in buyers})
                if not r.get("converged"): return False
                v = r["violations"]
                return len(v["under"])==0 and len(v["over"])==0 and len(v["thermal"])==0
            except Exception:
                return False
        lo_b, hi_b = 0.0, 300.0
        if n_b:
            for _ in range(40):
                mid = (lo_b + hi_b) / 2.0
                lo_b, hi_b = (mid, hi_b) if buyer_ok(mid) else (lo_b, mid)
        op_total = sum(ACTUAL_LOAD_DATA.get(bus_idx(player_locations[b]), (0.0, 0.0))[0]
                       for b in buyers) * 1000.0
        # Reverse-flow onset = Σload + loss (grid_supply = 0). A single POST_MATCH
        # power flow at Σinject = Σload (all injection exported) gives the loss, so
        # the UI can show the SAFE cap (Σinject<=Σload) vs the REAL edge before reverse.
        onset_total = op_total
        try:
            per_inj   = op_total / n
            buyer_kwh = {b: ACTUAL_LOAD_DATA.get(bus_idx(player_locations[b]),
                                                 (0.0, 0.0))[0] * 1000.0 for b in buyers}
            r2 = run_case("POST_MATCH", sellers, buyers, player_locations,
                          seller_energy_kwh={s: per_inj for s in sellers},
                          buyer_energy_kwh=buyer_kwh,
                          seller_sold_kwh={s: 0.0 for s in sellers},
                          buyer_bought_kwh={b: 0.0 for b in buyers},
                          seller_unsold_kwh={s: per_inj for s in sellers})
            if r2.get("converged"):
                onset_total = op_total + r2["metrics"]["total_loss_mw"] * 1000.0
        except Exception:
            pass
        edge_per   = int((onset_total / n) * 100) / 100.0   # floor to 2-dp (stay pre-reverse)
        edge_total = round(edge_per * n, 2)
        f2 = lambda x: int(x * 100) / 100.0      # floor: never round a cap UP
        _ER_CACHE[key] = (f2(min(lo_s, op_total)/n), f2(min(lo_s, op_total)),
                          f2(lo_s/n), f2(lo_s), round(op_total, 2),
                          edge_per, edge_total, round(onset_total, 2),
                          f2(lo_b/n_b) if n_b else 0.0, f2(lo_b))
    (rp, rt, hp, ht, op_total, r_edge_per, r_edge_total,
     r_onset_total, bu_per, bu_total) = _ER_CACHE[key]
    return jsonify(_build_response(rp, rt, hp, ht, op_total, allow_reverse,
                                   reverse_edge_per=r_edge_per,
                                   reverse_edge_total=r_edge_total,
                                   reverse_onset_total=r_onset_total,
                                   buyer_per=bu_per, buyer_total=bu_total))


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
            seller_unsold_kwh=data.get("seller_unsold_kwh"),
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

    # Unsold residual per seller = offered energy that could not be matched under
    # the bid >= offer rule. Under the current (provisional) settlement rule this
    # residual is sold back to the grid at FIT and is injected as a separate sgen
    # block in POST_MATCH so its effect on reverse power flow is visible.
    unsold_kwh = {
        s: max(0.0, float(seller_energy_kwh.get(s, 0.0)) - float(sold_kwh.get(s, 0.0)))
        for s in sellers
    }
    # Buyer unmet = demand bought from the main grid at ToU (economic side only;
    # the buyer's physical load already stays in POST_MATCH, drawn from the grid).
    unmet_kwh = {
        b: max(0.0, float(buyer_energy_kwh.get(b, 0.0)) - float(bought_kwh.get(b, 0.0)))
        for b in buyers
    }

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
                           buyer_bought_kwh =bought_kwh,
                           seller_unsold_kwh=unsold_kwh)
    except Exception as e:
        pf_post = {"converged": False, "error": str(e)}

    # ── 6. Reverse power flow comparison (BASE vs POST) + settlement summary ──
    def _rf(pf):
        m = (pf or {}).get("metrics", {}) if isinstance(pf, dict) else {}
        rlines = (pf or {}).get("reverseLines", []) if isinstance(pf, dict) else []
        return {
            "grid_supply_kw":  round(m.get("grid_supply_mw", 0.0) * 1000, 4),
            "grid_export_kw":  round(m.get("grid_export_mw", 0.0) * 1000, 4),
            "grid_import_kw":  round(m.get("grid_import_mw", 0.0) * 1000, 4),
            "is_reverse":      bool(m.get("is_reverse_to_grid", False)),
            "reverse_lines":   m.get("reverse_line_count", 0),
            "grid_bus":        m.get("grid_bus", 0),
            "pcc_bus":         m.get("pcc_bus", 1),
            "reverse_line_list": [
                {"from": l["from"], "to": l["to"], "pFromKw": l["pFromKw"],
                 "loading": l["loading"]} for l in rlines
            ],
            "max_loading_pct": round(m.get("max_line_loading_pct", 0.0), 4),
            "loss_kw":         round(m.get("total_loss_mw", 0.0) * 1000, 4),
        }

    total_unsold = sum(unsold_kwh.values())
    total_unmet  = sum(unmet_kwh.values())

    # Enrich POST reverse lines with BASE comparison so the UI can distinguish
    # "reversed AND more loaded" (concerning) from "reversed but less loaded"
    # (direction flipped while magnitude dropped — e.g. line 3->4). The standard
    # definition of reverse flow is a *direction* reversal (p_from < 0); whether
    # %loading rises depends on whether the reversed magnitude exceeds the
    # original forward magnitude, which is a separate question.
    base_line_load = {}
    if isinstance(pf_base, dict):
        for l in pf_base.get("lineResults", []):
            base_line_load[(l["from"], l["to"])] = l["loading"]
    post_reverse_detail = []
    if isinstance(pf_post, dict):
        for l in pf_post.get("reverseLines", []):
            bl = base_line_load.get((l["from"], l["to"]), 0.0)
            delta = round(l["loading"] - bl, 4)
            post_reverse_detail.append({
                "from": l["from"], "to": l["to"],
                "pFromKw": l["pFromKw"],
                "postLoading": l["loading"], "baseLoading": round(bl, 4),
                "deltaLoading": delta, "loadingUp": bool(delta > 1e-6),
            })

    reverse_flow_summary = {
        "base": _rf(pf_base),
        "post": _rf(pf_post),
        "post_reverse_detail": post_reverse_detail,
        # The unsold residual injected as grid export in POST_MATCH (kW == kWh/slot)
        "grid_export_from_unsold_kwh": round(total_unsold, 4),
        "grid_export_fit_revenue":     round(total_unsold * FIT_PRICE, 2),
        "buyer_unmet_kwh":             round(total_unmet, 4),
        "note": ("Reverse flow line = direction of real power reverses "
                 "(p_from < 0). This is NOT the same as %loading rising: a line "
                 "can reverse while its loading drops if the reversed magnitude is "
                 "smaller than the original forward magnitude. Residual seller "
                 "energy is sold back to the grid at FIT (provisional rule, to be "
                 "refined later). Buyer shortfall is bought from the grid at ToU."),
    }

    settlement_summary = {
        "seller_unsold_kwh": {s: round(v, 4) for s, v in unsold_kwh.items()},
        "buyer_unmet_kwh":   {b: round(v, 4) for b, v in unmet_kwh.items()},
        "fit_price":         FIT_PRICE,
    }

    return jsonify({
        "success":     True,
        "price_errors": [],
        "matching":    match_res,
        "power_flow": {
            "base":       pf_base,
            "pre_match":  pf_pre,
            "post_match": pf_post,
        },
        "case_labels": CASE_DISPLAY_NAMES,
        "reverse_flow": reverse_flow_summary,
        "settlement":   settlement_summary,
    })


# =============================================================================
# Entry point
# =============================================================================

# --- LIVE feasible-range endpoint (separate module; nothing above changes) ---
try:
    from energy_range_live import bp_live
    app.register_blueprint(bp_live)
except Exception as _e:          # module missing -> app still runs as before
    print("energy_range_live not loaded:", _e)

if __name__ == "__main__":
    from market import register_market_routes
    register_market_routes(app)


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