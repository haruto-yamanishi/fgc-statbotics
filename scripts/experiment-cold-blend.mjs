// Dynamic mixture diagnostic: blend the old and 2026-specific model by how
// many completed games each participating country has already played.
import {buildRoster,buildSeasonModel,matchKey,teamCode} from "../src/predict.js";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";
import {qualificationMatches} from "../src/epa.js";
const years=new Map(await Promise.all([2023,2024,2025,2026].map(async y=>{
 const r=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails="+(y===2026?"false":"true"),{signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error("API "+y);return [y,await r.json()];
})));
const cur=years.get(2026),roster=buildRoster(cur.rankings,cur.matches);
const hist=[years.get(2025),years.get(2024)];
const old=buildSeasonModel(roster,cur.matches,hist);
const newm=buildOpponentAwareModel(roster,cur.matches,hist,old.snapshots);
const time=m=>Number.isFinite(Date.parse(m.scheduledTime))?Date.parse(m.scheduledTime):Number(m.id||0);
const played=qualificationMatches(cur.matches).sort((a,b)=>time(a)-time(b)||Number(a.id||0)-Number(b.id||0));
const sides=m=>(m.participants||[]).filter(p=>{const n=Number(p.station);return n>=10&&n<30}).map(p=>Number(p.teamKey));
const currentTeamCode=new Map(roster.map(r=>[Number(r.teamKey),teamCode(r)]));
const rankFeatures=new Map();
for(const y of [2023,2024,2025]){
 const ranks=years.get(y).rankings;
 const N=ranks.length;
 rankFeatures.set(y,new Map(ranks.map(r=>{
  const rank=Number(r.rank);
  const z=Number.isFinite(rank)&&rank>0 ? 2*(.5-(rank-1)/(N-1)):0;
  return [teamCode(r),Math.max(-1,Math.min(1,z))];
 })));
}
const sig=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const rows=[];
const appearances=new Map();
for(let i=0;i<played.length;){
 const stamp=time(played[i]),group=[];
 while(i<played.length&&time(played[i])===stamp)group.push(played[i++]);
 for(const m of group){
  const teamIds=sides(m),codes=teamIds.map(k=>currentTeamCode.get(k));
  const counts=teamIds.map(k=>appearances.get(k)||0);
  const n=counts.reduce((sum,x)=>sum+x,0)/counts.length;
  const red=(m.participants||[]).filter(p=>Number(p.station)>=10&&Number(p.station)<20).map(p=>currentTeamCode.get(Number(p.teamKey)));
  const blue=(m.participants||[]).filter(p=>Number(p.station)>=20&&Number(p.station)<30).map(p=>currentTeamCode.get(Number(p.teamKey)));
  const rankDiff=Object.fromEntries([2023,2024,2025].map(y=>{
   const fmap=rankFeatures.get(y),sum=a=>a.reduce((s,x)=>s+(fmap.get(x)||0),0);
   return [y,sum(red)-sum(blue)];
  }));
  rows.push({i:rows.length,m,n,cold:counts.every(x=>x===0),
   old:old.snapshots.get(matchKey(m))?.redProbability,new:newm.snapshots.get(matchKey(m))?.redProbability,
   outcome:Math.sign(Number(m.redScore)-Number(m.blueScore)),rankDiff});
 }
 for(const m of group)for(const id of sides(m))appearances.set(id,(appearances.get(id)||0)+1);
}
function metric(xs,fn,from=0,to=rows.length){
 let n=0,correct=0,loss=0,brier=0;
 for(const r of xs)if(r.i>=from&&r.i<to&&r.outcome!==0){
  const y=r.outcome===1?1:0;
  const p=clamp(fn(r),.05,.95);
  correct+=Number((p>.5)===Boolean(y));n++;
  loss-=y*Math.log(p)+(1-y)*Math.log(1-p);brier+=(p-y)**2;
 }
 return {n,correct,accuracy:n?correct/n:null,loss:n?loss/n:null,brier:n?brier/n:null};
}
const original=metric(rows,x=>x.new);
const oldBase=metric(rows,x=>x.old);
const cold=rows.filter(x=>x.cold),warm=rows.filter(x=>!x.cold);
const reference={
 total:original,old:oldBase,
 coldNew:metric(cold,x=>x.new),coldOld:metric(cold,x=>x.old),
 warmNew:metric(warm,x=>x.new),warmOld:metric(warm,x=>x.old)
};
function predict(r,c){
 const rankLogit=c.rankScale*(c.rank2025*r.rankDiff[2025]+c.rank2024*r.rankDiff[2024]+c.rank2023*r.rankDiff[2023]);
 const priorP=sig(rankLogit);
 const coldP=(1-c.oldPart-c.rankPart)*r.new+c.oldPart*r.old+c.rankPart*priorP;
 const fade=c.gate===0?1:c.gate/(c.gate+r.n);
 return clamp((1-fade)*r.new+fade*coldP,.05,.95);
}
const configs=[];
for(const oldPart of [0,.25,.5,.75,1])
for(const rankPart of [0,.25,.5,.75,1]){
 if(oldPart+rankPart>1)continue;
 for(const gate of [0,.5,1,2,4,8])
 for(const rankScale of [.2,.5,1,2])
 for(const rank2025 of [0,.5,1])
 for(const rank2024 of [0,.5,1])
 for(const rank2023 of [0,.5,1]){
  if(rankPart===0&&(rank2025!==0||rank2024!==0||rank2023!==0))continue;
  const c={oldPart,rankPart,gate,rankScale,rank2025,rank2024,rank2023};
  const fn=x=>predict(x,c);
  const res={c,
   first35:metric(rows,fn,0,35),
   middle:metric(rows,fn,35,55),
   late:metric(rows,fn,55,rows.length),
   full:metric(rows,fn),
   cold:metric(cold,fn),
   warm:metric(warm,fn)
  };
  configs.push(res);
 }
}
const chooseDev=x=>x.first35.loss+.1*(1-x.first35.accuracy);
configs.sort((a,b)=>chooseDev(a)-chooseDev(b));
const selected=configs.filter(x=>x.first35.correct>metric(rows,r=>r.new,0,35).correct).slice(0,50);
const bestFull=configs.slice().sort((a,b)=>b.full.correct-a.full.correct||a.full.loss-b.full.loss);
const brief=x=>({c:x.c,first35:x.first35,middle:x.middle,late:x.late,full:x.full,cold:x.cold});
console.log("FGC_COLD_BLEND "+JSON.stringify({played:rows.length,configs:configs.length,reference,
 selectedFirst35:configs.slice(0,5).map(brief),selectedMoreHits:selected.slice(0,5).map(brief),
 bestFullHindsight:bestFull.slice(0,6).map(brief),
 caveat:"Cold-start settings selected on 2026 results are retrospective; past-year validation previously failed to support such priors."
}));
