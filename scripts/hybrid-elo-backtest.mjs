import { buildRoster, buildRatings, buildSeasonModel, matchKey } from "../src/predict.js";
import { qualificationMatches } from "../src/epa.js";
import { MODEL_PARAMS } from "../src/model-config.js";

const seasons=new Map(await Promise.all([2022,2023,2024,2025,2026].map(async year=>{
 const r=await fetch("https://api.first.global/v1?year="+year+"&excludeMatchDetails=true",{signal:AbortSignal.timeout(45000)});
 if(!r.ok)throw Error("API "+year+" "+r.status);
 const data=await r.json();
 return [year,{data,roster:buildRoster(data.rankings,data.matches),matches:qualificationMatches(data.matches)}];
})));
const ts=m=>{const x=Date.parse(m.scheduledTime);return Number.isFinite(x)?x:Number(m.id||0)};
function teams(m,side){return (m.participants||[]).filter(p=>{const s=Number(p.station);return side==="red"?s>=10&&s<20:s>=20&&s<30}).map(p=>Number(p.teamKey));}
const all=new Map();
for(const year of [2023,2024,2025,2026]){
 const s=seasons.get(year), older=[seasons.get(year-1)?.data,seasons.get(year-2)?.data];
 const baseline=buildSeasonModel(s.roster,s.data.matches,older);
 const historical=buildRatings(s.roster,[],older);
 const matches=s.matches.slice().sort((a,b)=>ts(a)-ts(b)||Number(a.id)-Number(b.id));
 const groups=new Map();
 for(const m of matches){const t=ts(m);if(!groups.has(t))groups.set(t,[]);groups.get(t).push(m);}
 all.set(year,{matches,groups:[...groups.values()],baseline,historical,roster:s.roster});
}
function calc(year,{prior,k,alpha}){
 const d=all.get(year),rates=new Map(d.roster.map(t=>[Number(t.teamKey),(d.historical.get(Number(t.teamKey))?.rating||0)*prior]));
 const picks=[];
 for(const group of d.groups){
  const changes=new Map();
  for(const match of group){
   const red=teams(match,"red"),blue=teams(match,"blue");if(!red.length||!blue.length)continue;
   const diff=red.reduce((a,x)=>a+(rates.get(x)||0),0)-blue.reduce((a,x)=>a+(rates.get(x)||0),0);
   const elo=Math.max(.05,Math.min(.95,1/(1+Math.exp(-diff/1.25))));
   const base=d.baseline.snapshots.get(matchKey(match))?.redProbability;
   if(!Number.isFinite(base))continue;
   const p=(1-alpha)*base+alpha*elo;
   const result=Math.sign(Number(match.redScore)-Number(match.blueScore));
   if(result!==0){
    const y=result===1?1:0;
    picks.push({p,y,correct:(p>0.5)===(y===1),tiePick:p===0.5});
    const delta=k*(y-elo);
    for(const x of red)changes.set(x,(changes.get(x)||0)+delta);
    for(const x of blue)changes.set(x,(changes.get(x)||0)-delta);
   }
  }
  for(const [key,v]of changes)rates.set(key,Math.max(-2.5,Math.min(2.5,(rates.get(key)||0)+v)));
 }
 const usable=picks.filter(p=>!p.tiePick);
 return {correct:usable.filter(p=>p.correct).length, eligible:usable.length,
  accuracy:usable.length?usable.filter(p=>p.correct).length/usable.length:null,
  loss:picks.reduce((s,p)=>s-p.y*Math.log(p.p)-(1-p.y)*Math.log(1-p.p),0)/picks.length,
  brier:picks.reduce((s,p)=>s+(p.p-p.y)**2,0)/picks.length};
}
const cands=[];
for(const prior of [0.5,1,1.5])for(const k of [.1,.2,.35,.5])for(const alpha of [0,.1,.2,.3,.4,.5,.6,.75,1]){
 const config={prior,k,alpha};
 const result=Object.fromEntries([2023,2024,2025,2026].map(y=>[y,calc(y,config)]));
 cands.push({config,result});
}
const base=cands.find(x=>x.config.alpha===0);
function summary(c){return {params:c.config,years:Object.fromEntries([2023,2024,2025,2026].map(y=>[y,{correct:c.result[y].correct,eligible:c.result[y].eligible,accuracy:c.result[y].accuracy,loss:c.result[y].loss}]))};}
const train=c=>[2023,2024,2025].reduce((v,y)=>v+c.result[y].loss,0)/3;
const ordered=cands.slice().sort((a,b)=>train(a)-train(b));
const current=cands.slice().sort((a,b)=>b.result[2026].correct-a.result[2026].correct||a.result[2026].loss-b.result[2026].loss);
const qualified=cands.filter(c=>c.result[2026].correct>base.result[2026].correct&&c.result[2026].loss<=base.result[2026].loss&&c.result[2024].correct>=base.result[2024].correct-3&&c.result[2025].correct>=base.result[2025].correct-3&&train(c)<=train(base)+0.005).sort((a,b)=>train(a)-train(b));
console.log("FGC_HYBRID "+JSON.stringify({
 tested:cands.length,baseline:summary(base),
 bestPast:ordered.slice(0,8).map(c=>({...summary(c),meanTrainingLoss:train(c)})),
 best2026:current.slice(0,8).map(c=>({...summary(c),meanTrainingLoss:train(c)})),
 qualified:qualified.slice(0,8).map(c=>({...summary(c),meanTrainingLoss:train(c)}))
}));
