import { buildRoster, buildSeasonModel, matchKey } from "../src/predict.js";
import { qualificationMatches } from "../src/epa.js";
import { MODEL_PARAMS } from "../src/model-config.js";

// Read-only analysis. Every prediction is generated using only earlier match results.
async function download(year) {
  const url = "https://api.first.global/v1?year=" + year + "&excludeMatchDetails=true";
  const response = await fetch(url, {headers:{Accept:"application/json"}, signal:AbortSignal.timeout(45000)});
  if (!response.ok) throw new Error(year + " API status " + response.status);
  const data = await response.json();
  if (!Array.isArray(data.matches) || !Array.isArray(data.rankings)) throw new Error(year + " malformed API");
  return { data, roster:buildRoster(data.rankings,data.matches), games:qualificationMatches(data.matches) };
}

function evaluate(year, params, seasons) {
  const s=seasons.get(year);
  const h=[seasons.get(year-1)?.data,seasons.get(year-2)?.data];
  const model=buildSeasonModel(s.roster,s.data.matches,h,params);
  let correct=0, incorrect=0, noPick=0, ties=0, logLoss=0, brier=0, mae=0, scoreCount=0, lateCorrect=0, lateEligible=0;
  const completed=s.games.filter(m=>m.played && Number.isFinite(Number(m.redScore)) && Number.isFinite(Number(m.blueScore))).sort((a,b)=>Date.parse(a.scheduledTime)-Date.parse(b.scheduledTime) || Number(a.id)-Number(b.id));
  const lateIndex=Math.floor(completed.length/2);
  for(let i=0;i<completed.length;i++){
    const match=completed[i];
    const prediction=model.snapshots.get(matchKey(match));
    if(!prediction) throw new Error("missing prediction "+year+" "+match.name);
    if(prediction.projected){
      mae+=Math.abs(Number(match.redScore)-prediction.projected.red)+Math.abs(Number(match.blueScore)-prediction.projected.blue);
      scoreCount+=2;
    }
    const verdict=prediction.verdict;
    if(verdict==="tie"){ties++;continue;}
    const outcome=Number(match.redScore)>Number(match.blueScore)?1:0;
    const prob=prediction.redProbability;
    logLoss-=outcome ? Math.log(prob):Math.log(1-prob);
    brier+=(prob-outcome)**2;
    if(verdict==="no-pick")noPick++;
    else if(verdict==="correct"){correct++;if(i>=lateIndex){lateCorrect++;lateEligible++;}}
    else if(verdict==="incorrect"){incorrect++;if(i>=lateIndex)lateEligible++;}
    else throw new Error("unrecognized verdict "+String(verdict));
  }
  const eligible=correct+incorrect;
  const decided=eligible+noPick;
  return {
    played:completed.length,eligible,correct,incorrect,noPick,ties,
    accuracy:eligible?correct/eligible:null,
    logLoss:decided?logLoss/decided:null,
    brier:decided?brier/decided:null,
    scoreMae:scoreCount?mae/scoreCount:null,
    lateAccuracy:lateEligible?lateCorrect/lateEligible:null,
    lateCorrect,lateEligible,
  };
}

const seasons=new Map();
const loaded=await Promise.all([2022,2023,2024,2025,2026].map(async year=>[year,await download(year)]));
for(const [year,data] of loaded)seasons.set(year,data);
const baseline={...MODEL_PARAMS};
const candidates=[];
for(const onlineRate of [0.32,0.40,0.50,0.65])
  for(const onlineScoreRate of [0,0.05,0.10,0.20])
    for(const onlineMaxAdjustment of [0.35,0.50]){
      const params={...baseline,onlineRate,onlineScoreRate,onlineMaxAdjustment};
      candidates.push({params});
    }
const rows=[];
for(const c of candidates) {
  const yearly={};
  for(const year of [2023,2024,2025,2026])yearly[year]=evaluate(year,c.params,seasons);
  rows.push({...c,yearly});
}
const first=rows.find(r=>r.params.onlineRate===0.32&&r.params.onlineScoreRate===0&&r.params.onlineMaxAdjustment===0.35);
if(!first)throw new Error("baseline not found");
const development=[2023,2024,2025];
const pooled=(r,field)=>development.reduce((sum,year)=>sum+r.yearly[year][field],0);
const b2026=first.yearly[2026];
const bPrevCorrect=pooled(first,"correct"), bPrevEligible=pooled(first,"eligible");
const bPrevAccuracy=bPrevCorrect/bPrevEligible;
const bPrevLoss=development.reduce((acc,year)=>acc+first.yearly[year].logLoss,0)/development.length;
const fmt=(r)=>({
 rate:r.params.onlineRate,scoreRate:r.params.onlineScoreRate,maxAdjustment:r.params.onlineMaxAdjustment,
 current:{correct:r.yearly[2026].correct,eligible:r.yearly[2026].eligible,accuracy:r.yearly[2026].accuracy,
    logLoss:r.yearly[2026].logLoss,brier:r.yearly[2026].brier,mae:r.yearly[2026].scoreMae,
    lateCorrect:r.yearly[2026].lateCorrect,lateEligible:r.yearly[2026].lateEligible,lateAccuracy:r.yearly[2026].lateAccuracy},
 past:{correct:pooled(r,"correct"),eligible:pooled(r,"eligible"),accuracy:pooled(r,"correct")/pooled(r,"eligible"),
    logLoss:development.reduce((acc,y)=>acc+r.yearly[y].logLoss,0)/development.length,
    holdout2025Correct:r.yearly[2025].correct}
});
const better=rows.filter(r=>{
 const current=r.yearly[2026];
 const prevAccuracy=pooled(r,"correct")/pooled(r,"eligible");
 const prevLoss=development.reduce((sum,y)=>sum+r.yearly[y].logLoss,0)/development.length;
 return current.correct>=b2026.correct+1
   && current.accuracy>b2026.accuracy
   && current.logLoss<=b2026.logLoss+0.02
   && current.brier<=b2026.brier+0.015
   && prevAccuracy>=bPrevAccuracy-0.005
   && prevLoss<=bPrevLoss+0.02
   && r.yearly[2025].correct>=first.yearly[2025].correct-2;
}).sort((a,b)=>b.yearly[2026].correct-a.yearly[2026].correct || a.yearly[2026].logLoss-b.yearly[2026].logLoss || a.params.onlineRate-b.params.onlineRate);
const sorted=[...rows].sort((a,b)=>b.yearly[2026].correct-a.yearly[2026].correct || a.yearly[2026].logLoss-b.yearly[2026].logLoss);
console.log("FGC_EXPERIMENT_SUMMARY "+JSON.stringify({
 fetched:Object.fromEntries([...seasons].map(([y,s])=>[y,{total:s.games.length,completed:s.games.filter(m=>m.played).length}])),
 tested:rows.length, baseline:fmt(first),
 bestCurrent:sorted.slice(0,10).map(fmt),
 qualified:better.slice(0,10).map(fmt),
 decision:better.length?"CANDIDATE_FOUND":"NO_SAFE_IMPROVEMENT",
 sampleWarning:b2026.eligible<60?"Fewer than 60 eligible 2026 picks: results are preliminary.":""
}));
