export function rankMovement(currentRank, previousRank) {
  const current = Number(currentRank);
  const previous = Number(previousRank);
  if (currentRank == null || previousRank == null || !Number.isInteger(current) || !Number.isInteger(previous) || current < 1 || previous < 1) return null;
  return previous - current;
}

export function allianceOutcome(match, side) {
  if (!match?.played || !["red", "blue"].includes(side) || match.redScore == null || match.blueScore == null) return null;
  const red = Number(match.redScore);
  const blue = Number(match.blueScore);
  if (!Number.isFinite(red) || !Number.isFinite(blue)) return null;
  if (red === blue) return "tie";
  return (side === "red" ? red > blue : blue > red) ? "win" : "lose";
}

export function teamRecord(matches, teamKey) {
  const record = { wins: 0, losses: 0, ties: 0 };
  for (const match of matches) {
    const participant = (match.participants || []).find((entry) => Number(entry.teamKey) === Number(teamKey));
    const station = Number(participant?.station);
    const side = station >= 10 && station < 20 ? "red" : station >= 20 && station < 30 ? "blue" : null;
    const outcome = allianceOutcome(match, side);
    if (outcome === "win") record.wins += 1;
    if (outcome === "lose") record.losses += 1;
    if (outcome === "tie") record.ties += 1;
  }
  return record;
}
