"""
test_buyer_limit.py — Binary-search the maximum total BUYER load (kWh per 1-hour
slot) the feeder can serve WITHOUT any violation.

BUG FIX (important):
  The previous version called run_case('POST_MATCH', ...). In POST_MATCH the
  buyer-bus load is FIXED to ACTUAL_LOAD_DATA and the buyer_energy_kwh argument
  is ignored — so the swept value had no effect on the power flow and the search
  saturated at UPPER (returning a meaningless 10000 kWh/buyer).
  The correct mode is 'BUYER_TEST', which places buyer_energy_kwh as the load at
  each buyer bus (this is the mode /api/energy_range uses for the same purpose).

NOTES after the Imax/R/X change (R,X x3, Imax = 0.34/3 kA):
  * Buyers are loads, so they push voltage DOWN — the binding limit is
    UNDER-VOLTAGE (Vmin = 0.95), reached at ~70.9 kW total (~14.18 kWh/buyer);
    line loading is still ~94% there, so voltage binds just before thermal.
  * UPPER only needs to exceed the true limit (~71 kW). 50000 was absurd; 200
    keeps a safe margin. (The loop is a fixed 40-iteration binary search, so a
    smaller UPPER is not "faster" — it just avoids wasted resolution.)
  * Thermal is included in the pass test so the result stays correct if the
    conductor parameters change and thermal becomes binding.
"""
import sys
sys.path.append('.')
from server import BUYERS, PLAYER_LOCATIONS, run_case

n_b = len(BUYERS)

# Upper search bound (TOTAL kWh across all buyers). Must exceed the true limit
# (~71 kW). 200 gives a safe ~2.8x margin.
UPPER = 200.0

lo = 0.0
hi = UPPER


def test_buyer_total(total_kwh: float) -> bool:
    """True if total_kwh of buyer load (split equally) causes NO violation."""
    per = total_kwh / n_b
    try:
        res = run_case(
            'BUYER_TEST', [], BUYERS, PLAYER_LOCATIONS,   # was 'POST_MATCH' (bug)
            buyer_energy_kwh={b: per for b in BUYERS},
        )
        if not res.get('converged'):
            return False
        v = res.get('violations', {})
        return (len(v.get('under', []))   == 0 and
                len(v.get('over', []))    == 0 and
                len(v.get('thermal', [])) == 0)
    except Exception:
        return False


for _ in range(40):
    mid = (lo + hi) / 2.0
    if test_buyer_total(mid):
        lo = mid
    else:
        hi = mid

per_max = lo / n_b
res = run_case('BUYER_TEST', [], BUYERS, PLAYER_LOCATIONS,
               buyer_energy_kwh={b: per_max for b in BUYERS})
m = res.get('metrics', {})

print(f"MAX_BUYER_TOTAL={lo:.4f}")
print(f"MAX_PER_BUYER={per_max:.4f}")
print(f"BINDING_VMIN={m.get('min_voltage_pu', 0):.5f} p.u.")
print(f"BINDING_MAX_LOADING={m.get('max_line_loading_pct', 0):.3f} %")