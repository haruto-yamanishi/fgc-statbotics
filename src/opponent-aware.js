// 2026 winner forecast: opponent-adjusted Wildfire scoring + historical strength.
// Parameters frozen after chronological replay on 2026 games 1–84.
// NOTE: win probabilities only. EPA and projected scores stay unchanged.
// Historical accuracy is a retrospective replay, not a log of predictions
// recorded before the tournament.
import { buildRatings, matchKey } from "./predict.js?v=20261008-5";
import { qualificationMatches } from "./epa.js";

export const OPPONENT_AWARE_2026 = Object.freeze({
  history: 2,
  offensePrior: 0.25,
  scoreRate: 0.15,
  winRate: 0.1,
  contestWeight: 0.5,
  offenseWeight: 0.25,
  winWeight: 0.5,
  scoreScale: 50,
  winTemperature: 2,
  offenseTemperature: 1.25,
  probabilityTemperature: 1,
  calibration: 0.5,
  concentration: 1.25,
  adjustmentClip: 4,
  ratingClip: 4,
});

const sigmoid = (x) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
const matchTime = (m) => {
  const parsed = Date.parse(m.scheduledTime);
  return Number.isFinite(parsed) ? parsed : Number(m.id || 0);
};
const alliances = (match, red) => (match.participants || [])
  .filter((p) => {
    const station = Number(p.station);
    return red ? station >= 10 && station < 20 : station >= 20 && station < 30;
  })
  .sort((a, b) => Number(a.station) - Number(b.station))
  .map((p) => Number(p.teamKey));

function outcome(match) {
  return Math.sign(Number(match.redScore) - Number(match.blueScore));
}

function scoring(match) {
  if (!match.details) return null;
  const red = Number(match.details.wildfireInRedSuppressionUnit);
  const blue = Number(match.details.wildfireInBlueSuppressionUnit);
  return Number.isFinite(red) && Number.isFinite(blue) ? { red, blue } : null;
}

function verdict(probability, result) {
  const actualWinner = result > 0 ? "red" : result < 0 ? "blue" : "tie";
  const predictedWinner = probability === 0.5 ? null : probability > 0.5 ? "red" : "blue";
  return {
    actualWinner,
    predictedWinner,
    verdict: actualWinner === "tie" ? "tie"
      : predictedWinner === null ? "no-pick"
      : predictedWinner === actualWinner ? "correct" : "incorrect",
  };
}

function startingRatings(roster, history, config) {
  const historical = buildRatings(roster, [], history);
  const countryIds = roster.map((row) => Number(row.teamKey)).filter(Number.isFinite);
  return {
    scoreRating: new Map(countryIds.map((id) => [id, config.history * (historical.get(id)?.rating || 0)])),
    winRating: new Map(countryIds.map((id) => [id, config.history * (historical.get(id)?.rating || 0)])),
    offense: new Map(countryIds.map((id) => [id, config.offensePrior * config.history * (historical.get(id)?.rating || 0)])),
  };
}

function sum(teams, ratings) {
  return teams.reduce((total, id) => total + (ratings.get(id) || 0), 0);
}

function probability(match, baseline, ratings, config) {
  const red = alliances(match, true);
  const blue = alliances(match, false);
  if (!red.length || !blue.length) return baseline;
  const contest = sum(red, ratings.scoreRating) - sum(blue, ratings.scoreRating);
  const offenseDifference = sum(red, ratings.offense) - sum(blue, ratings.offense);
  const winDifference = sum(red, ratings.winRating) - sum(blue, ratings.winRating);
  const weighted = config.contestWeight * contest / config.probabilityTemperature
    + config.offenseWeight * offenseDifference / config.offenseTemperature
    + config.winWeight * winDifference / config.winTemperature;
  const p = sigmoid(weighted * config.calibration);
  return clamp(0.5 + (p - 0.5) * config.concentration, 0.05, 0.95);
}

export function buildOpponentAwareModel(roster, matches, history, baselineSnapshots, config = OPPONENT_AWARE_2026) {
  const ratings = startingRatings(roster, history, config);
  const snapshots = new Map(baselineSnapshots);
  const played = qualificationMatches(matches)
    .sort((a, b) => matchTime(a) - matchTime(b) || Number(a.id || 0) - Number(b.id || 0));

  for (let index = 0; index < played.length;) {
    const timestamp = matchTime(played[index]);
    const group = [];
    while (index < played.length && matchTime(played[index]) === timestamp) group.push(played[index++]);

    const scoreChanges = new Map();
    const winChanges = new Map();
    // Predict the entire group before learning any result in that group.
    for (const match of group) {
      const red = alliances(match, true);
      const blue = alliances(match, false);
      if (!red.length || !blue.length) continue;
      const key = matchKey(match);
      const earlier = baselineSnapshots.get(key);
      if (earlier) {
        const redProbability = probability(match, earlier.redProbability, ratings, config);
        snapshots.set(key, {
          ...earlier,
          redProbability,
          ...verdict(redProbability, outcome(match)),
        });
      }
      const parts = scoring(match);
      if (!parts) continue; // Never invent or infer a missing score breakdown.
      const contest = sum(red, ratings.scoreRating) - sum(blue, ratings.scoreRating);
      const winDifference = sum(red, ratings.winRating) - sum(blue, ratings.winRating);
      const difference = (parts.red - parts.blue) / config.scoreScale;
      const signal = clamp(difference, -config.adjustmentClip, config.adjustmentClip);
      const residual = clamp(signal - contest / config.probabilityTemperature, -config.adjustmentClip, config.adjustmentClip);
      // Small Wildfire differences must not dominate rating updates.
      const multiplier = Math.min(1, Math.abs(signal) / config.adjustmentClip);
      const scoreDelta = config.scoreRate * residual * multiplier;

      const result = outcome(match);
      const winner = result === 1 ? 1 : result === -1 ? 0 : 0.5;
      const winDelta = config.winRate * (winner - sigmoid(winDifference / config.winTemperature));
      for (const id of red) {
        scoreChanges.set(id, (scoreChanges.get(id) || 0) + scoreDelta);
        winChanges.set(id, (winChanges.get(id) || 0) + winDelta);
      }
      for (const id of blue) {
        scoreChanges.set(id, (scoreChanges.get(id) || 0) - scoreDelta);
        winChanges.set(id, (winChanges.get(id) || 0) - winDelta);
      }
    }
    for (const [id, delta] of scoreChanges) {
      ratings.scoreRating.set(id, clamp((ratings.scoreRating.get(id) || 0) + delta, -config.ratingClip, config.ratingClip));
    }
    for (const [id, delta] of winChanges) {
      ratings.winRating.set(id, clamp((ratings.winRating.get(id) || 0) + delta, -config.ratingClip, config.ratingClip));
    }
  }

  return {
    snapshots,
    probability: (match, baseline) => probability(match, baseline, ratings, config),
  };
}
