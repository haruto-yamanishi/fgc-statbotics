import { fetchSeason } from "./api.js";
import { buildRoster, buildRatings, predictMatch, scoreContext, teamCode, teamNameJa as displayName } from "./predict.js";

const DEFAULT_TEAM = "JPN";
const AUTO_REFRESH_MS = 60_000;
const dateFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const numberFormat = new Intl.NumberFormat("ja-JP");

let historyPromise;
const state = {
  year: 2026,
  data: null,
  roster: [],
  ratings: new Map(),
  scoring: null,
  selectedTeamKey: null,
  selectedCode: DEFAULT_TEAM,
  loading: false,
  controller: null,
  scheduleView: "team",
  matchQuery: "",
  visibleMatches: 12,
  leaderQuery: "",
  sort: "prediction",
  historyYears: 0,
};

const ids = [
  "year-select", "event-state", "last-updated", "refresh-button", "data-note", "error-box",
  "team-search", "team-select", "selected-team-title", "team-summary", "prediction-source",
  "featured-prediction", "schedule-count", "show-team", "show-all", "match-search",
  "prediction-list", "show-more", "past-list", "leader-search", "sort-select", "leaderboard-body",
];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

el["year-select"].addEventListener("change", () => {
  state.year = Number(el["year-select"].value);
  state.visibleMatches = 12;
  loadSeason();
});
el["refresh-button"].addEventListener("click", loadSeason);
el["team-search"].addEventListener("input", updateTeamPicker);
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
el["leader-search"].addEventListener("input", () => {
  state.leaderQuery = el["leader-search"].value.trim().toLocaleLowerCase("ja");
  renderLeaderboard();
});
el["sort-select"].addEventListener("change", () => {
  state.sort = el["sort-select"].value;
  renderLeaderboard();
});

function getHistory() {
  if (!historyPromise) {
    historyPromise = Promise.allSettled([fetchSeason(2025), fetchSeason(2024)])
      .then((results) => {
        const seasons = results.map((result) => result.status === "fulfilled" ? result.value : null);
        if (seasons.some((season) => !season)) historyPromise = null;
        return seasons;
      });
  }
  return historyPromise;
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
    const data = await fetchSeason(state.year, controller.signal);
    const history = state.year === 2026 ? await getHistory() : [];
    if (controller.signal.aborted) return;
    state.data = data;
    state.roster = buildRoster(data.rankings, data.matches);
    state.ratings = buildRatings(state.roster, data.matches, history);
    state.scoring = scoreContext(data.matches);
    state.historyYears = history.filter(Boolean).length;
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
  const existing = state.roster.find((team) => Number(team.teamKey) === state.selectedTeamKey);
  if (existing) return;
  const byCode = state.roster.find((team) => teamCode(team) === state.selectedCode);
  state.selectedTeamKey = Number((byCode || state.roster[0])?.teamKey) || null;
}

function renderAll() {
  el["data-note"].hidden = Boolean(state.data.rankings.length);
  el["data-note"].textContent = state.data.rankings.length
    ? ""
    : "公式順位はまだ公開されていません。参加国は対戦表から表示し、勝率は過去の実績を使った暫定予測です。";
  el["prediction-source"].textContent = state.data.matches.some((match) => match.played)
    ? "今年の結果を反映"
    : state.historyYears ? `過去${state.historyYears}年の実績から推定` : "実績データ不足";
  updateTeamPicker();
  renderTeam();
  renderFeatured();
  renderSchedule();
  renderPast();
  renderLeaderboard();
}

function selectTeam(teamKey) {
  if (!state.roster.some((team) => Number(team.teamKey) === teamKey)) return;
  state.selectedTeamKey = teamKey;
  state.selectedCode = teamCode(selectedTeam());
  el["team-search"].value = "";
  updateTeamPicker();
  state.visibleMatches = 12;
  renderTeam();
  renderFeatured();
  renderSchedule();
  renderPast();
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

function updateTeamPicker() {
  if (!state.data) return;
  const query = el["team-search"].value.trim().toLocaleLowerCase("ja");
  const teams = state.roster
    .filter((team) => searchText(team).includes(query))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), "ja"));
  el["team-select"].innerHTML = teams.map((team) => `<option value="${Number(team.teamKey)}">${escapeHtml(teamCode(team))} · ${escapeHtml(displayName(team))}</option>`).join("");
  if (teams.some((team) => Number(team.teamKey) === state.selectedTeamKey)) {
    el["team-select"].value = String(state.selectedTeamKey);
  }
}

function renderTeam() {
  const team = selectedTeam();
  if (!team) {
    el["team-summary"].innerHTML = '<div class="empty-state">チームデータがありません。</div>';
    return;
  }
  const metric = state.ratings.get(Number(team.teamKey)) || {};
  const upcoming = teamMatches().filter((match) => !match.played).length;
  el["selected-team-title"].textContent = `${displayName(team)} · ${teamCode(team)}`;
  el["team-summary"].innerHTML = [
    statCard("これからの試合", formatNumber(upcoming), "公開済みの対戦表", true),
    statCard("公式順位", team.rank == null ? "—" : `#${formatNumber(team.rank)}`, team.rank == null ? "まだ未発表" : "FIRST Global 公式"),
    statCard("FGC EPA", formatDecimal(metric.epa), metric.modelGames ? `${metric.modelGames} 試合から算出` : "今年の試合後に算出"),
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
  const scoreText = prediction.projected
    ? `予測得点: 赤 ${prediction.projected.red} · 青 ${prediction.projected.blue}`
    : "得点予測は今年の結果が集まってから表示";
  el["featured-prediction"].innerHTML = `<article class="featured">
    <div class="featured-top"><strong>次の試合 · ${escapeHtml(matchLabel(next))}</strong><span class="match-meta">${escapeHtml(matchTime(next))} · フィールド ${escapeHtml(String(next.field || "—"))}</span></div>
    <div class="featured-body">
      <div class="alliance red"><span class="alliance-label">赤アライアンス</span><div class="alliance-team-list">${prediction.red.map(teamChip).join("")}</div></div>
      <div class="probability-center"><small>予測勝率</small><strong>${redPct}% <span style="color:#98a2b3;font-size:15px">対</span> ${bluePct}%</strong><div class="probability-bar" role="img" aria-label="赤 ${redPct} パーセント、青 ${bluePct} パーセント"><span style="width:${redPct}%"></span></div><div class="probability-labels"><span class="red-value">赤 ${redPct}%</span><span class="blue-value">青 ${bluePct}%</span></div></div>
      <div class="alliance blue"><span class="alliance-label">青アライアンス</span><div class="alliance-team-list">${prediction.blue.map(teamChip).join("")}</div></div>
    </div>
    <div class="featured-footer"><span>${escapeHtml(scoreText)}</span><span>過去実績あり ${prediction.covered}/${prediction.totalTeams} チーム · 独自モデルによる参考値</span></div>
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
    <div class="match-card-prediction"><div class="probability-bar" role="img" aria-label="赤 ${redPct} パーセント、青 ${100 - redPct} パーセント"><span style="width:${redPct}%"></span></div><div class="probability-labels"><span class="red-value">赤 ${redPct}%</span><span class="blue-value">青 ${100 - redPct}%</span></div><small>${prediction.projected ? `予測得点 ${prediction.projected.red} : ${prediction.projected.blue}` : `過去実績あり ${prediction.covered}/${prediction.totalTeams}`}</small></div>
  </article>`;
}

function renderPast() {
  const matches = teamMatches().filter((match) => match.played).sort(sortMatches).slice(-5).reverse();
  if (!matches.length) {
    el["past-list"].innerHTML = '<div class="empty-state">このチームの試合結果はまだありません。</div>';
    return;
  }
  el["past-list"].innerHTML = matches.map((match) => {
    const participant = match.participants.find((p) => Number(p.teamKey) === state.selectedTeamKey);
    const red = Number(participant.station) < 20;
    const allies = match.participants.filter((p) => (Number(p.station) < 20) === red).map(teamCodeFromParticipant);
    const opponents = match.participants.filter((p) => (Number(p.station) < 20) !== red).map(teamCodeFromParticipant);
    return `<div class="past-row"><strong>${escapeHtml(matchLabel(match))}</strong><span>${escapeHtml(allies.join(" · "))} 対 ${escapeHtml(opponents.join(" · "))}</span><strong>${formatNumber(red ? match.redScore : match.blueScore)} : ${formatNumber(red ? match.blueScore : match.redScore)}</strong></div>`;
  }).join("");
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
    previous: (a, b) => nullableRank(a.metric.previousRank) - nullableRank(b.metric.previousRank),
  };
  rows.sort((a, b) => (compare[state.sort] || compare.prediction)(a, b) || displayName(a.team).localeCompare(displayName(b.team), "ja"));
  el["leaderboard-body"].innerHTML = rows.map(({ team, metric }) => {
    const key = Number(team.teamKey);
    const validPrediction = metric.historical || metric.modelGames;
    return `<tr data-team-key="${key}" class="${key === state.selectedTeamKey ? "selected" : ""}" tabindex="0" aria-label="${escapeHtml(displayName(team))}を選択">
      <td>${validPrediction ? `#${predictionRanks.get(key)}` : "—"}</td>
      <td><div class="table-team"><b>${escapeHtml(teamCode(team))}</b><span>${escapeHtml(displayName(team))}</span></div></td>
      <td>${team.rank == null ? "—" : `#${formatNumber(team.rank)}`}</td>
      <td>${formatDecimal(metric.epa)}</td>
      <td>${metric.previousRank == null ? "—" : `#${formatNumber(metric.previousRank)}`}</td>
      <td>${validPrediction ? signed(metric.rating) : "—"}</td>
      <td>${formatNumber(team.played)}</td>
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
loadSeason();
setInterval(() => { if (!document.hidden && !state.loading) loadSeason(); }, AUTO_REFRESH_MS);
