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
const cacheDir = option("data-dir", path.join(os.tmpdir(), "fgc-statbotics-optimization"));
const trials = Number(option("trials", "160"));
const seed = Number(option("seed", "2026"));
const validationYear = Number(option("validation-year", "2025"));
if (!Number.isInteger(trials) || trials < 0 || trials > 5000) throw new Error("--trials must be an integer from 0 to 5000");
if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
if (![2025, 2026].includes(validationYear)) throw new Error("--validation-year must be 2025 or 2026");

const seasons = new Map();
for (let year = 2022; year <= validationYear; year += 1) {
  const data = await loadSeason(year);
  seasons.set(year, {
    data,
    roster: buildRoster(data.rankings, data.matches),
    games: qualificationMatches(data.matches),
  });
}

// Keep the latest season out of the parameter search. Historical 2025 results
// have already been inspected, so the default is validation, not an unseen test.
const developmentYears = validationYear === 2026 ? [2023, 2024, 2025] : [2023, 2024];
const fields = {
  epaLambda: [4, 8, 12, 16, 24, 32],
  historyShrink: [0.2, 0.35, 0.5, 0.7, 0.9],
  probabilityScale: [0.9, 1.1, 1.25, 1.5, 1.8],
  onlineRate: [0.16, 0.24, 0.32, 0.4, 0.5],
  onlineMaxAdjustment: [0.2, 0.35, 0.5],
  onlineScoreRate: [0, 0.025, 0.05, 0.1, 0.15, 0.2],
  ratingDecay: [0, 0.01, 0.02],
  paceStrength: [0, 0.4, 0.7, 1],
  scoreRatingScale: [0.8, 1.1, 1.4, 1.7],
  scorePriorAlliances: [0, 2, 6, 12],
  recentScoreWeight: [0, 0.3, 0.6, 0.9],
};
const fieldNames = Object.keys(fields);
const rng = random(seed);
const resultCache = new Map();
const baseline = { ...MODEL_PARAMS, onlineScoreRate: MODEL_PARAMS.onlineScoreRate || 0, ratingDecay: MODEL_PARAMS.ratingDecay || 0 };
const baselineResults = Object.fromEntries([...developmentYears, validationYear].map((year) => [year, evaluate(year, baseline)]));
if (baselineResults[validationYear].decided < 60) throw new Error(`${validationYear} needs at least 60 decided ranking matches for validation`);
console.log("Baseline", JSON.stringify(baselineResults));

const candidates = new Map();
function add(params) {
  const normalized = Object.fromEntries(Object.keys(baseline).map((key) => [key, params[key]]));
  const key = JSON.stringify(normalized);
  if (candidates.has(key)) return;
  const results = Object.fromEntries(developmentYears.map((year) => [year, evaluate(year, normalized)]));
  candidates.set(key, { params: normalized, results, cost: cost(results) });
}
add(baseline);

// Deterministic broad search, then a local pass around the strongest models.
// Only previous seasons are used here; every snapshot is made before its match.
for (let trial = 0; trial < trials; trial += 1) {
  const leaders = [...candidates.values()].sort((a, b) => a.cost - b.cost).slice(0, 12);
  const parent = leaders[Math.floor(rng() * Math.min(leaders.length, trial < trials / 3 ? 4 : 12))];
  const params = { ...parent.params };
  const changes = 1 + Math.floor(rng() * (trial < trials / 2 ? 4 : 3));
  for (let i = 0; i < changes; i += 1) {
    const field = fieldNames[Math.floor(rng() * fieldNames.length)];
    const values = fields[field];
    params[field] = values[Math.floor(rng() * values.length)];
  }
  add(params);
}
for (const leader of [...candidates.values()].sort((a, b) => a.cost - b.cost).slice(0, 3)) {
  for (const field of fieldNames) for (const value of fields[field]) add({ ...leader.params, [field]: value });
}

const ranked = [...candidates.values()].sort((a, b) => a.cost - b.cost);
const baselineCost = cost(Object.fromEntries(developmentYears.map((year) => [year, baselineResults[year]])));
const developmentPass = (candidate) => candidate.cost < baselineCost - 0.002
  && developmentYears.every((year) => candidate.results[year].logLoss <= baselineResults[year].logLoss
    && candidate.results[year].scoreMae <= baselineResults[year].scoreMae + 0.5)
  && developmentYears.reduce((sum, year) => sum + candidate.results[year].correct, 0)
    >= developmentYears.reduce((sum, year) => sum + baselineResults[year].correct, 0) + 5;
let selected = null;
// One finalist per score-update strength prevents near-identical aggressive
// candidates from consuming the whole validation budget.
const finalists = fields.onlineScoreRate
  .map((rate) => ranked.find((candidate) => candidate.params.onlineScoreRate === rate && developmentPass(candidate)))
  .filter(Boolean)
  .sort((a, b) => a.cost - b.cost);
for (const candidate of finalists) {
  const validation = evaluate(validationYear, candidate.params);
  candidate.validation = validation;
  if (!selected && validation.correct >= baselineResults[validationYear].correct + 3
    && validation.logLoss < baselineResults[validationYear].logLoss
    && validation.brier <= baselineResults[validationYear].brier
    && validation.scoreMae <= baselineResults[validationYear].scoreMae) {
    selected = { ...candidate, validation };
  }
}
console.log("Search", JSON.stringify({ seed, trials, uniqueCandidates: candidates.size, validationCandidates: finalists.length }));
console.log("Best development candidate", JSON.stringify(ranked[0]));
console.log("Finalists", JSON.stringify(finalists.map(({ params, results, validation }) => ({
  onlineScoreRate: params.onlineScoreRate,
  params,
  development: Object.fromEntries(developmentYears.map((year) => [year, results[year]])),
  validation,
}))));
console.log("Selected", JSON.stringify(selected));
console.log(`Release gate: ${selected ? "pass" : "fail"}`);
if (write && selected && JSON.stringify(selected.params) !== JSON.stringify(baseline)) {
  await fs.writeFile(path.join(root, "src/model-config.js"),
    `// Selected by npm run optimize -- --write on ${developmentYears.join(", ")}; ${validationYear} is a validation gate.\nexport const MODEL_PARAMS = Object.freeze(${JSON.stringify(selected.params, null, 2)});\n`);
  console.log("Wrote src/model-config.js");
} else if (write) {
  console.log("Active parameters were not changed");
}

function evaluate(year, params) {
  const key = `${year}:${JSON.stringify(params)}`;
  if (resultCache.has(key)) return resultCache.get(key);
  const season = seasons.get(year);
  const history = [seasons.get(year - 1)?.data, seasons.get(year - 2)?.data];
  const model = buildSeasonModel(season.roster, season.data.matches, history, params);
  let correct = 0;
  let decided = 0;
  let noPick = 0;
  let logLoss = 0;
  let brier = 0;
  let scoreCount = 0;
  let absoluteError = 0;
  for (const match of season.games) {
    const prediction = model.snapshots.get(matchKey(match));
    if (!prediction) throw new Error(`Missing pre-match prediction for ${year} ${match.name}`);
    if (prediction.projected) {
      scoreCount += 2;
      absoluteError += Math.abs(Number(match.redScore) - prediction.projected.red)
        + Math.abs(Number(match.blueScore) - prediction.projected.blue);
    }
    if (Number(match.redScore) === Number(match.blueScore)) continue;
    decided += 1;
    const outcome = Number(match.redScore) > Number(match.blueScore) ? 1 : 0;
    const probability = prediction.redProbability;
    logLoss -= outcome ? Math.log(probability) : Math.log(1 - probability);
    brier += (probability - outcome) ** 2;
    if (probability === 0.5) noPick += 1;
    else if (Number(probability > 0.5) === outcome) correct += 1;
  }
  if (!decided || !scoreCount) throw new Error(`${year} has no scorable ranking matches`);
  const result = {
    matches: season.games.length,
    decided,
    noPick,
    correct,
    accuracy: correct / decided,
    logLoss: logLoss / decided,
    brier: brier / decided,
    scoreMae: absoluteError / scoreCount,
  };
  resultCache.set(key, result);
  return result;
}

function cost(results) {
  return developmentYears.reduce((sum, year) => {
    const metric = results[year];
    return sum + metric.logLoss + 0.25 * (1 - metric.accuracy)
      + 0.08 * metric.scoreMae / baselineResults[year].scoreMae;
  }, 0) / developmentYears.length;
}

function random(initialSeed) {
  let state = initialSeed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function option(name, fallback) {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
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
    const response = await fetch(`https://api.first.global/v1?year=${year}&excludeMatchDetails=true`);
    if (!response.ok) throw new Error(`FIRST Global ${year}: HTTP ${response.status}`);
    data = await response.json();
    await fs.writeFile(file, JSON.stringify(data));
  }
  if (!Array.isArray(data.matches) || !Array.isArray(data.rankings)) throw new Error(`Invalid ${year} API data`);
  return data;
}
