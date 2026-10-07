import { fetchSeason } from "./api.js";
import { buildTeamMetrics, allianceRows } from "./epa.js";

const DEFAULT_TEAM = "JPN";
const AUTO_REFRESH_MS = 60_000;

const state = {
  year: 2026,
  data: null,
  metrics: new Map(),
  selectedTeamKey: null,
  selectedCode: DEFAULT_TEAM,
  loading: false,
  controller: null,
  leaderQuery: "",
  sort: "official",
};

const el = Object.fromEntries([
  "year-select", "event-state", "last-updated", "refresh-button", "team-search", "team-select",
  "selected-team-title", "team-summary", "epa-feature", "trend-chart", "team-matches", "leader-search",
  "sort-select", "leaderboard-body", "error-box",
].map((id) => [id, document.getElementById(id)]));

el["year-select"].addEventListener("change", () => {
  state.year = Number(el["year-select"].value);
  loadSeason();
});
el["refresh-button"].addEventListener("click", loadSeason);
el["team-select"].addEventListener("change", () => selectTeam(Number(el["team-select"].value)));
el["team-search"].addEventListener("input", updateTeamPicker);
el["leader-search"].addEventListener("input", () => {
  state.leaderQuery = el["leader-search"].value.trim().toLowerCase();
  renderLeaderboard();
});
el["sort-select"].addEventListener("change", () => {
  state.sort = el["sort-select"].value;
  renderLeaderboard();
});

async function loadSeason() {
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.loading = true;
  setError("");
  el["event-state"].textContent = `Loading ${state.year} results`;
  el["refresh-button"].disabled = true;

  try {
    const data = await fetchSeason(state.year, state.controller.signal);
    state.data = data;
    state.metrics = buildTeamMetrics(data.rankings, data.matches);
    reconcileSelection();
    renderAll();
    const played = data.matches.filter((m) => m.played).length;
    el["event-state"].textContent = `${state.year} live · ${played} matches posted`;
    el["last-updated"].textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date());
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error(error);
      setError(`${error.message}. If this is a local file, serve the folder over HTTP (for example: python3 -m http.server 8080).`);
      el["event-state"].textContent = "Live data unavailable";
    }
  } finally {
    state.loading = false;
    el["refresh-button"].disabled = false;
  }
}

function reconcileSelection() {
  const rankings = state.data?.rankings || [];
  const existing = rankings.find((r) => Number(r.teamKey) === Number(state.selectedTeamKey));
  if (existing) return;
  const byCode = rankings.find((r) => teamCode(r).toUpperCase() === state.selectedCode.toUpperCase());
  state.selectedTeamKey = Number((byCode || rankings[0])?.teamKey ?? 0) || null;
}

function renderAll() {
  updateTeamPicker();
  renderSelectedTeam();
  renderLeaderboard();
}

function selectTeam(teamKey) {
  if (!Number.isFinite(teamKey)) return;
  state.selectedTeamKey = teamKey;
  const ranking = getSelectedRanking();
  if (ranking) state.selectedCode = teamCode(ranking);
  el["team-select"].value = String(teamKey);
  renderSelectedTeam();
  renderLeaderboard();
  history.replaceState(null, "", `#team=${encodeURIComponent(state.selectedCode)}`);
}

function updateTeamPicker() {
  if (!state.data) return;
  const query = el["team-search"].value.trim().toLowerCase();
  const rankings = [...state.data.rankings]
    .filter((r) => !query || `${teamCode(r)} ${teamName(r)}`.toLowerCase().includes(query))
    .sort((a, b) => teamName(a).localeCompare(teamName(b)));

  el["team-select"].innerHTML = rankings.map((r) => `<option value="${Number(r.teamKey)}">${escapeHtml(teamCode(r))} — ${escapeHtml(teamName(r))}</option>`).join("");
  if (state.selectedTeamKey) el["team-select"].value = String(state.selectedTeamKey);
}

function renderSelectedTeam() {
  const ranking = getSelectedRanking();
  if (!ranking) return;
  const metric = state.metrics.get(Number(ranking.teamKey)) || {};
  el["selected-team-title"].textContent = `${teamName(ranking)} · ${teamCode(ranking)}`;

  const status = performanceStatus(metric.epaPercentile, ranking.rank, state.data.rankings.length);
  el["team-summary"].innerHTML = [
    statCard("Official rank", ordinal(ranking.rank), `of ${state.data.rankings.length}`, true),
    statCard("Ranking score", formatNumber(ranking.rankingScore), "official"),
    statCard("Highest points", formatNumber(ranking.highestScore), "single match"),
    statCard("Climb points", formatNumber(ranking.climbPoints), "tiebreak metric"),
    statCard("FGC EPA", formatDecimal(metric.epa), metric.epaRank ? `#${metric.epaRank} model rank` : "model pending", true),
    statCard("Recent form", signed(metric.form), status),
  ].join("");

  renderEpaFeature(ranking, metric);
  renderTrend(ranking);
  renderMatches(ranking);
}

function renderEpaFeature(ranking, metric) {
  const percentile = Number.isFinite(metric.epaPercentile) ? Math.round(metric.epaPercentile) : null;
  const confidence = Number.isFinite(metric.confidence) ? Math.round(metric.confidence * 100) : 0;
  el["epa-feature"].innerHTML = `
    <div class="epa-number">${formatDecimal(metric.epa)}<small>pts/team</small></div>
    <div class="epa-meta">
      <span><strong>${metric.epaRank ? `#${metric.epaRank}` : "—"}</strong> EPA rank</span>
      <span><strong>${percentile == null ? "—" : `${percentile}%`}</strong> percentile</span>
      <span><strong>${metric.modelGames ?? 0}</strong> model matches</span>
      <span><strong>${confidence}%</strong> confidence</span>
    </div>
    <div class="performance-label">${escapeHtml(performanceStatus(metric.epaPercentile, ranking.rank, state.data.rankings.length))}</div>`;
}

function renderTrend(ranking) {
  const key = Number(ranking.teamKey);
  const rows = allianceRows(state.data.matches).filter((row) => row.teamKeys.includes(key));
  if (!rows.length) {
    el["trend-chart"].innerHTML = `<div class="trend-empty">No played ranking matches yet.</div>`;
    return;
  }

  const values = rows.map((r) => r.score);
  const width = 620, height = 180, padX = 24, padY = 20;
  const min = Math.min(...values), max = Math.max(...values);
  const spread = Math.max(10, max - min);
  const yMin = Math.max(0, min - spread * .2), yMax = max + spread * .2;
  const x = (i) => padX + (values.length === 1 ? (width - 2 * padX) / 2 : i * (width - 2 * padX) / (values.length - 1));
  const y = (v) => height - padY - ((v - yMin) / (yMax - yMin || 1)) * (height - 2 * padY);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${padX},${height - padY} ${points} ${x(values.length - 1)},${height - padY}`;
  const grids = [0, .5, 1].map((t) => {
    const gy = padY + t * (height - 2 * padY);
    const gv = yMax - t * (yMax - yMin);
    return `<line x1="${padX}" y1="${gy}" x2="${width - padX}" y2="${gy}" class="chart-grid"/><text x="0" y="${gy + 3}" class="chart-axis">${Math.round(gv)}</text>`;
  }).join("");
  const dots = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" class="chart-dot"><title>Match ${i + 1}: ${v} points</title></circle>`).join("");

  el["trend-chart"].innerHTML = `<div class="chart-wrap">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Alliance score by played match">
      <defs><linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#67e8f9" stop-opacity=".22"/><stop offset="100%" stop-color="#67e8f9" stop-opacity="0"/></linearGradient></defs>
      ${grids}<polygon points="${area}" class="chart-area"/><polyline points="${points}" class="chart-line"/>${dots}
    </svg>
    <div class="chart-caption"><span>First played match</span><span>${values.length} match${values.length === 1 ? "" : "es"}</span><span>Latest</span></div>
  </div>`;
}

function renderMatches(ranking) {
  const key = Number(ranking.teamKey);
  const matches = [...state.data.matches]
    .filter((m) => (m.participants || []).some((p) => Number(p.teamKey) === key))
    .sort((a, b) => matchSortKey(a) - matchSortKey(b));
  const played = matches.filter((m) => m.played).slice(-4).reverse();
  const upcoming = matches.filter((m) => !m.played).slice(0, 4);
  const shown = [...upcoming, ...played].slice(0, 8);

  if (!shown.length) {
    el["team-matches"].innerHTML = `<div class="trend-empty">No matches found for this team.</div>`;
    return;
  }
  el["team-matches"].innerHTML = shown.map((m) => matchRow(m, key)).join("");
}

function matchRow(match, selectedKey) {
  const participants = match.participants || [];
  const selected = participants.find((p) => Number(p.teamKey) === selectedKey);
  const onRed = Number(selected?.station) < 20;
  const own = participants.filter((p) => (Number(p.station) < 20) === onRed).map((p) => p.country || p.teamKey);
  const other = participants.filter((p) => (Number(p.station) < 20) !== onRed).map((p) => p.country || p.teamKey);
  const ownScore = onRed ? match.redScore : match.blueScore;
  const otherScore = onRed ? match.blueScore : match.redScore;
  const time = match.scheduledTime ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(match.scheduledTime)) : "Time TBD";
  return `<div class="match-row">
    <div class="match-label"><strong>${escapeHtml(String(match.name || "Match").replace("Qualification", "Ranking"))}</strong><span>${escapeHtml(time)}${match.field ? ` · F${match.field}` : ""}</span></div>
    <div class="match-teams"><strong>${escapeHtml(own.join(" · "))}</strong><small>with · vs ${escapeHtml(other.join(" · "))}</small></div>
    <div class="match-score">${match.played ? `<strong>${formatNumber(ownScore)}</strong><span>other ${formatNumber(otherScore)}</span>` : `<strong>—</strong><span>upcoming</span>`}</div>
  </div>`;
}

function renderLeaderboard() {
  if (!state.data) return;
  let rows = state.data.rankings.map((r) => ({ ranking: r, metric: state.metrics.get(Number(r.teamKey)) || {} }));
  if (state.leaderQuery) rows = rows.filter(({ ranking }) => `${teamCode(ranking)} ${teamName(ranking)}`.toLowerCase().includes(state.leaderQuery));

  const sorters = {
    official: (a, b) => num(a.ranking.rank, 9999) - num(b.ranking.rank, 9999),
    epa: (a, b) => num(b.metric.epa, -Infinity) - num(a.metric.epa, -Infinity),
    rankingScore: (a, b) => num(b.ranking.rankingScore, -Infinity) - num(a.ranking.rankingScore, -Infinity),
    highestScore: (a, b) => num(b.ranking.highestScore, -Infinity) - num(a.ranking.highestScore, -Infinity),
    climbPoints: (a, b) => num(b.ranking.climbPoints, -Infinity) - num(a.ranking.climbPoints, -Infinity),
    form: (a, b) => num(b.metric.form, -Infinity) - num(a.metric.form, -Infinity),
  };
  rows.sort(sorters[state.sort] || sorters.official);

  el["leaderboard-body"].innerHTML = rows.map(({ ranking, metric }) => {
    const selected = Number(ranking.teamKey) === Number(state.selectedTeamKey);
    return `<tr data-team-key="${Number(ranking.teamKey)}" class="${selected ? "selected" : ""}">
      <td>#${formatNumber(ranking.rank)}</td>
      <td><div class="team-cell"><span class="team-code">${escapeHtml(teamCode(ranking))}</span><span class="team-name">${escapeHtml(teamName(ranking))}</span></div></td>
      <td>${formatDecimal(metric.epa)}</td>
      <td>${metric.epaRank ? `#${metric.epaRank}` : "—"}</td>
      <td>${formatNumber(ranking.rankingScore)}</td>
      <td>${formatNumber(ranking.highestScore)}</td>
      <td>${formatNumber(ranking.climbPoints)}</td>
      <td>${formatNumber(ranking.played)}</td>
      <td class="${Number(metric.form) > 0 ? "value-positive" : Number(metric.form) < 0 ? "value-negative" : ""}">${signed(metric.form)}</td>
    </tr>`;
  }).join("");

  el["leaderboard-body"].querySelectorAll("tr[data-team-key]").forEach((row) => {
    row.addEventListener("click", () => selectTeam(Number(row.dataset.teamKey)));
  });
}

function getSelectedRanking() {
  return state.data?.rankings.find((r) => Number(r.teamKey) === Number(state.selectedTeamKey));
}
function teamCode(r) { return String(r?.team?.country || r?.country || r?.team?.countryCode || r?.teamKey || "—").toUpperCase(); }
function teamName(r) { return String(r?.team?.shortName || r?.team?.name || r?.team?.countryName || teamCode(r)); }
function statCard(label, value, sub, highlight = false) { return `<article class="card stat-card ${highlight ? "highlight" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(String(sub || ""))}</small></article>`; }
function formatNumber(value) { const n = Number(value); return Number.isFinite(n) ? new Intl.NumberFormat().format(n) : "—"; }
function formatDecimal(value) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(1) : "—"; }
function signed(value) { const n = Number(value); return Number.isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(1)}` : "—"; }
function ordinal(value) { const n = Number(value); if (!Number.isFinite(n)) return "—"; const mod100 = n % 100; const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : ({1:"st",2:"nd",3:"rd"}[n % 10] || "th"); return `${n}${suffix}`; }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function matchSortKey(m) { if (m.scheduledTime) return new Date(m.scheduledTime).getTime(); const n = Number(String(m.name || "").match(/(\d+)/)?.[1]); return Number.isFinite(n) ? n : 0; }
function performanceStatus(percentile, officialRank, total) {
  const pct = Number(percentile);
  if (Number.isFinite(pct) && pct >= 90) return "Elite scoring pace · top 10% EPA";
  if (Number.isFinite(pct) && pct >= 75) return "Strong scoring pace · top quartile EPA";
  const rankPct = total ? Number(officialRank) / total : 1;
  if (rankPct <= .25) return "Officially on a strong qualification pace";
  if (Number.isFinite(pct) && pct >= 50) return "Above-average scoring pace";
  return "Still building sample size / pace";
}
function setError(message) { el["error-box"].hidden = !message; el["error-box"].textContent = message; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

const hashCode = new URLSearchParams(location.hash.replace(/^#/, "")).get("team");
if (hashCode) state.selectedCode = hashCode.toUpperCase();
loadSeason();
setInterval(() => { if (!document.hidden && !state.loading) loadSeason(); }, AUTO_REFRESH_MS);
