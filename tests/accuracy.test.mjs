import test from "node:test";
import assert from "node:assert/strict";
import { predictionAccuracy } from "../src/accuracy.js";

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
