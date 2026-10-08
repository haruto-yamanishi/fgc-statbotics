import assert from "node:assert/strict";
import { buildRoster,buildSeasonModel,matchKey,predictMatch } from "../src/predict.js";
import { buildGameAwareModel,GAME_AWARE_2026 } from "../src/game-aware.js";
import { qualificationMatches } from "../src/epa.js";

const years=await Promise.all([2024,2025,2026].map(async year=>{
 const r=await fetch("https://api.first.global/v1?year="+year+"&excludeMatchDetails=false",{signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error("API failed "+year);
 return [year,await r.json()];
}));
const data=new Map(years);
const current=data.get(2026),history=[data.get(2025),data.get(2024)];
const roster=buildRoster(current.rankings,current.matches);
const baseline=buildSeasonModel(roster,current.matches,history);
const candidate=buildGameAwareModel(roster,current.matches,history,baseline.snapshots);
let hit=0,eligible=0,loss=0,count=0,late=0,lateN=0;
const played=qualificationMatches(current.matches).sort((a,b)=>Date.parse(a.scheduledTime)-Date.parse(b.scheduledTime)||Number(a.id)-Number(b.id));
for(const [i,m]of played.entries()){
 const p=candidate.snapshots.get(matchKey(m));
 assert.ok(p,"Expected pre-match snapshot");
 if(p.verdict==="tie"||p.verdict==="no-pick")continue;
 eligible++;hit+=Number(p.verdict==="correct");
 const actual=m.redScore>m.blueScore?1:0;
 loss-=actual?Math.log(p.redProbability):Math.log(1-p.redProbability);
 count++;
 if(i>=50){late++;lateN+=Number(p.verdict==="correct");}
}
const upcoming=current.matches.find(m=>!m.played&&(m.participants||[]).length===6);
const futureP=upcoming?candidate.probability(upcoming,predictMatch(upcoming,baseline.ratings,baseline.scoring).redProbability):null;
function compareSubset(games) {
  const stats={};
  for(const [name,snapshots] of [["baseline",baseline.snapshots],["gameAware",candidate.snapshots]]) {
    let correct=0,eligible=0,loss=0,n=0;
    for(const m of games){
      const s=snapshots.get(matchKey(m));
      if(m.redScore===m.blueScore)continue;
      if(s.verdict!=="no-pick"){eligible++;if(s.verdict==="correct")correct++;}
      const y=m.redScore>m.blueScore?1:0;
      loss-=y?Math.log(s.redProbability):Math.log(1-s.redProbability);
      n++;
    }
    stats[name]={correct,eligible,accuracy:correct/eligible,logLoss:loss/n};
  }
  return stats;
}
const known=played.filter(m=>Number(m.id)<=75);
const newMatches=played.filter(m=>Number(m.id)>75);
const result={played:played.length,eligible,correct:hit,accuracy:hit/eligible,logLoss:loss/count,
 holdoutCorrect:lateN,holdoutEligible:late,futureP,params:GAME_AWARE_2026,
 frozen75:compareSubset(known),all:compareSubset(played),newlyPlayed:compareSubset(newMatches),
 added:newMatches.map(m=>({id:m.id,score:[m.redScore,m.blueScore],baselineP:baseline.snapshots.get(matchKey(m))?.redProbability,gameAwareP:candidate.snapshots.get(matchKey(m))?.redProbability}))};
console.log("FGC_INTEGRATED "+JSON.stringify(result));
assert.equal(result.frozen75.gameAware.correct,48,"Selected candidate must reproduce first 75 results");
assert.equal(result.frozen75.gameAware.eligible,74);
assert.ok(result.frozen75.gameAware.logLoss<.600);
assert.ok(result.all.gameAware.correct>=result.all.baseline.correct,"Game-aware model must not lose overall hits on new data");
assert.ok(result.all.gameAware.logLoss<result.all.baseline.logLoss,"Game-aware log loss must improve on new data");
if(futureP!=null)assert.ok(futureP>0&&futureP<1);
