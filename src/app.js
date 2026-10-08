import { fetchSeason } from "./api.js?v=20261008-4";
import { ACCURACY_WINDOW_MATCHES, predictionAccuracy } from "./accuracy.js?v=20261008-8";
import { buildOpponentAwareModel } from "./opponent-aware.js";
import { isOfficialMatch } from "./epa.js";
import { getLocaleTag, localeTags, resolveLocale, setLocale, t, translateStatic } from "./i18n.js?v=20261008-8";
import { buildRoster, buildSeasonModel, matchKey, predictMatch, teamCode, teamName } from "./predict.js?v=20261008-5";
import { completedRankingScores, countedRankingParticipant, isRankingMatch, projectedFinalRankingScores, projectedRankingPositions, rankingScore } from "./ranking-score.js";
import { allianceOutcome, projectedOutcome, rankMovement, teamRecord, teamSide } from "./standings.js";

const DEFAULT_TEAM = "JPN";
const AUTO_REFRESH_MS = 60_000;
let dateFormat;
let timeFormat;
let numberFormat;

function displayName(record) { return teamName(record, getLocaleTag()); }
function updateFormatters() {
  dateFormat = new Intl.DateTimeFormat(getLocaleTag(), { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  timeFormat = new Intl.DateTimeFormat(getLocaleTag(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  numberFormat = new Intl.NumberFormat(getLocaleTag());
}

const historyPromises = new Map();
const state = {
  year: 2026,
  lastUpdated: null,
  data: null,
  roster: [],
  ratings: new Map(),
  scoring: null,
  snapshots: new Map(),
  opponentAware: null,
  currentRankingScores: new Map(),
  projectedFinalRanks: new Map(),
  projectedFinalPositions: new Map(),
  selectedTeamKey: null,
  selectedCode: DEFAULT_TEAM,
  loading: false,
  controller: null,
  scheduleView: "team",
  matchQuery: "",
  visibleMatches: 12,
  resultView: "team",
  visibleResults: 10,
  leaderQuery: "",
  sort: "projectedFinal",
  userSorted: false,
  historyYears: 0,
};

const ids = [
  "language-select", "year-select", "event-state", "last-updated", "refresh-button", "data-note", "error-box",
  "team-search", "team-search-status", "team-select", "selected-team-title", "team-summary", "prediction-source",
  "accuracy-summary", "featured-prediction", "schedule-count", "show-team", "show-all", "match-search",
  "prediction-list", "show-more", "results-count", "show-results-team", "show-results-all",
  "result-list", "results-more", "leader-search", "sort-select", "sort-current-ranking", "sort-projected-final", "current-ranking-header", "projected-final-header", "leaderboard-body",
];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

let savedLanguage = "";
try { savedLanguage = localStorage.getItem("fgc-language") || ""; } catch { /* Storage may be disabled. */ }
setLocale(resolveLocale(location.search, savedLanguage));
el["language-select"].value = getLocaleTag().split("-")[0];
translateStatic();
updateFormatters();

el["language-select"].addEventListener("change", () => {
  setLocale(el["language-select"].value);
  translateStatic();
  updateFormatters();
  try { localStorage.setItem("fgc-language", el["language-select"].value); } catch { /* Storage may be disabled. */ }
  const url = new URL(location.href);
  url.searchParams.set("lang", el["language-select"].value);
  history.replaceState(null, "", url);
  if (state.data) {
    renderAll();
    renderEventStatus();
  }
  else el["event-state"].textContent = t("loadingYear", { year: state.year });
});

el["year-select"].addEventListener("change", () => {
  state.year = Number(el["year-select"].value);
  state.visibleMatches = 12;
  state.visibleResults = 10;
  const url = new URL(location.href);
  url.searchParams.set("year", String(state.year));
  history.replaceState(null, "", url);
  loadSeason();
});
el["refresh-button"].addEventListener("click", loadSeason);
el["team-search"].addEventListener("input", (event) => searchTeams(!event.isComposing));
el["team-search"].addEventListener("compositionend", () => searchTeams(true));
el["team-select"].addEventListener("change", () => selectTeam(Number(el["team-select"].value)));
el["show-team"].addEventListener("click", () => setScheduleView("team"));
el["show-all"].addEventListener("click", () => setScheduleView("all"));
el["match-search"].addEventListener("input", () => {
  state.matchQuery = el["match-search"].value.trim().toLocaleLowerCase("ja");
  state.visibleMatches = 12;
  renderSchedule();
});
el["show-more"].addEventListener("click", () => {
  state.visibleMatches += 24;
  renderSchedule();
});
el["show-results-team"].addEventListener("click", () => setResultView("team"));
el["show-results-all"].addEventListener("click", () => setResultView("all"));
el["results-more"].addEventListener("click", () => {
  state.visibleResults += 25;
  renderResults();
});
el["leader-search"].addEventListener("input", () => {
  state.leaderQuery = el["leader-search"].value.trim().toLocaleLowerCase("ja");
  renderLeaderboard();
});
el["sort-select"].addEventListener("change", () => {
  state.sort = el["sort-select"].value;
  state.userSorted = true;
  renderLeaderboard();
});

function getHistory(year) {
  if (!historyPromises.has(year)) {
    const pending = Promise.allSettled([fetchSeason(year - 1), fetchSeason(year - 2)])
      .then((results) => {
        const seasons = results.map((result) => result.status === "fulfilled" ? result.value : null);
        if (seasons.some((season) => !season)) historyPromises.delete(year);
        return seasons;
      });
    historyPromises.set(year, pending);
  }
  return historyPromises.get(year);
}

async function loadSeason() {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  state.loading = true;
  el["refresh-button"].disabled = true;
  el["event-state"].textContent = t("loadingYear", { year: state.year });
  setError("");

  try {
    const fetched = await fetchSeason(state.year, controller.signal, state.year === 2026);
    const data = { ...fetched, matches: fetched.matches.filter(isOfficialMatch) };
    const history = await getHistory(state.year);
    if (controller.signal.aborted) return;
    state.data = data;
    state.roster = buildRoster(data.rankings, data.matches);
    const model = buildSeasonModel(state.roster, data.matches, history);
    state.ratings = model.ratings;
    state.scoring = model.scoring;
    state.opponentAware = state.year === 2026
      ? buildOpponentAwareModel(state.roster, data.matches, history, model.snapshots)
      : null;
    state.snapshots = state.opponentAware?.snapshots || model.snapshots;
    state.currentRankingScores = state.year === 2026
      ? new Map(state.roster.map((team) => [Number(team.teamKey), rankingScore(completedRankingScores(data.matches, team.teamKey))]))
      : new Map();
    state.projectedFinalRanks = state.year === 2026
      ? projectedFinalRankingScores(data.matches, state.roster.map((team) => team.teamKey), (match) => predictMatch(match, model.ratings, model.scoring))
      : new Map();
    state.projectedFinalPositions = projectedRankingPositions(state.projectedFinalRanks);
    state.historyYears = history.filter(Boolean).length;
    if (state.year !== 2026 && ["currentRanking", "projectedFinal"].includes(state.sort)) {
      state.sort = "epa";
      el["sort-select"].value = state.sort;
    }
    if (!state.userSorted) {
      state.sort = state.year === 2026 ? "projectedFinal" : "epa";
      el["sort-select"].value = state.sort;
    }
    reconcileSelection();
    state.lastUpdated = new Date();
    renderAll();
    renderEventStatus();
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error(error);
      setError(t("fetchError", { error: error.message }));
      el["event-state"].textContent = t("fetchFailed");
    }
  } finally {
    if (state.controller === controller) {
      state.loading = false;
      el["refresh-button"].disabled = false;
    }
  }
}

function renderEventStatus() {
  if (!state.data) return;
  const played = state.data.matches.filter((match) => match.played).length;
  const upcoming = state.data.matches.length - played;
  el["event-state"].textContent = t("eventState", { year: state.year, upcoming: formatNumber(upcoming), played: formatNumber(played) });
  if (state.lastUpdated) el["last-updated"].textContent = timeFormat.format(state.lastUpdated);
}

function reconcileSelection() {
  const byCode = state.roster.find((team) => teamCode(team) === state.selectedCode);
  state.selectedTeamKey = Number((byCode || state.roster[0])?.teamKey) || null;
}

function renderAll() {
  const notes = [];
  if (!state.data.rankings.length) notes.push(t("noOfficialRanks"));
  if (state.scoring?.source === "prior") notes.push(t("provisionalScores"));
  el["data-note"].hidden = !notes.length;
  el["data-note"].textContent = notes.join(" ");
  el["prediction-source"].textContent = state.scoring?.source === "live"
    ? t("sourceLive", { matches: formatNumber(Math.floor(state.scoring.playedAlliances / 2)) })
    : state.historyYears ? t("sourceHistory", { years: formatNumber(state.historyYears) }) : t("insufficientScores");
  updateTeamPicker();
  renderAccuracy();
  renderTeam();
  renderFeatured();
  renderSchedule();
  renderResults();
  renderLeaderboard();
}

function displayPrediction(match) {
  const prediction = predictMatch(match, state.ratings, state.scoring);
  if (prediction && state.opponentAware) {
    prediction.redProbability = state.opponentAware.probability(match, prediction.redProbability);
  }
  return prediction;
}

function renderAccuracy() {
  const { correct, eligible, rate } = predictionAccuracy(state.snapshots, ACCURACY_WINDOW_MATCHES);
  if (rate == null) {
    el["accuracy-summary"].innerHTML = `<p class="accuracy-pending">${escapeHtml(t("accuracyPending"))}</p>`;
    return;
  }
  const percentage = new Intl.NumberFormat(getLocaleTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(rate);
  el["accuracy-summary"].innerHTML = `<div class="accuracy-metric">
    <strong>${escapeHtml(percentage)}%</strong>
    <span class="accuracy-count">${escapeHtml(t("accuracyRecord", { correct: formatNumber(correct), total: formatNumber(eligible) }))}</span>
  </div>
  <div class="accuracy-progress" role="progressbar" aria-label="${escapeHtml(t("accuracyTitle"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rate.toFixed(1)}"><span style="width:${rate}%"></span></div>`;
}

function selectTeam(teamKey, keepSearch = false) {
  if (!state.roster.some((team) => Number(team.teamKey) === teamKey)) return;
  state.selectedTeamKey = teamKey;
  state.selectedCode = teamCode(selectedTeam());
  if (!keepSearch) el["team-search"].value = "";
  updateTeamPicker();
  state.visibleMatches = 12;
  state.visibleResults = 10;
  renderTeam();
  renderFeatured();
  renderSchedule();
  renderResults();
  renderLeaderboard();
  history.replaceState(null, "", `#team=${encodeURIComponent(state.selectedCode)}`);
}

function setScheduleView(view) {
  state.scheduleView = view;
  state.visibleMatches = 12;
  el["show-team"].classList.toggle("active", view === "team");
  el["show-all"].classList.toggle("active", view === "all");
  renderSchedule();
}

function setResultView(view) {
  state.resultView = view;
  state.visibleResults = 10;
  el["show-results-team"].classList.toggle("active", view === "team");
  el["show-results-all"].classList.toggle("active", view === "all");
  renderResults();
}

function searchTeams(selectFirst) {
  const teams = updateTeamPicker();
  if (selectFirst && teams.length) selectTeam(Number(teams[0].teamKey), true);
}

function updateTeamPicker() {
  if (!state.data) return [];
  const query = el["team-search"].value.trim().toLocaleLowerCase("ja");
  const teams = state.roster
    .filter((team) => searchText(team).includes(query))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), getLocaleTag()));
  el["team-select"].innerHTML = teams.length
    ? teams.map((team) => `<option value="${Number(team.teamKey)}">${escapeHtml(teamCode(team))} · ${escapeHtml(displayName(team))}</option>`).join("")
    : `<option value="">${escapeHtml(t("noCountries"))}</option>`;
  el["team-select"].disabled = !teams.length;
  el["team-search-status"].textContent = query
    ? teams.length ? t("candidates", { count: formatNumber(teams.length) }) : t("noCountries")
    : t("teamCount", { count: formatNumber(teams.length) });
  if (teams.some((team) => Number(team.teamKey) === state.selectedTeamKey)) {
    el["team-select"].value = String(state.selectedTeamKey);
  }
  return teams;
}

function renderTeam() {
  const team = selectedTeam();
  if (!team) {
    el["team-summary"].innerHTML = `<div class="empty-state">${escapeHtml(t("noTeamData"))}</div>`;
    return;
  }
  const metric = state.ratings.get(Number(team.teamKey)) || {};
  const matches = teamMatches();
  const upcoming = matches.filter((match) => !match.played).length;
  const record = teamRecord(matches, team.teamKey);
  const movement = rankMovement(team.rank, metric.previousRank);
  const componentNote = t(state.year === 2026 ? "scoreDetailsPending" : "components2026");
  const key = Number(team.teamKey);
  const currentRankingScore = state.currentRankingScores.get(key);
  const projectedScore = state.projectedFinalRanks.get(key);
  const projectedPosition = state.projectedFinalPositions.get(key);
  el["selected-team-title"].textContent = `${displayName(team)} · ${teamCode(team)}`;
  el["team-summary"].innerHTML = [
    statCard(t("record"), t("recordValue", { wins: formatNumber(record.wins), losses: formatNumber(record.losses) }), t("recordNote", { ties: formatNumber(record.ties), upcoming: formatNumber(upcoming) }), true),
    statCard(t("officialRank"), team.rank == null ? "—" : `#${formatNumber(team.rank)}`, t(team.rank == null ? "rankPending" : "officialSource"), false, rankMovementBadge(movement)),
    ...(state.year === 2026 ? [
      statCard(t("projectedFinalRank"), projectedPosition == null ? "—" : `#${formatNumber(projectedPosition)}`, t("projectedRankNote")),
      statCard(t("currentRankingScore"), formatDecimal(currentRankingScore), t("currentRankingScoreNote")),
      statCard(t("predictedFinalRankingScore"), formatDecimal(projectedScore), t("projectedFinalScoreNote"), true),
    ] : []),
    statCard(t("totalEpa"), formatDecimal(metric.epa), metric.epaRank ? t("epaGames", { rank: formatNumber(metric.epaRank), games: formatNumber(metric.modelGames) }) : t("epaAfterMatch"), true),
    statCard(t("mainEpa"), formatDecimal(metric.mainEpa), metric.mainEpaRank ? t("mainNote", { rank: formatNumber(metric.mainEpaRank) }) : componentNote),
    statCard(t("endgameEpa"), formatDecimal(metric.endgameEpa), metric.endgameEpaRank ? t("endgameNote", { rank: formatNumber(metric.endgameEpaRank) }) : componentNote),
    statCard(t("previousOfficialRank"), metric.previousRank == null ? "—" : `#${formatNumber(metric.previousRank)}`, t(metric.previousRank == null ? "noPreviousRank" : "predictionReference")),
  ].join("");
}

function renderFeatured() {
  const next = teamMatches().filter((match) => !match.played).sort(sortMatches)[0];
  if (!next) {
    el["featured-prediction"].innerHTML = `<div class="empty-state">${escapeHtml(t("noUpcomingTeam"))}</div>`;
    return;
  }
  const prediction = displayPrediction(next);
  if (!prediction) {
    el["featured-prediction"].innerHTML = `<div class="empty-state">${escapeHtml(t("participantsPending"))}</div>`;
    return;
  }
  const redPct = Math.round(prediction.redProbability * 100);
  const bluePct = 100 - redPct;
  const selectedSide = teamSide(next.participants, state.selectedTeamKey);
  const projectedRank = projectedRankingScores().get(matchKey(next));
  const scoreText = t(state.scoring?.source === "live" ? "scoreSourceLive" : "scoreSourcePrior");
  el["featured-prediction"].innerHTML = `<article class="featured">
    <div class="featured-top"><div class="featured-heading"><strong>${escapeHtml(t("nextMatch", { match: matchLabel(next) }))}</strong>${predictionBadge(projectedOutcome(redPct, selectedSide), teamCode(selectedTeam()))}</div><span class="match-meta">${escapeHtml(matchTime(next))} · ${escapeHtml(t("field", { field: next.field || "—" }))}</span></div>
    <div class="featured-body">
      <div class="alliance red"><span class="alliance-label">${escapeHtml(t("redAlliance"))}</span><div class="alliance-team-list">${prediction.red.map(teamChip).join("")}</div></div>
      <div class="probability-center"><small>${escapeHtml(t("projectedScoreLong"))}</small><strong class="forecast-score"><span class="red-value">${prediction.projected?.red ?? "—"}</span><span class="score-divider">:</span><span class="blue-value">${prediction.projected?.blue ?? "—"}</span></strong><div class="forecast-unit">${escapeHtml(t("redBlue"))}</div><div class="probability-bar" role="img" aria-label="${escapeHtml(t("probabilityAria", { red: redPct, blue: bluePct }))}"><span style="width:${redPct}%"></span></div><div class="probability-labels"><span class="red-value">${escapeHtml(t("probabilityLabel", { side: t("red"), percent: redPct }))}</span><span class="blue-value">${escapeHtml(t("probabilityLabel", { side: t("blue"), percent: bluePct }))}</span></div>${rankingProjection(projectedRank)}</div>
      <div class="alliance blue"><span class="alliance-label">${escapeHtml(t("blueAlliance"))}</span><div class="alliance-team-list">${prediction.blue.map(teamChip).join("")}</div></div>
    </div>
    <div class="featured-footer"><span>${escapeHtml(scoreText)}</span><span>${escapeHtml(t("coveredTeams", { covered: formatNumber(prediction.covered), total: formatNumber(prediction.totalTeams) }))}</span></div>
  </article>`;
}

function renderSchedule() {
  if (!state.data) return;
  const projectedRanks = projectedRankingScores();
  const matches = (state.scheduleView === "team" ? teamMatches() : state.data.matches)
    .filter((match) => !match.played)
    .filter((match) => !state.matchQuery || matchSearchText(match).includes(state.matchQuery))
    .sort(sortMatches);
  el["schedule-count"].textContent = t("countMatches", { count: formatNumber(matches.length) });
  const shown = matches.slice(0, state.visibleMatches);
  el["prediction-list"].innerHTML = shown.length
    ? shown.map((match) => renderMatchCard(match, projectedRanks.get(matchKey(match)))).join("")
    : `<div class="empty-state">${escapeHtml(t("noScheduled"))}</div>`;
  el["show-more"].hidden = shown.length >= matches.length;
}

function renderMatchCard(match, projectedRank) {
  const prediction = displayPrediction(match);
  if (!prediction) return "";
  const redPct = Math.round(prediction.redProbability * 100);
  const selectedSide = teamSide(match.participants, state.selectedTeamKey);
  return `<article class="match-card">
    <div class="match-card-id"><strong>${escapeHtml(matchLabel(match))}</strong><span>${escapeHtml(matchTime(match))} · ${escapeHtml(t("field", { field: match.field || "—" }))}</span></div>
    <div class="match-card-sides"><div class="match-side"><b>${escapeHtml(t("red"))}</b><div class="match-team-list">${prediction.red.map(scheduleTeam).join("")}</div></div><span class="match-versus">${escapeHtml(t("versus"))}</span><div class="match-side blue"><b>${escapeHtml(t("blue"))}</b><div class="match-team-list">${prediction.blue.map(scheduleTeam).join("")}</div></div></div>
    <div class="match-card-prediction">${predictionBadge(projectedOutcome(redPct, selectedSide), selectedSide ? teamCode(selectedTeam()) : "")}<div class="compact-score"><small>${escapeHtml(t("projectedScore"))}</small><strong><span class="red-value">${prediction.projected?.red ?? "—"}</span> : <span class="blue-value">${prediction.projected?.blue ?? "—"}</span></strong></div><div class="probability-bar" role="img" aria-label="${escapeHtml(t("probabilityAria", { red: redPct, blue: 100 - redPct }))}"><span style="width:${redPct}%"></span></div><div class="probability-labels"><span class="red-value">${escapeHtml(t("probabilityLabel", { side: t("red"), percent: redPct }))}</span><span class="blue-value">${escapeHtml(t("probabilityLabel", { side: t("blue"), percent: 100 - redPct }))}</span></div>${rankingProjection(projectedRank)}</div>
  </article>`;
}

function projectedRankingScores() {
  const projected = new Map();
  if (state.year !== 2026 || !state.data || state.selectedTeamKey == null) return projected;
  const scores = completedRankingScores(state.data.matches, state.selectedTeamKey);
  const future = teamMatches().filter((match) => !match.played && isRankingMatch(match) && countedRankingParticipant(match, state.selectedTeamKey)).sort(sortMatches);
  for (const match of future) {
    const side = teamSide(match.participants, state.selectedTeamKey);
    const score = predictMatch(match, state.ratings, state.scoring)?.projected?.[side];
    if (!Number.isFinite(score)) continue;
    scores.push({ score, redCard: false });
    projected.set(matchKey(match), rankingScore(scores));
  }
  return projected;
}

function rankingProjection(value) {
  if (value == null) return "";
  return `<div class="ranking-projection"><span>${escapeHtml(t("predictedRankingScore"))}<small>${escapeHtml(t("rankingScoreAfterMatch"))}</small></span><strong>${formatDecimal(value)}</strong></div>`;
}

function renderResults() {
  const matches = (state.resultView === "team" ? teamMatches() : state.data?.matches || [])
    .filter((match) => match.played)
    .sort(sortMatches)
    .reverse();
  el["results-count"].textContent = t("countMatches", { count: formatNumber(matches.length) });
  const shown = matches.slice(0, state.visibleResults);
  el["result-list"].innerHTML = shown.length
    ? shown.map(renderResultCard).join("")
    : `<div class="empty-state">${escapeHtml(t("noResults"))}</div>`;
  el["results-more"].hidden = shown.length >= matches.length;
}

function renderResultCard(match) {
  const snapshot = state.snapshots.get(matchKey(match));
  const red = (match.participants || []).filter((p) => Number(p.station) < 20).map(teamCodeFromParticipant).join(" · ");
  const blue = (match.participants || []).filter((p) => Number(p.station) > 20).map(teamCodeFromParticipant).join(" · ");
  const verdicts = {
    correct: [t("correct"), "correct"],
    incorrect: [t("incorrect"), "incorrect"],
    tie: [t("tie"), "neutral"],
    "no-pick": [t("noPick"), "neutral"],
  };
  const [label, className] = verdicts[snapshot?.verdict] || [t("noPick"), "neutral"];
  const redPct = snapshot ? Math.round(snapshot.redProbability * 100) : null;
  const redOutcome = allianceOutcome(match, "red");
  const blueOutcome = allianceOutcome(match, "blue");
  return `<article class="result-card">
    <div class="result-heading"><div><strong>${escapeHtml(matchLabel(match))}</strong><span>${escapeHtml(matchTime(match))} · ${escapeHtml(t("field", { field: match.field || "—" }))}</span></div><span class="verdict ${className}">${escapeHtml(label)}</span></div>
    <div class="result-content"><div class="result-side red"><div class="result-side-heading"><b>${escapeHtml(t("red"))} · ${escapeHtml(red)}</b>${resultBadge(redOutcome)}</div><div><span>${escapeHtml(t("actualScore"))}</span><strong>${formatNumber(match.redScore)}</strong></div><small>${escapeHtml(t("prematchScore", { score: snapshot?.projected?.red ?? "—" }))}</small></div><div class="result-versus">${escapeHtml(t("versus"))}</div><div class="result-side blue"><div class="result-side-heading"><b>${escapeHtml(t("blue"))} · ${escapeHtml(blue)}</b>${resultBadge(blueOutcome)}</div><div><span>${escapeHtml(t("actualScore"))}</span><strong>${formatNumber(match.blueScore)}</strong></div><small>${escapeHtml(t("prematchScore", { score: snapshot?.projected?.blue ?? "—" }))}</small></div></div>
    <div class="result-footer"><span>${escapeHtml(snapshot ? t("prematchProbability", { red: redPct, blue: 100 - redPct }) : t("noPrematchPrediction"))}</span><span>${escapeHtml(t("noLeakage"))}</span></div>
  </article>`;
}

function renderLeaderboard() {
  if (!state.data) return;
  const showProjectedFinal = state.year === 2026;
  el["sort-current-ranking"].hidden = !showProjectedFinal;
  el["sort-current-ranking"].disabled = !showProjectedFinal;
  el["sort-projected-final"].hidden = !showProjectedFinal;
  el["sort-projected-final"].disabled = !showProjectedFinal;
  el["current-ranking-header"].hidden = !showProjectedFinal;
  el["projected-final-header"].hidden = !showProjectedFinal;
  const rows = state.roster
    .filter((team) => searchText(team).includes(state.leaderQuery))
    .map((team) => ({ team, metric: state.ratings.get(Number(team.teamKey)) || {} }));
  const compare = {
    official: (a, b) => nullableRank(a.team.rank) - nullableRank(b.team.rank),
    epa: (a, b) => nullableValue(b.metric.epa) - nullableValue(a.metric.epa),
    main: (a, b) => nullableValue(b.metric.mainEpa) - nullableValue(a.metric.mainEpa),
    endgame: (a, b) => nullableValue(b.metric.endgameEpa) - nullableValue(a.metric.endgameEpa),
    currentRanking: (a, b) => nullableValue(state.currentRankingScores.get(Number(b.team.teamKey))) - nullableValue(state.currentRankingScores.get(Number(a.team.teamKey))),
    projectedFinal: (a, b) => nullableValue(state.projectedFinalRanks.get(Number(b.team.teamKey))) - nullableValue(state.projectedFinalRanks.get(Number(a.team.teamKey))),
    previous: (a, b) => nullableRank(a.metric.previousRank) - nullableRank(b.metric.previousRank),
  };
  rows.sort((a, b) => (compare[state.sort] || compare.epa)(a, b) || displayName(a.team).localeCompare(displayName(b.team), getLocaleTag()));
  el["leaderboard-body"].innerHTML = rows.map(({ team, metric }, index) => {
    const key = Number(team.teamKey);
    const projectedScore = state.projectedFinalRanks.get(key);
    return `<tr data-team-key="${key}" class="${key === state.selectedTeamKey ? "selected" : ""}" tabindex="0" aria-label="${escapeHtml(t("selectTeamAria", { name: displayName(team) }))}">
      <td>#${formatNumber(index + 1)}</td>
      <td>${metric.epaRank ? `#${metric.epaRank}` : "—"}</td>
      <td><div class="table-team"><b>${escapeHtml(teamCode(team))}</b><span>${escapeHtml(displayName(team))}</span></div></td>
      <td>${formatDecimal(metric.epa)}</td>
      <td>${formatDecimal(metric.mainEpa)}</td>
      <td>${formatDecimal(metric.endgameEpa)}</td>
      <td>${formatNumber(metric.modelGames)}</td>
      <td>${team.rank == null ? "—" : `#${formatNumber(team.rank)}`}</td>
      ${showProjectedFinal ? `<td>${formatDecimal(state.currentRankingScores.get(key))}</td><td>${formatDecimal(projectedScore)}</td>` : ""}
      <td>${rankMovementBadge(rankMovement(team.rank, metric.previousRank)) || "—"}</td>
    </tr>`;
  }).join("");
  el["leaderboard-body"].querySelectorAll("tr[data-team-key]").forEach((row) => {
    row.addEventListener("click", () => selectTeam(Number(row.dataset.teamKey)));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectTeam(Number(row.dataset.teamKey));
      }
    });
  });
}

function selectedTeam() {
  return state.roster.find((team) => Number(team.teamKey) === state.selectedTeamKey);
}
function teamMatches() {
  return state.data?.matches.filter((match) => (match.participants || []).some((p) => Number(p.teamKey) === state.selectedTeamKey)) || [];
}
function searchText(record) {
  return `${teamCode(record)} ${Object.keys(localeTags).map((locale) => teamName(record, locale)).join(" ")} ${record?.team?.name || ""}`.toLocaleLowerCase(getLocaleTag());
}
function matchSearchText(match) {
  return `${match.name || ""} ${match.id || ""} ${matchLabel(match)} ${(match.participants || []).map((p) => searchText(p)).join(" ")}`.toLocaleLowerCase(getLocaleTag());
}
function teamCodeFromParticipant(participant) {
  return String(participant.country || state.roster.find((team) => Number(team.teamKey) === Number(participant.teamKey))?.team?.country || "—").toUpperCase();
}
function teamChip(participant) {
  const code = teamCodeFromParticipant(participant);
  const selected = Number(participant.teamKey) === state.selectedTeamKey;
  return `<span class="team-chip ${selected ? "selected" : ""}"><span class="team-chip-label"><b>${escapeHtml(code)}</b><small>${escapeHtml(displayName(participant))}</small></span>${teamFlag(participant)}</span>`;
}
function scheduleTeam(participant) {
  const code = teamCodeFromParticipant(participant);
  const name = displayName(participant);
  const selected = Number(participant.teamKey) === state.selectedTeamKey;
  return `<span class="match-team ${selected ? "selected" : ""}" title="${escapeHtml(name)}" aria-label="${escapeHtml(`${code} · ${name}`)}"><b>${escapeHtml(code)}</b>${teamFlag(participant)}</span>`;
}
function teamFlag(participant) {
  const region = String(participant.countryCode || state.roster.find((team) => Number(team.teamKey) === Number(participant.teamKey))?.team?.countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return `<span class="team-flag team-flag-fallback" aria-hidden="true">🌐</span>`;
  const flag = String.fromCodePoint(...[...region].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
  return `<span class="team-flag" aria-hidden="true">${flag}</span>`;
}
function matchLabel(match) {
  const name = String(match.name || `Match ${match.id || ""}`);
  const ranking = name.match(/^Ranking Match\s*(.*)$/i);
  if (ranking) return t("rankingMatch", { number: ranking[1] });
  const qualification = name.match(/^Qualification Match\s*(.*)$/i);
  if (qualification) return t("qualificationMatch", { number: qualification[1] });
  const generic = name.match(/^Match\s*(.*)$/i);
  return generic ? t("genericMatch", { number: generic[1] }) : name;
}
function matchTime(match) {
  if (!match.scheduledTime) return t("timePending");
  const date = new Date(match.scheduledTime);
  return Number.isNaN(date.getTime()) ? t("timePending") : `${dateFormat.format(date)} ${t("japanTime")}`;
}
function sortMatches(a, b) {
  const aTime = Date.parse(a.scheduledTime);
  const bTime = Date.parse(b.scheduledTime);
  return (Number.isFinite(aTime) ? aTime : Infinity) - (Number.isFinite(bTime) ? bTime : Infinity)
    || Number(a.id || 0) - Number(b.id || 0);
}
function statCard(label, value, note, emphasis = false, extra = "") {
  return `<div class="stat-card ${emphasis ? "emphasis" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(note)}</small>${extra}</div>`;
}
function rankMovementBadge(movement) {
  if (movement == null) return "";
  const trend = movement > 0 ? "up" : movement < 0 ? "down" : "same";
  const label = movement > 0 ? t("rankUp", { count: formatNumber(movement) }) : movement < 0 ? t("rankDown", { count: formatNumber(-movement) }) : t("rankSame");
  return `<span class="rank-movement ${trend}">${escapeHtml(t("rankChangeLabel", { movement: label }))}</span>`;
}
function resultBadge(outcome) {
  if (!outcome) return "";
  return `<span class="result-badge ${outcome}">${escapeHtml(t(outcome === "tie" ? "draw" : outcome))}</span>`;
}
function predictionBadge(outcome, code = "") {
  if (!outcome) return "";
  return `<span class="prediction-badge ${outcome}">${escapeHtml(t("predictedBadge", { code: code ? `${code} · ` : "", outcome: t(outcome === "even" ? "even" : outcome) }))}</span>`;
}
function formatNumber(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : numberFormat.format(Number(value));
}
function formatDecimal(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : new Intl.NumberFormat(getLocaleTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(value));
}
function nullableRank(value) { return value == null || !Number.isFinite(Number(value)) ? Infinity : Number(value); }
function nullableValue(value) { return value == null || !Number.isFinite(Number(value)) ? -Infinity : Number(value); }
function setError(message) {
  el["error-box"].hidden = !message;
  el["error-box"].textContent = message;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

const hashCode = new URLSearchParams(location.hash.replace(/^#/, "")).get("team");
if (hashCode) state.selectedCode = hashCode.toUpperCase();
const requestedYear = Number(new URLSearchParams(location.search).get("year"));
if ([2022, 2023, 2024, 2025, 2026].includes(requestedYear)) {
  state.year = requestedYear;
  el["year-select"].value = String(requestedYear);
}
loadSeason();
setInterval(() => { if (!document.hidden && !state.loading) loadSeason(); }, AUTO_REFRESH_MS);
