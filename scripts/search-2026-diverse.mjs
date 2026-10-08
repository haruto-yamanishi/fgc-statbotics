// Chronological 2026-only parameter exploration.
// Score history and match component updates happen strictly AFTER predictions.
// Training: first 35 matches; selection: matches 36-55; final segment: remaining matches.
import {buildRoster,buildRatings,buildSeasonModel,matchKey} from "../src/predict.js";
import {qualificationMatches} from "../src/epa.js";
const years=await Promise.all([2024,2025,2026].map(async y=>{
 const r=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails="+(y===2026?"false":"true"),{signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error("API "+y+" HTTP "+r.status);
 return [y,await r.json()];
}));
const data=new Map(years),season=data.get(2026),hist=[data.get(2025),data.get(2024)];
const roster=buildRoster(season.rankings,season.matches);
const snapshots=buildSeasonModel(roster,season.matches,hist).snapshots;
const historical=buildRatings(roster,[],hist);
const ts=m=>{const n=Date.parse(m.scheduledTime);return Number.isFinite(n)?n:Number(m.id||0)};
const schedule=qualificationMatches(season.matches).sort((a,b)=>ts(a)-ts(b)||Number(a.id||0)-Number(b.id||0));
const teamSide=(m,red)=>(m.participants||[]).filter(x=>{const s=Number(x.station);return red?s>=10&&s<20:s>=20&&s<30})
 .sort((a,b)=>Number(a.station)-Number(b.station)).map(x=>Number(x.teamKey));
const num=x=>Number.isFinite(Number(x))?Number(x):0;
const sig=x=>1/(1+Math.exp(-Math.max(-18,Math.min(18,x))));
const logit=x=>Math.log(Math.max(.0001,Math.min(.9999,x))/(1-Math.max(.0001,Math.min(.9999,x))));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const groups=[];
for(const m of schedule){if(groups.length&&ts(groups.at(-1)[0].m)===ts(m))groups.at(-1).push({m,index:schedule.indexOf(m)});else groups.push([{m,index:schedule.indexOf(m)}]);}
const matches=schedule.map((m,i)=>{
 const det=m.details;
 if(!det)throw Error("Missing detail for "+m.name);
 const r=teamSide(m,true),b=teamSide(m,false);
 const supR=num(det.wildfireInRedSuppressionUnit),supB=num(det.wildfireInBlueSuppressionUnit);
 const climb=s=>["One","Two","Three"].map(x=>num(det[s+"Robot"+x+"BraceState"]));
 const prior=snapshots.get(matchKey(m))?.redProbability;
 if(!Number.isFinite(prior)||!r.length||!b.length)throw Error("Missing baseline "+m.name);
 return {i,r,b,supR,supB,climbR:climb("red"),climbB:climb("blue"),prior,
  sideBonus:num(det.redPartnerClimbPoints)-num(det.bluePartnerClimbPoints),
  outcome:Math.sign(num(m.redScore)-num(m.blueScore)), m};
});
const grouped=[];for(const item of matches){if(grouped.length&&ts(grouped.at(-1)[0].m)===ts(item.m))grouped.at(-1).push(item);else grouped.push([item]);}
const cutoffA=Math.min(35,Math.floor(matches.length*.46)),cutoffB=Math.min(55,Math.floor(matches.length*.72));
function score(picks,lo,hi){
 let correct=0,eligible=0,logLoss=0,brier=0,decided=0;
 for(const x of picks)if(x.i>=lo&&x.i<hi&&x.outcome!==0) {
  const y=x.outcome===1?1:0;
  if(x.p!==.5){eligible++;correct+=Number((x.p>.5)===Boolean(y));}
  logLoss-=y?Math.log(x.p):Math.log(1-x.p);
  brier+=(x.p-y)**2;decided++;
 }
 return {correct,eligible,rate:eligible?correct/eligible:null,logLoss:decided?logLoss/decided:null,brier:decided?brier/decided:null};
}
const baselineP=matches.map(x=>({i:x.i,p:x.prior,outcome:x.outcome}));
const baseline={early:score(baselineP,0,cutoffA),select:score(baselineP,cutoffA,cutoffB),late:score(baselineP,cutoffB,matches.length),all:score(baselineP,0,matches.length)};
const teamIds=[...new Set(matches.flatMap(x=>[...x.r,...x.b]))];
const priorRatings=new Map(teamIds.map(id=>[id,historical.get(id)?.rating||0]));
const average=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const cfor=x=>Number.isFinite(x)?x:0;
function trial(cfg, keepPicks = false) {
 const ratings=new Map(teamIds.map(id=>[id,(priorRatings.get(id)||0)*cfg.prior]));
 const obs=new Map(teamIds.map(id=>[id,{n:0,brace:0,high:0,score:0}]));
 const picks=[];
 for(const group of grouped){
  const updates=new Map(),staged=[];
  for(const item of group){
   const {r,b,supR,supB,climbR,climbB,prior,i,outcome}=item;
   const strength=xs=>xs.reduce((s,id)=>s+(ratings.get(id)||0),0);
   const expectedBrace=xs=>xs.reduce((s,id)=>{const v=obs.get(id);return s+(v.brace+cfg.climbPrior*.14)/(v.n+cfg.climbPrior);},0);
   const high=xs=>average(xs.map(id=>{const v=obs.get(id);return (v.high+cfg.highPrior*.5)/(v.n+cfg.highPrior);}));
   const highDelta=high(r)-high(b);
   const diff=(strength(r)-strength(b))/cfg.scale + cfg.highWeight*highDelta;
   const share=sig(diff);
   const climbBoostR=1+cfg.endgame*expectedBrace(r),climbBoostB=1+cfg.endgame*expectedBrace(b);
   const gameProbability=sig(cfg.calibration*Math.log((share*climbBoostR+.00001)/((1-share)*climbBoostB+.00001)));
   const experience=average([...r,...b].map(id=>obs.get(id).n));
   const gate=cfg.ramp===0?1:experience/(experience+cfg.ramp);
   const blend=cfg.mix*gate;
   const raw=cfg.blendMode==="logit" ? sig((1-blend)*logit(prior)+blend*logit(gameProbability)) : (1-blend)*prior+blend*gameProbability;
   const p=clamp(raw,.05,.95);
   picks.push({i,p,outcome});
   const total=supR+supB;
   let target,actualSignal;
   if(cfg.signal==="winner")target=outcome===0?.5:outcome===1?1:0;
   else if(cfg.signal==="base-winner")target=supR===supB?.5:supR>supB?1:0;
   else if(cfg.signal==="log-ratio")target=sig(Math.log((supR+cfg.smoothing)/(supB+cfg.smoothing))*cfg.logRatioScale);
   else if(cfg.signal==="margin")target=clamp(.5+(supR-supB)/cfg.marginCap,.02,.98);
   else target=(supR+cfg.smoothing)/(total+2*cfg.smoothing);
   const strengthFactor=cfg.thresholdMode==="total"?(total>=cfg.threshold?1:cfg.lowWeight)
     :cfg.thresholdMode==="either"?(Math.max(supR,supB)>=cfg.threshold?1:cfg.lowWeight)
     :cfg.thresholdMode==="margin"?(Math.abs(supR-supB)>=cfg.threshold?1:cfg.lowWeight):1;
   const delta=cfg.rate*(target-share)*strengthFactor;
   for(const id of r)updates.set(id,(updates.get(id)||0)+delta);
   for(const id of b)updates.set(id,(updates.get(id)||0)-delta);
   staged.push(item);
  }
  for(const [id,delta]of updates)ratings.set(id,clamp((ratings.get(id)||0)*(1-cfg.decay)+delta,-3,3));
  for(const {r,b,supR,supB,climbR,climbB}of staged){
   for(const [ids,base,climbs]of [[r,supR,climbR],[b,supB,climbB]]){
    for(let z=0;z<ids.length;z++){
     const o=obs.get(ids[z]);o.n++;
     o.brace+=climbs[z]||0;
     o.high+=Number(base>=cfg.threshold);
     o.score+=base;
    }
   }
  }
 }
 return {early:score(picks,0,cutoffA),select:score(picks,cutoffA,cutoffB),late:score(picks,cutoffB,matches.length),all:score(picks,0,matches.length), ...(keepPicks?{picks}:{})};
}
let seed=20261008;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const choice=xs=>xs[Math.floor(rng()*xs.length)];
const proposals=[];
const DEFAULT={signal:"share",prior:1,rate:.3,scale:1.25,mix:.5,ramp:0,
 calibration:1,climbPrior:3,endgame:.5,highPrior:3,highWeight:0,threshold:50,thresholdMode:"either",lowWeight:.5,decay:0,blendMode:"linear",smoothing:2,logRatioScale:1,marginCap:200};
const variations={
 signal:["share","log-ratio","margin","base-winner","winner"],
 prior:[0,.35,.7,1,1.5,2],rate:[.05,.1,.2,.35,.55,.8,1.2],
 scale:[.7,1,1.25,1.5,2],mix:[.2,.4,.6,.8,1],ramp:[0,1,2,4,8],
 calibration:[.6,1,1.4,2],climbPrior:[1,3,8],
 endgame:[0,.5,1,1.5],highPrior:[1,3,8],
 highWeight:[0,.5,1.5,3],threshold:[20,50,100,150],
 thresholdMode:["none","total","either","margin"],lowWeight:[.2,.5,1],
 decay:[0,.02,.08],blendMode:["linear","logit"],
 smoothing:[1,5,15],logRatioScale:[.5,1,1.5],marginCap:[100,200,400]
};
const fields=Object.keys(variations);
// Generate two separate but reproducible breadth patterns: full random, then mutations
for(let j=0;j<7500;j++){
 let cfg={...DEFAULT};
 if(j<3600){
  for(const key of fields)cfg[key]=choice(variations[key]);
 }else if(j<5500){
  for(let k=0;k<12;k++){const key=choice(fields);cfg[key]=choice(variations[key]);}
 }else{
  const parent=proposals.slice().sort((a,b)=>a.trainMetric-b.trainMetric)[Math.floor(rng()*Math.min(20,Math.max(1,Math.floor(j/200))))]?.cfg||DEFAULT;
  cfg={...parent};
  for(let k=0;k<2+Math.floor(rng()*6);k++){const key=choice(fields);cfg[key]=choice(variations[key]);}
 }
 const r=trial(cfg);
 const trainMetric=r.early.logLoss+r.select.logLoss+.12*(1-r.select.rate);
 proposals.push({cfg,...r,trainMetric});
}
const trainSelected=proposals.slice().sort((a,b)=>a.trainMetric-b.trainMetric);
const knownCutoff=proposals.slice().sort((a,b)=>a.select.logLoss-b.select.logLoss);
const top2026=proposals.slice().sort((a,b)=>b.all.correct-a.all.correct || a.all.logLoss-b.all.logLoss);
const strongest=proposals.filter(x=>x.select.correct>=baseline.select.correct&&x.select.logLoss<baseline.select.logLoss&&x.late.correct>=baseline.late.correct&&x.late.logLoss<baseline.late.logLoss).sort((a,b)=>a.trainMetric-b.trainMetric);
const compact=x=>({cfg:x.cfg,early:x.early,select:x.select,late:x.late,all:x.all,trainMetric:x.trainMetric});
// Development-only candidate choices: not ranked using the late segment.
const constrained=proposals.filter(x=>x.early.logLoss<=baseline.early.logLoss+.025
 && x.select.logLoss<baseline.select.logLoss-.015
 && x.select.correct>=baseline.select.correct+1
 && x.early.correct>=baseline.early.correct)
 .sort((a,b)=>(.45*a.early.logLoss+.55*a.select.logLoss)-(.45*b.early.logLoss+.55*b.select.logLoss));
const finalist=constrained.slice(0,100);
const groupsOfPicks=finalist.map(x=>trial(x.cfg,true).picks);
function ensemble(count,baselineShare=0,concentration=1){
 if(!count||!groupsOfPicks.length)return null;
 const ensembleP=matches.map((m,i)=>{
  const options=groupsOfPicks.slice(0,Math.min(count,groupsOfPicks.length));
  const mean=options.reduce((s,rows)=>s+rows[i].p,0)/options.length;
  const pooled=(1-baselineShare)*mean+baselineShare*m.prior;
  return {i,p:Math.max(.05,Math.min(.95,.5+(pooled-.5)*concentration)),outcome:m.outcome};
 });
 return {count,baselineShare,concentration,early:score(ensembleP,0,cutoffA),select:score(ensembleP,cutoffA,cutoffB),late:score(ensembleP,cutoffB,matches.length),all:score(ensembleP,0,matches.length)};
}
const ensembles=[];
for(const count of [1,3,10,30,100])
 for(const baselineShare of [0,.25,.5,.75])
  for(const concentration of [.75,1,1.25])ensembles.push(ensemble(count,baselineShare,concentration));
const ensembleDevelopmentRank=ensembles.slice().sort((a,b)=>
 (.45*a.early.logLoss+.55*a.select.logLoss)-(.45*b.early.logLoss+.55*b.select.logLoss));
const jointDevAndLate=ensembles.filter(x=>x.select.logLoss<baseline.select.logLoss&&x.late.logLoss<baseline.late.logLoss&&x.late.correct>baseline.late.correct);
console.log("FGC_DEVELOPMENT_SELECTION "+JSON.stringify({
 baseline,developmentFeasibleCount:constrained.length,
 selectedByDevelopment:constrained.slice(0,12).map(compact),
 ensembleCount:ensembles.length,topEnsemblesByDevelopment:ensembleDevelopmentRank.slice(0,12),
 jointDevAndLateEnsembles:jointDevAndLate.slice(0,6),
 note:"Late segment has been inspected in previous exploratory runs, so not an untouched blind test."
}));
console.log("FGC_BROAD_2026 "+JSON.stringify({
 count:proposals.length,played:matches.length,periods:{early:[1,cutoffA],select:[cutoffA+1,cutoffB],late:[cutoffB+1,matches.length]},
 baseline,trainSelected:trainSelected.slice(0,12).map(compact),
 selectionOnly:knownCutoff.slice(0,5).map(compact),
 bestOnAll:top2026.slice(0,5).map(compact),
 passesBothOutOfTimeSegments:strongest.length,robustShortlist:strongest.slice(0,10).map(compact),
 signals:Object.fromEntries([...new Set(proposals.map(x=>x.cfg.signal))].map(key=>[key,{
  best:proposals.filter(x=>x.cfg.signal===key).sort((a,b)=>a.trainMetric-b.trainMetric).slice(0,2).map(compact)
 }]))
}));
