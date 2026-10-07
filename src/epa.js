const DEFAULT_LAMBDA = 6;

export function qualificationMatches(matches = []) {
  const played = matches.filter((m) => m?.played && Number.isFinite(Number(m.redScore)) && Number.isFinite(Number(m.blueScore)));
  const quals = played.filter((m) => {
    const name = String(m.name || "");
    const key = String(m.tournamentKey ?? "").toLowerCase();
    return /qualification|ranking/i.test(name) || key === "1" || key === "t1";
  });
  return quals.length ? quals : played;
}

export function allianceRows(matches = []) {
  const rows = [];
  for (const match of qualificationMatches(matches)) {
    const participants = Array.isArray(match.participants) ? match.participants : [];
    const red = participants.filter((p) => Number(p.station) < 20 && !isInactive(p)).map((p) => Number(p.teamKey));
    const blue = participants.filter((p) => Number(p.station) > 20 && !isInactive(p)).map((p) => Number(p.teamKey));
    if (red.length) rows.push({ teamKeys: red, score: Number(match.redScore), match });
    if (blue.length) rows.push({ teamKeys: blue, score: Number(match.blueScore), match });
  }
  return rows.filter((r) => r.teamKeys.every(Number.isFinite));
}

function isInactive(participant) {
  return Number(participant?.cardStatus) === 2 || Number(participant?.noShow) === 1;
}

export function computeEpa(rankings = [], matches = [], lambda = DEFAULT_LAMBDA) {
  const teamKeys = [...new Set(rankings.map((r) => Number(r.teamKey)).filter(Number.isFinite))];
  const rows = allianceRows(matches).filter((r) => r.teamKeys.every((key) => teamKeys.includes(key)));
  const index = new Map(teamKeys.map((key, i) => [key, i]));
  const n = teamKeys.length;
  const games = new Array(n).fill(0);

  if (!n || !rows.length) {
    return new Map(teamKeys.map((key) => [key, { epa: null, games: 0, confidence: 0 }]));
  }

  const avgAllianceScore = mean(rows.map((r) => r.score));
  const avgAllianceSize = mean(rows.map((r) => r.teamKeys.length)) || 3;
  const prior = avgAllianceScore / avgAllianceSize;

  const ata = Array.from({ length: n }, () => new Float64Array(n));
  const aty = new Float64Array(n);

  for (const row of rows) {
    const centered = row.score - prior * row.teamKeys.length;
    const ids = row.teamKeys.map((key) => index.get(key)).filter((v) => v !== undefined);
    for (const i of ids) {
      games[i] += 1;
      aty[i] += centered;
      for (const j of ids) ata[i][j] += 1;
    }
  }

  for (let i = 0; i < n; i += 1) ata[i][i] += lambda;
  const delta = solveLinearSystem(ata, aty);

  const result = new Map();
  for (let i = 0; i < n; i += 1) {
    const epa = prior + delta[i];
    result.set(teamKeys[i], {
      epa: Number.isFinite(epa) ? epa : prior,
      games: games[i],
      confidence: games[i] / (games[i] + lambda),
      prior,
    });
  }
  return result;
}

export function computeRecentForm(teamKey, matches, epaByTeam, count = 3) {
  const rows = allianceRows(matches)
    .filter((row) => row.teamKeys.includes(Number(teamKey)))
    .slice(-count);
  if (!rows.length) return null;

  const residuals = rows.map((row) => {
    const expected = row.teamKeys.reduce((sum, key) => sum + (epaByTeam.get(key)?.epa ?? 0), 0);
    return row.score - expected;
  });
  return mean(residuals);
}

export function buildTeamMetrics(rankings, matches, lambda = DEFAULT_LAMBDA) {
  const epaByTeam = computeEpa(rankings, matches, lambda);
  const metrics = rankings.map((ranking) => {
    const teamKey = Number(ranking.teamKey);
    const model = epaByTeam.get(teamKey) ?? { epa: null, games: 0, confidence: 0 };
    return {
      teamKey,
      epa: model.epa,
      modelGames: model.games,
      confidence: model.confidence,
      form: computeRecentForm(teamKey, matches, epaByTeam),
    };
  });

  const ranked = metrics.filter((m) => Number.isFinite(m.epa)).sort((a, b) => b.epa - a.epa);
  ranked.forEach((metric, i) => {
    metric.epaRank = i + 1;
    metric.epaPercentile = ranked.length <= 1 ? 100 : 100 * (1 - i / (ranked.length - 1));
  });

  return new Map(metrics.map((m) => [m.teamKey, m]));
}

export function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n + 1);
    row.set(matrix[i], 0);
    row[n] = vector[i];
    return row;
  });

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];

    const divisor = a[col][col];
    if (Math.abs(divisor) < 1e-10) continue;
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return new Float64Array(Array.from({ length: n }, (_, i) => a[i][n]));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
