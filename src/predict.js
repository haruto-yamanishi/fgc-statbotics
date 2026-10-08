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

export function scoreContext(matches = []) {
  const scores = allianceRows(matches).map((row) => row.score);
  if (scores.length < 12) return null;
  const mean = average(scores);
  const deviation = Math.sqrt(average(scores.map((score) => (score - mean) ** 2)));
  return { mean, deviation };
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
  const covered = participants.filter((p) => ratings.get(Number(p.teamKey))?.historical).length;
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
