import { allianceRows, buildTeamMetrics } from "./epa.js";

const PRIOR_WEIGHTS = [0.7, 0.3];
// 2024 season ratings predicting 2025 ranking-match winners: scale 2.5 had
// lower log loss than 2.0, 3.0, or an even 50% baseline (318 decided matches).
const PROBABILITY_SCALE = 2.5;
const regionNames = new Intl.DisplayNames(["ja"], { type: "region" });

export function teamCode(record) {
  return String(record?.team?.country || record?.country || "").toUpperCase();
}

export function teamNameJa(record) {
  const code2 = String(record?.team?.countryCode || record?.countryCode || "").toUpperCase();
  const translated = /^[A-Z]{2}$/.test(code2) ? regionNames.of(code2) : null;
  return translated && translated !== code2
    ? translated
    : String(record?.team?.name || record?.country || teamCode(record) || "不明");
}

export function buildRoster(rankings = [], matches = []) {
  const teams = new Map(rankings.map((ranking) => [Number(ranking.teamKey), ranking]));
  for (const match of matches) {
    for (const participant of match.participants || []) {
      const key = Number(participant.teamKey);
      if (!Number.isFinite(key) || teams.has(key)) continue;
      teams.set(key, {
        teamKey: key,
        rank: null,
        played: 0,
        rankingScore: null,
        highestScore: null,
        team: {
          country: participant.country,
          countryCode: participant.countryCode,
          name: participant.country,
        },
      });
    }
  }
  return [...teams.values()];
}

export function buildRatings(roster, currentMatches, history = []) {
  const current = buildTeamMetrics(roster, currentMatches);
  const currentZ = standardized(current);
  const prior = new Map();

  history.forEach((season, index) => {
    if (!season?.rankings?.length) return;
    const metrics = buildTeamMetrics(season.rankings, season.matches || []);
    const normalized = standardized(metrics);
    for (const ranking of season.rankings) {
      const code = teamCode(ranking);
      const z = normalized.get(Number(ranking.teamKey));
      if (!code || !Number.isFinite(z)) continue;
      const entry = prior.get(code) || { rating: 0, seasons: 0, previousRank: null };
      entry.rating += (PRIOR_WEIGHTS[index] || 0) * z;
      entry.seasons += 1;
      if (index === 0) entry.previousRank = ranking.rank;
      prior.set(code, entry);
    }
  });

  return new Map(roster.map((team) => {
    const key = Number(team.teamKey);
    const metric = current.get(key) || {};
    const historical = prior.get(teamCode(team));
    const games = metric.modelGames || 0;
    const currentWeight = games / (games + 8);
    const rating = (1 - currentWeight) * (historical?.rating || 0) * 0.7
      + currentWeight * (currentZ.get(key) || 0);
    return [key, {
      ...metric,
      rating: clamp(rating, -2.5, 2.5),
      historical: Boolean(historical),
      previousRank: historical?.previousRank ?? null,
    }];
  }));
}

export function scoreContext(matches = [], history = []) {
  const historical = history.map((season) => season ? allianceRows(season.matches || []).map((row) => row.score) : []);
  const weightTotal = historical.reduce((sum, scores, index) => sum + (scores.length ? PRIOR_WEIGHTS[index] || 0 : 0), 0);
  const priorMean = weightTotal ? historical.reduce((sum, scores, index) => sum + (scores.length ? average(scores) * (PRIOR_WEIGHTS[index] || 0) : 0), 0) / weightTotal : null;
  const priorDeviation = weightTotal ? historical.reduce((sum, scores, index) => sum + (scores.length ? deviation(scores) * (PRIOR_WEIGHTS[index] || 0) : 0), 0) / weightTotal : null;
  const scores = allianceRows(matches).map((row) => row.score);
  if (priorMean == null && !scores.length) return null;
  if (!scores.length) return { mean: priorMean, deviation: Math.max(8, priorDeviation), source: "prior", playedAlliances: 0 };

  // A small historical prior gives way as soon as this year's scores arrive.
  const currentMean = 0.4 * average(scores) + 0.6 * average(scores.slice(-24));
  const currentDeviation = deviation(scores);
  const currentWeight = priorMean == null ? 1 : scores.length / (scores.length + 2);
  const mean = (1 - currentWeight) * (priorMean ?? currentMean) + currentWeight * currentMean;
  const spread = (1 - currentWeight) * (priorDeviation ?? currentDeviation) + currentWeight * currentDeviation;
  return { mean, deviation: Math.max(8, spread), source: "live", playedAlliances: scores.length };
}

export function matchKey(match) {
  return `${match.eventKey || ""}:${match.tournamentKey || ""}:${match.id || match.name || ""}`;
}

export function buildSeasonModel(roster, matches, history = []) {
  const ratings = new Map([...buildRatings(roster, [], history)].map(([key, value]) => [key, { ...value, observedGames: 0 }]));
  const snapshots = new Map();
  const played = matches.filter((match) => match.played && Number.isFinite(Number(match.redScore)) && Number.isFinite(Number(match.blueScore)))
    .sort((a, b) => matchTime(a) - matchTime(b) || Number(a.id || 0) - Number(b.id || 0));
  const completed = [];
  let scoring = scoreContext([], history);

  for (let index = 0; index < played.length;) {
    const time = matchTime(played[index]);
    const group = [];
    while (index < played.length && matchTime(played[index]) === time) group.push(played[index++]);
    const changes = new Map();
    for (const match of group) {
      const prediction = predictMatch(match, ratings, scoring);
      if (!prediction) continue;
      const actualWinner = Number(match.redScore) === Number(match.blueScore)
        ? "tie" : Number(match.redScore) > Number(match.blueScore) ? "red" : "blue";
      const predictedWinner = prediction.redProbability === 0.5
        ? null : prediction.redProbability > 0.5 ? "red" : "blue";
      snapshots.set(matchKey(match), {
        ...prediction,
        actualWinner,
        predictedWinner,
        verdict: actualWinner === "tie" ? "tie" : !predictedWinner ? "no-pick" : actualWinner === predictedWinner ? "correct" : "incorrect",
      });
      const expectedDifference = prediction.projected ? prediction.projected.red - prediction.projected.blue : 0;
      const difference = Number(match.redScore) - Number(match.blueScore) - expectedDifference;
      const scale = Math.max(12, scoring?.deviation || 25) * Math.SQRT2;
      const adjustment = clamp(0.14 * difference / scale, -0.35, 0.35);
      for (const participant of prediction.red) addChange(changes, participant.teamKey, adjustment);
      for (const participant of prediction.blue) addChange(changes, participant.teamKey, -adjustment);
    }
    for (const [key, change] of changes) {
      const rating = ratings.get(key);
      if (rating) {
        rating.rating = clamp(rating.rating + change.delta, -2.5, 2.5);
        rating.observedGames += change.games;
      }
    }
    completed.push(...group);
    scoring = scoreContext(completed, history);
  }

  const current = buildTeamMetrics(roster, matches);
  for (const [key, metric] of current) ratings.set(key, { ...ratings.get(key), ...metric });
  return { ratings, scoring, snapshots };
}

export function predictMatch(match, ratings, scoring = null) {
  const participants = match.participants || [];
  const red = participants.filter((p) => Number(p.station) >= 10 && Number(p.station) < 20);
  const blue = participants.filter((p) => Number(p.station) >= 20 && Number(p.station) < 30);
  if (!red.length || !blue.length) return null;

  const total = (side) => side.reduce((sum, p) => sum + (ratings.get(Number(p.teamKey))?.rating || 0), 0);
  const redRating = total(red);
  const blueRating = total(blue);
  const redProbability = clamp(1 / (1 + Math.exp(-(redRating - blueRating) / PROBABILITY_SCALE)), 0.05, 0.95);
  const covered = participants.filter((p) => {
    const rating = ratings.get(Number(p.teamKey));
    return rating?.historical || rating?.observedGames || rating?.modelGames;
  }).length;
  const projected = scoring ? {
    red: Math.max(0, Math.round(scoring.mean + (redRating / red.length) * scoring.deviation * 0.65)),
    blue: Math.max(0, Math.round(scoring.mean + (blueRating / blue.length) * scoring.deviation * 0.65)),
  } : null;
  return { red, blue, redProbability, covered, totalTeams: participants.length, projected };
}

function standardized(metrics) {
  const entries = [...metrics.entries()].filter(([, value]) => Number.isFinite(value.epa));
  const mean = average(entries.map(([, value]) => value.epa));
  const deviation = Math.sqrt(average(entries.map(([, value]) => (value.epa - mean) ** 2))) || 1;
  return new Map(entries.map(([key, value]) => [key, clamp((value.epa - mean) / deviation, -2.5, 2.5)]));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values) {
  const mean = average(values);
  return values.length ? Math.sqrt(average(values.map((value) => (value - mean) ** 2))) : 0;
}

function matchTime(match) {
  // Scheduled field slots are a safer boundary than staggered actual starts:
  // a result from one field cannot be assumed known before another field starts.
  const time = Date.parse(match.scheduledTime);
  return Number.isFinite(time) ? time : Number(match.id || 0);
}

function addChange(changes, teamKey, delta) {
  const key = Number(teamKey);
  const current = changes.get(key) || { delta: 0, games: 0 };
  current.delta += delta;
  current.games += 1;
  changes.set(key, current);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
