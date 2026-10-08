import test from "node:test";
import assert from "node:assert/strict";
import { completedRankingScores, rankingScore } from "../src/ranking-score.js";

test("2026ランキングスコアは初戦を保持し、2試合目から最低得点を除いた平均", () => {
  assert.equal(rankingScore([]), null);
  assert.equal(rankingScore([{ score: 72, redCard: false }]), 72);
  assert.equal(rankingScore([{ score: 72, redCard: false }, { score: 79, redCard: false }]), 79);
  assert.equal(rankingScore([{ score: 72, redCard: false }, { score: 79, redCard: false }, { score: 100, redCard: false }]), 89.5);
});

test("レッドカードの0点は除外せず、別の最低得点を落とす", () => {
  assert.equal(rankingScore([{ score: 0, redCard: true }, { score: 30, redCard: false }, { score: 80, redCard: false }]), 40);
});

test("ノーショーとサロゲートは予測ランキングスコアの過去得点に入れない", () => {
  const match = (id, redScore, participant = {}) => ({
    id, name: `Ranking Match ${id}`, played: true, redScore, blueScore: 20,
    participants: [{ teamKey: 1, station: 11, ...participant }, { teamKey: 2, station: 21 }],
  });
  assert.deepEqual(completedRankingScores([
    match(1, 72), match(2, 50, { noShow: 1 }), match(3, 40, { surrogate: 1 }),
    match(4, 90, { cardStatus: 2 }), { ...match(5, 60), name: "Practice Match 5" },
  ], 1), [{ score: 72, redCard: false }, { score: 0, redCard: true }]);
});
