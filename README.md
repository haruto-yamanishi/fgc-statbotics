# FGC Stats

A lightweight Statbotics-style analytics dashboard for the **FIRST Global Challenge**.

It reads live event data from FIRST Global's public results API and adds an independent schedule-adjusted metric called **FGC EPA** alongside the official rankings.

## What it shows

- Official rank, ranking score, high score, climb points, and matches played
- FGC EPA and EPA rank for every team
- Recent schedule-adjusted form
- Team score trend
- Recent and upcoming matches
- Searchable/sortable live leaderboard
- 2022–2026 season switcher
- Automatic refresh every 60 seconds

The default tracked team is `JPN`.

## FGC EPA

FGC matches use multi-team alliances, so raw alliance scores are heavily schedule-dependent. FGC EPA fits every played ranking alliance simultaneously as an additive team-contribution model.

For alliance `a` with teams `T_a`:

```text
score_a ≈ Σ EPA_team
          team ∈ T_a
```

Because the live event begins with very little data, the implementation uses ridge regularization around the event-wide average team contribution rather than ordinary least squares. This keeps one lucky early match from exploding a team's rating.

This metric is **experimental and independent**. It is not an official FIRST Global statistic, and the official ranking remains the source of truth for advancement.

## Run locally

No dependencies or build step are required.

```bash
npm test
npm run serve
```

Then open `http://localhost:8080`.

Do not open `index.html` directly with `file://`; use a local HTTP server so browser CORS behavior matches deployment.

## Data source

The official results frontend maintained by The Orange Alliance reads from:

```text
https://api.first.global/v1?year=2026&excludeMatchDetails=true
```

The dashboard uses that same public read endpoint in the browser.

## Deploy

The repository includes a GitHub Pages workflow. Create a GitHub repository, push `main`, then enable **Settings → Pages → Source: GitHub Actions**.

## License

MIT. FIRST®, FIRST Global, and related marks belong to their respective owners. This project is not affiliated with FIRST Global.
