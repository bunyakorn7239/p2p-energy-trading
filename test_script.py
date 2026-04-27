import pandapower as pp
from backend.ieee33bus_network import create_network, run_power_flow
from backend.server import run_case, PLAYER_LOCATIONS, SELLERS, BUYERS

sellers = SELLERS
buyers = BUYERS
seller_kwh = {"C": 1200, "D": 900, "E": 1000, "F": 1100, "I": 950}
buyer_kwh = {"A": 1000, "B": 1000, "G": 1000, "H": 1000, "J": 1150}

# In POST_MATCH, if matched completely, bought = demand, sold = generation
sold_kwh = seller_kwh
bought_kwh = buyer_kwh

res = run_case("POST_MATCH", sellers, buyers, PLAYER_LOCATIONS, 
               seller_energy_kwh=seller_kwh, buyer_energy_kwh=buyer_kwh,
               seller_sold_kwh=sold_kwh, buyer_bought_kwh=bought_kwh)

print("Converged:", res["converged"])
print("Over:", res["violations"]["over"])
print("Under:", res["violations"]["under"])
print("Max V:", res["metrics"]["max_voltage_pu"])
print("Min V:", res["metrics"]["min_voltage_pu"])

res_pre = run_case("PRE_MATCH", sellers, buyers, PLAYER_LOCATIONS, seller_energy_kwh=seller_kwh)
print("PRE Max V:", res_pre["metrics"]["max_voltage_pu"])
