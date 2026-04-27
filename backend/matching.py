"""
matching.py
===========
P2P matching: CP = DF × (Bid + Offer) / 2

Algorithm (matches CP_average_adaptto_IEEE33.py / match_p2p_case1 exactly):
  1. Sort sellers by offering price ASCENDING once (seller_priority).
  2. Find root pair via next_feasible_root_pair (seller from priority + buyer with lowest CP).
  3. Trade qty = min(qs, qb).  Set cp_active[s][b] = None to prevent reuse.
  4. Continuation:
     - Both done → find new root pair.
     - Seller done → find best seller for SAME buyer (continuity).
     - Buyer done  → find best buyer for SAME seller (continuity).
  5. Repeat until no feasible pair remains.
"""
from __future__ import annotations
from collections import deque
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Import LINE_DATA directly from ieee33bus_network so that the path lengths
# used for DF / CP computation are IDENTICAL to the values pandapower uses
# for the AC power flow — eliminating Cause-2 numerical discrepancy.
# ---------------------------------------------------------------------------
try:
    from ieee33bus_network import LINE_DATA as EDGES
except ImportError:
    # Fallback (only if module cannot be imported, e.g. unit-test context)
    EDGES: List[Tuple[int, int, float]] = [
        (1,  2, 0.04), (2,  6, 0.04), (2,  3, 0.04), (3, 11, 0.02),
        (3,  4, 0.04), (4, 14, 0.02), (4, 17, 0.02), (4,  5, 0.04),
        (5, 20, 0.04), (6,  7, 0.04), (7, 28, 0.02), (7,  8, 0.04),
        (8, 30, 0.02), (8, 32, 0.02), (8,  9, 0.04), (9, 34, 0.02),
        (9, 10, 0.04), (10, 25, 0.04),(10, 26, 0.04),(11, 12, 0.02),
        (12, 13, 0.02),(14, 15, 0.02),(15, 16, 0.02),(17, 18, 0.02),
        (18, 19, 0.02),(20, 21, 0.02),(21, 22, 0.02),(23, 24, 0.02),
        (24, 25, 0.02),(26, 27, 0.02),(28, 29, 0.02),(30, 31, 0.02),
        (32, 33, 0.02),(34, 35, 0.02),
    ]


# ---------------------------------------------------------------------------
# Graph helpers
# ---------------------------------------------------------------------------

def build_graph() -> Dict[int, List[Tuple[int, float]]]:
    g: Dict[int, List] = {}
    for (f, t, L) in EDGES:
        g.setdefault(f, []).append((t, L))
        g.setdefault(t, []).append((f, L))
    return g


def shortest_path_km(graph: Dict, src: int, dst: int) -> float:
    if src == dst:
        return 0.0
    visited: Dict[int, float] = {src: 0.0}
    queue: deque = deque([(src, 0.0)])
    while queue:
        node, dist = queue.popleft()
        for nbr, w in graph.get(node, []):
            if nbr not in visited:
                nd = dist + w
                visited[nbr] = nd
                if nbr == dst:
                    return nd
                queue.append((nbr, nd))
    return float("inf")


def _bus(loc: str) -> int:
    return int(loc.replace("Bus", ""))


# ---------------------------------------------------------------------------
# Matrix builders
# ---------------------------------------------------------------------------

def generate_path_matrix(
    graph: Dict, sellers: List[str], buyers: List[str],
    player_locations: Dict[str, str],
) -> Dict[str, Dict[str, float]]:
    pm: Dict[str, Dict[str, float]] = {}
    for s in sellers:
        pm[s] = {}
        sb = _bus(player_locations[s])
        for b in buyers:
            pm[s][b] = shortest_path_km(graph, sb, _bus(player_locations[b]))
    return pm


def compute_distance_factor(
    path_matrix: Dict, sellers: List[str], buyers: List[str],
) -> Dict[str, Dict[str, float]]:
    df: Dict[str, Dict[str, float]] = {}
    for s in sellers:
        row_sum = sum(path_matrix[s][b] for b in buyers)
        df[s] = {
            b: round(path_matrix[s][b] / row_sum, 4) if row_sum > 0 else 0.0
            for b in buyers
        }
    return df


def compute_cost_path(
    df_matrix: Dict, sellers: List[str], buyers: List[str],
    bidding_price: Dict[str, float], offering_price: Dict[str, float],
) -> Dict[str, Dict[str, float]]:
    cp: Dict[str, Dict[str, float]] = {}
    for s in sellers:
        cp[s] = {
            b: round(df_matrix[s][b] * (bidding_price[b] + offering_price[s]) / 2.0, 4)
            for b in buyers
        }
    return cp


# ---------------------------------------------------------------------------
# Matching helpers (mirrors Python reference exactly)
# ---------------------------------------------------------------------------

def _find_best_buyer(
    cp_active: Dict, qb: Dict, seller: str,
    buyers: List[str], bidding_price: Dict, offering_price: Dict,
) -> Optional[str]:
    """Find buyer with lowest active CP for seller (bid >= offer only)."""
    best_b, best_cp = None, float("inf")
    for b in buyers:
        if qb[b] <= 1e-9:
            continue
        if cp_active[seller][b] is None:
            continue
        if bidding_price[b] < offering_price[seller]:
            continue
        if cp_active[seller][b] < best_cp:
            best_cp = cp_active[seller][b]
            best_b = b
    return best_b


def _find_best_seller(
    cp_active: Dict, qs: Dict, buyer: str,
    sellers: List[str], bidding_price: Dict, offering_price: Dict,
) -> Optional[str]:
    """Find seller with lowest active CP for buyer (bid >= offer only)."""
    best_s, best_cp = None, float("inf")
    for s in sellers:
        if qs[s] <= 1e-9:
            continue
        if cp_active[s][buyer] is None:
            continue
        if bidding_price[buyer] < offering_price[s]:
            continue
        if cp_active[s][buyer] < best_cp:
            best_cp = cp_active[s][buyer]
            best_s = s
    return best_s


def _next_feasible_root_pair(
    cp_active: Dict, qs: Dict, qb: Dict,
    seller_priority: List[str], buyers: List[str],
    bidding_price: Dict, offering_price: Dict,
) -> Tuple[Optional[str], Optional[str]]:
    """Find next root pair from seller_priority that has a feasible buyer."""
    for s in seller_priority:
        if qs[s] <= 1e-9:
            continue
        b = _find_best_buyer(cp_active, qb, s, buyers, bidding_price, offering_price)
        if b is not None:
            return s, b
    return None, None


# ---------------------------------------------------------------------------
# Core matching
# ---------------------------------------------------------------------------

def match_p2p(
    path_matrix: Dict, sellers: List[str], buyers: List[str],
    bidding_price: Dict[str, float], offering_price: Dict[str, float],
    seller_energy_kwh: Dict[str, float], buyer_energy_kwh: Dict[str, float],
) -> dict:
    """
    P2P matching — mirrors match_p2p_case1 in CP_average_adaptto_IEEE33.py.

    Uses cp_active matrix with None-marking and sDone/bDone continuation:
      - Buyer done  → find next best buyer for SAME seller.
      - Seller done → find next best seller for SAME buyer.
      - Both done   → find new root pair from seller_priority.
    """
    df_matrix = compute_distance_factor(path_matrix, sellers, buyers)
    cp_matrix = compute_cost_path(df_matrix, sellers, buyers, bidding_price, offering_price)

    qs = {s: float(seller_energy_kwh[s]) for s in sellers}
    qb = {b: float(buyer_energy_kwh[b])  for b in buyers}

    # Deep-copy cp into cp_active (None = already traded / exhausted)
    cp_active = {s: {b: cp_matrix[s][b] for b in buyers} for s in sellers}

    # Seller priority: sorted by offering price ASCENDING (once)
    seller_priority = sorted(sellers, key=lambda s: offering_price[s])

    trades: Dict[str, float] = {}
    logs:   List[dict]       = []
    step = 0

    curr_s, curr_b = _next_feasible_root_pair(
        cp_active, qs, qb, seller_priority, buyers, bidding_price, offering_price,
    )

    while curr_s is not None and curr_b is not None:
        qty = min(qs[curr_s], qb[curr_b])
        if qty <= 1e-9:
            cp_active[curr_s][curr_b] = None
            curr_s, curr_b = _next_feasible_root_pair(
                cp_active, qs, qb, seller_priority, buyers,
                bidding_price, offering_price,
            )
            continue

        # Capture BEFORE-trade state
        s_init = round(qs[curr_s], 4)
        b_init = round(qb[curr_b], 4)

        qs[curr_s] -= qty
        qb[curr_b] -= qty

        step += 1
        key = f"{curr_s}|{curr_b}"
        trades[key] = trades.get(key, 0.0) + qty
        clear_price = (offering_price[curr_s] + bidding_price[curr_b]) / 2.0

        logs.append({
            "step":       step,
            "seller":     curr_s,
            "buyer":      curr_b,
            "cp":         round(cp_matrix[curr_s][curr_b], 6),
            "offer":      offering_price[curr_s],
            "bid":        bidding_price[curr_b],
            "qty":        round(qty, 4),
            "sInit":      s_init,
            "bInit":      b_init,
            "sRem":       round(qs[curr_s], 4),
            "bRem":       round(qb[curr_b], 4),
            "clearPrice": round(clear_price, 6),
            "tradeValue": round(qty * clear_price, 6),
        })

        # Close this path so the same pair is not reused
        cp_active[curr_s][curr_b] = None

        s_done = qs[curr_s] <= 1e-9
        b_done = qb[curr_b] <= 1e-9

        if s_done and b_done:
            # Both exhausted → find new root pair
            curr_s, curr_b = _next_feasible_root_pair(
                cp_active, qs, qb, seller_priority, buyers,
                bidding_price, offering_price,
            )
        elif s_done:
            # Seller exhausted → find next best seller for SAME buyer
            ns = _find_best_seller(
                cp_active, qs, curr_b, sellers, bidding_price, offering_price,
            )
            if ns is not None:
                curr_s = ns
            else:
                curr_s, curr_b = _next_feasible_root_pair(
                    cp_active, qs, qb, seller_priority, buyers,
                    bidding_price, offering_price,
                )
        elif b_done:
            # Buyer exhausted → find next best buyer for SAME seller
            nb = _find_best_buyer(
                cp_active, qb, curr_s, buyers, bidding_price, offering_price,
            )
            if nb is not None:
                curr_b = nb
            else:
                curr_s, curr_b = _next_feasible_root_pair(
                    cp_active, qs, qb, seller_priority, buyers,
                    bidding_price, offering_price,
                )

    # -- Aggregated results ---------------------------------------------------
    sold_kwh   = {s: 0.0 for s in sellers}
    bought_kwh = {b: 0.0 for b in buyers}
    for key, qty_ in trades.items():
        s_, b_ = key.split("|")
        sold_kwh[s_]   += qty_
        bought_kwh[b_] += qty_

    feasibility = {
        s: {b: bidding_price[b] >= offering_price[s] for b in buyers}
        for s in sellers
    }
    mid_price = {
        s: {b: (bidding_price[b] + offering_price[s]) / 2.0 for b in buyers}
        for s in sellers
    }

    return {
        "trades":      trades,
        "logs":        logs,
        "qsRem":       qs,
        "qbRem":       qb,
        "cp":          cp_matrix,
        "df":          df_matrix,
        "pathMatrix":  path_matrix,
        "soldKwh":     sold_kwh,
        "boughtKwh":   bought_kwh,
        "feasibility": feasibility,
        "midPrice":    mid_price,
    }

