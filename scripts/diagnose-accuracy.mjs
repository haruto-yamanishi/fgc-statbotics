import { buildRoster, buildRatings, buildSeasonModel, predictMatch, matchKey } from "../src/predict.js";
import { qualificationMatches } from "../src/epa.js";
import { MODEL_PARAMS } from "../src/model-config.js";

const years=[2022,2023,2024,2025,2026];
const seasons=new Map(await Promise.all(years.map(async year=>{
 const response=await fetch("https://api.first.global/v1?year="+year+"&excludeMatchDetails=true",{signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw new Error("API "+year+": "+response.status);
 const data=await response.json();
 return [year,{data,roster:buildRoster(data.rankings,data.matches),games:qualificationMatches(data.matches)}];
})));

const mean=arr=>arr.length?arr.reduce((s,x)=>s+x,0)/arr.length:null;
const summarize=(a)=>({n:a.length,correct:a.filter(x=>x.correct).length,rate:mean(a.map(x=>x.correct?1:0)),logLoss:mean(a.map(x=>x.logLoss))});
const sortMatches=arr=>arr.slice().sort((a,b)=>Date.parse(a.scheduledTime)-Date.parse(b.scheduledTime)||Number(a.id||0)-Number(b.id||0));
function matchTime(match){const t=Date.parse(match.scheduledTime);return Number.isFinite(t)?t:Number(match.id||0);}
function participants(match,side){return (match.participants||[]).filter(p=>{const n=Number(p.station);return side==="red"?n>=10&&n<20:n>=20&&n<30;}).map(p=>Number(p.teamKey));}
function tracks(year){
 const season=seasons.get(year), older=[seasons.get(year-1)?.data,seasons.get(year-2)?.data];
 const model=buildSeasonModel(season.roster,season.data.matches,older);
 const plays=new Map(), rows=[];
 const groups=new Map();
 for(const match of sortMatches(season.games)){
  const time=matchTime(match);
  if(!groups.has(time))groups.set(time,[]);
  groups.get(time).push(match);
 }
 for(const group of groups.values()){
  for(const match of group){
   const s=model.snapshots.get(matchKey(match)); if(!s)throw Error("missing prediction");
   const red=participants(match,"red"),blue=participants(match,"blue");
   const ids=[...red,...blue];
   const actual=Math.sign(Number(match.redScore)-Number(match.blueScore));
   const picked=s.redProbability>0.5?1:s.redProbability<0.5?-1:0;
   const decided=actual!==0&&picked!==0;
   const favored=Math.max(s.redProbability,1-s.redProbability);
   const p=s.redProbability,y=actual===1?1:0;
   const firstAppear=ids.filter(id=>(plays.get(id)||0)===0).length;
   const playedBefore=ids.map(id=>plays.get(id)||0);
   rows.push({ match:match.name, redScore:Number(match.redScore),blueScore:Number(match.blueScore),
    actual,picked, decided, correct:decided&&picked===actual, favorite: favored,
    redP:p, margin:Math.abs(Number(match.redScore)-Number(match.blueScore)),
    averageGames:mean(playedBefore),minGames:Math.min(...playedBefore),
    firstAppear,historyCoverage:s.covered,
    logLoss:actual===0?null:-(y*Math.log(p)+(1-y)*Math.log(1-p))});
  }
  for(const match of group)for(const id of [...participants(match,"red"),...participants(match,"blue")])plays.set(id,(plays.get(id)||0)+1);
 }
 return {rows,teamGames:[...plays.values()],teamCount:season.roster.length};
}
function diagnostic(year){
 const {rows,teamGames,teamCount}=tracks(year);
 const eligible=rows.filter(r=>r.decided);
 const bin=(fn)=>[...new Set(rows.map(fn))].sort().map(key=>{
  const selection=rows.filter(r=>fn(r)===key&&r.decided);
  return {key,...summarize(selection)};
 });
 const buckets={
  "50–55":r=>r.favorite<0.55, "55–60":r=>r.favorite>=0.55&&r.favorite<0.6,
  "60–70":r=>r.favorite>=0.6&&r.favorite<0.7, "70–80":r=>r.favorite>=0.7&&r.favorite<0.8,
  "80–100":r=>r.favorite>=0.8
 };
 return {
  played:rows.length,eligible:eligible.length,decided:rows.filter(r=>r.actual!==0).length,teamCount,
  averageAppearances:mean(teamGames),medianAppearances:teamGames.sort((a,b)=>a-b)[Math.floor(teamGames.length/2)],
  totalTeamsAppeared:teamGames.length,totalTeamsWithLe1:teamGames.filter(x=>x<=1).length,
  overall:summarize(eligible),alwaysRed:mean(rows.filter(r=>r.actual!==0).map(r=>r.actual===1?1:0)),
  redBlueMean:[mean(rows.map(r=>r.redScore)),mean(rows.map(r=>r.blueScore))],
  scoreMean:mean(rows.map(r=>(r.redScore+r.blueScore)/2)),
  marginMean:mean(rows.map(r=>r.margin)),
  closeMatchFraction:mean(rows.map(r=>r.margin<=40?1:0)),
  firstHalf:summarize(eligible.filter(r=>rows.indexOf(r)<rows.length/2)),
  secondHalf:summarize(eligible.filter(r=>rows.indexOf(r)>=rows.length/2)),
  confidence:Object.entries(buckets).map(([key,fn])=>({key,...summarize(eligible.filter(fn)),averageConfidence:mean(eligible.filter(fn).map(r=>r.favorite))})),
  firstAppearance:bin(r=>r.firstAppear===0?"no debutants":r.firstAppear<=2?"1–2 debutants":"3+ debutants"),
  experience:bin(r=>r.averageGames<1?"<1":r.averageGames<2?"1–2":r.averageGames<3?"2–3":">=3"),
  biggestUpSets:eligible.filter(r=>!r.correct).sort((a,b)=>b.favorite-a.favorite).slice(0,8).map(r=>({match:r.match,p:r.redP,margin:r.margin,averageGames:r.averageGames}))
 };
}
const out={2024:diagnostic(2024),2025:diagnostic(2025),2026:diagnostic(2026)};
console.log("FGC_DIAGNOSTICS "+JSON.stringify(out));

function eloModel(year, opts){
 const season=seasons.get(year),older=[seasons.get(year-1)?.data,seasons.get(year-2)?.data];
 const prior=buildRatings(season.roster,[],older);
 const ratings=new Map(season.roster.map(t=>[Number(t.teamKey),opts.history?(prior.get(Number(t.teamKey))?.rating??0)*opts.history:0]));
 const groupByTime=new Map();
 for(const match of sortMatches(season.games)){
  const k=matchTime(match);
  if(!groupByTime.has(k))groupByTime.set(k,[]);
  groupByTime.get(k).push(match);
 }
 let correct=0,eligible=0,logs=0,decided=0,brier=0;
 for(const group of groupByTime.values()){
  const changes=new Map();
  for(const match of group){
   const red=participants(match,"red"),blue=participants(match,"blue");
   if(!red.length||!blue.length)continue;
   const sum=xs=>xs.reduce((s,x)=>s+(ratings.get(x)||0),0);
   const p=Math.max(.05,Math.min(.95,1/(1+Math.exp(-(sum(red)-sum(blue))/opts.scale))));
   const outcome=Math.sign(Number(match.redScore)-Number(match.blueScore));
   if(outcome!==0){
    const y=outcome===1?1:0;
    const pick=p>0.5?1:p<0.5?-1:0;
    if(pick){eligible++;if(pick===outcome)correct++;}
    logs-=y*Math.log(p)+(1-y)*Math.log(1-p);
    brier+=(p-y)**2;decided++;
    const delta=opts.k*(y-p);
    for(const k of red)changes.set(k,(changes.get(k)||0)+delta);
    for(const k of blue)changes.set(k,(changes.get(k)||0)-delta);
   }
  }
  for(const [id,delta]of changes)ratings.set(id,Math.max(-2.5,Math.min(2.5,(ratings.get(id)||0)+delta)));
 }
 return {correct,eligible,accuracy:eligible?correct/eligible:null,logLoss:decided?logs/decided:null,brier:decided?brier/decided:null};
}
const experiments=[];
for(const history of [0,0.5,1,1.5]){
 for(const k of [0,0.05,0.1,0.2,0.35,0.5,0.8]){
  const opts={history,k,scale:1.25};
  const results=Object.fromEntries([2024,2025,2026].map(year=>[year,eloModel(year,opts)]));
  experiments.push({opts,results});
 }
}
const sorted=experiments.slice().sort((a,b)=>b.results[2026].correct-a.results[2026].correct||a.results[2026].logLoss-b.results[2026].logLoss);
const bestHistorical=experiments.slice().sort((a,b)=>(a.results[2024].logLoss+a.results[2025].logLoss)-(b.results[2024].logLoss+b.results[2025].logLoss)).slice(0,4);
console.log("FGC_ELO_ABLATIONS "+JSON.stringify({
 total:experiments.length,
 baseline: {2024:summarize(tracks(2024).rows.filter(r=>r.decided)),2025:summarize(tracks(2025).rows.filter(r=>r.decided)),2026:summarize(tracks(2026).rows.filter(r=>r.decided))},
 bestOnPast:bestHistorical,
 bestOn2026:sorted.slice(0,8),
 noHistoryOnline:experiments.filter(x=>x.opts.history===0&&[0,.2,.5].includes(x.opts.k)),
 priorOnly:experiments.filter(x=>x.opts.history===1&&x.opts.k===0)
}));
