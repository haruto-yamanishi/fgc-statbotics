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

export function projectedFinalRankingScores(matches, teamKeys, predict) {
  const scores = new Map(teamKeys.map((key) => [Number(key), completedRankingScores(matches, key)]));
  for (const match of matches) {
    if (!isRankingMatch(match) || match.played) continue;
    const projected = predict(match)?.projected;
    if (!projected) continue;
    for (const participant of match.participants || []) {
      const key = Number(participant.teamKey);
      const entries = scores.get(key);
      if (!entries || !countedRankingParticipant(match, key)) continue;
      const station = Number(participant.station);
      const side = station >= 10 && station < 20 ? "red" : station >= 20 && station < 30 ? "blue" : null;
      if (side && Number.isFinite(projected[side])) entries.push({ score: projected[side], redCard: false });
    }
  }
  return new Map([...scores].map(([key, entries]) => [key, rankingScore(entries)]));
}

export function projectedRankingPositions(scores) {
  const ranked = [...scores]
    .filter(([, score]) => score != null && Number.isFinite(score))
    .map(([key, score]) => [key, Math.round(score * 10) / 10])
    .sort((a, b) => b[1] - a[1]);
  const positions = new Map();
  ranked.forEach(([key, score], index) => {
    positions.set(key, index && score === ranked[index - 1][1] ? positions.get(ranked[index - 1][0]) : index + 1);
  });
  return positions;
}
