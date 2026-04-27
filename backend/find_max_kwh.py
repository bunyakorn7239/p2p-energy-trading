import sys
sys.path.append('.')
from server import V_MIN, V_MAX, SELLERS, PLAYER_LOCATIONS, run_case
n = len(SELLERS)
UPPER = 30000.0
lo = 0.0
hi = UPPER

def test_total(total_kwh: float):
    per = total_kwh / n
    try:
        res = run_case('PRE_MATCH', SELLERS, [], PLAYER_LOCATIONS, seller_energy_kwh={s: per for s in SELLERS})
        if not res.get('converged'): return False
        v = res.get('violations', {})
        return len(v.get('under', [])) == 0 and len(v.get('over', [])) == 0
    except Exception:
        return False

for _ in range(40):
    mid = (lo + hi)/2.0
    if test_total(mid):
        lo = mid
    else:
        hi = mid

print(f"MAX_TOTAL={lo}")
print(f"MAX_PER_SELLER={lo/n}")
