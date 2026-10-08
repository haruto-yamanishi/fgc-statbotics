import assert from "node:assert/strict";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";
// New independent algorithm family: online opponent-adjusted score regression.
// Cross-check with historical Statbotics-like pre-match rating snapshots.
// All 2026 game component labels are used AFTER their scheduled match group.
import {buildRoster,buildRatings,buildSeasonModel,matchKey} from "../src/predict.js";
import {qualificationMatches} from "../src/epa.js";

const years=new Map(await Promise.all([2024,2025,2026].map(async year=>{
 const url="https://api.first.global/v1?year="+year+"&excludeMatchDetails="+(year===2026?"false":"true");
 const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error("HTTP "+response.status+" "+year);
 return [year,await response.json()];
})));
const season=years.get(2026),priorSeasons=[years.get(2025),years.get(2024)];
const roster=buildRoster(season.rankings,season.matches);
const base=buildSeasonModel(roster,season.matches,priorSeasons);
const prior=buildRatings(roster,[],priorSeasons);
const time=m=>Number.isFinite(Date.parse(m.scheduledTime))?Date.parse(m.scheduledTime):Number(m.id||0);
const raw=qualificationMatches(season.matches).sort((a,b)=>time(a)-time(b)||Number(a.id||0)-Number(b.id||0));
const sides=(m,red)=>(m.participants||[]).filter(x=>{const station=Number(x.station);return red?station>=10&&station<20:station>=20&&station<30}).sort((a,b)=>Number(a.station)-Number(b.station)).map(x=>Number(x.teamKey));
const num=x=>Number(x)||0;
const games=raw.map((m,i)=>{
 const det=m.details;if(!det)throw Error("missing details "+m.name);
 const red=sides(m,true),blue=sides(m,false);
 const baseP=base.snapshots.get(matchKey(m))?.redProbability;
 if(!Number.isFinite(baseP)||!red.length||!blue.length)throw Error("no pre-match probabilities");
 const climb=(color)=>["One","Two","Three"].map(x=>num(det[color+"Robot"+x+"BraceState"]));
 const match={id:Number(m.id),time:time(m),i,red,blue,
  wildfireRed:num(det.wildfireInRedSuppressionUnit),wildfireBlue:num(det.wildfireInBlueSuppressionUnit),
  scoreRed:num(m.redScore),scoreBlue:num(m.blueScore),climbRed:climb("red"),climbBlue:climb("blue"),
  baseP,outcome:Math.sign(num(m.redScore)-num(m.blueScore))};
 return match;
});
const groups=[];for(const m of games){if(groups.length&&groups.at(-1)[0].time===m.time)groups.at(-1).push(m);else groups.push([m]);}
const priorRatings=new Map(roster.map(t=>[Number(t.teamKey),prior.get(Number(t.teamKey))?.rating||0]));
const sig=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const logit=x=>Math.log(Math.max(0.000001,Math.min(.999999,x))/(1-Math.max(.000001,Math.min(.999999,x))));
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const earlyLimit=35,midLimit=55;
function metric(pred,from,to){
 const list=pred.filter(x=>x.i>=from&&x.i<to&&x.outcome!==0);
 let correct=0,valid=0,loss=0,brier=0;
 for(const x of list){
  const y=x.outcome===1?1:0;
  if(x.p!==.5){correct+=Number((x.p>.5)===Boolean(y));valid++;}
  loss-=y?Math.log(x.p):Math.log(1-x.p);brier+=(x.p-y)**2;
 }
 return {n:list.length,correct,valid,accuracy:valid?correct/valid:null,loss:list.length?loss/list.length:null,brier:list.length?brier/list.length:null};
}
const baseP=games.map(x=>({i:x.i,p:x.baseP,outcome:x.outcome}));
const baseline={early:metric(baseP,0,earlyLimit),mid:metric(baseP,earlyLimit,midLimit),late:metric(baseP,midLimit,games.length),overall:metric(baseP,0,games.length)};
const allIds=new Set(games.flatMap(x=>[...x.red,...x.blue]));
const byId=new Map([...allIds].map(id=>[id,priorRatings.get(id)||0]));
const avg=arr=>arr.reduce((s,v)=>s+v,0)/(arr.length||1);
function run(c, capture = false) {
 const scoreRating=new Map([...allIds].map(id=>[id,c.hist*(byId.get(id)||0)]));
 const winRating=new Map([...allIds].map(id=>[id,c.hist*(byId.get(id)||0)]));
 const wins=new Map([...allIds].map(id=>[id,{n:0,brace:0}]));
 const offense=new Map([...allIds].map(id=>[id,c.offensePrior*c.hist*(byId.get(id)||0)]));
 const pred=[];
 let baselineLevel=Math.log(55+c.offset);
 for(const group of groups){
  const ratingUpdates=new Map(),offUpdates=new Map(),winUpdates=new Map();
  const stage=[];
  for(const x of group){
   const rs=xs=>xs.reduce((s,id)=>s+(scoreRating.get(id)||0),0);
   const rw=xs=>xs.reduce((s,id)=>s+(winRating.get(id)||0),0);
   const ro=xs=>xs.reduce((s,id)=>s+(offense.get(id)||0),0);
   const climb=xs=>xs.reduce((s,id)=>{
    const v=wins.get(id);return s+(v.brace+c.climbPrior*.14)/(v.n+c.climbPrior);
   },0);
   const climbR=climb(x.red),climbB=climb(x.blue);
   const climbLog=Math.log((1+c.climbStrength*climbR)/(1+c.climbStrength*climbB));
   const contest=rs(x.red)-rs(x.blue);
   const offenseLog=ro(x.red)-ro(x.blue);
   const winDiff=rw(x.red)-rw(x.blue);
   const post=gameGroups=>0;
   const mixed=(
    c.contestWeight*contest/c.temperature+
    c.offenseWeight*offenseLog/c.offenseTemp+
    c.winWeight*winDiff/c.winTemp+
    c.endgameWeight*climbLog
   );
   let p=sig(mixed*c.confidence);
   const alpha=c.baseMix;
   p=c.mixType==="linear"?(1-alpha)*p+alpha*x.baseP:sig((1-alpha)*logit(p)+alpha*logit(x.baseP));
   p=clamp(.5+(p-.5)*c.concentration,.05,.95);
   pred.push({i:x.i,p,outcome:x.outcome});
   const outcome=x.outcome===1?1:x.outcome===-1?0:.5;
   const actualLog=Math.log((x.wildfireRed+c.offset)/(x.wildfireBlue+c.offset));
   const center=c.signal==="log"?clamp(actualLog,-c.targetClip,c.targetClip):
       c.signal==="diff"?clamp((x.wildfireRed-x.wildfireBlue)/c.scoreNorm,-c.targetClip,c.targetClip):
       c.signal==="final"?clamp(Math.log((x.scoreRed+c.offset)/(x.scoreBlue+c.offset)),-c.targetClip,c.targetClip):
       c.signal==="sqrt"?clamp((Math.sqrt(x.wildfireRed+1)-Math.sqrt(x.wildfireBlue+1))/c.sqrtNorm,-c.targetClip,c.targetClip):
       c.signal==="winner"?(outcome-.5)*2:
       clamp(2*(x.wildfireRed-x.wildfireBlue)/(x.wildfireRed+x.wildfireBlue+2*c.offset),-c.targetClip,c.targetClip);
   const relative=clamp(center-contest/c.temperature,-c.errorClip,c.errorClip);
   const multiplier=c.updateMode==="soft"?1/(1+Math.abs(center)/c.targetClip):
      c.updateMode==="big"?Math.min(1,Math.abs(center)/c.targetClip):
      c.updateMode==="cap"?Math.min(1,c.scoreNorm/(Math.abs(x.wildfireRed-x.wildfireBlue)+1)):1;
   const d=c.lr*relative*multiplier;
   for(const id of x.red)ratingUpdates.set(id,(ratingUpdates.get(id)||0)+d);
   for(const id of x.blue)ratingUpdates.set(id,(ratingUpdates.get(id)||0)-d);
   // Independent per-alliance scoring model: logarithmic observed suppression volume.
   const yR=Math.log(x.wildfireRed+c.offset),yB=Math.log(x.wildfireBlue+c.offset);
   const effectR=(yR-baselineLevel-ro(x.red)/c.offenseTemp);
   const effectB=(yB-baselineLevel-ro(x.blue)/c.offenseTemp);
   for(const id of x.red)offUpdates.set(id,(offUpdates.get(id)||0)+c.offenseRate*clamp(effectR,-c.errorClip,c.errorClip));
   for(const id of x.blue)offUpdates.set(id,(offUpdates.get(id)||0)+c.offenseRate*clamp(effectB,-c.errorClip,c.errorClip));
   const delWin=c.winRate*((x.outcome===1?1:x.outcome===-1?0:.5)-sig(winDiff/c.winTemp));
   for(const id of x.red)winUpdates.set(id,(winUpdates.get(id)||0)+delWin);
   for(const id of x.blue)winUpdates.set(id,(winUpdates.get(id)||0)-delWin);
   stage.push(x);
  }
  for(const [id,update] of ratingUpdates)scoreRating.set(id,clamp((scoreRating.get(id)||0)*(1-c.decay)+update,-c.clipRating,c.clipRating));
  for(const [id,update] of offUpdates)offense.set(id,clamp((offense.get(id)||0)*(1-c.decay)+update,-c.clipRating,c.clipRating));
  for(const [id,update] of winUpdates)winRating.set(id,clamp((winRating.get(id)||0)*(1-c.decay)+update,-c.clipRating,c.clipRating));
  for(const x of stage){
   const meanLog=(Math.log(x.wildfireRed+c.offset)+Math.log(x.wildfireBlue+c.offset))/2;
   baselineLevel=(1-c.paceRate)*baselineLevel+c.paceRate*meanLog;
   for(const [ids,climbs]of [[x.red,x.climbRed],[x.blue,x.climbBlue]])
    ids.forEach((id,i)=>{const st=wins.get(id);st.n++;st.brace+=climbs[i]||0;});
  }
 }
 return {early:metric(pred,0,earlyLimit),mid:metric(pred,earlyLimit,midLimit),late:metric(pred,midLimit,games.length),overall:metric(pred,0,games.length),...(capture?{pred}:{})};
}


const reference=run({"hist":2,"offensePrior":0.25,"signal":"diff","temperature":1,"offenseTemp":1.25,"winTemp":2,"lr":0.15,"offenseRate":0,"winRate":0.1,"contestWeight":0.5,"offenseWeight":0.25,"winWeight":0.5,"endgameWeight":0,"climbStrength":0.5,"climbPrior":8,"confidence":0.5,"baseMix":0,"concentration":1.25,"mixType":"linear","updateMode":"big","errorClip":4,"targetClip":4,"clipRating":4,"scoreNorm":50,"sqrtNorm":8,"offset":5,"paceRate":0.15,"decay":0},true);
const model=buildOpponentAwareModel(roster,season.matches,priorSeasons,base.snapshots);
let worstError=0;
for(let i=0;i<raw.length;i++){
 const expected=reference.pred[i].p;
 const observed=model.snapshots.get(matchKey(raw[i]));
 assert.ok(observed,"Snapshot missing "+raw[i].name);
 worstError=Math.max(worstError,Math.abs(expected-observed.redProbability));
 assert.ok(Math.abs(expected-observed.redProbability)<1e-10,
   "Prediction drift at "+raw[i].name+": "+expected+" != "+observed.redProbability);
}
const upcoming=season.matches.filter(m=>!m.played&&(m.participants||[]).length>=6).slice(0,8);
for(const next of upcoming){
 const forecast=model.probability(next,0.5);
 assert.ok(Number.isFinite(forecast)&&forecast>0&&forecast<1);
}
console.log("FGC_PRODUCTION_MODEL_VERIFIED "+JSON.stringify({
 played:raw.length,checked:raw.length,
 worstProbabilityError:worstError,upcomingChecked:upcoming.length,
 baseline:baseline.overall,challenger:reference.overall,
 lateBaseline:baseline.late,lateChallenger:reference.late,
 recentBaseline:metric(baseP,Math.max(0,games.length-20),games.length),
 recentChallenger:metric(reference.pred,Math.max(0,games.length-20),games.length)
}));
assert.ok(reference.overall.correct>=baseline.overall.correct+2);
assert.ok(reference.overall.loss<baseline.overall.loss);
