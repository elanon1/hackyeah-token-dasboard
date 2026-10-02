export function demoSummary(provider = "all") {
  const names = [
    "Null Pointers",
    "Ship Happens",
    "Ctrl Alt Elite",
    "The Context Window",
    "Rubber Ducks",
    "Midnight Merge",
  ];
  const teams = names.map((name, i) => {
    const inputTokens = Math.round(
      (1_850_000 - i * 241_321) *
        (provider === "all" ? 1 : provider === "claude" ? 0.61 : 0.39),
    );
    const outputTokens = Math.round(inputTokens * (0.16 + i * 0.014));
    return {
      id: String(i),
      name,
      inputTokens,
      outputTokens,
      cacheReadTokens: Math.round(inputTokens * 0.43),
      cacheWriteTokens: Math.round(inputTokens * 0.07),
      sessions: 12 - i,
      claude:
        provider === "codex"
          ? 0
          : Math.round((inputTokens + outputTokens) * 0.61),
      codex:
        provider === "claude"
          ? 0
          : Math.round((inputTokens + outputTokens) * 0.39),
      lastSeen: new Date(Date.now() - i * 95_000).toISOString(),
      active: 1,
    };
  });
  const totals = teams.reduce(
    (s, t) => {
      for (const k of [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "sessions",
      ])
        s[k] += t[k];
      return s;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessions: 0,
    },
  );
  const timeline = Array.from({ length: 24 }, (_, i) => ({
    hour:
      new Date(Date.now() - (23 - i) * 3600_000).toISOString().slice(0, 13) +
      ":00:00.000Z",
    inputTokens: Math.round(
      (70_000 + Math.sin(i * 0.66) * 40_000 + i * 2500) *
        (provider === "all" ? 1 : 0.5),
    ),
    outputTokens: Math.round(14000 + i * 720),
  }));
  return {
    demo: true,
    teams,
    totals,
    timeline,
    generatedAt: new Date().toISOString(),
    provider,
  };
}
