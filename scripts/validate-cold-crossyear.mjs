// Historical-year cross-validation of rankings as a pre-match cold-start prior.
// Select model using 2024 and 2025, assess 2026 afterwards.
// 2019 and 2022 have rankings but not match records; 2023 onwards have matches.
import {buildRoster,buildSeasonModel,matchKey,teamCode} from "../src/predict.js";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";
import {qualificationMatches} from "../src/epa.js";
const years=new Map(await Promise.all([2019,2022,2023,2024,2025,2026].map(async y=>{
 const r=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails="+(y===2026?"false":"true"),{signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error("API "+y+" "+r.status);
 return [y,await r.json()];
})));
const order=m=>Number.isFinite(Date.parse(m.scheduledTime))?Date.parse(m.scheduledTime):Number(m.id||0);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sig=x=>1/(1+Math.exp(-clamp(x,-20,20)));
const rankMaps=new Map();
for(const year of [2019,2022,2023,2024,2025]){
 const rs=years.get(year).rankings,denom=Math.max(1,rs.length-1);
 rankMaps.set(year,new Map(rs.map(r=>[teamCode(r),Number.isFinite(Number(r.rank))&&Number(r.rank)>0?
    clamp(2*(.5-(Number(r.rank)-1)/denom),-1,1):0])));
}
const models=new Map();
for(const yr of [2024,2025,2026]){
 const d=years.get(yr),history=[years.get(yr-1),years.get(yr===2024?2022:yr-2)];
 const roster=buildRoster(d.rankings,d.matches);
 const legacy=buildSeasonModel(roster,d.matches,history);
 const active=yr===2026?buildOpponentAwareModel(roster,d.matches,history,legacy.snapshots):legacy;
 const pcode=new Map(roster.map(r=>[Number(r.teamKey),teamCode(r)]));
 const played=qualificationMatches(d.matches).sort((a,b)=>order(a)-order(b)||Number(a.id||0)-Number(b.id||0));
 const lookback=yr===2024?[2023,2022,2019]:yr===2025?[2024,2023,2022]:[2025,2024,2023];
 const rows=[],counts=new Map();
 for(let j=0;j<played.length;){
  const t=order(played[j]),group=[];
  while(j<played.length&&order(played[j])===t)group.push(played[j++]);
  for(const m of group){
   const keys=(m.participants||[]).filter(p=>{const n=Number(p.station);return n>=10&&n<30;}).map(p=>Number(p.teamKey));
   const red=(m.participants||[]).filter(p=>{const n=Number(p.station);return n>=10&&n<20;}).map(p=>pcode.get(Number(p.teamKey)));
   const blue=(m.participants||[]).filter(p=>{const n=Number(p.station);return n>=20&&n<30;}).map(p=>pcode.get(Number(p.teamKey)));
   const rr=lookback.map(year=>{
    const map=rankMaps.get(year)||new Map();
    const sum=arr=>arr.reduce((s,k)=>s+(map.get(k)||0),0);
    return sum(red)-sum(blue);
   });
   rows.push({
    i:rows.length, y:Math.sign(Number(m.redScore)-Number(m.blueScore)),n:keys.reduce((s,k)=>s+(counts.get(k)||0),0)/(keys.length||1),
    old:legacy.snapshots.get(matchKey(m))?.redProbability,now:active.snapshots.get(matchKey(m))?.redProbability,rr
   });
  }
  for(const m of group)for(const p of m.participants||[]){
   const n=Number(p.station);if(n>=10&&n<30){const k=Number(p.teamKey);counts.set(k,(counts.get(k)||0)+1);}
  }
 }
 if(rows.some(r=>!Number.isFinite(r.old)||!Number.isFinite(r.now)))throw Error("no forecast "+yr);
 models.set(yr,rows);
}
const metric=(rows,fn,first=0,last=rows.length)=>{
 let n=0,correct=0,loss=0;
 for(const r of rows)if(r.i>=first&&r.i<last&&r.y!==0){
  const p=clamp(fn(r),.05,.95),y=r.y===1?1:0;
  n++;correct+=Number((p>.5)===Boolean(y));
  loss-=y*Math.log(p)+(1-y)*Math.log(1-p);
 }
 return {n,correct,rate:n?correct/n:null,loss:n?loss/n:null};
};
const baseline=Object.fromEntries([2024,2025,2026].map(yr=>{
 const rows=models.get(yr);
 return [yr,{early:metric(rows,r=>r.now,0,35),full:metric(rows,r=>r.now)}];
}));
function prior(r,c){
 const logits=c.priorScale*(c.recent*r.rr[0]+c.middle*r.rr[1]+c.oldest*r.rr[2]);
 return sig(logits);
}
function predict(r,c){
 const priorP=prior(r,c),f=c.gate===0?1:c.gate/(c.gate+r.n);
 const w=c.rankWeight*f;
 return (1-w)*r.now+w*priorP;
}
const candidates=[];
for(const recent of [0,.25,.5,1,1.5])
for(const middle of [0,.25,.5,1,1.5])
for(const oldest of [0,.25,.5,1,1.5]){
 if(!(recent+middle+oldest))continue;
 for(const rankWeight of [.25,.5,.75,1])
 for(const gate of [0,.5,1,2,4,8])
 for(const priorScale of [.25,.5,1,1.5,2]){
  const c={recent,middle,oldest,rankWeight,gate,priorScale};
  const results=Object.fromEntries([2024,2025].map(y=>{
   const rows=models.get(y);
   return [y,{early:metric(rows,r=>predict(r,c),0,35),full:metric(rows,r=>predict(r,c))}];
  }));
  // Objective trained without 2026 data: penalize any historical regression.
  const score=(results[2024].early.loss+results[2025].early.loss)/2
    +.10*((1-results[2024].early.rate)+(1-results[2025].early.rate))/2;
  candidates.push({c,score,past:results});
 }
}
candidates.sort((a,b)=>a.score-b.score);
const originalEarly=(baseline[2024].early.loss+baseline[2025].early.loss)/2;
const selected=candidates.slice(0,12).map(x=>({...x,
 holdout2026:{early:metric(models.get(2026),r=>predict(r,x.c),0,35),full:metric(models.get(2026),r=>predict(r,x.c))}
}));
const proven=candidates.filter(x=>x.past[2024].early.correct>=baseline[2024].early.correct
 &&x.past[2025].early.correct>=baseline[2025].early.correct
 &&x.past[2024].early.loss<baseline[2024].early.loss
 &&x.past[2025].early.loss<baseline[2025].early.loss);
const finalists=proven.slice(0,10).map(x=>({...x,
 holdout2026:{early:metric(models.get(2026),r=>predict(r,x.c),0,35),full:metric(models.get(2026),r=>predict(r,x.c))}
}));
console.log("FGC_CROSSYEAR_COLD "+JSON.stringify({
 cases:candidates.length, baseline,
 baselineHistoricalMeanLoss:originalEarly,
 topPast:selected,
 crossYearImprovedBoth:proven.length,
 finalistsBothYears:finalists,
 note:"Cross-year validation is for the ranking-only prior, not full game-specific model; 2026 results were studied during earlier runs."
}));
