import test from "node:test";
import assert from "node:assert/strict";
import { computeEpa, qualificationMatches, solveLinearSystem } from "../src/epa.js";

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
