"""
find_max_kwh.py — Binary-search the maximum total seller injection (kWh per
1-hour slot) that the feeder can absorb in PRE_MATCH WITHOUT any violation.

NOTE on UPPER (upper search bound):
  * The search loop runs a FIXED 40 iterations (binary search), so UPPER does
    NOT change how many iterations run — 300 and 30000 take the exact same time.
  * What UPPER must guarantee is that it stays ABOVE the true violation limit;
    otherwise the result saturates at UPPER and is wrong.
  * With the current network (R,X x3 conductor scaling, Imax = 0.34/3 kA) the
    binding limit is OVER-VOLTAGE, and the true PRE_MATCH max is ~54.3 kW total
    (~10.86 kWh/seller). UPPER = 150 keeps a safe ~2.8x margin with good
    resolution. (Realistic ceiling: a generous 15-20 kWp rooftop yields at most
    ~15-20 kWh/seller in one hour, i.e. ~75-100 kW total — still under 150.)

NOTE on the violation test:
  The original version checked under/over voltage only. This version ALSO checks
  the thermal limit so the result stays correct if the conductor parameters
  change and thermal becomes the binding constraint again (mirrors the
  /api/energy_range endpoint, which checks under + over + thermal).
"""
import sys
sys.path.append('.')
from server import SELLERS, PLAYER_LOCATIONS, run_case

n = len(SELLERS)

# Upper search bound (TOTAL kWh across all sellers). Must exceed the true
# violation limit (~54 kW). 150 gives a safe margin; 300 also works but is wider
# than necessary. Do NOT set this below ~60 or the result may saturate.
UPPER = 150.0

lo = 0.0
hi = UPPER


def test_total(total_kwh: float) -> bool:
    """Return True if injecting total_kwh (split equally) causes NO violation."""
    per = total_kwh / n
    try:
        res = run_case(
            'PRE_MATCH', SELLERS, [], PLAYER_LOCATIONS,
            seller_energy_kwh={s: per for s in SELLERS},
        )
        if not res.get('converged'):
            return False
        v = res.get('violations', {})
        return (len(v.get('under', []))   == 0 and
                len(v.get('over', []))    == 0 and
                len(v.get('thermal', [])) == 0)   # thermal now included
    except Exception:
        return False


for _ in range(40):
    mid = (lo + hi) / 2.0
    if test_total(mid):
        lo = mid
    else:
        hi = mid

# Report the max plus which constraint is binding at that point, so the user can
# see whether voltage or thermal is the active limit.
per_max = lo / n
res = run_case('PRE_MATCH', SELLERS, [], PLAYER_LOCATIONS,
               seller_energy_kwh={s: per_max for s in SELLERS})
m = res.get('metrics', {})

print(f"MAX_TOTAL={lo:.4f}")              # kW total across all sellers (1h slot)
print(f"MAX_PER_SELLER={per_max:.4f}")    # kW per seller
print(f"BINDING_VMAX={m.get('max_voltage_pu', 0):.5f} p.u.")
print(f"BINDING_MAX_LOADING={m.get('max_line_loading_pct', 0):.3f} %")
print(f"UPPER_USED={UPPER}  (true max is ~{lo:.1f} kW, so UPPER must stay above it)")