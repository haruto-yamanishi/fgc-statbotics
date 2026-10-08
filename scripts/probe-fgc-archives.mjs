const out=[];
for(const year of [2017,2018,2019,2020,2021,2022,2023]){
 try{
  const r=await fetch("https://api.first.global/v1?year="+year+"&excludeMatchDetails=true",{signal:AbortSignal.timeout(35000)});
  if(!r.ok){out.push({year,http:r.status});continue;}
  const data=await r.json(),matches=data.matches||[],ranks=data.rankings||[];
  out.push({year,rankings:ranks.length,matches:matches.length,played:matches.filter(m=>m.played).length,
    officialRankingMatches:matches.filter(m=>m.played&&(/qualification|ranking/i.test(m.name||"")||String(m.tournamentKey)==="t2")).length,
    firstName:matches[0]?.name,firstRank:ranks[0]?.rank,countries:new Set(ranks.map(r=>r.team?.country||r.country)).size});
 }catch(error){out.push({year,error:String(error)});}
}
console.log("FGC_ARCHIVES "+JSON.stringify(out));
