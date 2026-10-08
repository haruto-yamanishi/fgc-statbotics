import test from "node:test";
import assert from "node:assert/strict";
import { ACCURACY_WINDOW_MATCHES, predictionAccuracy } from "../src/accuracy.js";

test("試合前の勝者予想の的中率を集計し、引き分けと50:50予測を除外する", () => {
  const snapshots = new Map([
    ["a", { verdict: "correct" }], ["b", { verdict: "incorrect" }],
    ["c", { verdict: "correct" }], ["d", { verdict: "tie" }],
    ["e", { verdict: "no-pick" }], ["f", { verdict: "unknown" }],
  ]);
  const accuracy = predictionAccuracy(snapshots);
  assert.equal(accuracy.correct, 2);
  assert.equal(accuracy.incorrect, 1);
  assert.equal(accuracy.ties, 1);
  assert.equal(accuracy.noPick, 1);
  assert.equal(accuracy.eligible, 3);
  assert.ok(Math.abs(accuracy.rate - 200 / 3) < 1e-10);
});

test("評価可能な試合がないときは0%と表示せず欠損扱いにする", () => {
  assert.deepEqual(predictionAccuracy(), { correct: 0, incorrect: 0, ties: 0, noPick: 0, eligible: 0, rate: null });
  assert.equal(predictionAccuracy(new Map([["draw", { verdict: "tie" }]])).rate, null);
});

test("直近10試合のうち最後の10試合だけで的中率を算出する", () => {
  const snapshots = new Map(Array.from({ length: 13 }, (_, i) =>
    [String(i + 1), { verdict: i < 3 ? "correct" : i < 7 ? "incorrect" : "correct" }]));
  const recent = predictionAccuracy(snapshots, ACCURACY_WINDOW_MATCHES);
  assert.equal(ACCURACY_WINDOW_MATCHES, 10);
  assert.equal(recent.eligible, 10);
  assert.equal(recent.correct, 6);
  assert.equal(recent.incorrect, 4);
  assert.equal(recent.rate, 60);
  assert.equal(predictionAccuracy(snapshots).correct, 9);
});

test("直近10試合を切り出してから引き分けと50:50を除外する", () => {
  const entries = [
    ["old", { verdict: "correct" }],
    ...Array.from({ length: 8 }, (_, i) => ["game" + i, { verdict: "incorrect" }]),
    ["draw", { verdict: "tie" }],
    ["no-pick", { verdict: "no-pick" }],
  ];
  const recent = predictionAccuracy(new Map(entries), ACCURACY_WINDOW_MATCHES);
  assert.deepEqual(recent, { correct: 0, incorrect: 8, ties: 1, noPick: 1, eligible: 8, rate: 0 });
});

test("直近10試合未満でもその試合数で正しく集計する", () => {
  const matches = new Map([
    ["1", { verdict: "correct" }],
    ["2", { verdict: "incorrect" }],
    ["3", { verdict: "tie" }],
  ]);
  assert.deepEqual(predictionAccuracy(matches, ACCURACY_WINDOW_MATCHES), {
    correct: 1, incorrect: 1, ties: 1, noPick: 0, eligible: 2, rate: 50,
  });
  assert.equal(predictionAccuracy(new Map([["draw", { verdict: "tie" }]]), ACCURACY_WINDOW_MATCHES).rate, null);
});
