// ============================================================================
// handlePowerFlowViolations(pf)
//
// NO RETRY. A POST_MATCH power-flow failure is reported, not retried:
// there are no Round 1 / Round 2 attempts and no automatic grid fallback.
// When any limit is violated the run stops at wf.step = "blocked" and the
// Input Data tab explains WHICH limit was hit, so the user can decide what
// to change themselves.
//
// Four problem types are classified:
//   over-voltage        V > V_MAX (1.05 p.u.)
//   under-voltage       V < V_MIN (0.95 p.u.)
//   line overload       line loading > 100 %
//   transformer overload  trafo loading > 100 % of its kVA rating
//
// NOTE: the backend "violations" block reports only bus voltage and line
// thermal limits — transformer overload is NOT in it. It is derived here from
// post_match.trafoResults[].loadingPct, which run_case always returns.
// ============================================================================

const PF_LIMITS = { V_MIN: 0.95, V_MAX: 1.05, LOADING_MAX: 100.0 };

// Classify a POST_MATCH result into the four problem types above.
// Returns [] when everything is within limits.
function classifyPfProblems(post) {
  if (!post || typeof post !== "object") return [];
  const v = post.violations || {};
  const under = v.under || [];
  const over = v.over || [];
  const thermal = v.thermal || [];
  const trafos = post.trafoResults || [];
  const problems = [];

  if (over.length) {
    problems.push({
      type: "over-voltage",
      label: "Over-voltage (แรงดันเกิน)",
      icon: "🔺",
      limit: `V ≤ ${PF_LIMITS.V_MAX} p.u.`,
      detail: `${over.length} บัสแรงดันเกิน — สูงสุด ${f6(Math.max(...over.map(x => x.vm_pu)))} p.u.`,
      items: over.map(x => `Bus ${x.bus}: ${f6(x.vm_pu)} p.u. (เกิน ${f6(x.excess)})`),
      buses: over.map(x => x.bus),
    });
  }
  if (under.length) {
    problems.push({
      type: "under-voltage",
      label: "Under-voltage (แรงดันตก)",
      icon: "🔻",
      limit: `V ≥ ${PF_LIMITS.V_MIN} p.u.`,
      detail: `${under.length} บัสแรงดันตก — ต่ำสุด ${f6(Math.min(...under.map(x => x.vm_pu)))} p.u.`,
      items: under.map(x => `Bus ${x.bus}: ${f6(x.vm_pu)} p.u. (ขาด ${f6(x.short)})`),
      buses: under.map(x => x.bus),
    });
  }
  if (thermal.length) {
    problems.push({
      type: "line-overload",
      label: "Line overload (สายรับโหลดเกิน)",
      icon: "🔌",
      limit: `loading ≤ ${PF_LIMITS.LOADING_MAX} %`,
      detail: `${thermal.length} เส้นเกินพิกัด — สูงสุด ${f4(Math.max(...thermal.map(x => x.loading)))} %`,
      items: thermal.map(x => `Line ${x.line} (Bus ${x.from}→${x.to}): ${f4(x.loading)} %`),
      buses: [],
    });
  }
  const trafoOver = trafos.filter(t => (t.loadingPct ?? 0) > PF_LIMITS.LOADING_MAX);
  if (trafoOver.length) {
    problems.push({
      type: "transformer-overload",
      label: "Transformer overload (หม้อแปลงรับโหลดเกิน)",
      icon: "⚡",
      limit: `loading ≤ ${PF_LIMITS.LOADING_MAX} % ของพิกัด`,
      detail: `${trafoOver.length} ลูกเกินพิกัด — สูงสุด ${f4(Math.max(...trafoOver.map(t => t.loadingPct)))} %`,
      items: trafoOver.map(t =>
        `Trafo #${t.trafoIdx}: ${f4(t.loadingPct)} % ของ ${f4(t.snKva ?? 0)} kVA` +
        (t.isReverse ? ` — ไฟย้อน RPF ${f4(t.rpfKw ?? 0)} kW` : "")),
      buses: [],
    });
  }
  return problems;
}

function handlePowerFlowViolations(pf) {
  const post = pf.post_match;
  const problems = classifyPfProblems(post);

  // Keep the raw bus/line violation list for anything that still reads it.
  wf.pfViolations = [
    ...(post?.violations?.under || []),
    ...(post?.violations?.over || []),
    ...(post?.violations?.thermal || []),
  ];
  wf.pfProblems = problems;

  if (problems.length === 0) {
    wf.step = "results";
    wf.gridFallback = false;
    wf.failedPlayers = { sellers: [], buyers: [], buses: [] };
    wf.retryPlayers = new Set();
    buildResultsCache();
    logEvent("✅ Power flow PASSED — all tabs unlocked");
    renderAll(); showTab("dashboard");
    showToast("✅ P2P matching & power flow successful!", "success");
    return;
  }

  // Mark the players sitting on a violated bus so their input rows stand out.
  const violBuses = new Set(problems.flatMap(p => p.buses));
  const failed = { sellers: [], buyers: [], buses: [...violBuses] };
  for (const [player, loc] of Object.entries(PLAYER_LOCATIONS)) {
    const bus = parseInt(loc.replace("Bus", ""), 10);
    if (violBuses.has(bus)) {
      if (SELLERS.includes(player)) failed.sellers.push(player);
      if (BUYERS.includes(player)) failed.buyers.push(player);
    }
  }
  wf.failedPlayers = failed;
  wf.retryPlayers = new Set([...failed.sellers, ...failed.buyers]);

  // Report and stop — no retry round, no automatic grid fallback.
  wf.step = "blocked";
  wf.gridFallback = false;
  logEvent(`⛔ POST_MATCH PF FAILED — ${problems.map(p => p.type).join(", ")}`);
  renderAll(); showTab("inputs");
  showToast(`⛔ Power flow failed: ${problems.map(p => p.type).join(", ")}`, "error");
}