import sys
sys.path.append('.')
from server import V_MIN, V_MAX, BUYERS, PLAYER_LOCATIONS, run_case
n_b = len(BUYERS)
UPPER = 50000.0
lo = 0.0
hi = UPPER

def test_buyer_total(total_kwh: float):
    per = total_kwh / n_b
    try:
        res = run_case('POST_MATCH', [], BUYERS, PLAYER_LOCATIONS, buyer_energy_kwh={b: per for b in BUYERS})
        if not res.get('converged'): return False
        v = res.get('violations', {})
        return len(v.get('under', [])) == 0 and len(v.get('over', [])) == 0
    except Exception:
        return False

for _ in range(40):
    mid = (lo + hi)/2.0
    if test_buyer_total(mid):
        lo = mid
    else:
        hi = mid

print(f"MAX_BUYER_TOTAL={lo}")
print(f"MAX_PER_BUYER={lo/n_b}")
