from backend.server import run_case, PLAYER_LOCATIONS, SELLERS, BUYERS

sellers = SELLERS
buyers = BUYERS
# Test huge numbers
per_s = 5000
per_b = 5000
seller_kwh = {s: per_s for s in sellers}
buyer_kwh = {b: per_b for b in buyers}
sold_kwh = seller_kwh
bought_kwh = buyer_kwh

res = run_case("POST_MATCH", sellers, buyers, PLAYER_LOCATIONS, 
               seller_energy_kwh=seller_kwh, buyer_energy_kwh=buyer_kwh,
               seller_sold_kwh=sold_kwh, buyer_bought_kwh=bought_kwh)
print("Max V with unmet=0 (current logic):", res["metrics"]["max_voltage_pu"])

