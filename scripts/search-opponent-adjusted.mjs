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
const params={
 hist:[0,.25,.5,.75,1,1.5,2], offensePrior:[0,.25,.5,1],
 signal:["log","diff","final","sqrt","winner","share"],
 temperature:[.5,.75,1,1.25,1.75,2.5], offenseTemp:[.75,1.25,2],
 winTemp:[.75,1.25,2], lr:[.03,.07,.15,.3,.55,.9],
 offenseRate:[0,.02,.05,.1,.2,.4],
 winRate:[0,.05,.1,.2,.4],
 contestWeight:[0,.25,.5,.75,1,1.5,2],offenseWeight:[0,.25,.5,1,1.5],
 winWeight:[0,.25,.5,1],endgameWeight:[0,.5,1,1.5,2],
 climbStrength:[0,.5,1,1.5],climbPrior:[1,3,8],
 confidence:[.5,.75,1,1.5],baseMix:[0,.1,.25,.5,.75,1],
 concentration:[.7,1,1.25],mixType:["linear","logit"],
 updateMode:["none","soft","big","cap"],errorClip:[.5,1,2,4],
 targetClip:[.5,1,2,4],clipRating:[1.5,2.5,4],
 scoreNorm:[50,100,200],sqrtNorm:[8,12,20],
 offset:[1,5,15,30],paceRate:[0,.05,.15,.4],decay:[0,.01,.04]
};
const defaults={
 hist:.75,offensePrior:0,signal:"log",temperature:1.25,offenseTemp:1.25,winTemp:1.25,
 lr:.15,offenseRate:.05,winRate:.1,contestWeight:1,offenseWeight:.5,winWeight:.25,endgameWeight:.5,
 climbStrength:1,climbPrior:3,confidence:1,baseMix:.25,concentration:1,mixType:"linear",
 updateMode:"none",errorClip:2,targetClip:2,clipRating:2.5,scoreNorm:100,sqrtNorm:12,offset:5,
 paceRate:.1,decay:0
};
let state=20261008;const rng=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
const one=arr=>arr[Math.floor(rng()*arr.length)];
const fields=Object.keys(params);
const candidates=[];
const quality=r=>.35*r.early.loss+.65*r.mid.loss+.06*(1-r.mid.accuracy);
const count=12000;
for(let i=0;i<count;i++){
 let c={...defaults};
 if(i<3500){for(const field of fields)c[field]=one(params[field]);}
 else if(i<6500){for(let k=0;k<11;k++){const field=one(fields);c[field]=one(params[field]);}}
 else{
  const leaders=candidates.slice().sort((a,b)=>a.cost-b.cost).slice(0,25);
  const parent=leaders[Math.floor(rng()*Math.min(leaders.length,10))];
  c={...parent.c};
  for(let k=0;k<1+Math.floor(rng()*8);k++){const field=one(fields);c[field]=one(params[field]);}
 }
 if(c.contestWeight===0&&c.offenseWeight===0&&c.winWeight===0)continue;
 const r=run(c);
 candidates.push({c,...r,cost:quality(r)});
}
const ranked=candidates.slice().sort((a,b)=>a.cost-b.cost);
const bestAll=candidates.slice().sort((a,b)=>b.overall.correct-a.overall.correct||a.overall.loss-b.overall.loss);
const matched=candidates.filter(c=>c.mid.loss<baseline.mid.loss&&c.mid.correct>=baseline.mid.correct
 &&c.late.correct>baseline.late.correct&&c.late.loss<baseline.late.loss).sort((a,b)=>a.cost-b.cost);
const slim=x=>({params:x.c,early:x.early,mid:x.mid,late:x.late,overall:x.overall,selectionCost:x.cost});
console.log("FGC_NEW_FAMILY "+JSON.stringify({
 trials:candidates.length,played:games.length,baseline,
 bestTraining:ranked.slice(0,7).map(slim),
 bestAllDiagnosticOnly:bestAll.slice(0,5).map(slim),
 selectedModelsPassingLater:matched.length,
 safeCandidates:matched.slice(0,7).map(slim)
}));

const qualify=c=>c.early.loss<=baseline.early.loss+.025
 &&c.mid.correct>=baseline.mid.correct+1
 &&c.mid.loss<baseline.mid.loss;
const developed=candidates.filter(qualify).sort((a,b)=>a.cost-b.cost);
const baselineAcross=baseP.map(x=>({p:x.p,outcome:x.outcome,i:x.i}));
const topDev=developed.slice(0,120);
const diverse=[];
const seen=new Set();
for(const c of topDev){
 const x=run(c.c,true),signature=x.pred.map(z=>z.p.toFixed(4)).join(",");
 if(seen.has(signature))continue;
 seen.add(signature);
 diverse.push({model:c,result:x});
 if(diverse.length>=20)break;
}
function blendEnsemble(k,baselineMix,shrink){
 const selections=diverse.slice(0,k);
 if(!selections.length)return null;
 const predictions=baselineAcross.map((m,i)=>{
  const p=selections.reduce((s,c)=>s+c.result.pred[i].p,0)/selections.length;
  const mix=(1-baselineMix)*p+baselineMix*m.p;
  const adjusted=Math.max(.05,Math.min(.95,.5+(mix-.5)*shrink));
  return {...m,p:adjusted};
 });
 return {size:selections.length,baselineMix,shrink,predictions,
  early:metric(predictions,0,earlyLimit),mid:metric(predictions,earlyLimit,midLimit),
  late:metric(predictions,midLimit,games.length),all:metric(predictions,0,games.length)};
}
const ensembles=[];
for(const k of [1,3,5,10,20])for(const baselineMix of [0,.25,.5])for(const shrink of [.75,1,1.25]){
 const x=blendEnsemble(k,baselineMix,shrink);if(x)ensembles.push(x);
}
function compactEnsemble(x){
 const {predictions,...rest}=x;return rest;
}
const sortedEnsembles=ensembles.sort((a,b)=>.35*a.early.loss+.65*a.mid.loss-(.35*b.early.loss+.65*b.mid.loss));
const selected=sortedEnsembles[0];
const allBest=run(bestAll[0].c,true);
function confidence(rows,lo,hi){
 return [.5,.55,.6,.65,.7,.75,.8,.85].map(t=>{
  const xs=rows.filter(x=>x.i>=lo&&x.i<hi&&x.outcome!==0&&Math.max(x.p,1-x.p)>=t);
  const correct=xs.filter(x=>(x.p>.5?1:-1)===x.outcome).length;
  return {minConfidence:t,predicted:xs.length,correct,coverage:xs.length/Math.max(1,rows.filter(x=>x.i>=lo&&x.i<hi&&x.outcome!==0).length),hitRate:xs.length?correct/xs.length:null};
 });
}
function compared(a,b,lo,hi){
 const left=a.filter(x=>x.i>=lo&&x.i<hi&&x.outcome!==0);
 const right=b.filter(x=>x.i>=lo&&x.i<hi&&x.outcome!==0);
 let both=0,baselineOnly=0,candidateOnly=0,neither=0;
 for(let i=0;i<left.length;i++){
  const baselineHit=(left[i].p>.5?1:-1)===left[i].outcome;
  const candidateHit=(right[i].p>.5?1:-1)===right[i].outcome;
  if(baselineHit&&candidateHit)both++;
  else if(baselineHit)baselineOnly++;
  else if(candidateHit)candidateOnly++;
  else neither++;
 }
 return {both,baselineOnly,candidateOnly,neither};
}
console.log("FGC_ROBUST_CHECK "+JSON.stringify({
 played:games.length,base:baseline,trainEligible:developed.length,
 selectedDevelopmentSingle:developed[0]?{params:developed[0].c,early:developed[0].early,mid:developed[0].mid,late:developed[0].late,overall:developed[0].overall}:null,
 uniqueModelTop120:diverse.length,
 bestDevelopmentEnsembles:sortedEnsembles.slice(0,10).map(compactEnsemble),
 bestOverallDiagnostic:{params:bestAll[0].c,early:allBest.early,mid:allBest.mid,late:allBest.late,overall:allBest.overall},
 confidence:{
  baselineAll:confidence(baselineAcross,0,games.length),
  bestAll:confidence(allBest.pred,0,games.length),
  bestAllLate:confidence(allBest.pred,midLimit,games.length),
  devSelectedAll:selected?confidence(selected.predictions,0,games.length):[],
  devSelectedLate:selected?confidence(selected.predictions,midLimit,games.length):[]
 },
 pairedAll:compared(baselineAcross,allBest.pred,0,games.length),
 pairedLate:compared(baselineAcross,allBest.pred,midLimit,games.length)
}));
