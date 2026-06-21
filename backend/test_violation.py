import sys
import json
sys.path.append('.')
from server import run_case, SELLERS, BUYERS, PLAYER_LOCATIONS, V_MIN, V_MAX

# Realistic PV injection: บ้านละ ~10 kWp best-case ≈ 47 kWh/วัน
seller_energy_kwh = {
    "C": 47.0,
    "D": 47.0,
    "E": 47.0,
    "F": 47.0,
    "I": 47.0
}  # Total = 235 kWh (อยู่ในช่วง realistic, ต่ำกว่า UPPER 300)

buyer_energy_kwh = {
    "A": 47.0, "B": 47.0, "G": 47.0, "H": 47.0, "J": 47.0
}

# 2. Run the PRE_MATCH case (which checks the injection upper bound)
print(f"Testing PRE_MATCH with Total Seller Energy: {sum(seller_energy_kwh.values())} kWh")
res_pre = run_case(
    mode="PRE_MATCH",
    sellers=SELLERS,
    buyers=BUYERS,
    player_locations=PLAYER_LOCATIONS,
    seller_energy_kwh=seller_energy_kwh
)

if not res_pre.get('converged'):
    print("Power flow did not converge.")
else:
    v = res_pre.get('violations', {})
    under = v.get('under', [])
    over = v.get('over', [])
    print(f"Under-voltage violations (V < {V_MIN}): {len(under)}")
    for x in under:
        print(f"  - Bus {x['bus']}: {x['vm_pu']} p.u. (Short by {x['short']})")
    
    print(f"Over-voltage violations (V > {V_MAX}): {len(over)}")
    for x in over:
        print(f"  - Bus {x['bus']}: {x['vm_pu']} p.u. (Excess by {x['excess']})")

# Let's also print out the exact format returned by run_case for overvoltage to see how the code handles it
print("\nJSON representation of violations dict:")
print(json.dumps(res_pre['violations'], indent=2))
