import test from "node:test";
import assert from "node:assert/strict";
import { buildTeamMetrics, computeEpa, matchComponents, qualificationMatches, solveLinearSystem } from "../src/epa.js";

test("linear solver solves a small system", () => {
  const m = [new Float64Array([2, 1]), new Float64Array([1, 3])];
  const v = new Float64Array([5, 6]);
  const x = solveLinearSystem(m, v);
  assert.ok(Math.abs(x[0] - 1.8) < 1e-9);
  assert.ok(Math.abs(x[1] - 1.4) < 1e-9);
});

test("qualification filter prefers ranking matches", () => {
  const matches = [
    { played: true, name: "Qualification Match 1", tournamentKey: "1", redScore: 10, blueScore: 8 },
    { played: true, name: "Final Match 1", tournamentKey: "3", redScore: 20, blueScore: 18 },
  ];
  assert.equal(qualificationMatches(matches).length, 1);
  assert.equal(qualificationMatches([{ played: true, name: "Test Match 3", tournamentKey: "t99", redScore: 131, blueScore: 97 }]).length, 0);
});

test("EPA ranks a repeatedly stronger team higher", () => {
  const rankings = [1, 2, 3, 4].map((teamKey) => ({ teamKey }));
  const p = (teamKey, station) => ({ teamKey, station, cardStatus: 0, noShow: 0 });
  const matches = [
    { played: true, name: "Qualification Match 1", tournamentKey: "1", redScore: 90, blueScore: 30, participants: [p(1,11),p(2,12),p(3,13),p(2,21),p(3,22),p(4,23)] },
    { played: true, name: "Qualification Match 2", tournamentKey: "1", redScore: 95, blueScore: 35, participants: [p(1,11),p(3,12),p(4,13),p(2,21),p(3,22),p(4,23)] },
    { played: true, name: "Qualification Match 3", tournamentKey: "1", redScore: 100, blueScore: 40, participants: [p(1,11),p(2,12),p(4,13),p(2,21),p(3,22),p(4,23)] },
  ];
  const epa = computeEpa(rankings, matches, 2);
  assert.ok(epa.get(1).epa > epa.get(2).epa);
  assert.ok(epa.get(1).epa > epa.get(3).epa);
  assert.ok(epa.get(1).epa > epa.get(4).epa);
});

test("2026 の公式得点を本体と終盤に分け、EPA が合計と一致する", () => {
  const rankings = [1, 2, 3, 4, 5, 6].map((teamKey) => ({ teamKey }));
  const match = {
    played: true, name: "Ranking Match 1", redScore: 200, blueScore: 100,
    participants: [1, 2, 3].map((teamKey, i) => ({ teamKey, station: 11 + i }))
      .concat([4, 5, 6].map((teamKey, i) => ({ teamKey, station: 21 + i }))),
    details: {
      wildfireInRedSuppressionUnit: 100, wildfireInBlueSuppressionUnit: 50,
      redClimbMultiplier: 1.5, blueClimbMultiplier: 1.2,
      redPartnerClimbPoints: 25, bluePartnerClimbPoints: 0, coopertition: 10,
    },
  };
  assert.deepEqual(matchComponents(match, "red"), { body: 115, endgame: 85 });
  assert.deepEqual(matchComponents(match, "blue"), { body: 80, endgame: 20 });
  const metrics = buildTeamMetrics(rankings, [match]);
  assert.ok(Math.abs(metrics.get(1).epa - metrics.get(1).mainEpa - metrics.get(1).endgameEpa) < 1e-8);
  assert.equal(metrics.get(1).modelGames, 1);
  assert.equal(metrics.get(1).epaRank, 1);
  assert.equal(metrics.get(4).mainEpaRank > 3, true);
});

test("未出場チームには今年の EPA 順位を付けない", () => {
  const rankings = [1, 2, 3].map((teamKey) => ({ teamKey }));
  const played = { played: true, name: "Ranking Match 1", redScore: 50, blueScore: 20,
    participants: [{ teamKey: 1, station: 11 }, { teamKey: 2, station: 21 }] };
  const metrics = buildTeamMetrics(rankings, [played]);
  assert.equal(metrics.get(3).epa, null);
  assert.equal(metrics.get(3).epaRank, undefined);
});
