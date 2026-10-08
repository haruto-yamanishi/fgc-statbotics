// 2026 scoring forecast from current-season EPA and scoring components.
// The deployed winner model stays unchanged. A representative score pair must
// agree with its displayed win probability and share one path for ranking.
import { qualificationMatches, matchComponents } from "./epa.js";

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const average=values=>values.reduce((s,x)=>s+x,0)/(values.length||1);
function percentile(sorted,q) {
 if(!sorted.length)return 0;
 const n=(sorted.length-1)*q,i=Math.floor(n),j=Math.min(i+1,sorted.length-1);
 return sorted[i]+(sorted[j]-sorted[i])*(n-i);
}
function byTime(a,b) {
 const left=Date.parse(a.scheduledTime),right=Date.parse(b.scheduledTime);
 return (Number.isFinite(left)?left:Infinity)-(Number.isFinite(right)?right:Infinity)
   || Number(a.id||0)-Number(b.id||0);
}
function sideTeams(match,side) {
 const min=side==="red"?10:20,max=min+10;
 return (match.participants||[]).filter(p=>{
  const station=Number(p.station);
  return station>=min&&station<max&&Number(p.noShow)!==1&&Number(p.cardStatus)!==2;
 }).map(p=>Number(p.teamKey)).filter(Number.isFinite);
}
export function build2026ScoreForecaster(matches=[],ratings=new Map()) {
 const played=qualificationMatches(matches).slice().sort(byTime);
 const complete=played.filter(m=>[m.redScore,m.blueScore].every(s=>s!=null&&Number.isFinite(Number(s))));
 if(!complete.length)return {project:()=>null,games:0};
 const totals=complete.map(m=>Number(m.redScore)+Number(m.blueScore));
 const allianceScores=complete.flatMap(m=>[Number(m.redScore),Number(m.blueScore)]);
 const meanAlliance=average(allianceScores);
 const recent=allianceScores.slice(-Math.min(48,allianceScores.length));
 const paceShift=clamp(.2*(average(recent)-meanAlliance),-.2*meanAlliance,.2*meanAlliance);
 const sorted=totals.slice().sort((a,b)=>a-b);
 const lowTotal=Math.max(12,percentile(sorted,.10)*.60);
 const highTotal=Math.max(lowTotal+25,percentile(sorted,.90)*1.30);
 const marginRMS=Math.sqrt(average(complete.map(m=>(Number(m.redScore)-Number(m.blueScore))**2)));
 const marginScale=clamp(marginRMS*Math.sqrt(3)/Math.PI,10,Math.max(15,meanAlliance*.75));
 function contribution(key){
  const m=ratings.get(key)||{};
  const ep=Number.isFinite(m.epa)?m.epa:meanAlliance/3;
  const components=Number.isFinite(m.mainEpa)&&Number.isFinite(m.endgameEpa);
  const brokenDown=components?m.mainEpa+m.endgameEpa:ep;
  return clamp(components?.5*ep+.5*brokenDown:ep,0,Math.max(10,meanAlliance*.85));
 }
 function expectedSide(match,side){
  const ids=sideTeams(match,side);
  return ids.length?ids.reduce((s,id)=>s+contribution(id),0):null;
 }
 function project(match,redProbability){
  if(!Number.isFinite(redProbability))return null;
  const red=expectedSide(match,"red"),blue=expectedSide(match,"blue");
  if(red==null||blue==null)return null;
  const total=Math.round(clamp(red+blue+2*paceShift,lowTotal,highTotal));
  // Whole percentages are shown in the UI. At 50:50, show a level score.
  const shown=clamp(Math.round(redProbability*100)/100,.05,.95);
  if(shown===.5){const level=Math.round(total/2);return {red:level,blue:level};}
  const margin=Math.log(shown/(1-shown))*marginScale;
  const size=clamp(Math.round(Math.abs(margin)),1,Math.max(1,total-2));
  const redPoints=Math.max(0,Math.round((total+Math.sign(margin)*size)/2));
  const bluePoints=Math.max(0,total-redPoints);
  if(shown>.5&&redPoints<=bluePoints)return {red:bluePoints+1,blue:bluePoints};
  if(shown<.5&&bluePoints<=redPoints)return {red:redPoints,blue:redPoints+1};
  return {red:redPoints,blue:bluePoints};
 }
 return {project,games:complete.length,
  componentGames:complete.filter(m=>matchComponents(m,"red")&&matchComponents(m,"blue")).length,
  meanAlliance,marginScale};
}
