// 2026 game-component experiment. Read-only: never writes active model parameters.
// Uses ONLY matches that precede each prediction. Tunes on first 50 matches,
// evaluates on final 25 as a chronological holdout.
import { buildRoster, buildRatings, buildSeasonModel, matchKey } from "../src/predict.js";
import { qualificationMatches } from "../src/epa.js";

const years=[2024,2025,2026];
const fetched=await Promise.all(years.map(async year=>{
  const r=await fetch("https://api.first.global/v1?year="+year+"&excludeMatchDetails=false",{signal:AbortSignal.timeout(60000)});
  if(!r.ok)throw Error("API "+year+": "+r.status);
  const data=await r.json();
  if(!Array.isArray(data.matches)||!Array.isArray(data.rankings))throw Error("unexpected API "+year);
  return [year,data];
}));
const seasons=new Map(fetched);
const cur=seasons.get(2026);
const time=m=>{let t=Date.parse(m.scheduledTime);return Number.isFinite(t)?t:Number(m.id||0)};
const matches=qualificationMatches(cur.matches).sort((a,b)=>time(a)-time(b)||Number(a.id||0)-Number(b.id||0));
const roster=buildRoster(cur.rankings,cur.matches);
const prior=buildRatings(roster,[],[seasons.get(2025),seasons.get(2024)]);
const baseline=buildSeasonModel(roster,cur.matches,[seasons.get(2025),seasons.get(2024)]).snapshots;
const getTeams=(m,side)=>(m.participants||[]).filter(p=>{const i=Number(p.station);return side==="red"?i>=10&&i<20:i>=20&&i<30;}).sort((a,b)=>Number(a.station)-Number(b.station)).map(p=>Number(p.teamKey));
const sig=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const splitAt=Math.min(50,Math.floor(matches.length*2/3));
const groups=[];
for(const m of matches){
 const last=groups.at(-1);
 if(last&&time(last[0])===time(m))last.push(m);
 else groups.push([m]);
}
function components(m,side) {
 const d=m.details;
 if(!d)return null;
 const cap=side==="red"?"Red":"Blue",lower=side;
 const base=Number(d["wildfireIn"+cap+"SuppressionUnit"]);
 const mult=Number(d[side+"ClimbMultiplier"]);
 const partner=Number(d[side+"PartnerClimbPoints"]||0);
 const climb=[1,2,3].map((x,i)=>Number(d[lower+"Robot"+["One","Two","Three"][i]+"BraceState"]));
 if(!Number.isFinite(base)||!Number.isFinite(mult)||climb.some(x=>!Number.isFinite(x)))return null;
 return {base,mult,partner,climb};
}
const actual=matches.map(m=>({red:components(m,"red"),blue:components(m,"blue"),match:m}));
const missing=actual.filter(x=>!x.red||!x.blue).length;
if(missing)throw Error(missing+" matches are missing score components");
const thresholdStats=[20,50,100,150,200].map(t=>({threshold:t,share:actual.flatMap(x=>[x.red.base,x.blue.base]).filter(v=>v>=t).length/(actual.length*2)}));
const baseWinner=actual.filter(x=>x.red.base!==x.blue.base&&Math.sign(x.red.base-x.blue.base)===Math.sign(Number(x.match.redScore)-Number(x.match.blueScore))).length;
const endgameReversals=actual.filter(x=>x.red.base!==x.blue.base&&Math.sign(x.red.base-x.blue.base)!==Math.sign(Number(x.match.redScore)-Number(x.match.blueScore))).length;
const calcMismatch=actual.filter(x=>{
 const d=x.match.details;
 const common=Number(d.wildfireInExtinguisher||0)+Number(d.coopertition||0)+Number(d.coopertitionKnockdownBonus||0);
 return Math.ceil(x.red.base*x.red.mult)+x.red.partner+common!==Number(x.match.redScore)
     || Math.ceil(x.blue.base*x.blue.mult)+x.blue.partner+common!==Number(x.match.blueScore);
}).length;
console.log("FGC_COMPONENT_FACTS "+JSON.stringify({played:matches.length,splitAt,missing,scoreFormulaMismatches:calcMismatch,thresholdStats,
  winnerMatchesBase:baseWinner,endgameReversals,meanBase:actual.reduce((s,x)=>s+x.red.base+x.blue.base,0)/(2*actual.length),
  meanClimbMultiplier:actual.reduce((s,x)=>s+x.red.mult+x.blue.mult,0)/(2*actual.length),
  zeroBase:actual.flatMap(x=>[x.red.base,x.blue.base]).filter(v=>v===0).length}));
function evaluate(predictions,idx1,idx2) {
 const segment=predictions.filter(x=>x.index>=idx1&&x.index<idx2&&x.outcome!==0);
 const pick=segment.filter(x=>x.p!==0.5);
 const correct=pick.filter(x=>(x.p>0.5?1:-1)===x.outcome).length;
 const logLoss=segment.length?segment.reduce((s,x)=>s-(x.outcome===1?Math.log(x.p):Math.log(1-x.p)),0)/segment.length:null;
 const brier=segment.length?segment.reduce((s,x)=>s+(x.p-(x.outcome===1?1:0))**2,0)/segment.length:null;
 return {correct,eligible:pick.length,decided:segment.length,accuracy:pick.length?correct/pick.length:null,logLoss,brier};
}
const baseRows=matches.map((m,index)=>({index,outcome:Math.sign(Number(m.redScore)-Number(m.blueScore)),p:baseline.get(matchKey(m))?.redProbability}));
if(baseRows.some(x=>!Number.isFinite(x.p)))throw Error("baseline missing snapshots");
const baselineReport={train:evaluate(baseRows,0,splitAt),holdout:evaluate(baseRows,splitAt,matches.length),full:evaluate(baseRows,0,matches.length)};
const historic=new Map(roster.map(t=>[Number(t.teamKey),prior.get(Number(t.teamKey))?.rating||0]));
const mean=(list)=>list.length?list.reduce((s,x)=>s+x,0)/list.length:0;
function run(cfg) {
 const rating=new Map([...historic].map(([key,value])=>[key,cfg.history*value]));
 const statistics=new Map([...historic].map(([key])=>[key,{n:0,climb:0,high:0}]));
 const out=[];
 let index=0;
 for(const group of groups){
  const staged=[];
  for(const match of group){
   const red=getTeams(match,"red"),blue=getTeams(match,"blue");
   const redComp=components(match,"red"),blueComp=components(match,"blue");
   const rosterAverage=(keys,stat)=>mean(keys.map(k=>statistics.get(k)?.[stat]||0));
   const posteriorClimb=keys=>keys.reduce((sum,k)=>{
      const item=statistics.get(k)||{n:0,climb:0};
      return sum+(cfg.climbPrior*.14+item.climb)/(cfg.climbPrior+item.n);
   },0);
   const highProb=keys=>rosterAverage(keys,"high"); // raw count handled below
   const highRate=keys=>mean(keys.map(k=>{const s=statistics.get(k)||{n:0,high:0};return (cfg.highPrior*.5+s.high)/(cfg.highPrior+s.n);}));
   const ratingDifference=red.reduce((s,k)=>s+(rating.get(k)||0),0)-blue.reduce((s,k)=>s+(rating.get(k)||0),0);
   const highDifference=highRate(red)-highRate(blue);
   const share=sig(ratingDifference/cfg.temperature+cfg.thresholdEffect*highDifference);
   const redMult=1+cfg.endgameEffect*posteriorClimb(red);
   const blueMult=1+cfg.endgameEffect*posteriorClimb(blue);
   // Both alliances compete for a common wildfire pool; their share, not
   // independent gross score sums, determines the regional winner.
   const componentProbability=sig(cfg.confidence*Math.log((share*redMult+1e-6)/((1-share)*blueMult+1e-6)));
   const baseP=baseline.get(matchKey(match)).redProbability;
   const p=clamp(cfg.blend*componentProbability+(1-cfg.blend)*baseP,0.05,0.95);
   const outcome=Math.sign(Number(match.redScore)-Number(match.blueScore));
   out.push({index:index++,p,outcome});
   staged.push({red,blue,redComp,blueComp,share});
  }
  const updates=new Map();
  for(const {red,blue,redComp,blueComp,share} of staged){
   const target=(redComp.base+1)/(redComp.base+blueComp.base+2);
   const confidenceSize=Math.max(redComp.base,blueComp.base)>=cfg.threshold?1:cfg.smallMatchWeight;
   const adjust=cfg.rate*(target-share)*confidenceSize;
   for(const id of red)updates.set(id,(updates.get(id)||0)+adjust);
   for(const id of blue)updates.set(id,(updates.get(id)||0)-adjust);
  }
  for(const [id,delta]of updates)rating.set(id,clamp((rating.get(id)||0)+delta,-3,3));
  for(const {red,blue,redComp,blueComp}of staged)
    for(const [ids,comp]of [[red,redComp],[blue,blueComp]])
      for(let i=0;i<ids.length;i++){
        const old=statistics.get(ids[i])||{n:0,climb:0,high:0};
        old.n++;
        old.climb+=comp.climb[i]||0;
        old.high+=Number(comp.base>=cfg.threshold);
        statistics.set(ids[i],old);
      }
 }
 return {train:evaluate(out,0,splitAt),holdout:evaluate(out,splitAt,matches.length),full:evaluate(out,0,matches.length)};
}
const candidates=[];
const trainMetric=(r)=>r.train.logLoss;
for(const history of [.25,.5,1,1.5])
for(const rate of [.1,.2,.35,.55])
for(const threshold of [20,50,100,150])
for(const thresholdEffect of [0,.5,1.5])
for(const endgameEffect of [0,.5,1])
for(const blend of [.25,.5,.75,1]){
 const cfg={history,rate,threshold,thresholdEffect,endgameEffect,blend,
 temperature:1.25,confidence:1,highPrior:3,climbPrior:3,smallMatchWeight:.5};
 const result=run(cfg);
 candidates.push({cfg,...result});
}
const ranked=candidates.slice().sort((a,b)=>trainMetric(a)-trainMetric(b));
const shortlist=ranked.slice(0,15);
const bestHoldout=candidates.slice().sort((a,b)=>b.holdout.correct-a.holdout.correct||a.holdout.logLoss-b.holdout.logLoss).slice(0,5);
const plausible=shortlist.filter(x=>x.holdout.correct>baselineReport.holdout.correct&&x.holdout.logLoss<baselineReport.holdout.logLoss);
console.log("FGC_COMPONENT_OPTIMIZATION "+JSON.stringify({
 count:candidates.length,baseline:baselineReport, bestTraining:ranked.slice(0,8),
 topTrainingHoldout:shortlist.map(x=>({cfg:x.cfg,train:x.train,holdout:x.holdout})),
 bestHoldoutDiagnosticOnly:bestHoldout.map(x=>({cfg:x.cfg,train:x.train,holdout:x.holdout})),
 qualifiedFromTrainingTop15:plausible.map(x=>({cfg:x.cfg,train:x.train,holdout:x.holdout}))
}));
