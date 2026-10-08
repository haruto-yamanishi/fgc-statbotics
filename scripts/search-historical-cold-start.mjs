// Search for cold-start quality using country performance from older FGC seasons.
// Search only on 2024/2025, evaluate held-out 2026 first 35 games.
import {buildRoster,buildSeasonModel,matchKey,teamCode} from "../src/predict.js";
import {buildTeamMetrics,qualificationMatches,allianceRows} from "../src/epa.js";

const years=new Map(await Promise.all([2022,2023,2024,2025,2026].map(async y=>{
 const r=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails=true",{signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error("HTTP "+y+" "+r.status);
 return [y,await r.json()];
})));
const std=m=>{
 const numbers=[...m.values()].filter(Number.isFinite);
 const mean=numbers.reduce((s,x)=>s+x,0)/(numbers.length||1);
 const sd=Math.sqrt(numbers.reduce((s,x)=>s+(x-mean)**2,0)/(numbers.length||1))||1;
 return new Map([...m].map(([k,x])=>[k,Number.isFinite(x)?Math.max(-3,Math.min(3,(x-mean)/sd)):null]));
};
function stats(year){
 const d=years.get(year),roster=buildRoster(d.rankings,d.matches);
 const matches=qualificationMatches(d.matches);
 const model=buildTeamMetrics(roster,d.matches,16);
 const ids=new Map(roster.map(t=>[Number(t.teamKey),teamCode(t)]));
 const countryId=new Map(roster.map(t=>[teamCode(t),Number(t.teamKey)]));
 const winners=new Map(roster.map(t=>[Number(t.teamKey),{wins:0,decided:0}]));
 const alliance=new Map(roster.map(t=>[Number(t.teamKey),{score:0,n:0}]));
 for(const m of matches){
  const red=(m.participants||[]).filter(x=>Number(x.station)>=10&&Number(x.station)<20).map(x=>Number(x.teamKey));
  const blue=(m.participants||[]).filter(x=>Number(x.station)>=20&&Number(x.station)<30).map(x=>Number(x.teamKey));
  const win=Math.sign(Number(m.redScore)-Number(m.blueScore));
  for(const [teamKeys,s,side]of [[red,Number(m.redScore),1],[blue,Number(m.blueScore),-1]]){
   for(const k of teamKeys){
    const w=winners.get(k)||{wins:0,decided:0};
    if(win!==0){w.decided++;w.wins+=Number(win===side);}
    winners.set(k,w);
    const a=alliance.get(k)||{score:0,n:0};a.score+=s;a.n++;alliance.set(k,a);
   }
  }
 }
 const features={};
 features.epa=std(new Map(roster.map(t=>[teamCode(t),model.get(Number(t.teamKey))?.epa??null])));
 features.rank=std(new Map(roster.map(t=>[teamCode(t),Number.isFinite(Number(t.rank))&&Number(t.rank)>0?-Number(t.rank):null])));
 features.win=std(new Map(roster.map(t=>[teamCode(t),(()=>{
  const w=winners.get(Number(t.teamKey));
  return w?.decided?(w.wins+2)/(w.decided+4):null;
 })()])));
 features.score=std(new Map(roster.map(t=>[teamCode(t),(()=>{
  const a=alliance.get(Number(t.teamKey));return a?.n?a.score/a.n:null;
 })()])));
 return {roster,matches,features};
}
const seasons=new Map([2023,2024,2025,2026].map(y=>[y,stats(y)]));
const stableTime=m=>Number.isFinite(Date.parse(m.scheduledTime))?Date.parse(m.scheduledTime):Number(m.id||0);
const data=new Map([2024,2025,2026].map(y=>{
 const d=years.get(y),s=seasons.get(y);
 const snap=buildSeasonModel(s.roster,d.matches,[years.get(y-1),years.get(y-2)]).snapshots;
 const matches=s.matches.slice().sort((a,b)=>stableTime(a)-stableTime(b)||Number(a.id||0)-Number(b.id||0)).slice(0,35);
 const games=matches.map(m=>{
  const r=(m.participants||[]).filter(p=>Number(p.station)>=10&&Number(p.station)<20).map(p=>String(p.country||"").toUpperCase());
  const b=(m.participants||[]).filter(p=>Number(p.station)>=20&&Number(p.station)<30).map(p=>String(p.country||"").toUpperCase());
  const base=snap.get(matchKey(m))?.redProbability,win=Math.sign(Number(m.redScore)-Number(m.blueScore));
  if(!Number.isFinite(base)||!r.length||!b.length)throw Error("missing "+y+" "+m.name);
  return {r,b,base,win,name:m.name};
 });
 return [y,games];
}));
const fields=["epa","rank","win","score"];
const sig=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const logit=p=>Math.log(Math.max(.00001,Math.min(.99999,p))/(1-Math.max(.00001,Math.min(.99999,p))));
function evalSeason(y,c) {
 const games=data.get(y);
 const historical=[y-1,y-2,y-3].map(z=>seasons.get(z)?.features||null);
 const ratings=new Map();
 const countrySet=new Set(games.flatMap(g=>[...g.r,...g.b]));
 for(const code of countrySet){
  let total=0,denom=0,previous=null;
  for(let i=0;i<3;i++){
   const h=historical[i];if(!h)continue;
   let sum=0,weight=0;
   for(const f of fields){
    const value=h[f]?.get(code);
    if(!Number.isFinite(value))continue;
    sum+=c[f]*value;weight+=Math.abs(c[f]);
   }
   if(!weight)continue;
   const z=sum/weight;
   if(i===0)previous=z;
   const w=[c.recent,c.older,c.oldest][i];
   total+=w*z;denom+=w;
  }
  ratings.set(code,denom?total/denom:0);
 }
 let correct=0,baseCorrect=0,count=0,logLoss=0,baseLoss=0,uncertain=0;
 const perGame=[];
 for(const g of games){
  const side=arr=>arr.reduce((s,k)=>s+(ratings.get(k)||0),0);
  const diff=(side(g.r)-side(g.b))/c.temperature;
  const priorP=sig(diff);
  let p=c.merge==="linear"?(1-c.blend)*g.base+c.blend*priorP:sig((1-c.blend)*logit(g.base)+c.blend*logit(priorP));
  p=Math.max(.05,Math.min(.95,p));
  if(g.win===0)continue;
  const ywin=g.win>0?1:0;
  correct+=Number((p>.5)===(g.win>0));
  baseCorrect+=Number((g.base>.5)===(g.win>0));
  logLoss-=ywin?Math.log(p):Math.log(1-p);
  baseLoss-=ywin?Math.log(g.base):Math.log(1-g.base);
  count++;
  perGame.push({match:g.name,base:g.base,p,outcome:ywin});
 }
 return {correct,count,accuracy:correct/count,logLoss:logLoss/count,baseCorrect,baseLoss:baseLoss/count,...(c.record?{perGame}:{})};
}
const baseCfg={epa:1,rank:0,win:0,score:0,recent:1,older:.5,oldest:0,temperature:1.25,blend:.5,merge:"linear"};
const baseline=Object.fromEntries([2024,2025,2026].map(y=>[y,evalSeason(y,{...baseCfg,blend:0})]));
let seed=20261008;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};
const options={epa:[0,.25,.5,1,2],rank:[0,.25,.5,1,2],win:[0,.25,.5,1,2],score:[0,.25,.5,1,2],recent:[0,.3,.7,1,1.5],older:[0,.2,.5,1,1.5],oldest:[0,.1,.3,.7,1],temperature:[.5,.75,1,1.25,1.75,2.5,3],blend:[.25,.5,.75,1],merge:["linear","logit"]};
const keys=Object.keys(options),pick=a=>a[Math.floor(rand()*a.length)];
const candidates=[];
const rank=x=>.55*x.test2025.logLoss+.45*x.train2024.logLoss+.09*(1-x.test2025.accuracy);
for(let i=0;i<18000;i++){
 let cfg=i<10000?{...baseCfg}:{...(candidates.slice().sort((a,b)=>a.cost-b.cost)[Math.floor(rand()*Math.min(15,candidates.length))]?.cfg||baseCfg)};
 const alters=i<10000?Math.floor(rand()*11)+1:Math.floor(rand()*4)+1;
 for(let z=0;z<alters;z++){const k=pick(keys);cfg[k]=pick(options[k]);}
 if(fields.every(f=>cfg[f]===0)||[cfg.recent,cfg.older,cfg.oldest].every(x=>x===0))continue;
 const train2024=evalSeason(2024,cfg),test2025=evalSeason(2025,cfg);
 const x={cfg,train2024,test2025};
 x.cost=rank(x);candidates.push(x);
}
candidates.sort((a,b)=>a.cost-b.cost);
const contenders=candidates.slice(0,100).map(x=>({...x,holdout2026:evalSeason(2026,x.cfg)}));
const top2026=candidates.map(x=>({...x,holdout2026:evalSeason(2026,x.cfg)})).sort((a,b)=>b.holdout2026.correct-a.holdout2026.correct||a.holdout2026.logLoss-b.holdout2026.logLoss);
console.log("FGC_COLD_START "+JSON.stringify({
 searched:candidates.length,baseline,
 selectedByPast:contenders.slice(0,10),
 bestOn2026DiagnosticOnly:top2026.slice(0,8),
 anyHistoricalPass:contenders.filter(x=>x.holdout2026.correct>baseline[2026].baseCorrect).length
}));
