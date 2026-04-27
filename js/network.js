/**
 * network.js
 * IEEE 33-bus network topology + Dijkstra shortest path
 */

"use strict";

function buildNetworkGraph() {
  const graph = {};

  function addEdge(u, v, dist) {
    if (!graph[u]) graph[u] = [];
    if (!graph[v]) graph[v] = [];
    graph[u].push({ node: v, dist });
    graph[v].push({ node: u, dist });
  }

  // Main feeder path
  addEdge("Grid", "Bus1", 0.04);
  addEdge("Bus1", "Bus2", 0.04);
  addEdge("Bus2", "Bus3", 0.04);
  addEdge("Bus3", "Bus4", 0.04);
  addEdge("Bus4", "Bus5", 0.04);

  // Laterals from Bus2
  addEdge("Bus2", "Bus6", 0.04);
  addEdge("Bus6", "Bus7", 0.04);
  addEdge("Bus7", "Bus8", 0.04);
  addEdge("Bus8", "Bus9", 0.04);
  addEdge("Bus9", "Bus10", 0.04);

  // Laterals from Bus3
  addEdge("Bus3", "Bus11", 0.02);
  addEdge("Bus11", "Bus12", 0.02);
  addEdge("Bus12", "Bus13", 0.02);

  // Laterals from Bus4
  addEdge("Bus4", "Bus14", 0.02);
  addEdge("Bus14", "Bus15", 0.02);
  addEdge("Bus15", "Bus16", 0.02);

  addEdge("Bus4", "Bus17", 0.02);
  addEdge("Bus17", "Bus18", 0.02);
  addEdge("Bus18", "Bus19", 0.02);

  // Laterals from Bus5
  addEdge("Bus5", "Bus20", 0.04);
  addEdge("Bus20", "Bus21", 0.02);
  addEdge("Bus21", "Bus22", 0.02);

  // Laterals from Bus7
  addEdge("Bus7", "Bus28", 0.02);
  addEdge("Bus28", "Bus29", 0.02);

  // Laterals from Bus8
  addEdge("Bus8", "Bus30", 0.02);
  addEdge("Bus30", "Bus31", 0.02);
  addEdge("Bus8", "Bus32", 0.02);
  addEdge("Bus32", "Bus33", 0.02);

  // Laterals from Bus9
  addEdge("Bus9", "Bus34", 0.02);
  addEdge("Bus34", "Bus35", 0.02);

  // Laterals from Bus10
  addEdge("Bus10", "Bus25", 0.04);
  addEdge("Bus10", "Bus26", 0.04);
  addEdge("Bus26", "Bus27", 0.02);

  // Additional Bus23-24-25 connection
  addEdge("Bus23", "Bus24", 0.02);
  addEdge("Bus24", "Bus25", 0.02);

  return graph;
}

/**
 * Dijkstra shortest path between two nodes.
 * @returns {number} shortest distance in km, or Infinity if unreachable
 */
function dijkstra(graph, start, end) {
  const dist = {};
  const visited = new Set();
  const pq = [{ node: start, d: 0 }];
  dist[start] = 0;

  while (pq.length > 0) {
    // Simple priority-queue: sort smallest first
    pq.sort((a, b) => a.d - b.d);
    const { node: u, d } = pq.shift();

    if (u === end) return d;
    if (visited.has(u)) continue;
    visited.add(u);

    for (const { node: v, dist: w } of (graph[u] || [])) {
      if (!visited.has(v)) {
        const nd = d + w;
        if (nd < (dist[v] ?? Infinity)) {
          dist[v] = nd;
          pq.push({ node: v, d: nd });
        }
      }
    }
  }
  return Infinity;
}

/**
 * Generate the full seller × buyer path length matrix.
 * @param {object} state - current app state with sellers, buyers, playerLocations
 * @returns {object} pathMatrix[seller][buyer] = km
 */
function generatePathMatrix(graph, sellers, buyers, playerLocations) {
  const matrix = {};
  for (const s of sellers) {
    matrix[s] = {};
    for (const b of buyers) {
      const d = dijkstra(graph, playerLocations[s], playerLocations[b]);
      matrix[s][b] = parseFloat(d.toFixed(5));
    }
  }
  return matrix;
}

window.NetworkModule = { buildNetworkGraph, dijkstra, generatePathMatrix };
