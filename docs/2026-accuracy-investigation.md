# 2026 FGC Stats prediction accuracy research log (2026-10-08)

## Goal

Target 80% out-of-time **all-match** winner prediction accuracy. An 80% success rate on only high-confidence selections is a separate *selective prediction* metric and must always state coverage.

All trials are chronological pre-match replays based on FIRST Global's public API. No target-match or later score is used in its own prediction, and simultaneous scheduled matches are grouped.

## Baseline and best retrospective models

At 84 completed official ranking matches (83 non-ties):

| Metric | Production baseline | Best opponent-adjusted **in-sample** |
| --- | ---: | ---: |
| All decided matches | 53/83 = 63.9% | 59/83 = 71.1% |
| Log Loss, lower is better | 0.620 | 0.610 |
| First 35 matches (34 non-ties) | 20/34 = 58.8% | 20/34 = 58.8% |
| Matches 36–55 | 15/20 = 75% | 18/20 = 90% |
| Matches 56–84 | 18/29 = 62.1% | 21/29 = 72.4% |

These comparisons are retrospective and the best parameter vector was **selected after viewing all 83 outcomes**; it is not an honest estimate of future performance.

Experiment: `scripts/search-opponent-adjusted.mjs`. About 11,938 parameter sets were evaluated. Independent factors include opponent-adjusted score difference, per-team offensive output, Bradley–Terry/Elo-style win evidence, climbing, historical priors, calibration, decay, and blending.

## Time-ordered selection

The best candidate chosen using only matches 1–55 returned **54/83** over the 83 decided matches. Its final segment was **18/29**, tied with baseline **18/29**, and log loss on that segment worsened from 0.674 to 0.700. Ensembles selected only on matches 1–55 did not demonstrate a reliable final-period gain.

A 71.1% result therefore cannot yet justify automatically replacing production parameters. The test segments were additionally consulted during earlier research; they should not be called untouched blind holdouts.

## Selective prediction

The retrospective top-scoring model is correct **16/17 = 94.1%** when predicted favored-side win probability is >=75%, at **17/83 = 20.5% coverage**. For baseline, the corresponding numbers are **15/17 = 88.2%**. Restricting predictions to confident cases is **not** the 80% all-match target.

## Early-season cold start: main bottleneck

At start of 2026 there are ~185 participating countries but few games per team. A first-35-match hit rate of 20/34 makes 80% aggregate accuracy difficult.

The public API returns rankings but no match-level records for 2017, 2018, 2019, or 2022. It has no 2020–21 season records. Historical match results start in 2023. Data: `scripts/probe-fgc-archives.mjs`.

Cold-start priors combine previous years' standardized EPA, ranking, win rate, and total alliance score (`scripts/search-historical-cold-start.mjs`), tested against 2024 and 2025 early games before checking 2026.

A prior chosen using earlier seasons improved the 2026 first-35 result only from **20/34** to **21/34**, with **worse log loss (0.667 vs 0.637)** after adding 2019 and 2022 rankings. Parameters chosen directly on 2026 could reach 27–28/34 (roughly 79–82%), but in 2025 they performed much worse than baseline. This is overfitting, **not validated 80% accuracy**.

## What to test next

1. Freeze challenger predictions for future unplayed matches *before their results arrive*. Preserve the exact model version and API snapshot hash. Compare against baseline on exactly the same matches, including log loss and Brier.
2. Collect reliable pre-match (not post-match) team-specific scouting signals if available: prior FGC team continuity, robot readiness, matches played that day, known no-shows or penalties. Do not use after-match observations as if known before a match.
3. Add uncertainty-aware, per-team Bayesian shrinkage and opponent strength-adjusted score estimation, then evaluate on each successive incoming block of 20–30 matches.
4. Keep a separate high-confidence-pick accuracy and coverage number; do not mix it with overall winner accuracy.
5. Require positive paired out-of-time accuracy and no worsening in log loss before merging into `main`.

**Production status:** no changes to `main`. These experiments only live on `experiment/fgc-2026-live-weight`.


## 2026-10-08 follow-up: Bayesian and online-calibration ablations

### Bayesian shrinkage and team-experience uncertainty

Script: \`scripts/experiment-bayesian-2026.mjs\`. 4,860 independent configurations applied per-team match-count dependent shrinkage of learned deviations, exponential fading of the multi-year prior, and uncertainty contraction of favored-side probability, plus tweaks to online score and winner update rates. Same-scheduled-time match results are only applied **after** all predictions in the group.

Live dataset sampled at 92 played ranking matches (91 decisive):

| Parameter-selection criterion | Accuracy | Log Loss |
|---|---:|---:|
| Production 2026 winner model | 64/91 = 70.3% | 0.6112 |
| Best first-55 development candidate | 64/91 = 70.3% | 0.6129 |

Development segment (first 55, 54 decisive): production 38/54 and candidate 38/54. Middle (matches 56–90, 35 decisive): production 24/35 and candidate 24/35, but the candidate log loss worsened from 0.6665 to 0.6767. Only two decisive matches were newly observed beyond match 90. **No independent improvement validated.** Shrinking the learned score differences too strongly often worsens results; model is already partially regularized through its historical priors and capped updates.

Actions run: https://github.com/haruto-yamanishi/fgc-statbotics/actions/runs/37743892557

### Online log-odds calibration and bias correction

Script: \`scripts/experiment-calibration-2026.mjs\`. 3,840 independent combinations of historical/new winner-prediction blend, rolling logistic intercept (red-vs-blue bias), temperature/slope, gradient learning rate, weight decay, and calibration blending. This is online pre-game learning only, with no same-time leakage.

Live dataset sampled at 93 played matches (92 decisive):

| Metric | Production | Candidate selected using first 55 games |
|---|---:| ---: |
| All decided matches | 64/92 = 69.6% | 64/92 = 69.6% |
| All Log Loss | 0.6171 | 0.6150 |
| First 55 games (54 decisive) | 38/54 | 39/54 |
| Matches 56–90 | 24/35 | 23/35 |
| New matches after 90 | 2/3 | 2/3 |

Online probability calibration may marginally reduce Log Loss, but it did not improve out-of-time wins. Newest test portion has just three decisive games; do not imply statistical confidence.

Actions run: https://github.com/haruto-yamanishi/fgc-statbotics/actions/runs/37744019441

### Recommendation

**Keep production model unchanged.** All ~8,700 new combinations were evaluated without demonstrated later-period accuracy improvement. Preserve the models for further prospective trials.

Highest priority: solve the first-game cold-start weakness through independently available pre-match team signals (robot inspection readiness, same-year scouting, actual previous FGC team continuity, disaggregated scoring where allowed), and consider true chronological provenance snapshots of predictions before new match results are published. Do not optimize the public recent-10-match headline directly; retain full-season paired accuracy, Log Loss and Brier for model comparisons.


## Further structural research (2026-10-08)

### Independent Bayesian team ratings + offensive output + climbs

Code: \`scripts/experiment-structural-bayes.mjs\`. 6,908 configurations, including a diagonal-Gaussian (Kalman-style) team skill update with opponent-strength-adjusted score observations; independently learned per-team suppression offense; climbing results; winner features; dynamic team-experience gating; and 2026/legacy probability blending.

On 93 played (92 decided) games, the production opponent-aware predictor got **64/92 = 69.6%, Log Loss 0.61709**. Best selected on first 55 games got the **same 64/92**, but improved full-period Log Loss to **0.61104**. The retrospective best over all games also tied at 64/92, Log Loss **0.61046**. No first-55-selected model simultaneously improved middle-segment winner hit count and log loss. Bayesian weighting alone did not generate a reliable winner advantage.

Run: https://github.com/haruto-yamanishi/fgc-statbotics/actions/runs/37744334247

### Exact diagnosis of 2026 misses

Code: \`scripts/diagnose-2026-errors.mjs\`, 93 played / 92 decided:

| Match class | Current winner accuracy |
|---|---:|
| All six countries making their first appearance | **18/30 = 60.0%** |
| All six with at least one prior game | **46/62 = 74.2%** |
| Predicted confidence 50–55% | 11/14 = 78.6% |
| Predicted confidence 60–70% | 18/30 = 60.0% |
| Predicted confidence 70–80% | 8/14 = 57.1% |
| Predicted confidence at least 80% | 15/16 = 93.8% |
| Score reversals from base suppression winner to final winner | 4/7 = 57.1% |

This dataset is **heavily imbalanced by experience**. First-round games comprise alliances with 6 first-timers; later games mostly have 0 debutants. Observed hit rate differences may reflect other changing conditions (time, opponent pairings), so they do not independently prove causation.

Run: https://github.com/haruto-yamanishi/fgc-statbotics/actions/runs/37744521528

### Historical-rank plus experience blending

Code: \`scripts/experiment-cold-blend.mjs\`. 6,600 parameter combinations blending the current 2026 model, legacy model and world ranking percentiles of 2023, 2024, 2025, with a falloff based on games played so far.

At 94 played games (93 decided), production: **65/93 = 69.9%**, Log Loss 0.61694. The best *hindsight-selected* 2026 model: **70/93 = 75.3%**, Log Loss 0.58306. The latter favors the 2023 and 2024 ranking signal and neglects 2025. Selecting on the first 35 only, however, returned **65/93** with higher early hit rate but a loss in the next 20 games. **Do not claim 75.3% as prospective accuracy.**

Run: https://github.com/haruto-yamanishi/fgc-statbotics/actions/runs/37744650617

### Cross-year validation falsifies the aggressive ranking prior

Code: \`scripts/validate-cold-crossyear.mjs\`. 14,880 rank-prior candidates selected solely from 2024 + 2025, then assessed on 2026.

On the latest 2026 sample of 95 played / 94 decided, production got **66/94 = 70.2%**, Log Loss 0.61437. The top configuration chosen on historical years only got **56/94 = 59.6%**, Log Loss 0.67275, meaning a sharp regression. Some options improved the first 35 games of both 2024 and 2025, but those only delivered **21/34** on the first 35 of 2026 (baseline 20/34), and broadly fell short of production full-season accuracy.

The difference between 2026's retrospective-best **75.3%** and historically selected **59.6%** is strong evidence that simply fitting tournament rankings to 2026 is overfitting. **Do not merge the retrospective candidate into main.**

Run: https://github.com/haruto-yamanishi/fgc-statbotics/actions/runs/37744773177

### Decision and next research route

The publicly deployed \`main\` model should remain unchanged. Collect actual *pre-match, team-specific* robot readiness/availability and competition scouting rather than trying more historical-rank parameter permutations. For prospective accuracy, freeze a future-game prediction list or snapshots and evaluate these exact probabilities when results arrive. Continue reporting both decisive all-match winner hit rate and calibration/log loss. The homepage last-10-match accuracy is an expressly short-window UI metric, not a model-selection objective.
