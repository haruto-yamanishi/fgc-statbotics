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

export function projectedOutcome(redPercent, side) {
  if (!["red", "blue"].includes(side) || !Number.isInteger(redPercent) || redPercent < 0 || redPercent > 100) return null;
  if (redPercent === 50) return "even";
  return (side === "red" ? redPercent > 50 : redPercent < 50) ? "win" : "lose";
}

export function teamSide(participants, teamKey) {
  const participant = (participants || []).find((entry) => Number(entry.teamKey) === Number(teamKey));
  const station = Number(participant?.station);
  if (station >= 10 && station < 20) return "red";
  if (station >= 20 && station < 30) return "blue";
  return null;
}

export function teamRecord(matches, teamKey) {
  const record = { wins: 0, losses: 0, ties: 0 };
  for (const match of matches) {
    const outcome = allianceOutcome(match, teamSide(match.participants, teamKey));
    if (outcome === "win") record.wins += 1;
    if (outcome === "lose") record.losses += 1;
    if (outcome === "tie") record.ties += 1;
  }
  return record;
}
