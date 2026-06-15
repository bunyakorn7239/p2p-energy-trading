function handlePowerFlowViolations(pf) {
  // ── Voltage violation check on POST_MATCH ─────────────────────────────
  const violations = [
    ...(pf.post_match?.violations?.under || []),
    ...(pf.post_match?.violations?.over || []),
    ...(pf.post_match?.violations?.thermal || []),
  ];
  wf.pfViolations = violations;

  if (violations.length === 0) {
    wf.step = "results";
    wf.gridFallback = false;
    buildResultsCache();
    logEvent("✅ Power flow PASSED — all tabs unlocked");
    renderAll(); showTab("dashboard");
    showToast("✅ P2P matching & power flow successful!", "success");
  } else {
    // Determine failed players from violated buses
    const violBuses = new Set(violations.map(v => v.bus));
    const failed = { sellers: [], buyers: [], buses: [...violBuses] };
    for (const [player, loc] of Object.entries(PLAYER_LOCATIONS)) {
      const bus = parseInt(loc.replace("Bus", ""), 10);
      if (violBuses.has(bus)) {
        if (SELLERS.includes(player)) failed.sellers.push(player);
        if (BUYERS.includes(player)) failed.buyers.push(player);
      }
    }
    wf.failedPlayers = failed;

    if (wf.round === 0) {
      wf.round = 1;
      wf.retryPlayers = new Set([...failed.sellers, ...failed.buyers]);
      wf.step = "retry";
      logEvent(`⚠️ POST_MATCH PF FAILED Round 1 — affected: ${[...wf.retryPlayers].join(", ")}`);
      renderAll(); showTab("inputs");
      showToast("⚠️ Power flow failed — revise energy values (Round 1 of 2)", "warning");
    } else {
      wf.step = "grid";
      wf.gridFallback = true;
      logEvent("❌ POST_MATCH PF FAILED Round 2 → Grid fallback");
      renderAll(); showTab("inputs");
      showToast("❌ P2P trading abandoned — grid fallback active", "error");
    }
  }
}