import { buildRatings, matchKey } from "./predict.js?v=20261008-5";
import { isOfficialMatch } from "./epa.js";

// Scoring components are learned from 2026 only. 2024–25 supply weak
// country priors but never a fictitious cross-game raw-score baseline.
// Chosen by 2026 matches 1–50, checked on chronological matches 51–75.
export const GAME_AWARE_2026 = Object.freeze({
  history: 1.5,
  rate: 0.55,
  threshold: 50,
  thresholdEffect: 1.5,
  endgameEffect: 1,
  blend: 0.75,
  temperature: 1.25,
  confidence: 1,
  highPrior: 3,
  climbPrior: 3,
  smallMatchWeight: 0.5,
});

const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, value))));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const time = (m) => {
  const parsed = Date.parse(m.scheduledTime);
  return Number.isFinite(parsed) ? parsed : Number(m.id || 0);
};
const sides = (match, side) => (match.participants || [])
  .filter((participant) => {
    const station = Number(participant.station);
    return side === "red" ? station >= 10 && station < 20 : station >= 20 && station < 30;
  })
  .sort((a, b) => Number(a.station) - Number(b.station))
  .map((participant) => Number(participant.teamKey))
  .filter(Number.isFinite);
function sideComponents(match, side) {
  const detail = match?.details;
  if (!detail) return null;
  const title = side === "red" ? "Red" : "Blue";
  const suppression = Number(detail["wildfireIn" + title + "SuppressionUnit"]);
  const brace = ["One", "Two", "Three"].map((position) => Number(detail[side + "Robot" + position + "BraceState"]));
  if (!Number.isFinite(suppression) || brace.some((value) => !Number.isFinite(value))) return null;
  return { suppression, brace };
}
function outcome(match) {
  const red = Number(match.redScore);
  const blue = Number(match.blueScore);
  if (red === blue) return "tie";
  return red > blue ? "red" : "blue";
}
function verdict(match, probability) {
  const actual = outcome(match);
  if (actual === "tie") return { actualWinner: actual, predictedWinner: probability === 0.5 ? null : probability > 0.5 ? "red" : "blue", verdict: "tie" };
  const predicted = probability === 0.5 ? null : probability > 0.5 ? "red" : "blue";
  return { actualWinner: actual, predictedWinner: predicted, verdict: predicted == null ? "no-pick" : actual === predicted ? "correct" : "incorrect" };
}

// Used for live upcoming matches and for replaying pre-match probabilities.
export function gameAwareProbability(match, baselineProbability, ratings, stats, config = GAME_AWARE_2026) {
  if (!Number.isFinite(baselineProbability)) return null;
  const red = sides(match, "red");
  const blue = sides(match, "blue");
  if (!red.length || !blue.length) return baselineProbability;
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const highRate = (teamKeys) => average(teamKeys.map((teamKey) => {
    const { n = 0, high = 0 } = stats.get(teamKey) || {};
    return (config.highPrior * 0.5 + high) / (config.highPrior + n);
  }));
  const expectedClimb = (teamKeys) => teamKeys.reduce((sum, teamKey) => {
    const { n = 0, climb = 0 } = stats.get(teamKey) || {};
    return sum + (config.climbPrior * 0.14 + climb) / (config.climbPrior + n);
  }, 0);
  const sumRating = (teamKeys) => teamKeys.reduce((sum, key) => sum + (ratings.get(key) || 0), 0);
  const difference = (sumRating(red) - sumRating(blue)) / config.temperature
    + config.thresholdEffect * (highRate(red) - highRate(blue));
  const share = sigmoid(difference);
  const redExpected = share * (1 + config.endgameEffect * expectedClimb(red));
  const blueExpected = (1 - share) * (1 + config.endgameEffect * expectedClimb(blue));
  const calculated = sigmoid(config.confidence * Math.log((redExpected + 1e-6) / (blueExpected + 1e-6)));
  return clamp(config.blend * calculated + (1 - config.blend) * baselineProbability, 0.05, 0.95);
}

// Returns a chronological set of pre-match snapshots and a function for
// forecasting future matches with the learned, current-season state.
export function buildGameAwareModel(roster, matches, history, baselineSnapshots, config = GAME_AWARE_2026) {
  const previous = buildRatings(roster, [], history);
  const ratings = new Map(roster.map((team) => {
    const key = Number(team.teamKey);
    return [key, config.history * (previous.get(key)?.rating || 0)];
  }));
  const stats = new Map(roster.map((team) => [Number(team.teamKey), { n: 0, high: 0, climb: 0 }]));
  const snapshots = new Map(baselineSnapshots);
  const played = matches.filter((match) => isOfficialMatch(match) && match.played
    && Number.isFinite(Number(match.redScore)) && Number.isFinite(Number(match.blueScore)))
    .sort((a, b) => time(a) - time(b) || Number(a.id || 0) - Number(b.id || 0));
  for (let index = 0; index < played.length;) {
    const timestamp = time(played[index]);
    const group = [];
    while (index < played.length && time(played[index]) === timestamp) group.push(played[index++]);
    const staged = [];
    // No match in this group can see another match's results.
    for (const match of group) {
      const key = matchKey(match);
      const old = baselineSnapshots.get(key);
      if (old) {
        const redProbability = gameAwareProbability(match, old.redProbability, ratings, stats, config);
        snapshots.set(key, { ...old, redProbability, ...verdict(match, redProbability) });
      }
      const red = sides(match, "red");
      const blue = sides(match, "blue");
      const redComponents = sideComponents(match, "red");
      const blueComponents = sideComponents(match, "blue");
      if (red.length && blue.length && redComponents && blueComponents) {
        staged.push({ red, blue, redComponents, blueComponents });
      }
    }
    const updates = new Map();
    for (const row of staged) {
      const { red, blue, redComponents: r, blueComponents: b } = row;
      const observedShare = (r.suppression + 1) / (r.suppression + b.suppression + 2);
      // The update follows the raw suppression share model, not the mixed
      // winner probability; the exact same threshold variables drive both.
      const redHigh = red.reduce((sum, key) => {
        const { n = 0, high = 0 } = stats.get(key) || {};
        return sum + (config.highPrior * .5 + high) / (config.highPrior + n);
      }, 0) / red.length;
      const blueHigh = blue.reduce((sum, key) => {
        const { n = 0, high = 0 } = stats.get(key) || {};
        return sum + (config.highPrior * .5 + high) / (config.highPrior + n);
      }, 0) / blue.length;
      const redRating = red.reduce((sum, key) => sum + (ratings.get(key) || 0), 0);
      const blueRating = blue.reduce((sum, key) => sum + (ratings.get(key) || 0), 0);
      const estimatedShare = sigmoid((redRating - blueRating) / config.temperature
        + config.thresholdEffect * (redHigh - blueHigh));
      const magnitude = Math.max(r.suppression, b.suppression) >= config.threshold ? 1 : config.smallMatchWeight;
      const delta = config.rate * (observedShare - estimatedShare) * magnitude;
      for (const key of red) updates.set(key, (updates.get(key) || 0) + delta);
      for (const key of blue) updates.set(key, (updates.get(key) || 0) - delta);
    }
    for (const [key, delta] of updates) ratings.set(key, clamp((ratings.get(key) || 0) + delta, -3, 3));
    for (const { red, blue, redComponents, blueComponents } of staged) {
      for (const [teamKeys, component] of [[red, redComponents], [blue, blueComponents]]) {
        teamKeys.forEach((key, i) => {
          const record = stats.get(key) || { n: 0, high: 0, climb: 0 };
          record.n++;
          record.high += Number(component.suppression >= config.threshold);
          record.climb += component.brace[i] || 0;
          stats.set(key, record);
        });
      }
    }
  }
  return {
    snapshots,
    probability: (match, baseline) => gameAwareProbability(match, baseline, ratings, stats, config),
  };
}
