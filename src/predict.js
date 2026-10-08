import { allianceRows, buildTeamMetrics, isOfficialMatch } from "./epa.js";
import { t } from "./i18n.js?v=20261008-5";
import { MODEL_PARAMS } from "./model-config.js";

const PRIOR_WEIGHTS = [0.7, 0.3];
const regionNames = new Map();

export function teamCode(record) {
  return String(record?.team?.country || record?.country || "").toUpperCase();
}

export function teamName(record, locale = "ja") {
  const code2 = String(record?.team?.countryCode || record?.countryCode || "").toUpperCase();
  if (!regionNames.has(locale)) regionNames.set(locale, new Intl.DisplayNames([locale], { type: "region" }));
  const translated = /^[A-Z]{2}$/.test(code2) ? regionNames.get(locale).of(code2) : null;
  return translated && translated !== code2
    ? translated
    : String(record?.team?.name || record?.country || teamCode(record) || t("unknown"));
}

export function teamNameJa(record) { return teamName(record, "ja"); }

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

export function buildRatings(roster, currentMatches, history = [], params = MODEL_PARAMS) {
  const current = buildTeamMetrics(roster, currentMatches, params.epaLambda);
  const currentZ = standardized(current);
  const prior = new Map();
  const previousRanks = new Map((history[0]?.rankings || []).map((ranking) => [teamCode(ranking), ranking.rank]));

  history.forEach((season, index) => {
    if (!season?.rankings?.length) return;
    const metrics = buildTeamMetrics(season.rankings, season.matches || [], params.epaLambda);
    const normalized = standardized(metrics);
    for (const ranking of season.rankings) {
      const code = teamCode(ranking);
      const z = normalized.get(Number(ranking.teamKey));
      if (!code || !Number.isFinite(z)) continue;
      const entry = prior.get(code) || { rating: 0, seasons: 0 };
      entry.rating += (PRIOR_WEIGHTS[index] || 0) * z;
      entry.seasons += 1;
      prior.set(code, entry);
    }
  });

  return new Map(roster.map((team) => {
    const key = Number(team.teamKey);
    const metric = current.get(key) || {};
    const historical = prior.get(teamCode(team));
    const games = metric.modelGames || 0;
    const currentWeight = games / (games + 8);
    const rating = (1 - currentWeight) * (historical?.rating || 0) * params.historyShrink
      + currentWeight * (currentZ.get(key) || 0);
    return [key, {
      ...metric,
      rating: clamp(rating, -2.5, 2.5),
      historical: Boolean(historical),
      previousRank: previousRanks.get(teamCode(team)) ?? null,
    }];
  }));
}

export function scoreContext(matches = [], history = [], schedule = matches, params = MODEL_PARAMS, pace = historicalPace(history, params), phaseByMatch = matchPhases(schedule)) {
  const historical = history.map((season) => season ? allianceRows(season.matches || []).map((row) => row.score) : []);
  const weightTotal = historical.reduce((sum, scores, index) => sum + (scores.length ? PRIOR_WEIGHTS[index] || 0 : 0), 0);
  const priorMean = weightTotal ? historical.reduce((sum, scores, index) => sum + (scores.length ? average(scores) * (PRIOR_WEIGHTS[index] || 0) : 0), 0) / weightTotal : null;
  const priorDeviation = weightTotal ? historical.reduce((sum, scores, index) => sum + (scores.length ? deviation(scores) * (PRIOR_WEIGHTS[index] || 0) : 0), 0) / weightTotal : null;
  // Remove the expected event-phase effect before estimating this season's
  // score level. Otherwise low scores from opening matches would be counted
  // a second time when projecting another early match.
  const scores = allianceRows(matches).map((row) => row.score / paceFactor(pace, phaseByMatch.get(matchKey(row.match))));
  if (priorMean == null && !scores.length) return null;
  if (!scores.length) return { mean: priorMean, deviation: Math.max(8, priorDeviation), source: "prior", playedAlliances: 0, pace, phaseByMatch, params };

  // A small historical prior gives way as soon as this year's scores arrive.
  const currentMean = (1 - params.recentScoreWeight) * average(scores) + params.recentScoreWeight * average(scores.slice(-24));
  const currentDeviation = deviation(scores);
  const currentWeight = priorMean == null ? 1 : scores.length / (scores.length + params.scorePriorAlliances);
  const mean = (1 - currentWeight) * (priorMean ?? currentMean) + currentWeight * currentMean;
  const spread = (1 - currentWeight) * (priorDeviation ?? currentDeviation) + currentWeight * currentDeviation;
  return { mean, deviation: Math.max(8, spread), source: "live", playedAlliances: scores.length, pace, phaseByMatch, params };
}

export function matchKey(match) {
  return `${match.eventKey || ""}:${match.tournamentKey || ""}:${match.id || match.name || ""}`;
}

export function buildSeasonModel(roster, matches, history = [], params = MODEL_PARAMS) {
  const ratings = new Map([...buildRatings(roster, [], history, params)].map(([key, value]) => [key, { ...value, observedGames: 0 }]));
  const snapshots = new Map();
  const pace = historicalPace(history, params);
  const phaseByMatch = matchPhases(matches);
  const played = matches.filter((match) => isOfficialMatch(match) && match.played && Number.isFinite(Number(match.redScore)) && Number.isFinite(Number(match.blueScore)))
    .sort((a, b) => matchTime(a) - matchTime(b) || Number(a.id || 0) - Number(b.id || 0));
  const completed = [];
  let scoring = scoreContext([], history, matches, params, pace, phaseByMatch);

  for (let index = 0; index < played.length;) {
    const time = matchTime(played[index]);
    const group = [];
    while (index < played.length && matchTime(played[index]) === time) group.push(played[index++]);
    const changes = new Map();
    for (const match of group) {
      const prediction = predictMatch(match, ratings, scoring, params);
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
      const adjustment = clamp(params.onlineRate * difference / scale, -params.onlineMaxAdjustment, params.onlineMaxAdjustment);
      const scoreScale = Math.max(12, scoring?.deviation || 25);
      const scoreRate = params.onlineScoreRate || 0;
      const redPerformance = prediction.projected ? scoreRate * (Number(match.redScore) - prediction.projected.red) / scoreScale : 0;
      const bluePerformance = prediction.projected ? scoreRate * (Number(match.blueScore) - prediction.projected.blue) / scoreScale : 0;
      for (const participant of prediction.red) addChange(changes, participant.teamKey, adjustment + redPerformance);
      for (const participant of prediction.blue) addChange(changes, participant.teamKey, -adjustment + bluePerformance);
    }
    for (const [key, change] of changes) {
      const rating = ratings.get(key);
      if (rating) {
        rating.rating = clamp(rating.rating * (1 - (params.ratingDecay || 0)) ** change.games + change.delta, -2.5, 2.5);
        rating.observedGames += change.games;
      }
    }
    completed.push(...group);
    scoring = scoreContext(completed, history, matches, params, pace, phaseByMatch);
  }

  const current = buildTeamMetrics(roster, matches, params.epaLambda);
  for (const [key, metric] of current) ratings.set(key, { ...ratings.get(key), ...metric });
  return { ratings, scoring, snapshots };
}

export function predictMatch(match, ratings, scoring = null, params = scoring?.params || MODEL_PARAMS) {
  const participants = match.participants || [];
  const red = participants.filter((p) => Number(p.station) >= 10 && Number(p.station) < 20);
  const blue = participants.filter((p) => Number(p.station) >= 20 && Number(p.station) < 30);
  if (!red.length || !blue.length) return null;

  const total = (side) => side.reduce((sum, p) => sum + (ratings.get(Number(p.teamKey))?.rating || 0), 0);
  const redRating = total(red);
  const blueRating = total(blue);
  const redProbability = clamp(1 / (1 + Math.exp(-(redRating - blueRating) / params.probabilityScale)), 0.05, 0.95);
  const covered = participants.filter((p) => {
    const rating = ratings.get(Number(p.teamKey));
    return rating?.historical || rating?.observedGames || rating?.modelGames;
  }).length;
  const phase = scoring ? paceFactor(scoring.pace, scoring.phaseByMatch?.get(matchKey(match))) : 1;
  const projected = scoring ? {
    red: Math.max(0, Math.round((scoring.mean + (redRating / red.length) * scoring.deviation * params.scoreRatingScale) * phase)),
    blue: Math.max(0, Math.round((scoring.mean + (blueRating / blue.length) * scoring.deviation * params.scoreRatingScale) * phase)),
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

function historicalPace(history, params) {
  const seasons = history.map((season, index) => {
    const matches = rankingSchedule(season?.matches || [])
      .filter((match) => match.played && Number.isFinite(Number(match.redScore)) && Number.isFinite(Number(match.blueScore)))
      .sort(compareMatches);
    if (matches.length < 8) return null;
    const scores = matches.map((match) => (Number(match.redScore) + Number(match.blueScore)) / 2);
    const seasonMean = average(scores);
    if (seasonMean <= 0) return null;
    const bins = [0, 1, 2, 3].map((bin) => {
      const slice = scores.slice(Math.floor(bin * scores.length / 4), Math.floor((bin + 1) * scores.length / 4));
      return average(slice) / seasonMean;
    });
    return { bins, weight: PRIOR_WEIGHTS[index] || 0 };
  }).filter(Boolean);
  const totalWeight = seasons.reduce((sum, season) => sum + season.weight, 0);
  if (!totalWeight) return null;
  return [0, 1, 2, 3].map((bin) => 1 + params.paceStrength * (seasons.reduce((sum, season) => sum + season.bins[bin] * season.weight, 0) / totalWeight - 1));
}

function matchPhases(matches) {
  const ordered = rankingSchedule(matches).sort(compareMatches);
  return new Map(ordered.map((match, index) => [matchKey(match), (index + 0.5) / ordered.length]));
}

function rankingSchedule(matches) {
  return matches.filter((match) => isOfficialMatch(match) && (/qualification|ranking/i.test(String(match.name || "")) || String(match.tournamentKey || "").toLowerCase() === "t2"));
}

function paceFactor(pace, phase = 0.5) {
  if (!pace) return 1;
  const position = clamp(phase, 0.125, 0.875) * 4 - 0.5;
  const left = Math.min(3, Math.floor(position));
  const right = Math.min(3, left + 1);
  return pace[left] + (pace[right] - pace[left]) * (position - left);
}

function compareMatches(a, b) {
  const aTime = Date.parse(a.scheduledTime);
  const bTime = Date.parse(b.scheduledTime);
  return (Number.isFinite(aTime) ? aTime : Infinity) - (Number.isFinite(bTime) ? bTime : Infinity)
    || Number(a.id || 0) - Number(b.id || 0);
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
