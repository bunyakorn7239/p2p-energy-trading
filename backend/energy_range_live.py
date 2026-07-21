"""
energy_range_live.py — LIVE feasible-range recalculation.

WHY THIS IS A SEPARATE FILE
  /api/energy_range returns the FIXED reference caps (cached constants computed
  once for the default layout). Those stay exactly as they are.

  This module adds a SECOND, independent endpoint that re-runs the binary search
  against whatever the user has actually typed in, every time the input changes.

WHAT IS DIFFERENT FROM THE FIXED CAPS
  The fixed caps assume the injection is split EQUALLY between sellers. The live
  search scales the user's ACTUAL vector, so it accounts for where the energy is
  concentrated:

      p_i(k) = k * s_i        k = scale factor, s_i = what seller i typed

  k_max is the largest k with no violation. The live cap for seller i is then
  k_max * s_i, so a seller at the feeder end gets a smaller number than a seller
  near the substation — which the equal-share cap cannot express.

SPEED
  A plain 40-iteration bisection needs 40 power flows (~14 s) — far too slow to
  run on every keystroke. Vmax(k) and Vmin(k) are close to linear in k, so this
  module uses the secant method instead and converges in 4-5 power flows
  (~1.5 s per side). The result is then floored to 2 dp and verified with a full
  violation check; if the floored value still violates, it steps down.

  The frontend must still DEBOUNCE (~400 ms) so it fires once the user stops
  typing, not once per character.

REGISTER (2 lines in server.py, nothing else changes):
    from energy_range_live import bp_live
    app.register_blueprint(bp_live)
"""
from __future__ import annotations

import hashlib
import json
from typing import Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

bp_live = Blueprint("energy_range_live", __name__)

# --------------------------------------------------------------------------- #
# Deferred binding to server.py
#
# `from server import ...` at module level CANNOT be used here. When the app is
# started the normal way (`python server.py`), server.py runs as __main__, so a
# top-level `import server` loads a SECOND copy of the file, whose registration
# block re-imports this module while it is still initialising:
#
#     ImportError: cannot import name 'bp_live' from partially initialized
#     module 'energy_range_live' (most likely due to a circular import)
#
# The blueprint then silently fails to register and /api/energy_range_live
# returns 404. Resolving the symbols on first request instead avoids the cycle
# entirely and works whether server.py is __main__ or an imported module.
# --------------------------------------------------------------------------- #
SELLERS = BUYERS = PLAYER_LOCATIONS = None
V_MIN = V_MAX = None
run_case = None


def _ensure():
    global SELLERS, BUYERS, PLAYER_LOCATIONS, V_MIN, V_MAX, run_case
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
    run_case = mod.run_case

# --------------------------------------------------------------------------- #
# Tunables
# --------------------------------------------------------------------------- #
MAX_PF_PER_SIDE = 16       # hard budget of power flows for one side
TOL_KWH         = 0.05     # stop bisecting when the bracket is this narrow
SECANT_ITERS    = 4        # linear-predictor passes before the safety check
CEILING_KWH     = 5000.0   # absolute upper bound on any reported cap
VERIFY_STEPS    = 4        # step-down attempts if the floored value still fails
_CACHE: Dict[str, dict] = {}
_CACHE_MAX = 256


def _floor2(x: float) -> float:
    """Floor to 2 dp. A cap must never be rounded UP."""
    return int(max(x, 0.0) * 100) / 100.0


def _norm(d: Optional[Dict[str, float]], keys: List[str]) -> Dict[str, float]:
    d = d or {}
    return {k: max(float(d.get(k, 0.0) or 0.0), 0.0) for k in keys}


# --------------------------------------------------------------------------- #
# One power flow at a given scale factor
# --------------------------------------------------------------------------- #
def _solve(sellers, buyers, player_locations,
           s_vec: Dict[str, float], b_vec: Dict[str, float]) -> Optional[dict]:
    """POST_MATCH power flow. All injection is placed as unsold: the sold/unsold
    split changes only the revenue accounting, not the electrical result (both
    become an sgen at the same bus), so the feasible range is unaffected."""
    try:
        r = run_case("POST_MATCH", sellers, buyers, player_locations,
                     buyer_energy_kwh=dict(b_vec),
                     seller_sold_kwh={s: 0.0 for s in sellers},
                     seller_unsold_kwh=dict(s_vec))
    except Exception:
        return None
    if not r.get("converged"):
        return None
    m, v = r["metrics"], r["violations"]
    return {
        "vmax": m["max_voltage_pu"],
        "vmin": m["min_voltage_pu"],
        "loading": m["max_line_loading_pct"],
        "grid_supply_kw": m["grid_supply_mw"] * 1000.0,
        "n_over": len(v["over"]),
        "n_under": len(v["under"]),
        "n_thermal": len(v["thermal"]),
        "over_buses": [b["bus"] for b in v["over"]],
        "under_buses": [b["bus"] for b in v["under"]],
        "feasible": not (v["over"] or v["under"] or v["thermal"]),
    }


# --------------------------------------------------------------------------- #
# Secant root-find on the scale factor
# --------------------------------------------------------------------------- #
def _margin_seller(r) -> float:
    """Distance past the limit for the SELLER side (over-voltage / thermal).
    Monotonically INCREASING in injected energy."""
    return max(r["vmax"] - V_MAX, (r["loading"] - 100.0) / 1000.0)


def _margin_buyer(r) -> float:
    """Distance past the limit for the BUYER side (under-voltage / thermal).
    Monotonically INCREASING in withdrawn energy.

    Over-voltage is deliberately EXCLUDED here: adding load lowers Vmax, so
    folding it in would make the function V-shaped and the linear predictor
    would diverge. An over-voltage caused by the sellers is reported separately
    and is fixed on the seller side, not by limiting the buyers.
    """
    return max(V_MIN - r["vmin"], (r["loading"] - 100.0) / 1000.0)


def _search(eval_at, margin, seed: float) -> Tuple[float, int]:
    """Largest total (kWh) that is still fully feasible.

    Two stages, because each covers the other's weakness:

      1. LINEAR PREDICTOR - Vmax and Vmin are very nearly linear in energy, so a
         secant on margin() lands within ~0.1 kWh in about four power flows,
         where a plain 40-iteration bisection would need forty.

      2. VERIFIED BISECTION - the prediction is then closed onto the largest
         point that passes the SAME boolean feasibility test a bisection uses
         (no over-voltage, no under-voltage, no thermal). Only a point that has
         actually been solved and passed is ever returned, so the reported cap
         can never be optimistic even if the linear step overshoots.
    """
    calls = 0
    seed = max(float(seed), 0.5)
    best_ok = 0.0                      # largest total PROVEN feasible

    def probe(k):
        nonlocal calls, best_ok
        r = eval_at(k); calls += 1
        if r is not None and r["feasible"]:
            best_ok = max(best_ok, k)
        return r

    r0 = probe(seed)
    if r0 is None:
        return 0.0, calls

    # Non-monotonic start: if the current input already over-volts, adding load
    # can cure it, so the feasible band lies ABOVE the seed, not below.
    if not r0["feasible"] and r0["n_over"] and not r0["n_under"]:
        for mult in (2.0, 4.0, 8.0):
            rp = probe(seed * mult)
            if rp is not None and rp["feasible"]:
                seed, r0 = seed * mult, rp
                break

    # ---- stage 1: secant on the margin --------------------------------------
    k0, f0 = seed, margin(r0)
    k1 = seed * 2.0
    r1 = probe(k1)
    if r1 is None:
        return _floor2(best_ok), calls
    f1 = margin(r1)

    for _ in range(SECANT_ITERS):
        if abs(f1 - f0) < 1e-12:
            break
        k2 = min(max(k1 - f1 * (k1 - k0) / (f1 - f0), 0.0), CEILING_KWH)
        if abs(k2 - k1) < TOL_KWH:
            k1 = k2
            break
        r2 = probe(k2)
        if r2 is None:
            break
        k0, f0, k1, f1 = k1, f1, k2, margin(r2)

    # ---- stage 2: close the bracket with the true feasibility test ----------
    # One probe just under the prediction usually passes, which collapses the
    # bracket to <1% of the root and saves ~5 power flows of bisection.
    if k1 > 0 and best_ok < k1 * 0.99:
        probe(k1 * 0.99)

    hi = max(k1, best_ok)
    if hi > best_ok:
        while hi - best_ok > TOL_KWH and calls < MAX_PF_PER_SIDE:
            mid = (best_ok + hi) / 2.0
            r = probe(mid)
            if r is not None and r["feasible"]:
                pass                    # probe() already advanced best_ok
            else:
                hi = mid

    return best_ok, calls


def _verify_down(eval_at, k: float) -> Tuple[float, int]:
    """_search only ever returns a point it has already solved and passed, so
    this is a cheap final confirmation of the 2-dp floored value."""
    calls = 0
    if k <= 0.0:
        return 0.0, calls
    r = eval_at(k); calls += 1
    if r is not None and r["feasible"]:
        return k, calls
    for _ in range(VERIFY_STEPS):
        k = _floor2(k - max(k * 0.004, 0.02))
        if k <= 0.0:
            return 0.0, calls
        r = eval_at(k); calls += 1
        if r is not None and r["feasible"]:
            return k, calls
    return 0.0, calls


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #
@bp_live.route("/api/energy_range_live", methods=["POST"])
def energy_range_live():
    _ensure()
    data = request.json or {}
    sellers = data.get("sellers", SELLERS)
    buyers = data.get("buyers", BUYERS)
    player_locations = data.get("player_locations", PLAYER_LOCATIONS)
    s_in = _norm(data.get("seller_energy_kwh"), sellers)
    b_in = _norm(data.get("buyer_energy_kwh"), buyers)

    s_tot, b_tot = sum(s_in.values()), sum(b_in.values())

    # Cache on the rounded input vector so re-sending identical values is free.
    key = hashlib.md5(json.dumps({
        "s": {k: round(v, 3) for k, v in s_in.items()},
        "b": {k: round(v, 3) for k, v in b_in.items()},
        "pl": sorted(player_locations.items()),
    }, sort_keys=True).encode()).hexdigest()
    if key in _CACHE:
        out = dict(_CACHE[key]); out["cached"] = True
        return jsonify(out)

    # Shape vectors. With nothing entered yet, fall back to an equal split so a
    # meaningful number is still shown.
    s_shape = ({k: v / s_tot for k, v in s_in.items()} if s_tot > 1e-9
               else {k: 1.0 / max(len(sellers), 1) for k in sellers})
    b_shape = ({k: v / b_tot for k, v in b_in.items()} if b_tot > 1e-9
               else {k: 1.0 / max(len(buyers), 1) for k in buyers})

    calls = 0

    # -- current operating point -------------------------------------------- #
    now = _solve(sellers, buyers, player_locations, s_in, b_in)
    calls += 1

    # -- SELLER side: how much more injection until over-voltage? ------------ #
    # Buyer demand is held at what the buyers actually entered.
    def eval_s(total_kwh):
        return _solve(sellers, buyers, player_locations,
                      {k: total_kwh * w for k, w in s_shape.items()}, b_in)

    k_s, c = _search(eval_s, _margin_seller, seed=max(s_tot, 1.0))
    calls += c
    k_s, c = _verify_down(eval_s, _floor2(k_s)); calls += c

    # -- BUYER side: how much more demand until under-voltage? --------------- #
    # Seller injection is held at what the sellers actually entered.
    def eval_b(total_kwh):
        return _solve(sellers, buyers, player_locations, s_in,
                      {k: total_kwh * w for k, w in b_shape.items()})

    k_b, c = _search(eval_b, _margin_buyer, seed=max(b_tot, 1.0))
    calls += c
    k_b, c = _verify_down(eval_b, _floor2(k_b)); calls += c

    seller_cap = {s: _floor2(k_s * w) for s, w in s_shape.items()}
    buyer_cap = {b: _floor2(k_b * w) for b, w in b_shape.items()}

    out = {
        "ok": now is not None,
        "cached": False,
        "power_flows": calls,
        # what the user typed
        "seller_input_total": round(s_tot, 3),
        "buyer_input_total": round(b_tot, 3),
        # LIVE caps, computed on the user's own distribution
        "live_max_total_seller": _floor2(k_s),
        "live_max_total_buyer": _floor2(k_b),
        "live_max_per_seller": seller_cap,
        "live_max_per_buyer": buyer_cap,
        "seller_headroom_total": _floor2(max(k_s - s_tot, 0.0)),
        "buyer_headroom_total": _floor2(max(k_b - b_tot, 0.0)),
        "seller_utilisation_pct": round(100.0 * s_tot / k_s, 1) if k_s > 1e-9 else None,
        "buyer_utilisation_pct": round(100.0 * b_tot / k_b, 1) if k_b > 1e-9 else None,
        # state at the current input
        "now": now,
        "binding": ("over-voltage" if now and now["n_over"] else
                    "under-voltage" if now and now["n_under"] else
                    "thermal" if now and now["n_thermal"] else "none"),
        "note": (
            "Live range: the binary search is re-run on the energy actually "
            "entered, scaling that exact distribution. The fixed caps from "
            "/api/energy_range assume an equal split and are unchanged."
        ),
    }

    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()
    _CACHE[key] = out
    return jsonify(out)