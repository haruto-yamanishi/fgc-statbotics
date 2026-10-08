// Bayesian reliability, learning-rate and uncertainty ablation for FGC 2026.
// No 2026 result is used to predict its own scheduled match group.
// Selection uses matches 1–55 only. Later matches are retrospective diagnostics,
// not a truly untouched holdout (other experiments have inspected them).
import {buildRoster,buildRatings,buildSeasonModel,matchKey} from "../src/predict.js";
import {qualificationMatches} from "../src/epa.js";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";

const data=new Map(await Promise.all([2024,2025,2026].map(async y=>{
 const r=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails="+(y===2026?"false":"true"),
  {signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error("API "+y+" HTTP "+r.status);
 return [y,await r.json()];
})));
const year=data.get(2026),history=[data.get(2025),data.get(2024)];
const roster=buildRoster(year.rankings,year.matches);
const original=buildSeasonModel(roster,year.matches,history);
const deployed=buildOpponentAwareModel(roster,year.matches,history,original.snapshots);
const prior=buildRatings(roster,[],history);
const t=m=>{const x=Date.parse(m.scheduledTime);return Number.isFinite(x)?x:Number(m.id||0)};
const arr=qualificationMatches(year.matches).sort((a,b)=>t(a)-t(b)||Number(a.id||0)-Number(b.id||0));
const sides=(m,red)=>(m.participants||[]).filter(x=>{const n=Number(x.station);return red?n>=10&&n<20:n>=20&&n<30})
 .sort((a,b)=>Number(a.station)-Number(b.station)).map(x=>Number(x.teamKey));
const games=arr.map((m,i)=>({
 i,m,r:sides(m,true),b:sides(m,false),
 sR:Number(m.details?.wildfireInRedSuppressionUnit),sB:Number(m.details?.wildfireInBlueSuppressionUnit),
 outcome:Math.sign(Number(m.redScore)-Number(m.blueScore)),
 reference:deployed.snapshots.get(matchKey(m))?.redProbability,
}));
if(games.some(x=>!Number.isFinite(x.sR)||!Number.isFinite(x.sB)||!Number.isFinite(x.reference)))throw Error("Incomplete game data");
const groupings=[];for(const x of games){
 if(groupings.length&&t(groupings.at(-1)[0].m)===t(x.m))groupings.at(-1).push(x);
 else groupings.push([x]);
}
const ids=[...new Set(games.flatMap(x=>[...x.r,...x.b]))];
const priorById=new Map(ids.map(id=>[id,2*(prior.get(id)?.rating||0)]));
const sig=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const resultMetric=(picks,lo,hi)=>{
 let n=0,eligible=0,correct=0,loss=0,brier=0;
 for(const x of picks){
  if(x.i<lo||x.i>=hi||x.outcome===0)continue;
  n++;
  const y=x.outcome===1?1:0;
  if(x.p!==.5){eligible++;correct+=Number((x.p>.5)===Boolean(y));}
  loss-=y*Math.log(x.p)+(1-y)*Math.log(1-x.p);
  brier+=(x.p-y)**2;
 }
 return {n,eligible,correct,rate:eligible?correct/eligible:null,logLoss:n?loss/n:null,brier:n?brier/n:null};
};
const first=55,second=Math.min(90,games.length),third=games.length;
function summaries(picks){
 return {
  dev:resultMetric(picks,0,first),
  middle:resultMetric(picks,first,second),
  new:resultMetric(picks,second,third),
  full:resultMetric(picks,0,third),
  last20:resultMetric(picks,Math.max(0,third-20),third),
 };
}
const deployedP=games.map(g=>({i:g.i,p:g.reference,outcome:g.outcome}));
const baseline=summaries(deployedP);
function run(c){
 const score=new Map(priorById),win=new Map(priorById);
 const appearance=new Map(ids.map(id=>[id,0]));
 const picks=[];
 for(const group of groupings){
  const changesScore=new Map(),changesWin=new Map();
  function effective(ratings,id){
   const before=priorById.get(id)||0;
   const current=ratings.get(id)||0;
   const n=appearance.get(id)||0;
   const hist=before*Math.exp(-c.priorFade*n);
   const shrink=c.tau===0?1:n/(n+c.tau);
   return hist+(current-before)*shrink;
  }
  const sum=(team,ratings)=>team.reduce((acc,id)=>acc+effective(ratings,id),0);
  for(const x of group){
   const scoreDiff=sum(x.r,score)-sum(x.b,score);
   const winDiff=sum(x.r,win)-sum(x.b,win);
   const offDiff=.5*(x.r.reduce((acc,id)=>acc+(prior.get(id)?.rating||0),0)-
                        x.b.reduce((acc,id)=>acc+(prior.get(id)?.rating||0),0));
   const logOdds=.5*(c.scoreWeight*scoreDiff+.25*offDiff/1.25+c.winWeight*winDiff/2);
   const pp=sig(logOdds);
   const experience=[...x.r,...x.b].reduce((a,id)=>a+(appearance.get(id)||0),0)/6;
   const reliability=c.uncertainty===0?1:(experience+c.minPrior)/(experience+c.minPrior+c.uncertainty);
   const p=clamp(.5+(pp-.5)*1.25*reliability,.05,.95);
   picks.push({i:x.i,p,outcome:x.outcome});
   const signal=clamp((x.sR-x.sB)/50,-4,4);
   const residual=clamp(signal-scoreDiff,-4,4);
   const marginWeight=Math.min(1,Math.abs(signal)/4);
   const d=c.scoreRate*residual*marginWeight;
   const observed=x.outcome===1?1:x.outcome===-1?0:.5;
   const expectedWin=sig(winDiff/2);
   const dw=c.winRate*(observed-expectedWin);
   for(const id of x.r){
    changesScore.set(id,(changesScore.get(id)||0)+d);
    changesWin.set(id,(changesWin.get(id)||0)+dw);
   }
   for(const id of x.b){
    changesScore.set(id,(changesScore.get(id)||0)-d);
    changesWin.set(id,(changesWin.get(id)||0)-dw);
   }
  }
  for(const [id,v]of changesScore)score.set(id,clamp((score.get(id)||0)+v,-4,4));
  for(const [id,v]of changesWin)win.set(id,clamp((win.get(id)||0)+v,-4,4));
  for(const x of group)for(const id of [...x.r,...x.b])appearance.set(id,(appearance.get(id)||0)+1);
 }
 return summaries(picks);
}
const configs=[];
for(const priorFade of [0,.03,.08,.15,.25,.4])
 for(const tau of [0,.5,1,2,4,8])
 for(const uncertainty of [0,.5,1,2,4])
 for(const scoreRate of [.08,.15,.25])
 for(const winRate of [.05,.1,.2])
 for(const winWeight of [.25,.5,.75]){
  const c={priorFade,tau,uncertainty,scoreRate,winRate,winWeight,scoreWeight:.5,minPrior:1};
  const r=run(c);configs.push({c,...r});
 }
const val=x=>x.dev.logLoss+.08*(1-x.dev.rate);
configs.sort((a,b)=>val(a)-val(b));
const eligible=configs.filter(x=>x.dev.correct>=baseline.dev.correct&&x.dev.logLoss<baseline.dev.logLoss).sort((a,b)=>val(a)-val(b));
const sortedAll=configs.slice().sort((a,b)=>b.full.correct-a.full.correct||a.full.logLoss-b.full.logLoss);
function compact(x){return {c:x.c,dev:x.dev,middle:x.middle,new:x.new,full:x.full,last20:x.last20};}
const bestDev=configs[0];
const trend={
 priorFade:[],tau:[],uncertainty:[]
};
for(const key of Object.keys(trend)){
 const values=[...new Set(configs.map(x=>x.c[key]))];
 trend[key]=values.map(value=>{
  const candidates=configs.filter(x=>x.c[key]===value).sort((a,b)=>val(a)-val(b));
  return {value,bestDevelopment:compact(candidates[0])};
 });
}
console.log("FGC_BAYESIAN_ABLATION "+JSON.stringify({
 played:games.length,decided:baseline.full.n,tries:configs.length,
 baseline,baselineParams:{priorFade:0,tau:0,uncertainty:0,scoreRate:.15,winRate:.1,winWeight:.5,scoreWeight:.5},
 selfCheck:compact(configs.find(x=>x.c.priorFade===0&&x.c.tau===0&&x.c.uncertainty===0&&x.c.scoreRate===.15&&x.c.winRate===.1&&x.c.winWeight===.5)),
 developmentBest:compact(bestDev),
 developmentShortlist:eligible.slice(0,12).map(compact),
 hindsightTop:sortedAll.slice(0,8).map(compact),
 devBetterAndMiddleBetter:configs.filter(x=>x.dev.logLoss<baseline.dev.logLoss&&x.middle.logLoss<baseline.middle.logLoss&&x.middle.correct>baseline.middle.correct).length,
 robustAll:eligible.filter(x=>x.full.correct>baseline.full.correct&&x.full.logLoss<baseline.full.logLoss).slice(0,8).map(compact),
 trend,
 disclaimer:"2026 middle and new segments were viewed in earlier investigations; not pristine holdout data."
}));
