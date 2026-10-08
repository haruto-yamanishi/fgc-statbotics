// Online probability calibration / model blending for 2026 FGC.
// This is a true pre-match chronological replay, not stored historical
// predictions. Parameter selection limited to the first 55 games.
import {buildRoster,buildSeasonModel,matchKey} from "../src/predict.js";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";
import {qualificationMatches} from "../src/epa.js";
const data=new Map(await Promise.all([2024,2025,2026].map(async y=>{
 const response=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails="+(y===2026?"false":"true"),{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error("FGC "+y+" "+response.status);
 return [y,await response.json()];
})));
const year=data.get(2026),history=[data.get(2025),data.get(2024)];
const roster=buildRoster(year.rankings,year.matches);
const previous=buildSeasonModel(roster,year.matches,history);
const current=buildOpponentAwareModel(roster,year.matches,history,previous.snapshots);
const time=m=>{const n=Date.parse(m.scheduledTime);return Number.isFinite(n)?n:Number(m.id||0)};
const played=qualificationMatches(year.matches).sort((a,b)=>time(a)-time(b)||Number(a.id||0)-Number(b.id||0));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const logit=p=>Math.log(clamp(p,.00001,.99999)/(1-clamp(p,.00001,.99999)));
const sigmoid=x=>1/(1+Math.exp(-clamp(x,-20,20)));
const games=played.map((m,i)=>({
 i,m,y:Math.sign(Number(m.redScore)-Number(m.blueScore)), 
 old:previous.snapshots.get(matchKey(m))?.redProbability,
 p:current.snapshots.get(matchKey(m))?.redProbability,
}));
if(games.some(x=>!Number.isFinite(x.p)||!Number.isFinite(x.old)))throw Error("Missing forecasts");
const groups=[];for(const x of games){if(groups.length&&time(groups.at(-1)[0].m)===time(x.m))groups.at(-1).push(x);else groups.push([x]);}
const metric=(rows,min,max)=>{
 const list=rows.filter(x=>x.i>=min&&x.i<max&&x.y!==0);
 let hit=0,eligible=0,loss=0,brier=0;
 for(const x of list){
  const target=x.y===1?1:0;
  if(x.pred!==.5){eligible++;hit+=Number((x.pred>.5)===Boolean(target));}
  loss-=target*Math.log(x.pred)+(1-target)*Math.log(1-x.pred);
  brier+=(x.pred-target)**2;
 }
 return {decided:list.length,correct:hit,eligible,rate:eligible?hit/eligible:null,
  logLoss:list.length?loss/list.length:null,brier:list.length?brier/list.length:null};
};
function summaries(rows){
 return {
  dev:metric(rows,0,55),
  middle:metric(rows,55,Math.min(90,rows.length)),
  new:metric(rows,90,rows.length),
  all:metric(rows,0,rows.length),
  last20:metric(rows,Math.max(0,rows.length-20),rows.length)
 };
}
const reference=summaries(games.map(x=>({...x,pred:x.p})));
const old=summaries(games.map(x=>({...x,pred:x.old})));
function run(c){
 let intercept=0,slope=c.initialSlope;
 const output=[];
 let errorPrior=0,weight=0;
 for(const group of groups){
  let biasDelta=0,slopeDelta=0,amount=0;
  for(const x of group){
   const modelLogit=(1-c.blend)*logit(x.old)+c.blend*logit(x.p);
   const adjusted=sigmoid(intercept+slope*modelLogit);
   const alpha=c.ensembleGate; // 0 means pure logistic, 1 means only the raw current model
   const combined=clamp((1-alpha)*adjusted+alpha*x.p,.05,.95);
   output.push({...x,pred:combined});
   if(x.y===0)continue;
   const y=x.y===1?1:0;
   // Proper-score gradient, evaluated after the entire time group.
   const residual=y-adjusted;
   biasDelta+=residual;
   slopeDelta+=residual*modelLogit;
   amount++;
  }
  if(amount>0){
   intercept=(1-c.interceptDecay)*intercept+c.biasLearning*biasDelta/amount;
   slope=1+(slope-1)*(1-c.slopeDecay)+c.slopeLearning*slopeDelta/amount;
   intercept=clamp(intercept,-1,1);slope=clamp(slope,.35,1.8);
  }
 }
 return summaries(output);
}
const candidates=[];
for(const blend of [.5,.7,.85,1])
 for(const initialSlope of [.7,.9,1,1.2])
 for(const biasLearning of [0,.02,.05,.1,.2])
 for(const slopeLearning of [0,.005,.02,.05])
 for(const interceptDecay of [0,.05,.2])
 for(const ensembleGate of [0,.25,.5,1]){
  const cfg={blend,initialSlope,biasLearning,slopeLearning,interceptDecay,
   slopeDecay:interceptDecay,ensembleGate};
  const r=run(cfg);candidates.push({cfg,...r});
 }
const cost=x=>x.dev.logLoss+.1*(1-x.dev.rate);
candidates.sort((a,b)=>cost(a)-cost(b));
const perDev=candidates.filter(x=>x.dev.logLoss<reference.dev.logLoss&&x.dev.correct>=reference.dev.correct)
 .sort((a,b)=>cost(a)-cost(b));
const byAll=candidates.slice().sort((a,b)=>b.all.correct-a.all.correct||a.all.logLoss-b.all.logLoss);
const compact=x=>({params:x.cfg,dev:x.dev,middle:x.middle,new:x.new,all:x.all,last20:x.last20});
console.log("FGC_CALIBRATION "+JSON.stringify({
 tests:candidates.length,played:games.length,reference,old,
 topDevelopment:candidates.slice(0,8).map(compact),
 devImprove:perDev.length,
 selectedFromDevelopment:perDev.slice(0,8).map(compact),
 hindsightBest:byAll.slice(0,6).map(compact),
 chronoMiddleWins:perDev.filter(x=>x.middle.correct>reference.middle.correct&&x.middle.logLoss<reference.middle.logLoss).length,
 caveat:"Only new games beyond 90 are fully unobserved during preceding coefficient experiments."
}));
