// Validate actual 2026 data without publishing or changing original win forecasts.
import assert from "node:assert/strict";
import {buildRoster,buildSeasonModel,matchKey,predictMatch} from "../src/predict.js";
import {buildOpponentAwareModel} from "../src/opponent-aware.js";
import {build2026ScoreForecaster} from "../src/score-forecast.js";
import {buildTeamMetrics,qualificationMatches} from "../src/epa.js";
import {projectedFinalRankingScores} from "../src/ranking-score.js";

const years=await Promise.all([2024,2025,2026].map(async year=>{
 const url="https://api.first.global/v1?year="+year+"&excludeMatchDetails="+(year===2026?"false":"true");
 const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
 assert.equal(response.status,200,"FGC official API "+year);
 return [year,await response.json()];
}));
const data=new Map(years),season=data.get(2026),history=[data.get(2025),data.get(2024)];
const roster=buildRoster(season.rankings,season.matches);
const previous=buildSeasonModel(roster,season.matches,history);
const winner=buildOpponentAwareModel(roster,season.matches,history,previous.snapshots);
const scoring=build2026ScoreForecaster(season.matches,previous.ratings);
let checked=0,oldMismatch=0,bad=0;
const sample=[];
const predict=(match)=>{
 const pred=predictMatch(match,previous.ratings,previous.scoring);
 if(!pred)return null;
 const p=winner.probability(match,pred.redProbability);
 const forecast=scoring.project(match,p);
 if(!forecast)return {...pred,redProbability:p,projected:null};
 const visible=Math.round(p*100)/100;
 const sign= Math.sign(forecast.red-forecast.blue);
 const expected=visible>.5?1:visible<.5?-1:0;
 assert.equal(sign,expected,"winner mismatch "+match.name);
 checked++;
 if(pred.projected&&Math.sign(pred.projected.red-pred.projected.blue)!==expected)oldMismatch++;
 if(!Number.isInteger(forecast.red)||!Number.isInteger(forecast.blue)||forecast.red<0||forecast.blue<0)bad++;
 if(sample.length<20||[99,155,171,191].includes(Number(match.id)))
  sample.push({match:match.name,probability:p,oldScore:pred.projected,newScore:forecast});
 return {...pred,redProbability:p,projected:forecast};
};
const upcoming=season.matches.filter(m=>!m.played);
const ranking=projectedFinalRankingScores(season.matches,roster.map(x=>x.teamKey),predict);
assert.equal(bad,0);
assert.ok(checked>=50,"Too few live games to verify");
assert.ok([...ranking.values()].some(Number.isFinite),"Missing ranking forecast");
const official=qualificationMatches(season.matches).sort((a,b)=>Date.parse(a.scheduledTime)-Date.parse(b.scheduledTime)||Number(a.id)-Number(b.id));
const train=official.slice(0,Math.min(60,official.length));
const evaluate=official.slice(60,Math.min(90,official.length));
const rosterMetrics=buildTeamMetrics(roster,train,16);
const trainForecast=build2026ScoreForecaster(train,rosterMetrics);
let testMAE=0,legacyMAE=0,n=0;
for(const game of evaluate){
 const guess=trainForecast.project(game,winner.snapshots.get(matchKey(game))?.redProbability);
 const old=previous.snapshots.get(matchKey(game))?.projected;
 if(!guess||!old)continue;
 const actual=[Number(game.redScore),Number(game.blueScore)];
 testMAE+=(Math.abs(guess.red-actual[0])+Math.abs(guess.blue-actual[1]))/2;
 legacyMAE+=(Math.abs(old.red-actual[0])+Math.abs(old.blue-actual[1]))/2;
 n++;
}
console.log("FGC_SCORE_COHERENCE "+JSON.stringify({
 played:official.length,upcoming:upcoming.length,checked,oldScoreWinnerMismatches:oldMismatch,newMismatches:bad,
 scoreModel:{games:scoring.games,componentGames:scoring.componentGames,meanAlliance:scoring.meanAlliance,marginScale:scoring.marginScale},
 rankingCount:ranking.size,scoreValidation60To90:{n,oldMAE:n?legacyMAE/n:null,newMAE:n?testMAE/n:null},
 sample:sample.slice(0,5),importantSamples:sample.filter(s=>[99,155,171,191].some(id=>s.match.endsWith(" "+id)))
}));
