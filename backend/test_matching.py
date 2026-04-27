#!/usr/bin/env python3
"""
test_matching.py — Verify matching.py produces identical output to the Python reference.
"""
import sys
sys.path.insert(0, ".")

from matching import build_graph, generate_path_matrix, compute_distance_factor, compute_cost_path, match_p2p

SELLERS = ["C", "D", "E", "F", "I"]
BUYERS  = ["A", "B", "G", "H", "J"]

PLAYER_LOCATIONS = {
    "A": "Bus2",  "B": "Bus11", "G": "Bus17", "H": "Bus20", "J": "Bus29",
    "C": "Bus14", "D": "Bus25", "E": "Bus32", "F": "Bus35", "I": "Bus7",
}

# Test data from the user
OFFERING_PRICE = {
    "C": 2.5242, "D": 5.7535, "E": 3.2388, "F": 2.7864, "I": 2.5163,
}
BIDDING_PRICE = {
    "A": 2.2270, "B": 3.5213, "G": 4.5535, "H": 3.5520, "J": 2.8750,
}
SELLER_ENERGY_KWH = {
    "C": 73.9, "D": 93.2, "E": 68.7, "F": 15.6, "I": 95.0,
}
BUYER_ENERGY_KWH = {
    "A": 24.7, "B": 53.1, "G": 34.6, "H": 56.4, "J": 86.5,
}

print("=" * 80)
print("TEST: matching.py with user's data")
print("=" * 80)

graph = build_graph()
path_matrix = generate_path_matrix(graph, SELLERS, BUYERS, PLAYER_LOCATIONS)

print("\n=== Path Length Matrix (km) ===")
sellers_by_price = sorted(SELLERS, key=lambda s: OFFERING_PRICE[s])
buyers_sorted = sorted(BUYERS)
for s in sellers_by_price:
    row = f"  {s:<6}"
    for b in buyers_sorted:
        row += f"{path_matrix[s][b]:>10.4f}"
    print(row)

df = compute_distance_factor(path_matrix, SELLERS, BUYERS)
print("\n=== Distance Factor (DF) ===")
for s in sellers_by_price:
    row = f"  {s:<6}"
    for b in buyers_sorted:
        row += f"{df[s][b]:>10.4f}"
    print(row)

cp = compute_cost_path(df, SELLERS, BUYERS, BIDDING_PRICE, OFFERING_PRICE)
print("\n=== Cost Path (CP) ===")
for s in sellers_by_price:
    row = f"  {s:<6}"
    for b in buyers_sorted:
        row += f"{cp[s][b]:>10.4f}"
    print(row)

print("\n=== Seller Priority (by offering price) ===")
for s in sellers_by_price:
    print(f"  {s}: {OFFERING_PRICE[s]:.4f}")

result = match_p2p(
    path_matrix=path_matrix,
    sellers=SELLERS, buyers=BUYERS,
    bidding_price=BIDDING_PRICE, offering_price=OFFERING_PRICE,
    seller_energy_kwh=SELLER_ENERGY_KWH, buyer_energy_kwh=BUYER_ENERGY_KWH,
)

print(f"\n{'='*100}")
print("MATCHING STEPS")
print(f"{'='*100}")
print(f"  {'Step':>4} | {'Seller':>6} | {'Buyer':>5} | {'CP':>8} | "
      f"{'S.Init':>10} | {'B.Init':>10} | {'Traded':>10} | "
      f"{'S.Rem':>10} | {'B.Rem':>10}")
print("  " + "-" * 90)

for log in result["logs"]:
    print(f"  {log['step']:>4} | {log['seller']:>6} | {log['buyer']:>5} | "
          f"{log['cp']:>8.4f} | {log['sInit']:>10.1f} | {log['bInit']:>10.1f} | "
          f"{log['qty']:>10.1f} | {log['sRem']:>10.1f} | {log['bRem']:>10.1f}")

print(f"\n=== Remaining Energy ===")
print("  Sellers:")
for s in sellers_by_price:
    print(f"    {s}: {result['qsRem'][s]:.1f} kWh")
print("  Buyers:")
for b in buyers_sorted:
    print(f"    {b}: {result['qbRem'][b]:.1f} kWh")

total_traded = sum(result['trades'].values())
print(f"\n  Total traded: {total_traded:.1f} kWh")
