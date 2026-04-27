/**
 * powerflow.js  (v3 — matches Python powerflow_CP_average_final.py)
 *
 * THREE CASES (matching Python exactly):
 *   BASE       : ACTUAL_LOAD_DATA at every bus, no DG
 *   PRE_MATCH  : Seller sgen at FULL SELLER_ENERGY_KWH, NO loads anywhere
 *   POST_MATCH : Seller sgen = sold_kwh only (no actual load for seller buses)
 *                Buyer load  = unmet demand (demand - bought), no actual load
 *                Other buses = ACTUAL_LOAD_DATA
 *
 * Network: IEEE 33-bus, 22kV/0.4kV transformer (Bus 0 HV → Bus 1 LV slack)
 *          Buses 1-35 are LV (0.4 kV)
 */

"use strict";

// ── Constants ───────────────────────────────────────────────────────────────
const V_NOM_HV  = 22.0;   // kV  (Bus 0)
const V_NOM_LV  = 0.4;    // kV  (Bus 1-35)
const V_MIN     = 0.95;   // p.u.
const V_MAX     = 1.05;   // p.u.
const KWH_TO_MW = kwh => kwh / 24.0 / 1000.0;

/**
 * Line data: [from, to, length_km, r_ohm_per_km, x_ohm_per_km, max_i_ka]
 * Source: powerflow_phase_A_10bus.py
 */
const LINE_DATA = [
  // Main feeder
  [1,  2,  0.04, 0.3415404, 0.4257663, 0.34],
  [2,  6,  0.04, 0.3415404, 0.4257663, 0.34],
  [2,  3,  0.04, 0.3415404, 0.4257663, 0.34],
  [3,  11, 0.02, 0.3415404, 0.4257663, 0.34],
  [3,  4,  0.04, 0.3415404, 0.4257663, 0.34],
  [4,  14, 0.02, 0.3415404, 0.4257663, 0.34],
  [4,  17, 0.02, 0.3415404, 0.4257663, 0.34],
  [4,  5,  0.04, 0.3415404, 0.4257663, 0.34],
  [5,  20, 0.04, 0.3415404, 0.4257663, 0.34],
  [6,  7,  0.04, 0.3415404, 0.4257663, 0.34],
  [7,  28, 0.02, 0.3415404, 0.4257663, 0.34],
  [7,  8,  0.04, 0.3415404, 0.4257663, 0.34],
  [8,  30, 0.02, 0.3415404, 0.4257663, 0.34],
  [8,  32, 0.02, 0.3415404, 0.4257663, 0.34],
  [8,  9,  0.04, 0.3415404, 0.4257663, 0.34],
  [9,  34, 0.02, 0.3415404, 0.4257663, 0.34],
  [9,  10, 0.04, 0.3415404, 0.4257663, 0.34],
  [10, 25, 0.04, 0.3415404, 0.4257663, 0.34],
  [10, 26, 0.04, 0.3415404, 0.4257663, 0.34],
  [11, 12, 0.02, 0.3415404, 0.4257663, 0.34],
  [12, 13, 0.02, 0.3415404, 0.4257663, 0.34],
  [14, 15, 0.02, 0.3415404, 0.4257663, 0.34],
  [15, 16, 0.02, 0.3415404, 0.4257663, 0.34],
  [17, 18, 0.02, 0.3415404, 0.4257663, 0.34],
  [18, 19, 0.02, 0.3415404, 0.4257663, 0.34],
  [20, 21, 0.02, 0.3415404, 0.4257663, 0.34],
  [21, 22, 0.02, 0.3415404, 0.4257663, 0.34],
  [23, 24, 0.02, 0.3415404, 0.4257663, 0.34],
  [24, 25, 0.02, 0.3415404, 0.4257663, 0.34],
  [26, 27, 0.02, 0.3415404, 0.4257663, 0.34],
  [28, 29, 0.02, 0.3415404, 0.4257663, 0.34],
  [30, 31, 0.02, 0.3415404, 0.4257663, 0.34],
  [32, 33, 0.02, 0.3415404, 0.4257663, 0.34],
  [34, 35, 0.02, 0.3415404, 0.4257663, 0.34],
];

// ── Network tree structure ─────────────────────────────────────────────────
function buildTree() {
  const children = {}, parent = {};
  for (const [f, t] of LINE_DATA) {
    if (!children[f]) children[f] = [];
    children[f].push(t);
  }
  const q = [1], vis = new Set([1]);
  while (q.length) {
    const u = q.shift();
    for (const v of (children[u] || [])) {
      if (!vis.has(v)) { vis.add(v); parent[v] = u; q.push(v); }
    }
  }
  return { children, parent };
}

function bfsOrder(children) {
  const order = [], q = [1], vis = new Set([1]);
  while (q.length) {
    const u = q.shift(); order.push(u);
    for (const v of (children[u] || [])) {
      if (!vis.has(v)) { vis.add(v); q.push(v); }
    }
  }
  return order;
}

// ── Core Power Flow (Forward-Backward Sweep) ───────────────────────────────
/**
 * busLoad: { busIdx: { pMw, qMvar } }
 *   pMw > 0  = net consuming (load > gen)
 *   pMw < 0  = net exporting (gen > load)  ← DG injection
 *
 * Returns comprehensive results matching Python display_full_results()
 */
function runSimplifiedPowerFlow(busLoad) {
  const { children, parent } = buildTree();
  const order = bfsOrder(children);
  const reverseOrder = [...order].reverse();

  // Build line map
  const lineMap = {};
  for (const [f, t, L, r, x, maxI] of LINE_DATA) {
    lineMap[`${f}-${t}`] = { f, t, L, r, x, R: r * L, X: x * L, maxI };
  }

  // All LV buses in the network
  const allBuses = new Set([1]);
  for (const [f, t] of LINE_DATA) { allBuses.add(f); allBuses.add(t); }
  const busArr = [...allBuses].sort((a, b) => a - b);

  // Initial voltages at nominal = 1.0 p.u.
  const vm = {};
  for (const b of busArr) vm[b] = 1.0;
  vm[1] = 1.0; // LV slack (transformer secondary)

  // Net injection at each bus: P[bus] = gen - load
  // (positive = net generation, negative = net load)
  const P = {}, Q = {};
  for (const b of busArr) { P[b] = 0; Q[b] = 0; }
  for (const [bus, { pMw, qMvar }] of Object.entries(busLoad)) {
    // pMw > 0 = load, pMw < 0 = generator
    // P[bus] = -pMw (where positive P = injection into bus)
    P[+bus] = -(pMw);
    Q[+bus] = -(qMvar);
  }

  // Branch flows (MW, MVAR) — positive = from parent to child
  const Pbr = {}, Qbr = {};
  for (const key of Object.keys(lineMap)) { Pbr[key] = 0; Qbr[key] = 0; }

  const MAX_ITER = 80, TOL = 1e-8;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const vmOld = { ...vm };

    // ── Backward sweep: branch flows from leaves to root
    for (const bus of reverseOrder) {
      if (bus === 1) continue;
      const par = parent[bus];
      if (par === undefined) continue;
      const key = `${par}-${bus}`;
      if (!lineMap[key]) continue;

      // Branch power = power consumed at bus (load - gen) + downstream branch flows
      // "load into bus" = -P[bus] (since P[bus] = injection = gen-load, so load = -P)
      let pb = -P[bus], qb = -Q[bus];
      for (const child of (children[bus] || [])) {
        pb += Pbr[`${bus}-${child}`] || 0;
        qb += Qbr[`${bus}-${child}`] || 0;
      }
      Pbr[key] = pb;
      Qbr[key] = qb;
    }

    // ── Forward sweep: compute voltages from root to leaves
    vm[1] = 1.0;
    for (const bus of order) {
      for (const child of (children[bus] || [])) {
        const key = `${bus}-${child}`;
        const line = lineMap[key]; if (!line) continue;
        const { R, X } = line;
        const pb = Pbr[key] || 0, qb = Qbr[key] || 0;
        const vFrom = vm[bus];
        // ΔV ≈ (P·R + Q·X) / (V_from · V_base²)
        // All P,Q in MW,MVAR; result in p.u.
        const dV = (pb * R + qb * X) / (vFrom * V_NOM_LV * V_NOM_LV);
        vm[child] = Math.max(vFrom - dV, 0.70);
      }
    }

    // Check convergence
    let maxDiff = 0;
    for (const b of busArr) maxDiff = Math.max(maxDiff, Math.abs(vm[b] - vmOld[b]));
    if (maxDiff < TOL) break;
  }

  // ── Compute comprehensive line results (matching Python display_line_* functions)
  const lineResults = LINE_DATA.map(([f, t, L, r, x, maxI], idx) => {
    const key = `${f}-${t}`;
    const pFrom_mw = Pbr[key] || 0;  // Active power at sending end (MW)
    const qFrom_mvar = Qbr[key] || 0; // Reactive power at sending end (MVAR)
    const vFrom_kv = vm[f] * V_NOM_LV;
    const vTo_kv   = vm[t] * V_NOM_LV;

    // Sending-end current (kA)
    const sMva = Math.sqrt(pFrom_mw * pFrom_mw + qFrom_mvar * qFrom_mvar);
    const iFrom_ka = sMva / (Math.sqrt(3) * Math.max(vFrom_kv, 0.001));

    // Line losses: P_loss = I²·R·L,  Q_loss = I²·X·L
    const pl_mw   = iFrom_ka * iFrom_ka * r * L;
    const ql_mvar = iFrom_ka * iFrom_ka * x * L;

    // Receiving-end power and current
    const pTo_mw   = pFrom_mw - pl_mw;
    const qTo_mvar = qFrom_mvar - ql_mvar;
    const sTo = Math.sqrt(pTo_mw * pTo_mw + qTo_mvar * qTo_mvar);
    const iTo_ka = sTo / (Math.sqrt(3) * Math.max(vTo_kv, 0.001));

    const loading = (iFrom_ka / maxI) * 100;

    return {
      lineIdx: idx,
      from: f, to: t, L,
      rOhmPerKm: r, xOhmPerKm: x, maxIKa: maxI,
      iFromKa: iFrom_ka,  iToKa: iTo_ka,
      pFromMw: pFrom_mw,  pToMw: pTo_mw,
      qFromMvar: qFrom_mvar, qToMvar: qTo_mvar,
      plMw: pl_mw, qlMvar: ql_mvar,
      loading,
    };
  });

  // ── System totals
  const totalLineLossMw   = lineResults.reduce((s, l) => s + l.plMw, 0);
  const totalLineLossMvar = lineResults.reduce((s, l) => s + l.qlMvar, 0);

  // Total load consumed (MW) = sum of positive pMw entries
  const totalLoadMw = Object.values(busLoad).reduce((s, { pMw }) => s + Math.max(0, pMw), 0);
  // Total DG generated (MW) = sum of |negative pMw| entries  
  const totalSgenMw = Object.values(busLoad).reduce((s, { pMw }) => s + Math.max(0, -pMw), 0);
  // Grid supply from slack (external grid), balancing load + losses - sgen
  const gridSupplyMw = Math.max(0, totalLoadMw - totalSgenMw + totalLineLossMw);

  // Bus voltages table (matches Python display_bus_voltages)
  const busVoltages = [
    // Bus 1 is LV slack (corresponds to transformer LV side; Bus 0 HV is implicit)
    ...busArr.map(bus => {
      const vm_pu = vm[bus];
      let status = "OK";
      if (bus === 1) status = "Slack";
      else if (vm_pu < V_MIN) status = "LOW";
      else if (vm_pu > V_MAX) status = "HIGH";
      return {
        bus,
        vnKv: V_NOM_LV,
        vKv: parseFloat((vm_pu * V_NOM_LV).toFixed(4)),
        vm_pu,
        vaDeg: 0.0, // Simplified model — angles not computed
        status,
      };
    })
  ];

  const lvBuses = busVoltages.filter(v => v.bus !== 1);
  const minVmPu = lvBuses.length ? Math.min(...lvBuses.map(v => v.vm_pu)) : 1.0;
  const maxVmPu = lvBuses.length ? Math.max(...lvBuses.map(v => v.vm_pu)) : 1.0;
  const maxLoading = lineResults.length ? Math.max(...lineResults.map(l => l.loading)) : 0;

  return {
    busVoltages,
    lineResults,
    totalLineLossMw,
    totalLineLossMvar,
    totalLoadMw,
    totalSgenMw,
    gridSupplyMw,
    minVmPu,
    maxVmPu,
    maxLoading,
  };
}

// ── CASE BUILDERS (matching Python run_case() logic exactly) ──────────────

/**
 * BASE CASE: ACTUAL_LOAD_DATA at every bus, no DG sgen.
 * Python: mode="BASE" → pp.create_load for every bus_idx in ACTUAL_LOAD_DATA
 */
function buildBaseCase(actualLoadData) {
  const busLoad = {};
  for (const [bus, val] of Object.entries(actualLoadData)) {
    busLoad[+bus] = { pMw: val.pMw, qMvar: val.qMvar };
  }
  return { busLoad, totalDgMw: 0, totalBuyerLoadMw: 0 };
}

/**
 * PRE_MATCH CASE: Sellers inject FULL energy (SELLER_ENERGY_KWH) as sgen.
 * NO loads at all (no buyer load, no other-bus load).
 * Python: mode="PRE_MATCH" → pass (no loads), then create_sgen at full kwh
 */
function buildPreMatchCase(sellerEnergyKwh, playerLocations, sellers) {
  const busLoad = {};
  let totalDgMw = 0;
  for (const s of sellers) {
    const bus = parseInt(playerLocations[s].replace("Bus", ""), 10);
    const injectMw = KWH_TO_MW(sellerEnergyKwh[s]);
    // Net at bus: generator only (negative net pMw = exporting)
    busLoad[bus] = { pMw: -injectMw, qMvar: 0.0 };
    totalDgMw += injectMw;
  }
  return { busLoad, totalDgMw, totalBuyerLoadMw: 0 };
}

/**
 * POST_MATCH CASE:
 *   Seller bus : no actual load; sgen = sold_kwh  (net pMw = -soldMw)
 *   Buyer bus  : unmet demand = (demand - bought) as load (pMw = unmetMw, qMvar = 0)
 *   Other bus  : ACTUAL_LOAD_DATA (pMw, qMvar as measured)
 *
 * Python: mode="POST_MATCH"
 *   seller_bus → pass (no load)
 *   buyer_bus  → create_load(unmet_mw, q_mvar=0)
 *   else       → create_load(orig_p, orig_q)
 *   + create_sgen for each seller with sold_kwh
 */
function buildPostMatchCase(
  actualLoadData, soldKwh, boughtKwh,
  buyerEnergyKwh, playerLocations, sellers, buyers
) {
  // Build bus→player maps
  const sellerBusMap = {};  // { busNum: sellerName }
  const buyerBusMap  = {};  // { busNum: buyerName  }
  for (const s of sellers) {
    sellerBusMap[parseInt(playerLocations[s].replace("Bus", ""), 10)] = s;
  }
  for (const b of buyers) {
    buyerBusMap[parseInt(playerLocations[b].replace("Bus", ""), 10)] = b;
  }

  const busLoad = {};
  let totalDgMw = 0, totalBuyerLoadMw = 0;

  // Process each bus that has actual load data (all 10 player buses)
  for (const [busStr, val] of Object.entries(actualLoadData)) {
    const busNum = +busStr;

    if (sellerBusMap[busNum] !== undefined) {
      // ── Seller bus: NO actual load; DG sgen = sold_kwh
      const s = sellerBusMap[busNum];
      const soldMw = KWH_TO_MW(soldKwh[s] || 0);
      busLoad[busNum] = { pMw: -soldMw, qMvar: 0.0 };  // net exporting
      totalDgMw += soldMw;

    } else if (buyerBusMap[busNum] !== undefined) {
      // ── Buyer bus: unmet demand as load (no actual load from ACTUAL_LOAD_DATA)
      const b = buyerBusMap[busNum];
      const demandMw = KWH_TO_MW(buyerEnergyKwh[b]);
      const boughtMw = KWH_TO_MW(boughtKwh[b] || 0);
      const unmetMw  = Math.max(0, demandMw - boughtMw);
      if (unmetMw > 1e-9) {
        busLoad[busNum] = { pMw: unmetMw, qMvar: 0.0 };
        totalBuyerLoadMw += unmetMw;
      }

    } else {
      // ── Other bus: use ACTUAL_LOAD_DATA as-is
      busLoad[busNum] = { pMw: val.pMw, qMvar: val.qMvar };
    }
  }

  return { busLoad, totalDgMw, totalBuyerLoadMw };
}

// ── Compute full metrics dict (matches Python print_metrics) ──────────────
function computeMetrics(pfResult, totalDgMw, totalBuyerLoadMw) {
  return {
    min_voltage_pu:       pfResult.minVmPu,
    max_voltage_pu:       pfResult.maxVmPu,
    total_loss_mw:        pfResult.totalLineLossMw,
    grid_supply_mw:       pfResult.gridSupplyMw,
    max_line_loading_pct: pfResult.maxLoading,
    total_dg_mw:          totalDgMw,
    total_buyer_load_mw:  totalBuyerLoadMw,
    total_load_mw:        pfResult.totalLoadMw,
    total_sgen_mw:        pfResult.totalSgenMw,
    total_loss_mvar:      pfResult.totalLineLossMvar,
  };
}

// ── Violation checker ────────────────────────────────────────────────────
function checkVoltageViolations(busVoltages) {
  return busVoltages
    .filter(v => v.bus !== 1 && (v.vm_pu < V_MIN || v.vm_pu > V_MAX))
    .map(v => ({
      bus: v.bus, vm_pu: v.vm_pu,
      type: v.vm_pu < V_MIN ? 'UNDERVOLTAGE' : 'OVERVOLTAGE',
      severity: parseFloat((v.vm_pu < V_MIN ? V_MIN - v.vm_pu : v.vm_pu - V_MAX).toFixed(5)),
    }));
}

function identifyFailedPlayers(violations, playerLocations, sellers, buyers) {
  if (!violations || violations.length === 0) return { sellers: [], buyers: [], buses: [] };
  const violatedBuses = new Set(violations.map(v => v.bus));
  const failedSellers = [], failedBuyers = [];
  for (const [player, loc] of Object.entries(playerLocations)) {
    const bus = parseInt(loc.replace("Bus", ""), 10);
    if (violatedBuses.has(bus)) {
      if (sellers.includes(player)) failedSellers.push(player);
      if (buyers.includes(player)) failedBuyers.push(player);
    }
  }
  return { sellers: failedSellers, buyers: failedBuyers, buses: [...violatedBuses] };
}

// ── Energy range analysis (binary search for max feasible injection) ──────
function findFeasibleEnergyRange(actualLoadData, playerLocations, sellers) {
  const N = sellers.length;
  if (N === 0) return { maxKwhPerSeller: 0, maxKwhTotal: 0, minKwhPerSeller: 0, feasibilityNote: "No sellers" };

  function testTotal(totalKwh) {
    const { busLoad } = buildPreMatchCase(
      Object.fromEntries(sellers.map(s => [s, totalKwh / N])),
      playerLocations, sellers
    );
    const pf = runSimplifiedPowerFlow(busLoad);
    return checkVoltageViolations(pf.busVoltages).length === 0;
  }

  if (testTotal(30000)) {
    return {
      maxKwhPerSeller: Math.floor(30000 / N), maxKwhTotal: 30000, minKwhPerSeller: 0,
      feasibilityNote: "All tested values feasible (bounded at 30,000 kWh total)",
    };
  }

  let lo = 0, hi = 30000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (testTotal(mid)) lo = mid; else hi = mid;
  }
  return {
    maxKwhPerSeller: Math.floor(lo / N),
    maxKwhTotal: Math.floor(lo),
    minKwhPerSeller: 0,
    feasibilityNote: `Binary-search result: ${N} sellers, equal distribution, voltage kept within ${V_MIN}–${V_MAX} p.u.`,
  };
}

// ── Exports ──────────────────────────────────────────────────────────────
window.PowerFlowModule = {
  runSimplifiedPowerFlow,
  buildBaseCase,
  buildPreMatchCase,
  buildPostMatchCase,
  computeMetrics,
  checkVoltageViolations,
  identifyFailedPlayers,
  findFeasibleEnergyRange,
  KWH_TO_MW,
  LINE_DATA,
  V_MIN, V_MAX, V_NOM_LV, V_NOM_HV,
};
