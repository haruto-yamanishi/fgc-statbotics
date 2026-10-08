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
