"""
calibrate_energy_range.py — Re-derive every constant in server._DEFAULT_ER from
the live network model, so the cached numbers can never drift from the code.

Run:  python calibrate_energy_range.py
Then paste the printed dict over _DEFAULT_ER in server.py.
"""
import sys; sys.path.append('.')
from server import (SELLERS, BUYERS, PLAYER_LOCATIONS, run_case, bus_idx,
                    ACTUAL_LOAD_DATA)

NS, NB = len(SELLERS), len(BUYERS)
BUYER_REF = {b: ACTUAL_LOAD_DATA[bus_idx(PLAYER_LOCATIONS[b])][0] * 1000.0 for b in BUYERS}
LOAD_TOTAL = sum(BUYER_REF.values())

def clean(r):
    if not r.get("converged"): return False
    v = r["violations"]
    return not (v["under"] or v["over"] or v["thermal"])

def bsearch(fn, hi=300.0, iters=45):
    lo = 0.0
    for _ in range(iters):
        mid = (lo + hi) / 2.0
        lo, hi = (mid, hi) if fn(mid) else (lo, mid)
    return lo

def floor2(x):  return int(x * 100) / 100.0   # never round UP a safety cap

# ── 1. PRE_MATCH over-voltage limit (no load at all = worst case) ────────────
pre = bsearch(lambda t: clean(run_case(
    "PRE_MATCH", SELLERS, [], PLAYER_LOCATIONS,
    seller_energy_kwh={s: t/NS for s in SELLERS})))

# ── 2. POST_MATCH over-voltage limit at the reference buyer load ─────────────
def post_ok(t, bk):
    return clean(run_case("POST_MATCH", SELLERS, BUYERS, PLAYER_LOCATIONS,
                          buyer_energy_kwh=bk,
                          seller_sold_kwh={s: 0.0 for s in SELLERS},
                          seller_unsold_kwh={s: t/NS for s in SELLERS}))
post_ref = bsearch(lambda t: post_ok(t, BUYER_REF))

# ── 3. Reverse-flow onset = Sigma load + losses ──────────────────────────────
r2 = run_case("POST_MATCH", SELLERS, BUYERS, PLAYER_LOCATIONS,
              buyer_energy_kwh=BUYER_REF,
              seller_sold_kwh={s: 0.0 for s in SELLERS},
              seller_unsold_kwh={s: LOAD_TOTAL/NS for s in SELLERS})
onset = LOAD_TOTAL + r2["metrics"]["total_loss_mw"] * 1000.0

# ── 4. Buyer-side under-voltage limit (BUYER_TEST) ───────────────────────────
buy = bsearch(lambda t: clean(run_case(
    "BUYER_TEST", SELLERS, BUYERS, PLAYER_LOCATIONS,
    buyer_energy_kwh={b: t/NB for b in BUYERS})))
rb = run_case("BUYER_TEST", SELLERS, BUYERS, PLAYER_LOCATIONS,
              buyer_energy_kwh={b: buy/NB for b in BUYERS})

edge_per = floor2(onset / NS)

print(f"""
_DEFAULT_ER = {{
    # --- operating point (reference buyer load from ACTUAL_LOAD_DATA) --------
    "load_cap_total":           {LOAD_TOTAL:.2f},
    "relief_total":             {LOAD_TOTAL:.2f},
    "relief_per":               {floor2(LOAD_TOTAL/NS):.2f},
    "reverse_edge_per":         {edge_per:.2f},
    "reverse_edge_total":       {edge_per*NS:.2f},
    "reverse_onset_total":      {onset:.2f},

    # --- OVER-VOLTAGE hard caps (verified by binary search) -----------------
    # Worst case = no buyer load. Valid for ANY buyer demand -> this is what
    # the UI must enforce, because buyer demand is user input.
    "hard_total":               {floor2(pre):.2f},
    "hard_per":                 {floor2(pre/NS):.2f},
    "hard_total_premaatch":     {floor2(pre):.2f},
    # Reference-load limit: only valid when Sigma buyer load == {LOAD_TOTAL:.2f} kWh.
    "hard_total_at_ref_load":   {floor2(post_ref):.2f},
    "hard_per_at_ref_load":     {floor2(post_ref/NS):.2f},

    # --- UNDER-VOLTAGE cap (buyer side, BUYER_TEST) ------------------------
    "undervolt_total_buyer":    {floor2(buy):.2f},
    "undervolt_per_buyer":      {floor2(buy/NB):.2f},
    "thermal_max_total_seller": {floor2(pre):.2f},
    "thermal_max_total_buyer":  {floor2(buy):.2f},
}}
""")
print("--- binding-constraint check ---")
rp = run_case("PRE_MATCH", SELLERS, [], PLAYER_LOCATIONS,
              seller_energy_kwh={s: pre/NS for s in SELLERS})
print(f"  over-voltage cap  {pre:8.4f}  Vmax={rp['metrics']['max_voltage_pu']:.5f} "
      f" loading={rp['metrics']['max_line_loading_pct']:.2f}%  -> binding = VOLTAGE")
print(f"  post@ref load     {post_ref:8.4f}")
print(f"  under-voltage cap {buy:8.4f}  Vmin={rb['metrics']['min_voltage_pu']:.5f} "
      f" loading={rb['metrics']['max_line_loading_pct']:.2f}%  -> binding = VOLTAGE")