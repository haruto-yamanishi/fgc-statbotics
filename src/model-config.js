// Selected by npm run optimize -- --write using 2024 for tuning and 2025 as holdout.
export const MODEL_PARAMS = Object.freeze({
  "epaLambda": 16,
  "historyShrink": 0.5,
  "probabilityScale": 1.25,
  "onlineRate": 0.32,
  "onlineMaxAdjustment": 0.35,
  "paceStrength": 0.7,
  "scoreRatingScale": 1.4,
  "scorePriorAlliances": 2,
  "recentScoreWeight": 0.6
});
