import { isOfficialMatch } from "./epa.js";

export function isRankingMatch(match) {
  return isOfficialMatch(match) && (/qualification|ranking/i.test(String(match?.name || "")) || String(match?.tournamentKey || "").toLowerCase() === "t2");
}

export function countedRankingParticipant(match, teamKey) {
  const participant = (match?.participants || []).find((entry) => Number(entry.teamKey) === Number(teamKey));
  return participant && Number(participant.noShow) !== 1 && Number(participant.surrogate) !== 1 ? participant : null;
}

export function completedRankingScores(matches, teamKey) {
  const entries = [];
  for (const match of matches || []) {
    if (!isRankingMatch(match) || !match.played) continue;
    const participant = countedRankingParticipant(match, teamKey);
    if (!participant) continue;
    const station = Number(participant.station);
    const side = station >= 10 && station < 20 ? "red" : station >= 20 && station < 30 ? "blue" : null;
    if (!side || match[`${side}Score`] == null || !Number.isFinite(Number(match[`${side}Score`]))) continue;
    const redCard = Number(participant.cardStatus) >= 2 || Number(participant.disqualified) === 1;
    entries.push({ score: redCard ? 0 : Number(match[`${side}Score`]), redCard });
  }
  return entries;
}

export function rankingScore(entries) {
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0].score;
  const droppable = entries.filter((entry) => !entry.redCard);
  const lowest = droppable.length ? Math.min(...droppable.map((entry) => entry.score)) : 0;
  const total = entries.reduce((sum, entry) => sum + entry.score, 0);
  return (total - lowest) / (entries.length - (droppable.length ? 1 : 0));
}
