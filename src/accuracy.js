// Aggregates chronological, pre-match predictions, not hindsight projections.
export function predictionAccuracy(snapshots = new Map()) {
  let correct = 0, incorrect = 0, ties = 0, noPick = 0;
  for (const snapshot of snapshots.values()) {
    if (snapshot?.verdict === "correct") correct++;
    else if (snapshot?.verdict === "incorrect") incorrect++;
    else if (snapshot?.verdict === "tie") ties++;
    else if (snapshot?.verdict === "no-pick") noPick++;
  }
  const eligible = correct + incorrect;
  return { correct, incorrect, ties, noPick, eligible,
    rate: eligible ? correct / eligible * 100 : null };
}
