import { fetchSeason } from "./api.js";
import { isOfficialMatch } from "./epa.js";
import { buildRoster, buildSeasonModel, matchKey, predictMatch, teamCode, teamNameJa as displayName } from "./predict.js";

const DEFAULT_TEAM = "JPN";
const AUTO_REFRESH_MS = 60_000;
const dateFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const numberFormat = new Intl.NumberFormat("ja-JP");

const historyPromises = new Map();
const state = {
  year: 2026,
  data: null,
  roster: [],
  ratings: new Map(),
  scoring: null,
  snapshots: new Map(),
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
  sort: "prediction",
  userSorted: false,
  historyYears: 0,
};

const ids = [
  "year-select", "event-state", "last-updated", "refresh-button", "data-note", "error-box",
  "team-search", "team-search-status", "team-select", "selected-team-title", "team-summary", "prediction-source",
  "featured-prediction", "schedule-count", "show-team", "show-all", "match-search",
  "prediction-list", "show-more", "results-count", "show-results-team", "show-results-all",
  "result-list", "results-more", "leader-search", "sort-select", "leaderboard-body",
];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

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
  el["event-state"].textContent = `${state.year} 年のデータを読み込み中…`;
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
    state.snapshots = model.snapshots;
    state.historyYears = history.filter(Boolean).length;
    if (!state.userSorted) {
      state.sort = [...state.ratings.values()].some((rating) => rating.modelGames) ? "epa" : "prediction";
      el["sort-select"].value = state.sort;
    }
    reconcileSelection();
    renderAll();
    const played = data.matches.filter((match) => match.played).length;
    const upcoming = data.matches.length - played;
    el["event-state"].textContent = `${state.year} · ${formatNumber(upcoming)} 試合予定 / ${formatNumber(played)} 試合終了`;
    el["last-updated"].textContent = timeFormat.format(new Date());
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error(error);
      setError(`公式データを取得できませんでした: ${error.message}`);
      el["event-state"].textContent = "データを取得できません";
    }
  } finally {
    if (state.controller === controller) {
      state.loading = false;
      el["refresh-button"].disabled = false;
    }
  }
}

function reconcileSelection() {
  const byCode = state.roster.find((team) => teamCode(team) === state.selectedCode);
  state.selectedTeamKey = Number((byCode || state.roster[0])?.teamKey) || null;
}

function renderAll() {
  const notes = [];
  if (!state.data.rankings.length) notes.push("公式順位はまだ未発表です。参加国は対戦表から表示しています。");
  if (state.scoring?.source === "prior") notes.push("予測得点は過去年の得点水準と大会中の伸び方を使った暫定値です。今年の結果が公開されると自動で補正します。");
  el["data-note"].hidden = !notes.length;
  el["data-note"].textContent = notes.join(" ");
  el["prediction-source"].textContent = state.scoring?.source === "live"
    ? `ランキング戦 ${Math.floor(state.scoring.playedAlliances / 2)} 試合の実測を反映`
    : state.historyYears ? `過去${state.historyYears}年の得点水準・進行度を反映` : "得点実績不足";
  updateTeamPicker();
  renderTeam();
  renderFeatured();
  renderSchedule();
  renderResults();
  renderLeaderboard();
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
    .sort((a, b) => displayName(a).localeCompare(displayName(b), "ja"));
  el["team-select"].innerHTML = teams.length
    ? teams.map((team) => `<option value="${Number(team.teamKey)}">${escapeHtml(teamCode(team))} · ${escapeHtml(displayName(team))}</option>`).join("")
    : '<option value="">該当する国がありません</option>';
  el["team-select"].disabled = !teams.length;
  el["team-search-status"].textContent = query
    ? teams.length ? `${teams.length} 件の候補 · 最初の国を表示` : "該当する国がありません"
    : `${teams.length} チームから選択できます`;
  if (teams.some((team) => Number(team.teamKey) === state.selectedTeamKey)) {
    el["team-select"].value = String(state.selectedTeamKey);
  }
  return teams;
}

function renderTeam() {
  const team = selectedTeam();
  if (!team) {
    el["team-summary"].innerHTML = '<div class="empty-state">チームデータがありません。</div>';
    return;
  }
  const metric = state.ratings.get(Number(team.teamKey)) || {};
  const upcoming = teamMatches().filter((match) => !match.played).length;
  const componentNote = state.year === 2026 ? "得点詳細の公開後に算出" : "内訳は 2026 年のみ";
  el["selected-team-title"].textContent = `${displayName(team)} · ${teamCode(team)}`;
  el["team-summary"].innerHTML = [
    statCard("これからの試合", formatNumber(upcoming), "公開済みの対戦表", true),
    statCard("公式順位", team.rank == null ? "—" : `#${formatNumber(team.rank)}`, team.rank == null ? "まだ未発表" : "FIRST Global 公式"),
    statCard("総合 EPA", formatDecimal(metric.epa), metric.epaRank ? `EPA #${metric.epaRank} · ${metric.modelGames} 試合` : "今年の試合後に算出", true),
    statCard("本体 EPA", formatDecimal(metric.mainEpa), metric.mainEpaRank ? `#${metric.mainEpaRank} · 終盤以外` : componentNote),
    statCard("終盤 EPA", formatDecimal(metric.endgameEpa), metric.endgameEpaRank ? `#${metric.endgameEpaRank} · 登坂など` : componentNote),
    statCard("前年の公式順位", metric.previousRank == null ? "—" : `#${formatNumber(metric.previousRank)}`, metric.previousRank == null ? "前年データなし" : "予測の参考情報"),
  ].join("");
}

function renderFeatured() {
  const next = teamMatches().filter((match) => !match.played).sort(sortMatches)[0];
  if (!next) {
    el["featured-prediction"].innerHTML = '<div class="empty-state">このチームの今後の試合は、対戦表にまだありません。</div>';
    return;
  }
  const prediction = predictMatch(next, state.ratings, state.scoring);
  if (!prediction) {
    el["featured-prediction"].innerHTML = '<div class="empty-state">参加チームが確定すると予測を表示します。</div>';
    return;
  }
  const redPct = Math.round(prediction.redProbability * 100);
  const bluePct = 100 - redPct;
  const scoreText = state.scoring?.source === "live"
    ? "今年の得点水準・直近の結果・大会進行度を反映"
    : "初戦前の得点は過去年の水準と大会進行度による暫定値";
  el["featured-prediction"].innerHTML = `<article class="featured">
    <div class="featured-top"><strong>次の試合 · ${escapeHtml(matchLabel(next))}</strong><span class="match-meta">${escapeHtml(matchTime(next))} · フィールド ${escapeHtml(String(next.field || "—"))}</span></div>
    <div class="featured-body">
      <div class="alliance red"><span class="alliance-label">赤アライアンス</span><div class="alliance-team-list">${prediction.red.map(teamChip).join("")}</div></div>
      <div class="probability-center"><small>予測得点 · Estimated Points</small><strong class="forecast-score"><span class="red-value">${prediction.projected?.red ?? "—"}</span><span class="score-divider">:</span><span class="blue-value">${prediction.projected?.blue ?? "—"}</span></strong><div class="forecast-unit">赤 : 青</div><div class="probability-bar" role="img" aria-label="赤 ${redPct} パーセント、青 ${bluePct} パーセント"><span style="width:${redPct}%"></span></div><div class="probability-labels"><span class="red-value">赤 ${redPct}%</span><span class="blue-value">青 ${bluePct}%</span></div></div>
      <div class="alliance blue"><span class="alliance-label">青アライアンス</span><div class="alliance-team-list">${prediction.blue.map(teamChip).join("")}</div></div>
    </div>
    <div class="featured-footer"><span>${escapeHtml(scoreText)}</span><span>実績あり ${prediction.covered}/${prediction.totalTeams} チーム · 独自モデルによる参考値</span></div>
  </article>`;
}

function renderSchedule() {
  if (!state.data) return;
  const matches = (state.scheduleView === "team" ? teamMatches() : state.data.matches)
    .filter((match) => !match.played)
    .filter((match) => !state.matchQuery || matchSearchText(match).includes(state.matchQuery))
    .sort(sortMatches);
  el["schedule-count"].textContent = `(${formatNumber(matches.length)} 試合)`;
  const shown = matches.slice(0, state.visibleMatches);
  el["prediction-list"].innerHTML = shown.length
    ? shown.map(renderMatchCard).join("")
    : '<div class="empty-state">該当する予定試合はありません。</div>';
  el["show-more"].hidden = shown.length >= matches.length;
}

function renderMatchCard(match) {
  const prediction = predictMatch(match, state.ratings, state.scoring);
  if (!prediction) return "";
  const redPct = Math.round(prediction.redProbability * 100);
  const redTeams = prediction.red.map((p) => teamCodeFromParticipant(p)).join(" · ");
  const blueTeams = prediction.blue.map((p) => teamCodeFromParticipant(p)).join(" · ");
  return `<article class="match-card">
    <div class="match-card-id"><strong>${escapeHtml(matchLabel(match))}</strong><span>${escapeHtml(matchTime(match))} · フィールド ${escapeHtml(String(match.field || "—"))}</span></div>
    <div class="match-card-sides"><div class="match-side"><b>赤</b><span title="${escapeHtml(redTeams)}">${escapeHtml(redTeams)}</span></div><span class="match-versus">対</span><div class="match-side blue"><b>青</b><span title="${escapeHtml(blueTeams)}">${escapeHtml(blueTeams)}</span></div></div>
    <div class="match-card-prediction"><div class="compact-score"><small>予測得点</small><strong><span class="red-value">${prediction.projected?.red ?? "—"}</span> : <span class="blue-value">${prediction.projected?.blue ?? "—"}</span></strong></div><div class="probability-bar" role="img" aria-label="赤 ${redPct} パーセント、青 ${100 - redPct} パーセント"><span style="width:${redPct}%"></span></div><div class="probability-labels"><span class="red-value">赤 ${redPct}%</span><span class="blue-value">青 ${100 - redPct}%</span></div></div>
  </article>`;
}

function renderResults() {
  const matches = (state.resultView === "team" ? teamMatches() : state.data?.matches || [])
    .filter((match) => match.played)
    .sort(sortMatches)
    .reverse();
  el["results-count"].textContent = `(${formatNumber(matches.length)} 試合)`;
  const shown = matches.slice(0, state.visibleResults);
  el["result-list"].innerHTML = shown.length
    ? shown.map(renderResultCard).join("")
    : '<div class="empty-state">終了した試合はまだありません。</div>';
  el["results-more"].hidden = shown.length >= matches.length;
}

function renderResultCard(match) {
  const snapshot = state.snapshots.get(matchKey(match));
  const red = (match.participants || []).filter((p) => Number(p.station) < 20).map(teamCodeFromParticipant).join(" · ");
  const blue = (match.participants || []).filter((p) => Number(p.station) > 20).map(teamCodeFromParticipant).join(" · ");
  const verdicts = {
    correct: ["的中", "correct"],
    incorrect: ["不的中", "incorrect"],
    tie: ["引き分け", "neutral"],
    "no-pick": ["予測なし", "neutral"],
  };
  const [label, className] = verdicts[snapshot?.verdict] || ["予測なし", "neutral"];
  const redPct = snapshot ? Math.round(snapshot.redProbability * 100) : null;
  return `<article class="result-card">
    <div class="result-heading"><div><strong>${escapeHtml(matchLabel(match))}</strong><span>${escapeHtml(matchTime(match))} · フィールド ${escapeHtml(String(match.field || "—"))}</span></div><span class="verdict ${className}">${label}</span></div>
    <div class="result-content"><div class="result-side red"><b>赤 · ${escapeHtml(red)}</b><div><span>実得点</span><strong>${formatNumber(match.redScore)}</strong></div><small>試合前予測 ${snapshot?.projected?.red ?? "—"} 点</small></div><div class="result-versus">対</div><div class="result-side blue"><b>青 · ${escapeHtml(blue)}</b><div><span>実得点</span><strong>${formatNumber(match.blueScore)}</strong></div><small>試合前予測 ${snapshot?.projected?.blue ?? "—"} 点</small></div></div>
    <div class="result-footer"><span>${snapshot ? `試合前の勝率 · 赤 ${redPct}% / 青 ${100 - redPct}%` : "試合前予測なし"}</span><span>終了後のデータはこの試合の予測に使用していません</span></div>
  </article>`;
}

function renderLeaderboard() {
  if (!state.data) return;
  const rated = [...state.roster].sort((a, b) => (state.ratings.get(Number(b.teamKey))?.rating || 0) - (state.ratings.get(Number(a.teamKey))?.rating || 0));
  const predictionRanks = new Map(rated.map((team, index) => [Number(team.teamKey), index + 1]));
  const rows = state.roster
    .filter((team) => searchText(team).includes(state.leaderQuery))
    .map((team) => ({ team, metric: state.ratings.get(Number(team.teamKey)) || {} }));
  const compare = {
    prediction: (a, b) => (b.metric.rating || 0) - (a.metric.rating || 0),
    official: (a, b) => nullableRank(a.team.rank) - nullableRank(b.team.rank),
    epa: (a, b) => nullableValue(b.metric.epa) - nullableValue(a.metric.epa),
    main: (a, b) => nullableValue(b.metric.mainEpa) - nullableValue(a.metric.mainEpa),
    endgame: (a, b) => nullableValue(b.metric.endgameEpa) - nullableValue(a.metric.endgameEpa),
    previous: (a, b) => nullableRank(a.metric.previousRank) - nullableRank(b.metric.previousRank),
  };
  rows.sort((a, b) => (compare[state.sort] || compare.prediction)(a, b) || displayName(a.team).localeCompare(displayName(b.team), "ja"));
  el["leaderboard-body"].innerHTML = rows.map(({ team, metric }) => {
    const key = Number(team.teamKey);
    const validPrediction = metric.historical || metric.modelGames;
    return `<tr data-team-key="${key}" class="${key === state.selectedTeamKey ? "selected" : ""}" tabindex="0" aria-label="${escapeHtml(displayName(team))}を選択">
      <td>${metric.epaRank ? `#${metric.epaRank}` : "—"}</td>
      <td><div class="table-team"><b>${escapeHtml(teamCode(team))}</b><span>${escapeHtml(displayName(team))}</span></div></td>
      <td>${formatDecimal(metric.epa)}</td>
      <td>${formatDecimal(metric.mainEpa)}</td>
      <td>${formatDecimal(metric.endgameEpa)}</td>
      <td>${formatNumber(metric.modelGames)}</td>
      <td>${team.rank == null ? "—" : `#${formatNumber(team.rank)}`}</td>
      <td>${validPrediction ? `#${predictionRanks.get(key)} · ${signed(metric.rating)}` : "—"}</td>
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
  return `${teamCode(record)} ${displayName(record)} ${record?.team?.name || ""}`.toLocaleLowerCase("ja");
}
function matchSearchText(match) {
  return `${match.name || ""} ${match.id || ""} ${matchLabel(match)} ${(match.participants || []).map((p) => searchText(p)).join(" ")}`.toLocaleLowerCase("ja");
}
function teamCodeFromParticipant(participant) {
  return String(participant.country || state.roster.find((team) => Number(team.teamKey) === Number(participant.teamKey))?.team?.country || "—").toUpperCase();
}
function teamChip(participant) {
  const code = teamCodeFromParticipant(participant);
  const selected = Number(participant.teamKey) === state.selectedTeamKey;
  return `<span class="team-chip ${selected ? "selected" : ""}"><b>${escapeHtml(code)}</b><small>${escapeHtml(displayName(participant))}</small></span>`;
}
function matchLabel(match) {
  const name = String(match.name || `Match ${match.id || ""}`);
  return name.replace(/^Ranking Match\s*/i, "ランキング戦 ").replace(/^Qualification Match\s*/i, "予選 ").replace(/^Match\s*/i, "試合 ");
}
function matchTime(match) {
  if (!match.scheduledTime) return "時刻未定";
  const date = new Date(match.scheduledTime);
  return Number.isNaN(date.getTime()) ? "時刻未定" : `${dateFormat.format(date)} 日本時間`;
}
function sortMatches(a, b) {
  const aTime = Date.parse(a.scheduledTime);
  const bTime = Date.parse(b.scheduledTime);
  return (Number.isFinite(aTime) ? aTime : Infinity) - (Number.isFinite(bTime) ? bTime : Infinity)
    || Number(a.id || 0) - Number(b.id || 0);
}
function statCard(label, value, note, emphasis = false) {
  return `<div class="stat-card ${emphasis ? "emphasis" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(note)}</small></div>`;
}
function formatNumber(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : numberFormat.format(Number(value));
}
function formatDecimal(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(1);
}
function signed(value) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}` : "—";
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
