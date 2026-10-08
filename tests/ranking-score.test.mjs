import test from "node:test";
import assert from "node:assert/strict";
import { completedRankingScores, projectedFinalRankingScores, projectedRankingPositions, rankingScore } from "../src/ranking-score.js";

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

test("全チームの最終予測ランキングスコアは実績と残りのランキング戦を合算する", () => {
  const participant = (teamKey, station, extra = {}) => ({ teamKey, station, ...extra });
  const match = (id, played, red, blue, participants) => ({
    id, name: `Ranking Match ${id}`, played, redScore: red, blueScore: blue, participants,
  });
  const matches = [
    match(1, true, 50, 20, [participant(1, 11), participant(2, 21)]),
    match(2, true, 30, 60, [participant(1, 11, { cardStatus: 2 }), participant(2, 21)]),
    match(3, false, null, null, [participant(1, 21), participant(2, 11)]),
    match(4, false, null, null, [participant(1, 11, { surrogate: 1 }), participant(2, 21)]),
  ];
  const forecasts = new Map([[3, { projected: { red: 70, blue: 80 } }], [4, { projected: { red: 100, blue: 10 } }]]);
  const scores = projectedFinalRankingScores(matches, [1, 2, 3], (game) => forecasts.get(game.id));
  assert.equal(scores.get(1), 40); // 0-point red card stays; the 50-point result is dropped.
  assert.equal(scores.get(2), 50); // 10 is dropped from 20, 60, 70, 10.
  assert.equal(scores.get(3), null);
});

test("予測順位は全チームを対象に表示桁で同点を扱い、スコアなしは除外する", () => {
  const positions = projectedRankingPositions(new Map([[1, 100.04], [2, 95], [3, 100.02], [4, null], [5, 80]]));
  assert.deepEqual([...positions], [[1, 1], [3, 1], [2, 3], [5, 4]]);
  assert.equal(positions.get(2), 3); // A search for team 2 still shows its overall rank.
});
