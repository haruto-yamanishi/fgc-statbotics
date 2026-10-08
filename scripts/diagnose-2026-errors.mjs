// Diagnose 2026 error modes, without fitting parameters on result data.
import {buildRoster,buildSeasonModel,matchKey} from "../src/predict.js";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";
import {qualificationMatches} from "../src/epa.js";
const data=new Map(await Promise.all([2024,2025,2026].map(async y=>{
 const r=await fetch("https://api.first.global/v1?year="+y+"&excludeMatchDetails="+(y===2026?"false":"true"),{signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error(y+" API "+r.status);return [y,await r.json()];
})));
const current=data.get(2026),roster=buildRoster(current.rankings,current.matches),history=[data.get(2025),data.get(2024)];
const model=buildSeasonModel(roster,current.matches,history);
const prod=buildOpponentAwareModel(roster,current.matches,history,model.snapshots);
const time=m=>Number.isFinite(Date.parse(m.scheduledTime))?Date.parse(m.scheduledTime):Number(m.id||0);
const matches=qualificationMatches(current.matches).sort((a,b)=>time(a)-time(b)||Number(a.id||0)-Number(b.id||0));
const sides=(m,r)=> (m.participants||[]).filter(p=>{const x=Number(p.station);return r?x>=10&&x<20:x>=20&&x<30}).map(p=>Number(p.teamKey));
const countries=new Map(roster.map(row=>[Number(row.teamKey),row.team?.country||row.team?.name||row.teamKey]));
const playCount=new Map();const rows=[];
let n=0;
for(let i=0;i<matches.length;){
 const t=time(matches[i]),group=[];
 while(i<matches.length&&time(matches[i])===t)group.push(matches[i++]);
 for(const m of group){
  const rs=sides(m,true),bs=sides(m,false);
  const all=[...rs,...bs];
  const d=m.details||{};
  const supR=Number(d.wildfireInRedSuppressionUnit),supB=Number(d.wildfireInBlueSuppressionUnit);
  const final=Math.sign(Number(m.redScore)-Number(m.blueScore));
  const baseWin=Math.sign(supR-supB);
  const s=prod.snapshots.get(matchKey(m));
  const base=model.snapshots.get(matchKey(m));
  if(!s||!Number.isFinite(s.redProbability))continue;
  const confidence=Math.max(s.redProbability,1-s.redProbability);
  const pick=s.redProbability>.5?1:s.redProbability<.5?-1:0;
  const actualMargin=Math.abs(Number(m.redScore)-Number(m.blueScore));
  rows.push({
   number:n++,match:m.name,id:m.id,actual:final,pick,correct:final!==0&&pick!==0&&pick===final,
   decided:final!==0&&pick!==0,
   confidence,p:s.redProbability,oldP:base.redProbability,
   redNames:rs.map(x=>countries.get(x)),blueNames:bs.map(x=>countries.get(x)),
   redScore:Number(m.redScore),blueScore:Number(m.blueScore),
   suppressionRed:supR,suppressionBlue:supB,baseWinner:baseWin,
   reversedByEndgame:baseWin!==0&&baseWin!==final, 
   averagePreviousGames:all.reduce((sum,id)=>sum+(playCount.get(id)||0),0)/(all.length||1),
   debutants:all.filter(id=>!playCount.get(id)).length,
   finalMargin:actualMargin
  });
 }
 for(const m of group)for(const id of [...sides(m,true),...sides(m,false)])playCount.set(id,(playCount.get(id)||0)+1);
}
const valid=rows.filter(x=>x.decided);
const round=v=>v==null?null:Math.round(v*1000)/1000;
const stats=a=>({n:a.length,hits:a.filter(r=>r.correct).length,accuracy:a.length?round(a.filter(r=>r.correct).length/a.length):null,
 meanConfidence:a.length?round(a.reduce((s,r)=>s+r.confidence,0)/a.length):null});
const bucket=(name,fn)=>Object.fromEntries(Object.entries(fn).map(([label,check])=>[label,stats(valid.filter(check))]));
const dataOut={
 completed:rows.length,decided:valid.length,overall:stats(valid),
 segments:bucket("period",{"first35":x=>x.number<35,"36-55":x=>x.number>=35&&x.number<55,"56-90":x=>x.number>=55&&x.number<90,"91+":x=>x.number>=90}),
 confidence:bucket("confidence",{"50-55%":x=>x.confidence<.55,"55-60%":x=>x.confidence>=.55&&x.confidence<.6,"60-70%":x=>x.confidence>=.6&&x.confidence<.7,"70-80%":x=>x.confidence>=.7&&x.confidence<.8,"80-100%":x=>x.confidence>=.8}),
 experience:bucket("experience",{"<1":x=>x.averagePreviousGames<1,"1-2":x=>x.averagePreviousGames>=1&&x.averagePreviousGames<2,"2-4":x=>x.averagePreviousGames>=2&&x.averagePreviousGames<4,">=4":x=>x.averagePreviousGames>=4}),
 debutants:bucket("newcomers",{"0":x=>x.debutants===0,"1-2":x=>x.debutants>0&&x.debutants<=2,">=3":x=>x.debutants>=3}),
 close:bucket("margin",{"<=20":x=>x.finalMargin<=20,"21-100":x=>x.finalMargin>20&&x.finalMargin<=100,">100":x=>x.finalMargin>100}),
 endgame:bucket("endgame",{"basicScoreWinnerSame":x=>!x.reversedByEndgame,"endgameReversal":x=>x.reversedByEndgame}),
 side:{redWins:valid.filter(x=>x.actual===1).length,blueWins:valid.filter(x=>x.actual===-1).length,
   predictedRed:valid.filter(x=>x.pick===1).length,predictedBlue:valid.filter(x=>x.pick===-1).length},
 mostConfidentMisses:valid.filter(x=>!x.correct).sort((a,b)=>b.confidence-a.confidence).slice(0,10).map(x=>({
 match:x.match,red:x.redNames,blue:x.blueNames,p:x.p,scores:[x.redScore,x.blueScore],
 suppression:[x.suppressionRed,x.suppressionBlue],avgGames:round(x.averagePreviousGames),debutants:x.debutants
 })),
 disagreements:stats(valid.filter(x=>(x.oldP>.5?1:x.oldP<.5?-1:0)!==x.pick))
};
console.log("FGC_2026_ERROR_MODES "+JSON.stringify(dataOut));
