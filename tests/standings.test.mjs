import test from "node:test";
import assert from "node:assert/strict";
import { allianceOutcome, projectedOutcome, rankMovement, teamRecord } from "../src/standings.js";

const match = (redScore, blueScore, played = true) => ({
  played, redScore, blueScore,
  participants: [{ teamKey: 1, station: 11 }, { teamKey: 2, station: 21 }],
});

test("公式順位の前年比は上昇・下降・同順位と未発表を区別する", () => {
  assert.equal(rankMovement(20, 100), 80);
  assert.equal(rankMovement(100, 20), -80);
  assert.equal(rankMovement(20, 20), 0);
  assert.equal(rankMovement(null, 20), null);
  assert.equal(rankMovement(20, null), null);
});

test("終了試合の勝敗は所属アライアンスの得点から数え、未実施を除く", () => {
  const matches = [match(90, 80), match(50, 60), match(40, 40), match(0, 0, false), match(null, 30)];
  assert.deepEqual(teamRecord(matches, 1), { wins: 1, losses: 1, ties: 1 });
  assert.deepEqual(teamRecord(matches, 2), { wins: 1, losses: 1, ties: 1 });
  assert.deepEqual(teamRecord(matches, 3), { wins: 0, losses: 0, ties: 0 });
  assert.equal(allianceOutcome(matches[0], "red"), "win");
  assert.equal(allianceOutcome(matches[0], "blue"), "lose");
  assert.equal(allianceOutcome(matches[2], "red"), "tie");
  assert.equal(allianceOutcome(matches[3], "red"), null);
});

test("予測勝率の表示に合わせて両アライアンスの WIN / LOSE / 五分を判定する", () => {
  assert.equal(projectedOutcome(67, "red"), "win");
  assert.equal(projectedOutcome(67, "blue"), "lose");
  assert.equal(projectedOutcome(49, "red"), "lose");
  assert.equal(projectedOutcome(49, "blue"), "win");
  assert.equal(projectedOutcome(50, "red"), "even");
  assert.equal(projectedOutcome(50, "blue"), "even");
  assert.equal(projectedOutcome(101, "red"), null);
});
