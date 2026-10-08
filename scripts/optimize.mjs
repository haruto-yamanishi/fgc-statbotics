import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qualificationMatches } from "../src/epa.js";
import { MODEL_PARAMS } from "../src/model-config.js";
import { buildRoster, buildSeasonModel, matchKey } from "../src/predict.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const write = args.includes("--write");
const refresh = args.includes("--refresh");
const cacheDir = args.find((arg) => arg.startsWith("--data-dir="))?.slice("--data-dir=".length)
  || path.join(os.tmpdir(), "fgc-statbotics-optimization");
const seasons = new Map();

// Only 2024 is used to select parameters. 2025 stays untouched until the
// final evaluation, which makes a cross-game regression visible.
for (const year of [2022, 2023, 2024, 2025]) seasons.set(year, await loadSeason(year));

const results = new Map();
function evaluate(year, params) {
  const key = `${year}:${JSON.stringify(params)}`;
  if (results.has(key)) return results.get(key);
  const season = seasons.get(year);
  const history = [seasons.get(year - 1), seasons.get(year - 2)];
  const model = buildSeasonModel(buildRoster(season.rankings, season.matches), season.matches, history, params);
  const games = qualificationMatches(season.matches)
    .map((match) => ({ match, prediction: model.snapshots.get(matchKey(match)) }))
    .filter(({ prediction }) => prediction?.projected);
  if (!games.length) throw new Error(`${year} has no scorable ranking matches`);

  let decided = 0;
  let logLoss = 0;
  let brier = 0;
  let correct = 0;
  let totalAbsoluteError = 0;
  let totalBias = 0;
  for (const { match, prediction } of games) {
    const actualRed = Number(match.redScore);
    const actualBlue = Number(match.blueScore);
    totalAbsoluteError += Math.abs(actualRed - prediction.projected.red) + Math.abs(actualBlue - prediction.projected.blue);
    totalBias += prediction.projected.red - actualRed + prediction.projected.blue - actualBlue;
    if (actualRed === actualBlue) continue;
    decided += 1;
    const outcome = actualRed > actualBlue ? 1 : 0;
    const probability = prediction.redProbability;
    logLoss -= outcome ? Math.log(probability) : Math.log(1 - probability);
    brier += (probability - outcome) ** 2;
    if ((probability > 0.5) === Boolean(outcome)) correct += 1;
  }
  const metrics = {
    matches: games.length,
    decided,
    logLoss: logLoss / decided,
    brier: brier / decided,
    accuracy: correct / decided,
    scoreMae: totalAbsoluteError / (games.length * 2),
    scoreBias: totalBias / (games.length * 2),
  };
  results.set(key, metrics);
  return metrics;
}

function tune(initial, fields, objective, minimumGain, passes = 2) {
  let current = { ...initial };
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;
    for (const [field, choices] of Object.entries(fields)) {
      let best = current;
      let bestValue = evaluate(2024, current)[objective];
      for (const value of choices) {
        if (value === current[field]) continue;
        const candidate = { ...current, [field]: value };
        const score = evaluate(2024, candidate)[objective];
        if (score < bestValue - minimumGain) {
          best = candidate;
          bestValue = score;
        }
      }
      if (best !== current) {
        current = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}

const baseline = { ...MODEL_PARAMS };
const baselineTrain = evaluate(2024, baseline);
const baselineHoldout = evaluate(2025, baseline);
console.log("Baseline", JSON.stringify({ train2024: baselineTrain, holdout2025: baselineHoldout }));

const winnerFields = {
  historyShrink: [0.35, 0.5, 0.7, 0.9, 1.1],
  probabilityScale: [1.25, 1.75, 2.25, 2.5, 3, 3.5],
  onlineRate: [0, 0.07, 0.14, 0.22, 0.32],
  epaLambda: [2, 4, 6, 10, 16],
};
const scoreFields = {
  paceStrength: [0, 0.4, 0.7, 1, 1.2],
  scoreRatingScale: [0, 0.3, 0.65, 1, 1.4],
  scorePriorAlliances: [0, 2, 8, 24],
  recentScoreWeight: [0, 0.3, 0.6, 1],
};
let tuned = baseline;
for (let cycle = 0; cycle < 4; cycle += 1) {
  const winnerTuned = tune(tuned, winnerFields, "logLoss", 0.0005);
  const scoreTuned = tune(winnerTuned, scoreFields, "scoreMae", 0.05);
  console.log(`Tuning cycle ${cycle + 1}`, JSON.stringify({ params: scoreTuned, train2024: evaluate(2024, scoreTuned) }));
  if (JSON.stringify(scoreTuned) === JSON.stringify(tuned)) break;
  tuned = scoreTuned;
}
const train = evaluate(2024, tuned);
const holdout = evaluate(2025, tuned);
console.log("Optimized", JSON.stringify({ params: tuned, train2024: train, holdout2025: holdout }));

// The holdout is a release gate, never an input to the search above.
const changed = JSON.stringify(tuned) !== JSON.stringify(baseline);
const acceptable = !changed || train.logLoss < baselineTrain.logLoss && train.scoreMae < baselineTrain.scoreMae
  && holdout.logLoss <= baselineHoldout.logLoss + 0.01
  && holdout.scoreMae <= baselineHoldout.scoreMae + 0.5;
console.log(`Release gate: ${changed ? acceptable ? "pass" : "fail" : "no change"}`);
if (write) {
  if (!changed) {
    console.log("Active parameters are already the best candidates in this search");
    process.exit(0);
  }
  if (!acceptable) throw new Error("Holdout regression: active parameters were not changed");
  await fs.writeFile(path.join(root, "src/model-config.js"),
    `// Selected by npm run optimize -- --write using 2024 for tuning and 2025 as holdout.\nexport const MODEL_PARAMS = Object.freeze(${JSON.stringify(tuned, null, 2)});\n`);
  console.log("Wrote src/model-config.js");
}

async function loadSeason(year) {
  await fs.mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${year}.json`);
  let data;
  if (!refresh) {
    try { data = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!data) {
    const url = `https://api.first.global/v1?year=${year}&excludeMatchDetails=true`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`FIRST Global ${year}: HTTP ${response.status}`);
    data = await response.json();
    await fs.writeFile(file, JSON.stringify(data));
  }
  if (!Array.isArray(data.matches) || !Array.isArray(data.rankings)) throw new Error(`Invalid ${year} API data`);
  return data;
}
