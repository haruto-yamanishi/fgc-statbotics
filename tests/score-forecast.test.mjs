import test from "node:test";
import assert from "node:assert/strict";
import { build2026ScoreForecaster } from "../src/score-forecast.js";
import { projectedFinalRankingScores } from "../src/ranking-score.js";

const p=(teamKey,station)=>({teamKey,station});
const past=(id,redScore,blueScore)=>({
 id,name:"Ranking Match "+id,tournamentKey:"t2",played:true,
 scheduledTime:"2026-10-08T10:00:00Z",redScore,blueScore,
 participants:[p(1,11),p(2,12),p(3,13),p(4,21),p(5,22),p(6,23)],
 details:{wildfireInRedSuppressionUnit:Math.floor(redScore*.7),
  wildfireInBlueSuppressionUnit:Math.floor(blueScore*.7)}
});
const future={id:100,name:"Ranking Match 100",tournamentKey:"t2",played:false,
 participants:[p(1,11),p(2,12),p(3,13),p(4,21),p(5,22),p(6,23)]};
const ratings=new Map([[1,{epa:62,mainEpa:44,endgameEpa:18}],
 [2,{epa:54,mainEpa:39,endgameEpa:15}],
 [3,{epa:37,mainEpa:20,endgameEpa:17}],
 [4,{epa:48,mainEpa:32,endgameEpa:16}],
 [5,{epa:40,mainEpa:28,endgameEpa:12}],
 [6,{epa:38,mainEpa:24,endgameEpa:14}]]);
const fixtures=[past(1,180,40),past(2,108,170),past(3,275,55),
 past(4,100,90),past(5,150,160),past(6,100,110)];

test("予測得点の勝者は表示する2026年勝率と一致する",()=>{
 const model=build2026ScoreForecaster(fixtures,ratings);
 for(const prob of [.05,.09,.21,.47,.49]){
  const score=model.project(future,prob);
  assert.ok(score.blue>score.red,JSON.stringify({prob,score}));
 }
 for(const prob of [.51,.53,.79,.91,.95]){
  const score=model.project(future,prob);
  assert.ok(score.red>score.blue,JSON.stringify({prob,score}));
 }
 const score=model.project(future,.5);
 assert.equal(score.red,score.blue);
});

test("丸め表示50:50は得点も引き分け",()=>{
 const model=build2026ScoreForecaster(fixtures,ratings);
 assert.deepEqual(model.project(future,.501),model.project(future,.5));
 assert.deepEqual(model.project(future,.499),model.project(future,.5));
});
test("今年の得点水準で予測を抑制し、極端なEPAをそのまま表示しない",()=>{
 const model=build2026ScoreForecaster(fixtures,ratings);
 for(const prob of [.05,.21,.53,.79,.91,.95]){
  const score=model.project(future,prob);
  assert.ok(Number.isInteger(score.red)&&score.red>=0);
  assert.ok(Number.isInteger(score.blue)&&score.blue>=0);
  assert.ok(score.red+score.blue<450,JSON.stringify(score));
 }
 const huge=new Map([1,2,3,4,5,6].map(id=>[id,{epa:1e10}]));
 const score=build2026ScoreForecaster(fixtures,huge).project(future,.7);
 assert.ok(score.red+score.blue<450);
});
test("公式得点がない時は架空の旧ルール得点を表示しない",()=>{
 assert.equal(build2026ScoreForecaster([],ratings).project(future,.8),null);
 assert.equal(build2026ScoreForecaster([{...past(1,100,90),name:"Practice Match 1"}],ratings).project(future,.8),null);
});
test("予測ランキングの得点も同じ予測を使用できる",()=>{
 const score=build2026ScoreForecaster(fixtures,ratings).project(future,.53);
 const ranks=projectedFinalRankingScores([future],[1,4],()=>({projected:score}));
 assert.equal(ranks.get(1),score.red);
 assert.equal(ranks.get(4),score.blue);
 assert.ok(ranks.get(1)>ranks.get(4));
});
