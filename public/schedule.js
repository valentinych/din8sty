/**
 * Top-4 schedule page — same query/filters as /top4/schedule
 * (club_leagues=GB1,ES1,IT1,L1 · GW2–43 · cups/supers/Europe via clubs).
 */
const $ = (id) => document.getElementById(id);

const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

const TOP4_LEAGUES = [
  { id: "GB1", label: "ENG · PL" },
  { id: "ES1", label: "SPA · LaLiga" },
  { id: "IT1", label: "ITA · Serie A" },
  { id: "L1", label: "GER · Bundesliga" },
];
const TOP4_LEAGUE_IDS = TOP4_LEAGUES.map((l) => l.id).join(",");
const SCHED_GW_MIN = 2;
const SCHED_GW_MAX = 43;

const state = {
  league: "",
  club: "",
  status: "",
  gameweek: "",
  xi: "",
  full: "",
  clubs: [],
  xiTeams: [],
  urlFiltered: false,
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `<span class="when"><span class="date">${date}</span><span class="sub">${time}</span></span>`;
}

function scoreCell(f) {
  const done = ["FT", "AET", "PEN"].includes(f.status);
  const live = ["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT"].includes(f.status);
  if (f.home_goals != null && f.away_goals != null) {
    const cls = done ? "score done" : live ? "score live" : "score";
    return `<span class="${cls}">${f.home_goals}:${f.away_goals}</span>`;
  }
  return `<span class="score empty">—</span>`;
}

function teamCell(name, crest, clubName) {
  const label = clubName || name || "—";
  const crestSrc = crest ? escapeHtml(crest) : "";
  return `<div class="player">
    ${crestSrc ? `<img class="crest" src="${crestSrc}" alt="" loading="lazy" />` : `<span class="crest"></span>`}
    <span>${escapeHtml(label)}</span>
  </div>`;
}

function opponentCell(f, clubId) {
  const focus = clubId != null ? String(clubId) : "";
  const isHome = focus && String(f.home_club_id ?? "") === focus;
  const isAway = focus && String(f.away_club_id ?? "") === focus;
  let ha;
  let name;
  let crest;
  let clubName;
  let clubCode;
  if (isHome) {
    ha = "H";
    name = f.away_name;
    crest = f.away_crest;
    clubName = f.away_club_name;
    clubCode = f.away_club_code;
  } else if (isAway) {
    ha = "A";
    name = f.home_name;
    crest = f.home_crest;
    clubName = f.home_club_name;
    clubCode = f.home_club_code;
  } else {
    ha = "?";
    name = `${f.home_club_name || f.home_name || "—"} — ${f.away_club_name || f.away_name || "—"}`;
    crest = null;
    clubName = null;
    clubCode = null;
  }
  const label = clubName || name || "—";
  const code = clubCode || label;
  const crestSrc = crest ? escapeHtml(crest) : "";
  return `<div class="opponent-cell">
    <span class="ha" title="${ha === "H" ? tr("common.home") : ha === "A" ? tr("common.away") : ""}">${escapeHtml(ha)}</span>
    <span class="ha-sep" aria-hidden="true">·</span>
    ${crestSrc ? `<img class="crest" src="${crestSrc}" alt="" loading="lazy" />` : `<span class="crest"></span>`}
    <span class="opp-name">${escapeHtml(label)}</span>
    <span class="opp-code" title="${escapeHtml(label)}">${escapeHtml(code)}</span>
  </div>`;
}

function resultCell(f) {
  const status = f.status || "—";
  const hasScore = f.home_goals != null && f.away_goals != null;
  if (hasScore) {
    return `<span class="result-cell">${scoreCell(f)} <span class="badge">${escapeHtml(status)}</span></span>`;
  }
  return `<span class="badge">${escapeHtml(status)}</span>`;
}

function codeCell(teams, focusCode) {
  if (!teams.length) return `<span class="sched-xi-empty">—</span>`;
  const focus = String(focusCode || "").toUpperCase();
  return `<span class="sched-xi">${teams
    .map((t) => {
      const code = String(t.code || "").toUpperCase();
      const on = focus && code === focus;
      return `<span class="sched-xi-code${on ? " is-focus" : ""}" title="${escapeHtml(t.name || t.code)}">${escapeHtml(t.code)}</span>`;
    })
    .join("")}</span>`;
}

function xiCell(f) {
  return codeCell(Array.isArray(f.xi_teams) ? f.xi_teams : [], state.xi);
}

function fullCell(f) {
  return codeCell(Array.isArray(f.full_teams) ? f.full_teams : [], state.full);
}

function setFixturesHeader(compact) {
  const thead = document.querySelector("#sched-table thead tr");
  if (!thead) return;
  const xiTh = `<th title="${escapeHtml(tr("schedule.xiHint"))}">${tr("schedule.xi")}</th>`;
  const fullTh = `<th title="${escapeHtml(tr("schedule.fullHint"))}">${tr("schedule.full")}</th>`;
  thead.innerHTML = compact
    ? `<th>${tr("common.date")}</th><th>GW</th><th>${tr("common.competition")}</th><th>${tr("common.opponent")}</th>${xiTh}${fullTh}<th>${tr("common.status")}</th>`
    : `<th>${tr("common.date")}</th><th>GW</th><th>${tr("common.competition")}</th><th>${tr("common.roundCol")}</th><th>${tr("common.homeTeam")}</th><th></th><th>${tr("common.awayTeam")}</th>${xiTh}${fullTh}<th>${tr("common.status")}</th>`;
  $("sched-table")?.classList.toggle("club-fixtures", compact);
  $("sched-table")?.classList.add("has-xi", "has-full");
  $("sched-table-wrap")?.classList.toggle("club-fixtures-wrap", compact);
}

function pickDefaultSchedGw(gameweeks) {
  const inRange = (gameweeks || []).filter((g) => {
    const n = Number(g.gameweek);
    return n >= SCHED_GW_MIN && n <= SCHED_GW_MAX;
  });
  if (!inRange.length) return "";
  const now = Date.now();
  const current = inRange.find((g) => {
    const start = Date.parse(g.start);
    const end = Date.parse(g.end);
    return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
  });
  if (current) return String(current.gameweek);
  const upcoming = inRange.find((g) => Date.parse(g.start) > now);
  if (upcoming) return String(upcoming.gameweek);
  return String(inRange[0].gameweek);
}

async function loadGameweeks() {
  const res = await fetch("/api/gameweeks");
  const data = await res.json();
  const sel = $("gameweek");
  const prev = state.gameweek;
  sel.innerHTML = `<option value="">${tr("schedule.allGw", { min: SCHED_GW_MIN, max: SCHED_GW_MAX })}</option>`;
  const inRange = (data.gameweeks || []).filter((g) => {
    const n = Number(g.gameweek);
    return n >= SCHED_GW_MIN && n <= SCHED_GW_MAX;
  });
  for (const g of inRange) {
    const opt = document.createElement("option");
    opt.value = String(g.gameweek);
    opt.textContent = g.label || `GW${g.gameweek}`;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  } else if (!state.urlFiltered) {
    const def = pickDefaultSchedGw(data.gameweeks);
    state.gameweek = def;
    sel.value = def;
  } else {
    state.gameweek = "";
    sel.value = "";
  }
}

async function loadClubs() {
  const league = state.league;
  const url = league ? `/api/clubs?league=${encodeURIComponent(league)}` : "/api/clubs";
  const res = await fetch(url);
  const data = await res.json();
  const top4 = new Set(TOP4_LEAGUES.map((l) => l.id));
  state.clubs = league
    ? data.clubs || []
    : (data.clubs || []).filter((c) => top4.has(c.league_id));
  const sel = $("club");
  const prev = state.club;
  sel.innerHTML = `<option value="">${tr("common.allClubs")}</option>`;
  for (const c of state.clubs) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if (prev && state.clubs.some((c) => c.id === prev)) {
    sel.value = prev;
  } else if (prev && state.urlFiltered) {
    const opt = document.createElement("option");
    opt.value = prev;
    opt.textContent = prev;
    sel.appendChild(opt);
    sel.value = prev;
  } else {
    state.club = "";
    sel.value = "";
  }
}

async function loadXiTeams() {
  const sel = $("xi");
  const fullSel = $("full");
  if (!sel && !fullSel) return;
  try {
    const res = await fetch("/api/top4");
    const data = await res.json();
    const teams = (data.registrations || data.squads?.teams || [])
      .map((t) => ({
        code: String(t.team_code || "").trim().toUpperCase(),
        name: String(t.team_name || t.name || "").trim(),
      }))
      .filter((t) => t.code);
    teams.sort((a, b) => a.code.localeCompare(b.code));
    const uniq = [];
    const seen = new Set();
    for (const t of teams) {
      if (seen.has(t.code)) continue;
      seen.add(t.code);
      uniq.push(t);
    }
    state.xiTeams = uniq;
  } catch {
    state.xiTeams = [];
  }
  fillCodeFilter(sel, "xi");
  fillCodeFilter(fullSel, "full");
}

function fillCodeFilter(sel, key) {
  if (!sel) return;
  const prev = state[key];
  sel.innerHTML = `<option value="">${tr("schedule.allXi")}</option>`;
  for (const t of state.xiTeams) {
    const opt = document.createElement("option");
    opt.value = t.code;
    opt.textContent = t.name ? `${t.code} · ${t.name}` : t.code;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  } else if (prev && state.urlFiltered) {
    const opt = document.createElement("option");
    opt.value = prev;
    opt.textContent = prev;
    sel.appendChild(opt);
    sel.value = prev;
  } else {
    state[key] = "";
    sel.value = "";
  }
}

async function loadFixtures() {
  const params = new URLSearchParams();
  params.set("gw_min", String(SCHED_GW_MIN));
  params.set("gw_max", String(SCHED_GW_MAX));
  // Clubs from selected Top-4 league (or all Top-4): domestic + cups + supers + Europe.
  if (state.club) params.set("club", state.club);
  else if (state.league) params.set("club_leagues", state.league);
  else params.set("club_leagues", TOP4_LEAGUE_IDS);
  if (state.status) params.set("status", state.status);
  if (state.gameweek) params.set("gameweek", state.gameweek);
  params.set("xi", "1");

  const res = await fetch(`/api/fixtures?${params}`);
  const data = await res.json();
  const compact = Boolean(state.club);
  setFixturesHeader(compact);

  const xiFocus = String(state.xi || "").toUpperCase();
  const fullFocus = String(state.full || "").toUpperCase();
  const fixtures = (data.fixtures || []).filter((f) => {
    if (
      xiFocus &&
      !(f.xi_teams || []).some((t) => String(t.code || "").toUpperCase() === xiFocus)
    ) {
      return false;
    }
    if (
      fullFocus &&
      !(f.full_teams || []).some(
        (t) => String(t.code || "").toUpperCase() === fullFocus,
      )
    ) {
      return false;
    }
    return true;
  });

  $("meta").textContent = tr("league.schedShown4", {
    min: SCHED_GW_MIN,
    max: SCHED_GW_MAX,
    n: fixtures.length,
  });

  const body = $("rows");
  if (!fixtures.length) {
    body.innerHTML = `<tr><td colspan="${compact ? 7 : 10}" class="sub">${tr("common.noMatches")}</td></tr>`;
    return;
  }

  body.innerHTML = fixtures
    .map((f) => {
      const round = (f.round || "").replace(/^Regular Season - /, tr("common.round"));
      const gw =
        f.gameweek != null
          ? `<span class="badge">GW${escapeHtml(f.gameweek)}</span>`
          : `<span class="sub">—</span>`;
      const competition = f.competition_name || f.league_name || f.league_id || "";
      if (compact) {
        return `<tr>
          <td class="when-cell">${fmtWhen(f.date)}</td>
          <td class="gw-cell">${gw}</td>
          <td class="comp-cell">
            <span class="comp-name">${escapeHtml(competition)}</span>
            ${round ? `<span class="sub">${escapeHtml(round)}</span>` : ""}
          </td>
          <td class="opp-cell">${opponentCell(f, state.club)}</td>
          <td class="xi-td">${xiCell(f)}</td>
          <td class="full-td">${fullCell(f)}</td>
          <td class="result-td">${resultCell(f)}</td>
        </tr>`;
      }
      return `<tr>
        <td>${fmtWhen(f.date)}</td>
        <td>${gw}</td>
        <td>${escapeHtml(competition)}</td>
        <td class="sub">${escapeHtml(round)}</td>
        <td>${teamCell(f.home_name, f.home_crest, f.home_club_name)}</td>
        <td class="score-cell">${scoreCell(f)}</td>
        <td>${teamCell(f.away_name, f.away_crest, f.away_club_name)}</td>
        <td class="xi-td">${xiCell(f)}</td>
        <td class="full-td">${fullCell(f)}</td>
        <td><span class="badge">${escapeHtml(f.status || "—")}</span></td>
      </tr>`;
    })
    .join("");
}

function bind() {
  $("gameweek").addEventListener("change", (e) => {
    state.gameweek = e.target.value;
    loadFixtures();
  });
  $("league").addEventListener("change", async (e) => {
    state.league = e.target.value;
    await loadClubs();
    await loadFixtures();
  });
  $("club").addEventListener("change", (e) => {
    state.club = e.target.value;
    loadFixtures();
  });
  $("status").addEventListener("change", (e) => {
    state.status = e.target.value;
    loadFixtures();
  });
  $("xi")?.addEventListener("change", (e) => {
    state.xi = e.target.value;
    loadFixtures();
  });
  $("full")?.addEventListener("change", (e) => {
    state.full = e.target.value;
    loadFixtures();
  });
}

function readUrlState() {
  const p = new URLSearchParams(location.search);
  if (p.get("club")) state.club = p.get("club");
  if (p.get("league")) state.league = p.get("league");
  if (p.get("gameweek")) state.gameweek = p.get("gameweek");
  if (p.get("status")) state.status = p.get("status");
  if (p.get("xi")) state.xi = String(p.get("xi") || "").trim().toUpperCase();
  if (p.get("full")) state.full = String(p.get("full") || "").trim().toUpperCase();
  state.urlFiltered = Boolean(
    state.club || state.league || state.gameweek || state.status || state.xi || state.full,
  );
}

function fillLeagueSelect() {
  const sel = $("league");
  if (!sel || sel.options.length > 1) return;
  for (const l of TOP4_LEAGUES) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.label;
    sel.appendChild(opt);
  }
  if (state.league && [...sel.options].some((o) => o.value === state.league)) {
    sel.value = state.league;
  }
}

async function init() {
  readUrlState();
  fillLeagueSelect();
  bind();
  if (state.status) $("status").value = state.status;
  await Promise.all([loadGameweeks(), loadClubs(), loadXiTeams()]);
  await loadFixtures();
  document.addEventListener("din8sty:lang", async () => {
    if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
    fillLeagueSelect();
    await loadGameweeks();
    await loadClubs();
    await loadXiTeams();
    await loadFixtures();
  });
}

init().catch((err) => {
  console.error(err);
  $("meta").textContent = String(err);
});
