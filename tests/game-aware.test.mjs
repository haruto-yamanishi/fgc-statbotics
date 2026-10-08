import test from "node:test";
import assert from "node:assert/strict";
import { buildGameAwareModel, gameAwareProbability } from "../src/game-aware.js";
import { matchKey } from "../src/predict.js";

const p=(teamKey,station)=>({teamKey,station,country:"T"+teamKey});
const match=(id,r,b,rClimb,bClimb,time)=>{
  const red=[p(1,11),p(2,12),p(3,13)],blue=[p(4,21),p(5,22),p(6,23)];
  return {id,name:"Ranking Match "+id,scheduledTime:time,tournamentKey:"t2",played:true,
    participants:[...red,...blue],redScore:r,blueScore:b,details:{
    wildfireInRedSuppressionUnit:r,wildfireInBlueSuppressionUnit:b,
    redRobotOneBraceState:rClimb,redRobotTwoBraceState:.1,redRobotThreeBraceState:.1,
    blueRobotOneBraceState:bClimb,blueRobotTwoBraceState:.1,blueRobotThreeBraceState:.1
  }};
};
const roster=Array.from({length:6},(_,i)=>({teamKey:i+1,team:{country:"T"+(i+1)}}));
test("今年の強さは過去試合のみから予測し、試合後に更新される",()=>{
 const first=match(1,100,5,.3,0,"2026-10-08T09:00:00Z");
 const second=match(2,5,100,0,.3,"2026-10-08T10:00:00Z");
 const base=new Map([[matchKey(first),{redProbability:.7}],[matchKey(second),{redProbability:.7}]]);
 const a=buildGameAwareModel(roster,[first,second],[],base);
 const changed=buildGameAwareModel(roster,[first,{...second,redScore:999,blueScore:1,details:{...second.details,wildfireInRedSuppressionUnit:999}}],[],base);
 assert.deepEqual(a.snapshots.get(matchKey(first)),changed.snapshots.get(matchKey(first)));
 assert.equal(a.snapshots.get(matchKey(first)).verdict,"correct");
 assert.equal(a.snapshots.get(matchKey(second)).verdict,"incorrect");
 assert.ok(Number.isFinite(a.probability(second,.7)));
});
test("同時刻の試合は互いに情報漏洩しない",()=>{
 const a=match(1,100,5,.3,0,"2026-10-08T09:00:00Z");
 const b=match(2,10,90,0,.3,"2026-10-08T09:00:00Z");
 const base=new Map([[matchKey(a),{redProbability:.6}],[matchKey(b),{redProbability:.6}]]);
 const original=buildGameAwareModel(roster,[a,b],[],base);
 const changed=buildGameAwareModel(roster,[{...a,redScore:1000,details:{...a.details,wildfireInRedSuppressionUnit:1000}},b],[],base);
 assert.deepEqual(original.snapshots.get(matchKey(b)),changed.snapshots.get(matchKey(b)));
});
test("得点閾値と個別登坂実績の学習が予測に反映される",()=>{
 const m=match(1,50,10,.3,0,"2026-10-08T09:00:00Z");
 const ratings=new Map(roster.map(t=>[t.teamKey,0]));
 const empty=new Map(roster.map(t=>[t.teamKey,{n:0,high:0,climb:0}]));
 const observed=new Map(roster.map(t=>[t.teamKey,{n:1,high:t.teamKey<4?1:0,climb:t.teamKey<4?.3:0}]));
 assert.equal(gameAwareProbability(m,.5,ratings,empty),.5);
 assert.ok(gameAwareProbability(m,.5,ratings,observed)>.5);
});
