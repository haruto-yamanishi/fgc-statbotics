// Aggregates chronological, pre-match predictions, not hindsight projections.
// The Map insertion order follows the scheduled match order in buildSeasonModel.
// Slice completed games FIRST; exclude ties and 50:50 picks from the denominator AFTERWARD.
export const ACCURACY_WINDOW_MATCHES = 10;

export function predictionAccuracy(snapshots = new Map(), lastMatches = Infinity) {
  const recent = Array.from(snapshots.values()).slice(-lastMatches);
  let correct = 0, incorrect = 0, ties = 0, noPick = 0;
  for (const snapshot of recent) {
    if (snapshot?.verdict === "correct") correct++;
    else if (snapshot?.verdict === "incorrect") incorrect++;
    else if (snapshot?.verdict === "tie") ties++;
    else if (snapshot?.verdict === "no-pick") noPick++;
  }
  const eligible = correct + incorrect;
  return { correct, incorrect, ties, noPick, eligible,
    rate: eligible ? correct / eligible * 100 : null };
}
