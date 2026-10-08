const base="https://api.first.global/v1?year=2026&excludeMatchDetails=false";
const response=await fetch(base,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(60000)});
if(!response.ok)throw new Error("API "+response.status);
const raw=await response.json();
const played=raw.matches.filter(m=>m.played&&m.details);
const keys={};
for(const m of played)for(const [k,v] of Object.entries(m.details)){
 const entry=keys[k]||={nonNull:0,numeric:0,min:Infinity,max:-Infinity,sum:0,samples:[]};
 if(v!=null){entry.nonNull++;let n=Number(v);if(v!==""&&Number.isFinite(n)){entry.numeric++;entry.min=Math.min(entry.min,n);entry.max=Math.max(entry.max,n);entry.sum+=n;}if(entry.samples.length<3&&!entry.samples.includes(v))entry.samples.push(v);}
 keys[k]=entry;
}
console.log("FIELDS "+JSON.stringify({allMatches:raw.matches.length,played:raw.matches.filter(m=>m.played).length,detailsPlayed:played.length,keys:Object.fromEntries(Object.entries(keys).map(([k,x])=>[k,{count:x.nonNull,min:x.min===Infinity?null:x.min,max:x.max===-Infinity?null:x.max,mean:x.numeric?x.sum/x.numeric:null,samples:x.samples}]))}));
console.log("SAMPLES "+JSON.stringify(played.slice(0,3).map(m=>({id:m.id,name:m.name,red:m.redScore,blue:m.blueScore,details:m.details,participant:m.participants?.slice(0,2)}))));
