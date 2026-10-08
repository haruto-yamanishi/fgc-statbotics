import test from "node:test";
import assert from "node:assert/strict";
import { buildRoster, buildRatings, buildSeasonModel, matchKey, predictMatch, scoreContext, teamNameJa } from "../src/predict.js";
import { MODEL_PARAMS } from "../src/model-config.js";

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

test("前年の試合結果がなくても前年の公式順位を参照できる", () => {
  const current = match([participant(88, "JPN")], [participant(42, "CRC")], 0, 0, false);
  const previous = { rankings: [{ teamKey: 1, rank: 100, team: { country: "JPN" } }], matches: [] };
  const ratings = buildRatings(buildRoster([], [current]), [current], [previous]);
  assert.equal(ratings.get(88).previousRank, 100);
  assert.equal(ratings.get(88).historical, false);
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

test("今年の得点が出た直後から得点水準を更新する", () => {
  const older = { matches: [match([participant(10, "JPN")], [participant(20, "CRC")], 50, 50)] };
  const previous = scoreContext([], [older]);
  const played = match([participant(88, "JPN")], [participant(42, "CRC")], 180, 220);
  const updated = scoreContext([played], [older]);
  assert.equal(previous.mean, 50);
  assert.ok(updated.mean > 50);
  assert.ok(updated.mean < 200);
  assert.equal(updated.playedAlliances, 2);
});

test("過去大会の前半から終盤への得点増を予定試合に適用し、今年の序盤実績は二重補正しない", () => {
  const red = [participant(1, "JPN")];
  const blue = [participant(2, "CRC")];
  const schedule = Array.from({ length: 8 }, (_, index) => ({
    ...match(red, blue, 0, 0, false), id: index + 1,
    scheduledTime: `2026-10-08T${String(index + 10).padStart(2, "0")}:00:00Z`,
  }));
  const rising = { matches: schedule.map((game, index) => ({ ...game, played: true, redScore: 30 + index * 10, blueScore: 30 + index * 10 })) };
  const flat = { matches: schedule.map((game) => ({ ...game, played: true, redScore: 65, blueScore: 65 })) };
  const ratings = new Map([[1, { rating: 0 }], [2, { rating: 0 }]]);
  const initial = scoreContext([], [rising], schedule);
  assert.ok(predictMatch(schedule[7], ratings, initial).projected.red > predictMatch(schedule[0], ratings, initial).projected.red);

  const firstPlayed = { ...schedule[0], played: true, redScore: 40, blueScore: 40 };
  const risingUpdated = scoreContext([firstPlayed], [rising], schedule);
  const flatUpdated = scoreContext([firstPlayed], [flat], schedule);
  assert.ok(risingUpdated.mean > flatUpdated.mean);
  assert.equal(risingUpdated.playedAlliances, 2);
});

test("過去試合の予測にはその試合と後の結果を混ぜない", () => {
  const first = { ...match([participant(88, "JPN")], [participant(42, "CRC")], 100, 20), id: 1, scheduledTime: "2026-10-08T10:00:00Z" };
  const second = { ...match([participant(88, "JPN")], [participant(42, "CRC")], 40, 80), id: 2, scheduledTime: "2026-10-08T11:00:00Z" };
  const older = { rankings: [
    { teamKey: 10, rank: 1, team: { country: "JPN" } },
    { teamKey: 20, rank: 2, team: { country: "CRC" } },
  ], matches: [match([participant(10, "JPN")], [participant(20, "CRC")], 90, 40)] };
  const roster = buildRoster([], [first, second]);
  const model = buildSeasonModel(roster, [first, second], [older]);
  const changedSecond = { ...second, redScore: 900, blueScore: 1 };
  const changed = buildSeasonModel(roster, [first, changedSecond], [older]);
  assert.deepEqual(model.snapshots.get(matchKey(first)), changed.snapshots.get(matchKey(first)));
  assert.equal(model.snapshots.get(matchKey(first)).verdict, "correct");
  assert.equal(model.snapshots.get(matchKey(second)).verdict, "incorrect");
  assert.ok(model.snapshots.get(matchKey(second)).projected.red > model.snapshots.get(matchKey(first)).projected.red);
});

test("同時刻の試合結果は互いの試合前予測に使わない", () => {
  const first = { ...match([participant(1, "JPN")], [participant(2, "CRC")], 100, 20), id: 1, scheduledTime: "2026-10-08T10:00:00Z" };
  const second = { ...match([participant(1, "JPN")], [participant(2, "CRC")], 40, 80), id: 2, scheduledTime: "2026-10-08T10:00:00Z" };
  const roster = buildRoster([], [first, second]);
  const original = buildSeasonModel(roster, [first, second]);
  const changed = buildSeasonModel(roster, [{ ...first, redScore: 1000 }, second]);
  assert.deepEqual(original.snapshots.get(matchKey(second)), changed.snapshots.get(matchKey(second)));
});

test("得点実績を使う更新は終了した試合の後にだけ次の予測へ反映する", () => {
  const old = { rankings: [
    { teamKey: 10, team: { country: "JPN" } },
    { teamKey: 20, team: { country: "CRC" } },
  ], matches: [match([participant(10, "JPN")], [participant(20, "CRC")], 50, 50)] };
  const first = { ...match([participant(1, "JPN")], [participant(2, "CRC")], 100, 100), id: 1, scheduledTime: "2026-10-08T10:00:00Z" };
  const sameTime = { ...match([participant(1, "JPN")], [participant(3, "USA")], 50, 50), id: 2, scheduledTime: "2026-10-08T10:00:00Z" };
  const later = { ...match([participant(1, "JPN")], [participant(3, "USA")], 50, 50), id: 3, scheduledTime: "2026-10-08T11:00:00Z" };
  const params = { ...MODEL_PARAMS, onlineRate: 0, onlineScoreRate: 0.2, scoreRatingScale: 0 };
  const schedule = [first, sameTime, later];
  const model = buildSeasonModel(buildRoster([], schedule), schedule, [old], params);
  const firstSnapshot = model.snapshots.get(matchKey(sameTime));
  const laterSnapshot = model.snapshots.get(matchKey(later));
  assert.equal(firstSnapshot.redProbability, 0.5);
  assert.ok(laterSnapshot.redProbability > 0.5);
  const changed = buildSeasonModel(buildRoster([], schedule), [{ ...first, redScore: 200, blueScore: 200 }, sameTime, later], [old], params);
  assert.deepEqual(firstSnapshot, changed.snapshots.get(matchKey(sameTime)));
  assert.ok(changed.snapshots.get(matchKey(later)).redProbability > laterSnapshot.redProbability);
});

test("公式集計前のテスト試合は今年の得点水準と試合前予測に入れない", () => {
  const testMatch = { ...match([participant(1, "JPN")], [participant(2, "CRC")], 131, 97), id: 3, name: "Test Match 3", tournamentKey: "t99" };
  const ranking = { ...match([participant(1, "JPN")], [participant(2, "CRC")], 0, 0, false), id: 1 };
  const roster = buildRoster([], [testMatch, ranking]);
  const model = buildSeasonModel(roster, [testMatch, ranking]);
  assert.equal(model.scoring, null);
  assert.equal(model.snapshots.size, 0);
  assert.equal(model.ratings.get(1).epa, null);
});
