/**
 * matching.js
 * P2P energy matching using Average Cost Path (CP = DF × (Bid+Offer)/2)
 *
 * Algorithm (mirrors CP_average_adaptto_IEEE33.py / match_p2p_case1 exactly):
 *   1. Sort sellers by offering price ASCENDING once (sellerPriority).
 *   2. Find root pair via nextFeasibleRootPair (seller from priority + buyer with lowest CP).
 *   3. Trade qty = min(qs, qb).  Set cpActive[s][b] = null to prevent reuse.
 *   4. Continuation:
 *      - Both done → find new root pair.
 *      - Seller done → find best seller for SAME buyer (continuity).
 *      - Buyer done  → find best buyer for SAME seller (continuity).
 *   5. Repeat until no feasible pair remains.
 */

"use strict";

/**
 * Compute Distance Factor (row-normalised per seller).
 * DF_i,j = dist(i,j) / Σ_j dist(i,j)
 */
function computeDistanceFactor(pathMatrix, sellers, buyers) {
  const df = {};
  for (const s of sellers) {
    df[s] = {};
    const total = buyers.reduce((acc, b) => acc + pathMatrix[s][b], 0);
    for (const b of buyers) {
      df[s][b] = total > 0 ? parseFloat((pathMatrix[s][b] / total).toFixed(4)) : 0;
    }
  }
  return df;
}

/**
 * Compute Cost Path matrix.
 * CP_i,j = DF_i,j × (bid_j + offer_i) / 2
 */
function computeCostPath(df, sellers, buyers, biddingPrice, offeringPrice) {
  const cp = {};
  for (const s of sellers) {
    cp[s] = {};
    for (const b of buyers) {
      const avgPrice = (biddingPrice[b] + offeringPrice[s]) / 2;
      cp[s][b] = parseFloat((df[s][b] * avgPrice).toFixed(4));
    }
  }
  return cp;
}

/**
 * Build price feasibility matrix: bid >= offer → PASS
 */
function buildFeasibilityMatrix(sellers, buyers, biddingPrice, offeringPrice) {
  const matrix = {};
  for (const s of sellers) {
    matrix[s] = {};
    for (const b of buyers) {
      matrix[s][b] = biddingPrice[b] >= offeringPrice[s];
    }
  }
  return matrix;
}

/**
 * Build mid-market price matrix: (bid + offer) / 2
 */
function buildMidPriceMatrix(sellers, buyers, biddingPrice, offeringPrice) {
  const matrix = {};
  for (const s of sellers) {
    matrix[s] = {};
    for (const b of buyers) {
      matrix[s][b] = (biddingPrice[b] + offeringPrice[s]) / 2;
    }
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Matching helpers (mirror Python reference exactly)
// ---------------------------------------------------------------------------

/** Find the buyer with the lowest active CP for a given seller (price-feasible only). */
function findBestBuyer(cpActive, qb, seller, buyers, biddingPrice, offeringPrice) {
  let bestBuyer = null, bestCp = Infinity;
  for (const b of buyers) {
    if (qb[b] <= 1e-9) continue;
    if (cpActive[seller][b] === null) continue;
    if (biddingPrice[b] < offeringPrice[seller]) continue;
    if (cpActive[seller][b] < bestCp) {
      bestCp = cpActive[seller][b];
      bestBuyer = b;
    }
  }
  return bestBuyer;
}

/** Find the seller with the lowest active CP for a given buyer (price-feasible only). */
function findBestSeller(cpActive, qs, buyer, sellers, biddingPrice, offeringPrice) {
  let bestSeller = null, bestCp = Infinity;
  for (const s of sellers) {
    if (qs[s] <= 1e-9) continue;
    if (cpActive[s][buyer] === null) continue;
    if (biddingPrice[buyer] < offeringPrice[s]) continue;
    if (cpActive[s][buyer] < bestCp) {
      bestCp = cpActive[s][buyer];
      bestSeller = s;
    }
  }
  return bestSeller;
}

/** Find next feasible root pair from priority-ordered sellers. */
function nextFeasibleRootPair(cpActive, qs, qb, sellerPriority, buyers, biddingPrice, offeringPrice) {
  for (const s of sellerPriority) {
    if (qs[s] <= 1e-9) continue;
    const b = findBestBuyer(cpActive, qb, s, buyers, biddingPrice, offeringPrice);
    if (b !== null) return [s, b];
  }
  return [null, null];
}

// ---------------------------------------------------------------------------
// Core matching
// ---------------------------------------------------------------------------

/**
 * Main P2P matching algorithm — mirrors match_p2p_case1 exactly.
 *
 * Uses cpActive matrix with null-marking and sDone/bDone continuation:
 *   - Buyer done  → find next best buyer for SAME seller.
 *   - Seller done → find next best seller for SAME buyer.
 *   - Both done   → find new root pair from sellerPriority.
 *
 * @returns {{ trades, logs, qsRem, qbRem, cp, df, pathMatrix }}
 */
function matchP2P(pathMatrix, sellers, buyers, biddingPrice, offeringPrice, sellerEnergyKwh, buyerEnergyKwh) {
  const qs = {};
  const qb = {};
  for (const s of sellers) qs[s] = parseFloat(sellerEnergyKwh[s]) || 0;
  for (const b of buyers)  qb[b] = parseFloat(buyerEnergyKwh[b])  || 0;

  const df = computeDistanceFactor(pathMatrix, sellers, buyers);
  const cp = computeCostPath(df, sellers, buyers, biddingPrice, offeringPrice);

  // Deep-copy cp into cpActive (null means "already traded / exhausted")
  const cpActive = {};
  for (const s of sellers) {
    cpActive[s] = {};
    for (const b of buyers) cpActive[s][b] = cp[s][b];
  }

  // Seller priority: cheapest offering price first (sorted once)
  const sellerPriority = [...sellers].sort((a, b) => offeringPrice[a] - offeringPrice[b]);

  const trades = {};
  const logs   = [];
  let step = 0;

  let [currS, currB] = nextFeasibleRootPair(
    cpActive, qs, qb, sellerPriority, buyers, biddingPrice, offeringPrice
  );

  while (currS !== null && currB !== null) {
    const qty = Math.min(qs[currS], qb[currB]);
    if (qty <= 1e-9) {
      cpActive[currS][currB] = null;
      [currS, currB] = nextFeasibleRootPair(
        cpActive, qs, qb, sellerPriority, buyers, biddingPrice, offeringPrice
      );
      continue;
    }

    // Capture BEFORE-trade state (mirrors Python qs_track / qb_track)
    const sInit = qs[currS];
    const bInit = qb[currB];

    qs[currS] -= qty;
    qb[currB] -= qty;

    const key = `${currS}|${currB}`;
    trades[key] = (trades[key] || 0) + qty;

    const offer      = offeringPrice[currS];
    const bid        = biddingPrice[currB];
    const clearPrice = (offer + bid) / 2;

    step++;
    logs.push({
      step,
      seller:     currS,
      buyer:      currB,
      cp:         parseFloat(cp[currS][currB].toFixed(6)),
      offer,
      bid,
      sInit:      parseFloat(sInit.toFixed(4)),
      bInit:      parseFloat(bInit.toFixed(4)),
      qty:        parseFloat(qty.toFixed(4)),
      sRem:       parseFloat(Math.max(qs[currS], 0).toFixed(4)),
      bRem:       parseFloat(Math.max(qb[currB], 0).toFixed(4)),
      clearPrice: parseFloat(clearPrice.toFixed(6)),
      tradeValue: parseFloat((qty * clearPrice).toFixed(6)),
    });

    // Close this path so the same pair is not reused
    cpActive[currS][currB] = null;

    const sDone = qs[currS] <= 1e-9;
    const bDone = qb[currB] <= 1e-9;

    if (sDone && bDone) {
      // Both exhausted → find new root pair
      [currS, currB] = nextFeasibleRootPair(
        cpActive, qs, qb, sellerPriority, buyers, biddingPrice, offeringPrice
      );
    } else if (sDone) {
      // Seller exhausted → find next best seller for SAME buyer (continuity)
      const ns = findBestSeller(cpActive, qs, currB, sellers, biddingPrice, offeringPrice);
      if (ns !== null) {
        currS = ns;
      } else {
        [currS, currB] = nextFeasibleRootPair(
          cpActive, qs, qb, sellerPriority, buyers, biddingPrice, offeringPrice
        );
      }
    } else if (bDone) {
      // Buyer exhausted → find next best buyer for SAME seller (continuity)
      const nb = findBestBuyer(cpActive, qb, currS, buyers, biddingPrice, offeringPrice);
      if (nb !== null) {
        currB = nb;
      } else {
        [currS, currB] = nextFeasibleRootPair(
          cpActive, qs, qb, sellerPriority, buyers, biddingPrice, offeringPrice
        );
      }
    }
  }

  return { trades, logs, qsRem: qs, qbRem: qb, cp, df, pathMatrix };
}

/**
 * Aggregate sold / bought per player.
 */
function aggregateTrades(trades, sellers, buyers) {
  const soldKwh = Object.fromEntries(sellers.map(s => [s, 0]));
  const boughtKwh = Object.fromEntries(buyers.map(b => [b, 0]));
  for (const [key, qty] of Object.entries(trades)) {
    const [s, b] = key.split("|");
    soldKwh[s] = (soldKwh[s] || 0) + qty;
    boughtKwh[b] = (boughtKwh[b] || 0) + qty;
  }
  return { soldKwh, boughtKwh };
}

window.MatchingModule = {
  computeDistanceFactor,
  computeCostPath,
  buildFeasibilityMatrix,
  buildMidPriceMatrix,
  matchP2P,
  aggregateTrades,
};
