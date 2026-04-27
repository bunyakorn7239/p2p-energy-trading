"""
ieee33bus_network.py
====================
Reconstruct the network from powerflow_phase_A_10bus.py.

Topology (verified from Python line-current output):
  Main feeder : 1 → 2 → 6 → 7 → 8 → 9 → 10
  Branch      : 2 → 3 → 4 → 5  (with sub-branches to players)
  Sub-branches: 3→11→12→13  |  4→14→15→16  |  4→17→18→19  |  5→20→21→22
  From feeder : 7→28→29  |  8→30→31  |  8→32→33  |  9→34→35
  Seller D    : 10→25  AND  24→25 (dead-end stubs 23←24 off Bus 25)
  Dead ends   : 10→26→27  |  Bus 22 terminal

LINE ORDER matches Python line-index output exactly (Line 0 … Line 33).

Transformer (100 kVA, 22/0.4 kV) — parameters matched to Python output:
  Loading@BASE=22.14%, P_loss@BASE=0.154 kW, P_loss@PRE=0.150 kW
  => pfe=0.150 kW (iron), vkr≈0.085% (very low copper), vk=4%

Network is MESHED (Bus 25 has two connections: line-17 and line-28).
Newton-Raphson is used directly.
"""
import pandapower as pp


# ---------------------------------------------------------------------------
# Line topology  (from, to, length_km)
# ORDER MUST MATCH the Python output line indices 0-33
# ---------------------------------------------------------------------------
LINE_DATA = [
    # ── Main feeder  1 → 2 → 6 → 7 → 8 → 9 → 10 ──────────────────────────
    (1,  2,  0.04),   # Line  0
    (2,  6,  0.04),   # Line  1  ★ feeder continues 2→6 (not 2→3)
    # ── Branch  2 → 3 → 4 → 5 (sub-network with larger loads) ────────────
    (2,  3,  0.04),   # Line  2
    (3,  11, 0.02),   # Line  3  → Buyer B
    (3,  4,  0.04),   # Line  4
    (4,  14, 0.02),   # Line  5  → Seller C
    (4,  17, 0.02),   # Line  6  → Buyer G
    (4,  5,  0.04),   # Line  7
    (5,  20, 0.04),   # Line  8  → Buyer H
    # ── Main feeder continues from Bus 6 ─────────────────────────────────
    (6,  7,  0.04),   # Line  9  → Seller I
    (7,  28, 0.02),   # Line 10
    (7,  8,  0.04),   # Line 11
    (8,  30, 0.02),   # Line 12
    (8,  32, 0.02),   # Line 13  → Seller E
    (8,  9,  0.04),   # Line 14
    (9,  34, 0.02),   # Line 15
    (9,  10, 0.04),   # Line 16
    (10, 25, 0.04),   # Line 17  → Seller D (main connection)
    (10, 26, 0.04),   # Line 18  (dead-end branch)
    # ── Sub-branch terminals ──────────────────────────────────────────────
    (11, 12, 0.02),   # Line 19
    (12, 13, 0.02),   # Line 20
    (14, 15, 0.02),   # Line 21
    (15, 16, 0.02),   # Line 22
    (17, 18, 0.02),   # Line 23
    (18, 19, 0.02),   # Line 24
    (20, 21, 0.02),   # Line 25
    (21, 22, 0.02),   # Line 26  (Bus 22 dead end)
    # ── Dead-end stubs hanging off Bus 25 (Seller D) ─────────────────────
    (23, 24, 0.02),   # Line 27
    (24, 25, 0.02),   # Line 28  creates mesh with Line 17 → use NR solver
    # ── Remaining terminals ───────────────────────────────────────────────
    (26, 27, 0.02),   # Line 29
    (28, 29, 0.02),   # Line 30  → Buyer J
    (30, 31, 0.02),   # Line 31
    (32, 33, 0.02),   # Line 32
    (34, 35, 0.02),   # Line 33  → Seller F
]

# Line electrical parameters (same as original Python file)
R_OHM_PER_KM = 0.3415404
X_OHM_PER_KM = 0.4257663
C_NF_PER_KM  = 10.89339
MAX_I_KA     = 0.34


def create_network() -> pp.pandapowerNet:
    """Create the pandapower network matching powerflow_phase_A_10bus.py."""
    net = pp.create_empty_network(f_hz=50.0)

    # ── Buses ──────────────────────────────────────────────────────────────
    pp.create_bus(net, vn_kv=22.0, name="Bus_0_HV")   # index 0: HV slack
    for i in range(1, 36):
        pp.create_bus(net, vn_kv=0.4, name=f"Bus_{i}")  # indices 1-35: LV

    # ── External grid (slack at HV bus 0) ──────────────────────────────────
    pp.create_ext_grid(net, bus=0, vm_pu=1.0, va_degree=0.0, name="Grid")

    # ── Transformer  22 kV / 0.4 kV  100 kVA ──────────────────────────────
    # Parameters reverse-engineered from Python output (BASE case):
    #   sn_mva=0.100  → loading=22.1355% matches ref 22.1362%
    #   vkr=0.085%    → P_cu_rated=85W → P_loss@BASE≈154.2W, @PRE≈150.2W
    #   vk=5.0%       → Bus1=0.99663 p.u. matches ref 0.99660
    #   pfe=0.150 kW  → matches transformer iron losses in Python output
    #   i0=2.0%       → Q_loss@PRE≈2.22 kVAR matches ref 2.224 kVAR
    pp.create_transformer_from_parameters(
        net,
        hv_bus=0, lv_bus=1,
        sn_mva=0.100,
        vn_hv_kv=22.0, vn_lv_kv=0.4,
        vkr_percent=0.085,   # very low Cu losses (derived from Python P_loss diff)
        vk_percent=5.0,      # tuned: gives Bus1=0.9966 p.u. in BASE case
        pfe_kw=0.150,        # iron losses (constant, from Python trafo data)
        i0_percent=2.0,      # no-load current (Q_loss@low-load ≈ 2.0 kVAR)
        shift_degree=0.0,
        name="Trafo_22kV_0.4kV",
    )

    # ── Distribution lines ──────────────────────────────────────────────────
    for (f, t, L) in LINE_DATA:
        pp.create_line_from_parameters(
            net,
            from_bus=f, to_bus=t,
            length_km=L,
            r_ohm_per_km=R_OHM_PER_KM,
            x_ohm_per_km=X_OHM_PER_KM,
            c_nf_per_km=C_NF_PER_KM,
            max_i_ka=MAX_I_KA,
            name=f"Line_{f}_{t}",
        )

    return net


def run_power_flow(net: pp.pandapowerNet) -> bool:
    """
    Run Newton-Raphson power flow — locked to 'nr' algorithm only.

    The NR algorithm is used in the Python reference code and must be used
    here to guarantee identical numerical results (Cause-3 fix).
    No fallback to iwamoto_nr is performed; if NR fails the function
    returns False so the caller can handle the failure explicitly.
    """
    try:
        pp.runpp(
            net,
            algorithm="nr",
            numba=False,
            calculate_voltage_angles=True,
            max_iteration=50,
            tolerance_mva=1e-8,   # same as pandapower default — explicit for clarity
        )
        return True
    except Exception as e:
        print(f"[!] Power flow (NR) failed: {e}")
        return False
