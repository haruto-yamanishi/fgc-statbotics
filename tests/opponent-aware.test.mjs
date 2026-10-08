import test from "node:test";
import assert from "node:assert/strict";
import { buildOpponentAwareModel } from "../src/opponent-aware.js";
import { matchKey } from "../src/predict.js";

const roster=Array.from({length:6},(_,i)=>({teamKey:i+1,country:"T"+(i+1),team:{country:"T"+(i+1)}}));
const fixture=(id,redScore,blueScore,time)=>({
 id,eventKey:"2026",tournamentKey:"t2",name:"Ranking Match "+id,scheduledTime:time,played:true,
 redScore,blueScore,participants:[
  ...[1,2,3].map((key,i)=>({station:11+i,teamKey:key})),
  ...[4,5,6].map((key,i)=>({station:21+i,teamKey:key})),
 ],
 details:{wildfireInRedSuppressionUnit:redScore,wildfireInBlueSuppressionUnit:blueScore}
});
test("モデルは同時刻の試合結果から情報漏洩しない",()=>{
 const t="2026-10-08T09:00:00Z";
 const a=fixture(1,100,5,t),b=fixture(2,10,90,t);
 const baselines=new Map([[matchKey(a),{redProbability:.7}],[matchKey(b),{redProbability:.7}]]);
 const first=buildOpponentAwareModel(roster,[a,b],[],baselines);
 const changed=buildOpponentAwareModel(roster,[{...a,redScore:5,blueScore:100,details:{wildfireInRedSuppressionUnit:5,wildfireInBlueSuppressionUnit:100}},b],[],baselines);
 assert.deepEqual(first.snapshots.get(matchKey(b)),changed.snapshots.get(matchKey(b)));
});
test("未来の結果変更は過去の試合前予測を変更しない",()=>{
 const a=fixture(1,100,5,"2026-10-08T09:00:00Z");
 const b=fixture(2,10,90,"2026-10-08T10:00:00Z");
 const baselines=new Map([[matchKey(a),{redProbability:.7}],[matchKey(b),{redProbability:.7}]]);
 const first=buildOpponentAwareModel(roster,[a,b],[],baselines);
 const changed=buildOpponentAwareModel(roster,[a,{...b,redScore:1000,details:{wildfireInRedSuppressionUnit:1000,wildfireInBlueSuppressionUnit:90}}],[],baselines);
 assert.deepEqual(first.snapshots.get(matchKey(a)),changed.snapshots.get(matchKey(a)));
 assert.equal(first.snapshots.get(matchKey(a)).verdict,"no-pick");
});
test("前の試合の結果で次戦の予測は更新される",()=>{
 const a=fixture(1,100,5,"2026-10-08T09:00:00Z");
 const b=fixture(2,10,90,"2026-10-08T10:00:00Z");
 const baseline=new Map([[matchKey(a),{redProbability:.7}],[matchKey(b),{redProbability:.7}]]);
 const m=buildOpponentAwareModel(roster,[a,b],[],baseline);
 const forecastBefore=m.snapshots.get(matchKey(a)).redProbability;
 const forecastAfter=m.snapshots.get(matchKey(b)).redProbability;
 assert.equal(forecastBefore,0.5);
 assert.ok(forecastAfter>forecastBefore);
 const pred=m.probability(b,.5);
 assert.ok(Number.isFinite(pred));
});
