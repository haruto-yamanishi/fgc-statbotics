import test from "node:test";
import assert from "node:assert/strict";
import { buildRoster, buildRatings, predictMatch, scoreContext, teamNameJa } from "../src/predict.js";

const participant = (teamKey, country, station) => ({ teamKey, country, station });
const match = (red, blue, redScore = 80, blueScore = 40, played = true) => ({
  name: "Ranking Match 1",
  played,
  redScore,
  blueScore,
  participants: [...red.map((p, i) => ({ ...p, station: 11 + i })), ...blue.map((p, i) => ({ ...p, station: 21 + i }))],
});

test("対戦表から公式順位公開前の参加チームを作る", () => {
  const schedule = [match([participant(88, "JPN")], [participant(42, "CRC")], 0, 0, false)];
  const roster = buildRoster([], schedule);
  assert.deepEqual(roster.map((team) => team.team.country), ["JPN", "CRC"]);
  assert.equal(roster[0].rank, null);
});

test("前年のチーム ID が変わっても国コードで予測に使う", () => {
  const current = match([participant(88, "JPN")], [participant(42, "CRC")], 0, 0, false);
  const previous = {
    rankings: [
      { teamKey: 1, rank: 1, team: { country: "JPN" } },
      { teamKey: 2, rank: 2, team: { country: "CRC" } },
    ],
    matches: [match([participant(1, "JPN")], [participant(2, "CRC")])],
  };
  const ratings = buildRatings(buildRoster([], [current]), [current], [previous]);
  assert.ok(ratings.get(88).rating > ratings.get(42).rating);
  assert.equal(ratings.get(88).previousRank, 1);
  assert.ok(predictMatch(current, ratings).redProbability > 0.5);
});

test("実績がなければ五分、今年の得点資料が足りなければスコアを出さない", () => {
  const scheduled = match([participant(88, "JPN")], [participant(42, "CRC")], 0, 0, false);
  const ratings = buildRatings(buildRoster([], [scheduled]), [scheduled]);
  assert.equal(predictMatch(scheduled, ratings).redProbability, 0.5);
  assert.equal(scoreContext([scheduled]), null);
  assert.equal(predictMatch(scheduled, ratings).projected, null);
});

test("地域コードが数字の特別チームでも日本語表示が止まらない", () => {
  assert.equal(teamNameJa({ country: "HPE", countryCode: "10" }), "HPE");
  assert.equal(teamNameJa({ country: "JPN", countryCode: "jp" }), "日本");
});
