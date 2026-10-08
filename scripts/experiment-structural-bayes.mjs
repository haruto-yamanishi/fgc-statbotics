// 2026 independent structural experiments: online Bayesian skill inference, offensive
// scoring ability, endgame scouting, recency, and experience-weighted ensembles.
// All features update after an entire same-scheduled-time group; never from the target game.
import {buildRoster,buildRatings,buildSeasonModel,matchKey} from "../src/predict.js";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";
import {qualificationMatches} from "../src/epa.js";

const years=new Map(await Promise.all([2024,2025,2026].map(async y=>{
 const r=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails="+(y===2026?"false":"true"),{signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error(y+" API "+r.status);return [y,await r.json()];
})));
const season=years.get(2026),historical=[years.get(2025),years.get(2024)];
const roster=buildRoster(season.rankings,season.matches);
const legacy=buildSeasonModel(roster,season.matches,historical);
const baseline=buildOpponentAwareModel(roster,season.matches,historical,legacy.snapshots);
const priorRating=buildRatings(roster,[],historical);
const parseTime=m=>Number.isFinite(Date.parse(m.scheduledTime))?Date.parse(m.scheduledTime):Number(m.id||0);
const keys=(m,red)=>(m.participants||[]).filter(p=>{const n=Number(p.station);return red?n>=10&&n<20:n>=20&&n<30;}).sort((a,b)=>Number(a.station)-Number(b.station)).map(x=>Number(x.teamKey));
const scheduled=qualificationMatches(season.matches).sort((a,b)=>parseTime(a)-parseTime(b)||Number(a.id||0)-Number(b.id||0));
const games=scheduled.map((m,i)=>{
 const r=keys(m,true),b=keys(m,false),d=m.details||{};
 const sr=Number(d.wildfireInRedSuppressionUnit),sb=Number(d.wildfireInBlueSuppressionUnit);
 const climbR=["One","Two","Three"].map(s=>Number(d["redRobot"+s+"BraceState"]||0));
 const climbB=["One","Two","Three"].map(s=>Number(d["blueRobot"+s+"BraceState"]||0));
 const pb=baseline.snapshots.get(matchKey(m))?.redProbability,po=legacy.snapshots.get(matchKey(m))?.redProbability;
 if(!Number.isFinite(sr)||!Number.isFinite(sb)||!Number.isFinite(pb)||!r.length||!b.length)throw Error("Missing "+m.name);
 return {i,m,red:r,blue:b,sr,sb,climbR,climbB,y:Math.sign(Number(m.redScore)-Number(m.blueScore)),baseline:pb,legacy:po};
});
const groups=[];for(const game of games)if(groups.length&&parseTime(groups.at(-1)[0].m)===parseTime(game.m))groups.at(-1).push(game);else groups.push([game]);
const IDs=[...new Set(games.flatMap(g=>[...g.red,...g.blue]))];
const prior=new Map(IDs.map(id=>[id,Number(priorRating.get(id)?.rating||0)]));
const sig=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const logit=p=>Math.log(clamp(p,1e-5,1-1e-5)/(1-clamp(p,1e-5,1-1e-5)));
function metric(rows,from,to){
 let n=0,correct=0,eligible=0,loss=0,brier=0;
 for(const z of rows)if(z.i>=from&&z.i<to&&z.y!==0){
  const y=z.y===1?1:0;n++;
  if(z.p!==.5){eligible++;correct+=Number((z.p>.5)===Boolean(y));}
  loss-=y*Math.log(z.p)+(1-y)*Math.log(1-z.p);
  brier+=(z.p-y)**2;
 }
 return {n,correct,eligible,accuracy:eligible?correct/eligible:null,logLoss:n?loss/n:null,brier:n?brier/n:null};
}
const regions=(rows)=>{
 const length=rows.length;
 return {
  dev:metric(rows,0,55),mid:metric(rows,55,Math.min(90,length)),
  latest:metric(rows,Math.min(90,length),length),
  last20:metric(rows,Math.max(0,length-20),length),
  full:metric(rows,0,length)
 };
};
const baselineP=games.map(g=>({i:g.i,y:g.y,p:g.baseline}));
const oldP=games.map(g=>({i:g.i,y:g.y,p:g.legacy}));
const reference=regions(baselineP),old=regions(oldP);
function predictor(cfg) {
 const means=new Map(IDs.map(id=>[id,cfg.history*(prior.get(id)||0)]));
 const variances=new Map(IDs.map(id=>[id,cfg.priorVar]));
 const offense=new Map(IDs.map(id=>[id,0]));
 const win=new Map(IDs.map(id=>[id,0]));
 const climb=new Map(IDs.map(id=>[id,{n:0,sum:0}]));
 const appearances=new Map(IDs.map(id=>[id,0]));
 const picks=[];
 const s=(ids,ratings)=>ids.reduce((total,id)=>total+(ratings.get(id)||0),0);
 const exClimb=ids=>ids.reduce((t,id)=>{
  const r=climb.get(id);return t+(r.sum+cfg.climbPrior*.14)/(r.n+cfg.climbPrior);
 },0);
 for(const group of groups){
  const scoreDelta=new Map(),winDelta=new Map(),offDelta=new Map(),varianceDeltas=new Map(),staged=[];
  for(const g of group){
   const mainDiff=s(g.red,means)-s(g.blue,means);
   const winDiff=s(g.red,win)-s(g.blue,win);
   const offenseDiff=s(g.red,offense)-s(g.blue,offense);
   const climbDelta=exClimb(g.red)-exClimb(g.blue);
   const gameLogit=cfg.mainWeight*mainDiff+cfg.offWeight*offenseDiff+cfg.winWeight*winDiff+cfg.climbWeight*climbDelta;
   const experience=[...g.red,...g.blue].reduce((t,id)=>t+(appearances.get(id)||0),0)/6;
   const modelGate=cfg.gate===0?cfg.mix:cfg.mix*(experience+cfg.gatePrior)/(experience+cfg.gatePrior+cfg.gate);
   const intrinsic=sig(cfg.temperature*gameLogit);
   let p=(1-modelGate)*g.baseline+modelGate*intrinsic;
   if(cfg.blendMode==="logit")p=sig((1-modelGate)*logit(g.baseline)+modelGate*logit(intrinsic));
   const pAdjusted=clamp(.5+(p-.5)*cfg.confidence,.05,.95);
   picks.push({i:g.i,y:g.y,p:pAdjusted});
   const signal=cfg.label==="log"?Math.log((g.sr+cfg.offset)/(g.sb+cfg.offset)):
    cfg.label==="share"?2*(g.sr-g.sb)/(g.sr+g.sb+2*cfg.offset):
    cfg.label==="win"?g.y:
    cfg.label==="final"?Math.log((g.m.redScore+cfg.offset)/(g.m.blueScore+cfg.offset)):
    (g.sr-g.sb)/cfg.norm;
   const obs=clamp(signal,-cfg.labelClip,cfg.labelClip);
   // Online diagonal-Gaussian Bayesian update. The same residual is distributed
   // among the six partner/opponent countries in inverse proportion to noise,
   // with a posterior variance update. Legacy Elo is NOT used as the target.
   const involved=[...g.red,...g.blue], noise=cfg.noise;
   const priorDenom=noise+involved.reduce((total,id)=>total+(variances.get(id)||0),0);
   const prediction=mainDiff;
   const residual=clamp(obs-prediction,-cfg.errorClip,cfg.errorClip);
   const factor=cfg.updater==="bayes" ? cfg.lr/Math.max(priorDenom,.01) : cfg.lr/6;
   for(const id of g.red){
    const v=variances.get(id)||0;
    const delta=factor*(cfg.updater==="bayes"?v:1)*residual;
    scoreDelta.set(id,(scoreDelta.get(id)||0)+delta);
    if(cfg.updater==="bayes")varianceDeltas.set(id,(varianceDeltas.get(id)||0)+v*v/Math.max(priorDenom,.01));
   }
   for(const id of g.blue){
    const v=variances.get(id)||0;
    const delta=-factor*(cfg.updater==="bayes"?v:1)*residual;
    scoreDelta.set(id,(scoreDelta.get(id)||0)+delta);
    if(cfg.updater==="bayes")varianceDeltas.set(id,(varianceDeltas.get(id)||0)+v*v/Math.max(priorDenom,.01));
   }
   const targetWin=g.y===1?1:g.y===-1?0:.5;
   const wr=cfg.winRate*(targetWin-sig(winDiff));
   for(const id of g.red)winDelta.set(id,(winDelta.get(id)||0)+wr);
   for(const id of g.blue)winDelta.set(id,(winDelta.get(id)||0)-wr);
   // Independent suppression scoring, each alliance evaluated against the
   // running offense expectation of its three partners.
   for(const [ids,score]of [[g.red,g.sr],[g.blue,g.sb]]){
    const transformed=cfg.offMode==="log"?Math.log(score+cfg.offset):Math.sqrt(score+1);
    const expectation=cfg.offMode==="log"?Math.log(cfg.offset+35):Math.sqrt(36);
    const err=clamp((transformed-expectation-s(ids,offense)), -cfg.errorClip,cfg.errorClip);
    for(const id of ids)offDelta.set(id,(offDelta.get(id)||0)+cfg.offRate*err/3);
   }
   staged.push(g);
  }
  for(const [id,d]of scoreDelta)means.set(id,clamp((means.get(id)||0)*(1-cfg.decay)+d,-cfg.ratingClip,cfg.ratingClip));
  for(const [id,d]of winDelta)win.set(id,clamp((win.get(id)||0)+d,-cfg.ratingClip,cfg.ratingClip));
  for(const [id,d]of offDelta)offense.set(id,clamp((offense.get(id)||0)+d,-cfg.ratingClip,cfg.ratingClip));
  for(const [id,d]of varianceDeltas)variances.set(id,Math.max(.02,(variances.get(id)||0)-d));
  for(const g of staged){
    for(const [ids,braces]of [[g.red,g.climbR],[g.blue,g.climbB]]){
     ids.forEach((id,j)=>{const o=climb.get(id);o.n++;o.sum+=braces[j];appearances.set(id,(appearances.get(id)||0)+1)});
    }
  }
 }
 return regions(picks);
}
const DEFAULT={history:2,priorVar:1,noise:4,lr:1,label:"log",offset:5,norm:100,
 labelClip:3,errorClip:3,updater:"bayes",mainWeight:.4,offWeight:0,winWeight:0,climbWeight:0,
 offRate:0,winRate:0,offMode:"log",climbPrior:3,gate:0,gatePrior:1,mix:.5,blendMode:"linear",
 temperature:1,confidence:1,decay:0,ratingClip:4};
const OPTIONS={history:[0,.5,1,1.5,2],priorVar:[.25,1,2,4],noise:[1,3,6,12,30],
 lr:[.25,.5,1,2,3],label:["log","share","win","final","diff"],offset:[1,5,15],
 norm:[50,100,200],labelClip:[1,2,4],errorClip:[1,2,4],updater:["bayes","sgd"],
 mainWeight:[0,.2,.4,.7,1,1.5],offWeight:[0,.2,.5,1],winWeight:[0,.25,.5,1],
 climbWeight:[0,.5,1,2],offRate:[0,.05,.15,.3],winRate:[0,.05,.1,.2],
 offMode:["log","sqrt"],climbPrior:[1,3,8],gate:[0,1,3,6],gatePrior:[.5,1,3],
 mix:[.25,.5,.75,1],blendMode:["linear","logit"],temperature:[.5,1,1.5],confidence:[.8,1,1.2],
 decay:[0,.01,.04],ratingClip:[2,4]};
const optionKeys=Object.keys(OPTIONS);
let seed=20261008;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const choose=xs=>xs[Math.floor(rng()*xs.length)];
const experiments=[];
let leaders=[];
const metricCost=x=>x.dev.logLoss+.07*(1-x.dev.accuracy);
for(let trial=0;trial<7000;trial++){
 let c={...DEFAULT};
 if(trial<2200){for(const key of optionKeys)c[key]=choose(OPTIONS[key]);}
 else if(trial<3500){for(let z=0;z<10;z++){const k=choose(optionKeys);c[k]=choose(OPTIONS[k]);}}
 else{
  const parent=choose(leaders)?.c||DEFAULT;c={...parent};
  for(let z=0;z<1+Math.floor(rng()*7);z++){const key=choose(optionKeys);c[key]=choose(OPTIONS[key]);}
 }
 if(!c.mainWeight&&!c.offWeight&&!c.winWeight&&!c.climbWeight)continue;
 const r=predictor(c);
 const x={c,...r,cost:metricCost(r)};
 experiments.push(x);
 if(trial%100===0)leaders=experiments.slice().sort((a,b)=>a.cost-b.cost).slice(0,20);
}
experiments.sort((a,b)=>a.cost-b.cost);
const checked=experiments.slice().sort((a,b)=>b.full.correct-a.full.correct||a.full.logLoss-b.full.logLoss);
const selected=experiments.filter(x=>x.dev.correct>=reference.dev.correct&&x.dev.logLoss<reference.dev.logLoss)
 .sort((a,b)=>a.cost-b.cost);
const winners=selected.filter(x=>x.mid.correct>reference.mid.correct&&x.mid.logLoss<reference.mid.logLoss).sort((a,b)=>a.cost-b.cost);
const passes=selected.filter(x=>x.full.correct>reference.full.correct&&x.full.logLoss<reference.full.logLoss).sort((a,b)=>a.cost-b.cost);
const brief=x=>({c:x.c,dev:x.dev,mid:x.mid,latest:x.latest,last20:x.last20,full:x.full});
console.log("FGC_STRUCTURAL_BAYES "+JSON.stringify({
 count:experiments.length,played:games.length,reference,legacy:regions(oldP),
 bestDevelopment:experiments.slice(0,7).map(brief),
 allBestRetrospective:checked.slice(0,7).map(brief),
 selectedCount:selected.length,eligibleMiddleWins:winners.length,devPlusMiddle:winners.slice(0,6).map(brief),
 selectedAndFullBetter:passes.length,selectedFullBetter:passes.slice(0,5).map(brief),
 caveat:"All late data has been inspected in earlier research; results are retrospective and not a fresh holdout."
}));
