const $ = (id) => document.getElementById(id);

const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

const LEAGUE_ORDER = ["GB1", "ES1", "L1", "FR1", "IT1", "PO1", "NL1", "BE1"];
const TOP8_LEAGUES = [
  { id: "GB1", label: "ENG · PL" },
  { id: "ES1", label: "SPA · LaLiga" },
  { id: "L1", label: "GER · Bundesliga" },
  { id: "FR1", label: "FRA · Ligue 1" },
  { id: "IT1", label: "ITA · Serie A" },
  { id: "PO1", label: "POR · Liga Portugal" },
  { id: "NL1", label: "NED · Eredivisie" },
  { id: "BE1", label: "BEL · Jupiler" },
];
const POOL_PAGE_SIZE = 100;
const ROLE_TO_LINE = {
  GK: "GK",
  LB: "DEF",
  CB: "DEF",
  RB: "DEF",
  LWB: "DEF",
  RWB: "DEF",
  DM: "MID",
  CM: "MID",
  AM: "MID",
  LM: "MID",
  RM: "MID",
  LW: "ATT",
  RW: "ATT",
  SS: "ATT",
  CF: "ATT",
  ST: "ATT",
};

let state = {
  data: null,
  tab: "overview",
  teamId: null,
  gw: null,
  myTeamId: null,
  claimedTeamIds: new Set(),
  isAdmin: false,
  /** Undrafted Top-8 players (full pool minus primer picks). */
  poolPlayers: [],
  poolPage: 1,
  poolSortKey: "rating",
  poolSortDir: -1,
  filters: {
    league: "",
    club: "",
    line: "",
    pos: "",
    mvMin: 0,
    mvMax: 0,
    wageMin: 0,
    wageMax: 0,
  },
  bounds: {
    mvMin: 0,
    mvMax: 1,
    wageMin: 0,
    wageMax: 1,
  },
  /** @type {{ roster: {key:string,dir:number}, xi: {key:string,dir:number}, bench: {key:string,dir:number} }} */
  teamSort: {
    roster: { key: "pick", dir: 1 },
    xi: { key: "slot", dir: 1 },
    bench: { key: "name", dir: 1 },
  },
};

const ROSTER_GET = {
  pick: (p) => p.pick,
  name: (p) => p.name,
  pos: (p) => p.position_display,
  club: (p) => p.club_name,
  league: (p) => p.league_id,
  rating: (p) => p.fm_rating,
  mv: (p) => p.market_value_eur,
  wage: (p) => p.wage_pw,
};
const ROSTER_NUM = new Set(["pick", "rating", "mv", "wage"]);

const LINEUP_GET = {
  slot: (p) => (p.slot_roles || []).join("/"),
  name: (p) => p.name,
  pos: (p) => p.position_display,
  line: (p) => p.fantasy_line,
  club: (p) => p.club_name,
  match: (p) =>
    p.is_home == null
      ? p.opponent || ""
      : `${p.is_home ? "H" : "A"} ${p.opponent || ""}`,
  xpts: (p) => p.xPts,
};
const LINEUP_NUM = new Set(["xpts"]);

function sortBy(list, sort, getters, numKeys) {
  if (!sort?.key || !getters[sort.key]) return list.slice();
  const dir = sort.dir || 1;
  const key = sort.key;
  const numeric = numKeys.has(key);
  return list.slice().sort((a, b) => {
    const va = getters[key](a);
    const vb = getters[key](b);
    let c;
    if (numeric) {
      const na = va == null || va === "" || !Number.isFinite(Number(va)) ? null : Number(va);
      const nb = vb == null || vb === "" || !Number.isFinite(Number(vb)) ? null : Number(vb);
      if (na == null && nb == null) c = 0;
      else if (na == null) c = 1;
      else if (nb == null) c = -1;
      else c = na - nb;
    } else {
      c = String(va ?? "").localeCompare(String(vb ?? ""), "ru", {
        sensitivity: "base",
        numeric: true,
      });
    }
    return c * dir || String(a.name ?? "").localeCompare(String(b.name ?? ""), "ru");
  });
}

function sortTh(label, key, sortState, table) {
  const active = sortState.key === key;
  const arrow = active ? (sortState.dir > 0 ? " ↑" : " ↓") : "";
  return `<th class="sortable${active ? " sorted" : ""}" data-sort-table="${esc(table)}" data-sort-key="${esc(key)}" role="columnheader" tabindex="0">${esc(label)}${arrow}</th>`;
}

function wireTeamSortHeaders(team) {
  $("panel").querySelectorAll("th.sortable[data-sort-key]").forEach((th) => {
    const activate = () => {
      const table = th.getAttribute("data-sort-table");
      const key = th.getAttribute("data-sort-key");
      if (!table || !key || !state.teamSort[table]) return;
      const cur = state.teamSort[table];
      if (cur.key === key) cur.dir *= -1;
      else {
        cur.key = key;
        cur.dir = 1;
      }
      renderTeam(team);
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });
}

function eur(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(v >= 100_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}K`;
  return `€${v}`;
}

/** Wage sums at ~1K precision: €2 847K */
function wageSum(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const k = Math.round(v / 1000);
  return `€${k.toLocaleString("ru-RU")}K`;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function budgetBadge(team, rules) {
  const mvOk = team.sum_market_value_eur <= rules.mv_cap;
  const wageOk = team.sum_wage_pw <= rules.wage_cap;
  const countOk = team.player_count >= (rules.rounds ?? 26);
  const leaguesOk = team.leagues_ok !== false;
  const clubsOk = team.clubs_ok !== false;
  const gkOk = team.gk_ok !== false;
  if (mvOk && wageOk && countOk && leaguesOk && clubsOk && gkOk) {
    return `<span class="status-pill ok">OK</span>`;
  }
  const bits = [];
  if (!countOk) bits.push(`&lt;${rules.rounds ?? 26}`);
  if (!mvOk) bits.push("MV");
  if (!wageOk) bits.push("wage");
  if (!leaguesOk) bits.push(tr("primer.failBits.league"));
  if (!clubsOk) bits.push(tr("primer.failBits.club"));
  if (!gkOk) bits.push("GK");
  return `<span class="status-pill bad">${bits.join(" · ")}</span>`;
}

function portraitCell(p) {
  const href = `/player.html?id=${encodeURIComponent(p.id)}`;
  if (p.portrait_url) {
    return `<a class="photo-link" href="${href}"><img class="primer-portrait" src="${esc(p.portrait_url)}" alt="" loading="lazy" /></a>`;
  }
  return `<span class="primer-portrait placeholder" aria-hidden="true"></span>`;
}

function playerNameCell(p) {
  return `<a class="player-link" href="/player.html?id=${encodeURIComponent(p.id)}"><span class="name">${esc(p.name)}</span></a>`;
}

function leagueStrip(team) {
  const leagues = team.leagues || {};
  return LEAGUE_ORDER.map((id) => {
    const n = leagues[id] ?? 0;
    const ok = n >= (state.data?.rules?.min_per_league ?? 3);
    return `<span class="league-chip${ok ? "" : " bad"}" title="${esc(id)}">${esc(id)} ${n}</span>`;
  }).join("");
}

function playerWage(p) {
  return Number(p.trusted_wage_pw ?? p.wage_pw) || 0;
}

function playerMv(p) {
  return Number(p.market_value_eur) || 0;
}

function primaryRole(p) {
  const raw = (p.detail_role || p.detail_label || p.position || "").toString().trim().toUpperCase();
  return raw === "ST" ? "CF" : raw;
}

function playerLine(p) {
  const role = primaryRole(p);
  if (ROLE_TO_LINE[role]) return ROLE_TO_LINE[role];
  const g = (p.position || "").toString().toUpperCase();
  if (g === "GK" || g === "DEF" || g === "MID" || g === "ATT") return g;
  return "";
}

function playerRoles(p) {
  const roles = new Set();
  const main = primaryRole(p);
  if (main) roles.add(main);
  const disp = String(p.position_display || "");
  const m = disp.match(/\(([^)]+)\)/);
  if (m) {
    for (const part of m[1].split(",")) {
      const r = part.trim().toUpperCase();
      if (r) roles.add(r === "ST" ? "CF" : r);
    }
  }
  const head = disp.split("(")[0].trim().toUpperCase();
  if (head) roles.add(head === "ST" ? "CF" : head);
  return [...roles];
}

function draftedIdSet() {
  const ids = new Set();
  for (const t of state.data?.teams || []) {
    for (const p of t.players || []) ids.add(String(p.id));
  }
  return ids;
}

function initPoolFilterBounds() {
  let mvMax = 0;
  let wageMax = 0;
  for (const p of state.poolPlayers) {
    mvMax = Math.max(mvMax, playerMv(p));
    wageMax = Math.max(wageMax, playerWage(p));
  }
  state.bounds = {
    mvMin: 0,
    mvMax: Math.max(mvMax, 1),
    wageMin: 0,
    wageMax: Math.max(wageMax, 1),
  };
  state.filters.mvMin = 0;
  state.filters.mvMax = state.bounds.mvMax;
  state.filters.wageMin = 0;
  state.filters.wageMax = state.bounds.wageMax;
}

async function loadUnpickedPool() {
  const leagues = TOP8_LEAGUES.map((l) => l.id).join(",");
  const res = await fetch(
    `/api/players?leagues=${encodeURIComponent(leagues)}&sort=rating-desc&limit=5000`,
  );
  if (!res.ok) throw new Error(`pool HTTP ${res.status}`);
  const data = await res.json();
  const picked = draftedIdSet();
  state.poolPlayers = (data.players || []).filter((p) => !picked.has(String(p.id)));
  initPoolFilterBounds();
  state.poolPage = 1;
}

function poolClubOptions() {
  const map = new Map();
  for (const p of state.poolPlayers) {
    if (state.filters.league && p.league_id !== state.filters.league) continue;
    const id = String(p.club_id || p.club_name || "");
    if (!id) continue;
    if (!map.has(id)) map.set(id, p.club_name || id);
  }
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
}

function poolPosOptions() {
  const set = new Set();
  for (const p of state.poolPlayers) {
    if (state.filters.league && p.league_id !== state.filters.league) continue;
    if (state.filters.line && playerLine(p) !== state.filters.line) continue;
    for (const r of playerRoles(p)) set.add(r);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function filteredUnpicked() {
  const f = state.filters;
  return state.poolPlayers.filter((p) => {
    if (f.league && p.league_id !== f.league) return false;
    if (f.club && String(p.club_id || p.club_name) !== f.club) return false;
    if (f.line && playerLine(p) !== f.line) return false;
    if (f.pos) {
      const roles = playerRoles(p);
      if (!roles.includes(f.pos)) return false;
    }
    const mv = playerMv(p);
    const w = playerWage(p);
    if (mv < f.mvMin || mv > f.mvMax) return false;
    if (w < f.wageMin || w > f.wageMax) return false;
    return true;
  });
}

function sortedUnpicked() {
  const key = state.poolSortKey;
  const dir = state.poolSortDir;
  const num = new Set(["rating", "mv", "wage"]);
  return filteredUnpicked().sort((a, b) => {
    let va;
    let vb;
    if (key === "rating") {
      va = a.fm_rating;
      vb = b.fm_rating;
    } else if (key === "mv") {
      va = a.market_value_eur;
      vb = b.market_value_eur;
    } else if (key === "wage") {
      va = playerWage(a);
      vb = playerWage(b);
    } else if (key === "pos") {
      va = a.position_display;
      vb = b.position_display;
    } else if (key === "club") {
      va = a.club_name;
      vb = b.club_name;
    } else if (key === "league") {
      va = a.league_id;
      vb = b.league_id;
    } else {
      va = a.name;
      vb = b.name;
    }
    let c;
    if (num.has(key)) {
      const na = va == null || !Number.isFinite(Number(va)) ? null : Number(va);
      const nb = vb == null || !Number.isFinite(Number(vb)) ? null : Number(vb);
      if (na == null && nb == null) c = 0;
      else if (na == null) c = 1;
      else if (nb == null) c = -1;
      else c = na - nb;
    } else {
      c = String(va ?? "").localeCompare(String(vb ?? ""), "ru", {
        sensitivity: "base",
        numeric: true,
      });
    }
    return c * dir || String(a.name ?? "").localeCompare(String(b.name ?? ""), "ru");
  });
}

function poolSortTh(label, key) {
  const active = state.poolSortKey === key;
  const arrow = active ? (state.poolSortDir > 0 ? " ↑" : " ↓") : "";
  return `<th class="sortable${active ? " sorted" : ""}" data-pool-sort="${esc(key)}" role="columnheader" tabindex="0">${esc(label)}${arrow}</th>`;
}

function renderPoolFilters() {
  const f = state.filters;
  const clubs = poolClubOptions();
  const roles = poolPosOptions();
  const leagueOpts = TOP8_LEAGUES.map(
    (l) => `<option value="${esc(l.id)}"${f.league === l.id ? " selected" : ""}>${esc(l.label)}</option>`,
  ).join("");
  const clubOpts = clubs
    .map(
      ([id, name]) =>
        `<option value="${esc(id)}"${f.club === id ? " selected" : ""}>${esc(name)}</option>`,
    )
    .join("");
  const posOpts = roles
    .map((r) => `<option value="${esc(r)}"${f.pos === r ? " selected" : ""}>${esc(r)}</option>`)
    .join("");

  return `
    <section class="filters top4-pool-filters" id="pool-filters">
      <label>
        Лига
        <select id="f-league">
          <option value="">Все топ-8</option>
          ${leagueOpts}
        </select>
      </label>
      <label>
        Клуб
        <select id="f-club">
          <option value="">Все клубы</option>
          ${clubOpts}
        </select>
      </label>
      <label>
        Линия
        <select id="f-line">
          <option value="">Все</option>
          <option value="GK"${f.line === "GK" ? " selected" : ""}>GK</option>
          <option value="DEF"${f.line === "DEF" ? " selected" : ""}>DEF</option>
          <option value="MID"${f.line === "MID" ? " selected" : ""}>MID</option>
          <option value="ATT"${f.line === "ATT" ? " selected" : ""}>ATT</option>
        </select>
      </label>
      <label>
        Позиция
        <select id="f-pos">
          <option value="">Все</option>
          ${posOpts}
        </select>
      </label>
      <label class="range-filter">
        Стоимость
        <div class="dual-range" data-kind="mv">
          <input type="range" id="f-mv-min" min="${state.bounds.mvMin}" max="${state.bounds.mvMax}" step="100000" value="${f.mvMin}" />
          <input type="range" id="f-mv-max" min="${state.bounds.mvMin}" max="${state.bounds.mvMax}" step="100000" value="${f.mvMax}" />
        </div>
        <span class="range-label" id="f-mv-label">${esc(eur(f.mvMin))} – ${esc(eur(f.mvMax))}</span>
      </label>
      <label class="range-filter">
        Зарплата
        <div class="dual-range" data-kind="wage">
          <input type="range" id="f-wage-min" min="${state.bounds.wageMin}" max="${state.bounds.wageMax}" step="1000" value="${f.wageMin}" />
          <input type="range" id="f-wage-max" min="${state.bounds.wageMin}" max="${state.bounds.wageMax}" step="1000" value="${f.wageMax}" />
        </div>
        <span class="range-label" id="f-wage-label">${esc(wageSum(f.wageMin))} – ${esc(wageSum(f.wageMax))}</span>
      </label>
      <button type="button" class="auth-link" id="f-reset">Сбросить фильтры</button>
    </section>`;
}

function renderPoolPager(page, totalPages, from, to, total) {
  if (total === 0) return "";
  const prevDis = page <= 1 ? " disabled" : "";
  const nextDis = page >= totalPages ? " disabled" : "";
  return `
    <div class="top4-pool-pager">
      <button type="button" class="auth-link pool-prev"${prevDis}>← Назад</button>
      <span class="muted">${from}–${to} · стр. ${page} из ${totalPages}</span>
      <button type="button" class="auth-link pool-next"${nextDis}>Вперёд →</button>
    </div>`;
}

function renderUnpickedPool() {
  const players = sortedUnpicked();
  const total = players.length;
  const all = state.poolPlayers.length;
  const totalPages = Math.max(1, Math.ceil(total / POOL_PAGE_SIZE) || 1);
  if (state.poolPage > totalPages) state.poolPage = totalPages;
  if (state.poolPage < 1) state.poolPage = 1;
  const page = state.poolPage;
  const start = total === 0 ? 0 : (page - 1) * POOL_PAGE_SIZE;
  const shown = players.slice(start, start + POOL_PAGE_SIZE);
  const from = total === 0 ? 0 : start + 1;
  const to = start + shown.length;
  const rows = shown
    .map(
      (p) => `<tr>
        <td class="photo-cell">${portraitCell(p)}</td>
        <td>${playerNameCell(p)}</td>
        <td>${esc(p.club_name)}</td>
        <td>${esc(p.league_id)}</td>
        <td>${esc(p.position_display)}</td>
        <td class="mono">${p.fm_rating ?? "—"}</td>
        <td class="money">${eur(p.market_value_eur)}</td>
        <td class="money">${wageSum(playerWage(p))}</td>
      </tr>`,
    )
    .join("");
  const pageHint =
    total === 0 ? "" : tr("common.pageOf", { from, to, page, pages: totalPages });
  return `
    <h2 class="section-title">${tr("primer.unpickedTitle", { total, all, pageHint })}</h2>
    ${renderPoolFilters()}
    ${renderPoolPager(page, totalPages, from, to, total)}
    <div class="table-wrap">
      <table class="compact-table" id="pool-table">
        <thead>
          <tr>
            <th></th>
            ${poolSortTh(tr("common.player"), "name")}
            ${poolSortTh(tr("common.club"), "club")}
            ${poolSortTh(tr("common.league"), "league")}
            ${poolSortTh(tr("common.posDot"), "pos")}
            ${poolSortTh(tr("common.rating"), "rating")}
            ${poolSortTh(tr("common.value"), "mv")}
            ${poolSortTh(tr("common.wage"), "wage")}
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="8" class="muted">${tr("common.noPlayersFilter")}</td></tr>`}</tbody>
      </table>
    </div>
    ${renderPoolPager(page, totalPages, from, to, total)}`;
}

function syncPoolRangeLabels() {
  const f = state.filters;
  const mvLabel = $("f-mv-label");
  const wageLabel = $("f-wage-label");
  if (mvLabel) mvLabel.textContent = `${eur(f.mvMin)} – ${eur(f.mvMax)}`;
  if (wageLabel) wageLabel.textContent = `${wageSum(f.wageMin)} – ${wageSum(f.wageMax)}`;
}

function wirePoolFilters() {
  const league = $("f-league");
  const club = $("f-club");
  const line = $("f-line");
  const pos = $("f-pos");
  const mvMin = $("f-mv-min");
  const mvMax = $("f-mv-max");
  const wageMin = $("f-wage-min");
  const wageMax = $("f-wage-max");
  const reset = $("f-reset");

  league?.addEventListener("change", () => {
    state.filters.league = league.value;
    state.filters.club = "";
    state.filters.pos = "";
    state.poolPage = 1;
    renderOverview();
  });
  club?.addEventListener("change", () => {
    state.filters.club = club.value;
    state.poolPage = 1;
    renderOverview();
  });
  line?.addEventListener("change", () => {
    state.filters.line = line.value;
    state.filters.pos = "";
    state.poolPage = 1;
    renderOverview();
  });
  pos?.addEventListener("change", () => {
    state.filters.pos = pos.value;
    state.poolPage = 1;
    renderOverview();
  });

  const bindDual = (minEl, maxEl, kind) => {
    if (!minEl || !maxEl) return;
    const onInput = () => {
      let lo = Number(minEl.value);
      let hi = Number(maxEl.value);
      if (lo > hi) {
        if (minEl === document.activeElement) hi = lo;
        else lo = hi;
        minEl.value = String(lo);
        maxEl.value = String(hi);
      }
      if (kind === "mv") {
        state.filters.mvMin = lo;
        state.filters.mvMax = hi;
      } else {
        state.filters.wageMin = lo;
        state.filters.wageMax = hi;
      }
      syncPoolRangeLabels();
    };
    const onChange = () => {
      onInput();
      state.poolPage = 1;
      renderOverview();
    };
    minEl.addEventListener("input", onInput);
    maxEl.addEventListener("input", onInput);
    minEl.addEventListener("change", onChange);
    maxEl.addEventListener("change", onChange);
  };

  bindDual(mvMin, mvMax, "mv");
  bindDual(wageMin, wageMax, "wage");

  reset?.addEventListener("click", () => {
    state.filters.league = "";
    state.filters.club = "";
    state.filters.line = "";
    state.filters.pos = "";
    state.filters.mvMin = state.bounds.mvMin;
    state.filters.mvMax = state.bounds.mvMax;
    state.filters.wageMin = state.bounds.wageMin;
    state.filters.wageMax = state.bounds.wageMax;
    state.poolPage = 1;
    renderOverview();
  });
}

function wirePoolPager() {
  document.querySelectorAll(".pool-prev").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.poolPage <= 1) return;
      state.poolPage -= 1;
      renderOverview();
    });
  });
  document.querySelectorAll(".pool-next").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.poolPage += 1;
      renderOverview();
    });
  });
}

function wirePoolSort() {
  $("pool-table")?.querySelectorAll("th.sortable[data-pool-sort]").forEach((th) => {
    const activate = () => {
      const key = th.getAttribute("data-pool-sort");
      if (!key) return;
      if (state.poolSortKey === key) state.poolSortDir *= -1;
      else {
        state.poolSortKey = key;
        state.poolSortDir =
          key === "name" || key === "club" || key === "pos" || key === "league" ? 1 : -1;
      }
      state.poolPage = 1;
      renderOverview();
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });
}

function renderTabs() {
  const data = state.data;
  const teams = data.teams || [];
  const items = [
    { id: "overview", label: tr("primer.overview") },
    ...teams.map((t) => ({ id: `team-${t.id}`, label: t.name, teamId: t.id })),
  ];

  $("tabs").innerHTML = items
    .map((item) => {
      const active =
        item.id === "overview"
          ? state.tab === "overview"
          : state.tab === "team" && state.teamId === item.teamId;
      const mine = item.teamId != null && item.teamId === state.myTeamId;
      const taken =
        item.teamId != null && state.claimedTeamIds.has(item.teamId);
      const classes = [
        "primer-tab",
        active ? "active" : "",
        taken ? "taken" : "",
        mine ? "mine" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const suffix = mine ? tr("primer.you") : taken ? tr("primer.taken") : "";
      const title = taken && !mine ? ` title="${tr("primer.takenTitle")}"` : "";
      return `<button type="button" class="${classes}" data-tab="${esc(item.id)}"${title}>${esc(item.label)}${suffix}</button>`;
    })
    .join("");

  $("tabs").onclick = (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    const tab = btn.getAttribute("data-tab");
    if (tab === "overview") {
      state.tab = "overview";
      state.teamId = null;
    } else {
      const id = Number(String(tab).replace("team-", ""));
      state.tab = "team";
      state.teamId = id;
      const team = teams.find((t) => t.id === id);
      const gws = team?.gameweeks || [];
      if (gws.length && (state.gw == null || !gws.some((g) => g.gw === state.gw))) {
        state.gw = gws[0].gw;
      }
    }
    renderTabs();
    renderPanel();
  };
}

function renderOverview() {
  const data = state.data;
  const rules = data.rules || {};
  const summary = data.summary || {};
  const teams = data.teams || [];
  const unpickedCount = state.poolPlayers.length;

  const flags = [
    [tr("primer.check26"), summary.all_have_26],
    [tr("primer.checkBudget"), summary.all_within_budget],
    [tr("primer.checkLeague"), summary.all_leagues_ok],
    [tr("primer.checkClub"), summary.all_clubs_ok],
    ["≥3 GK", summary.all_gk_ok],
    [tr("primer.checkXi"), summary.all_field_formation],
    [tr("primer.totalPlayers"), summary.total_players],
    [tr("primer.unpicked"), unpickedCount],
  ];
  const summaryHtml = flags
    .map(([label, val]) => {
      const isBool = typeof val === "boolean";
      const cls = isBool ? (val ? "ok" : "bad") : "";
      const text = isBool ? (val ? tr("common.yes") : tr("common.no")) : esc(val);
      return `<div class="summary-card ${cls}"><div class="summary-label">${esc(label)}</div><div class="summary-value">${text}</div></div>`;
    })
    .join("");

  const teamRows = teams
    .map((t) => {
      const g = t.groups || {};
      const forms = (t.formations || []).length
        ? t.formations.map((f) => esc(f)).join("<br>")
        : "—";
      const gws = t.gameweeks?.length ?? 0;
      return `<tr>
        <td><button type="button" class="linkish" data-goto-team="${t.id}">${esc(t.name)}</button></td>
        <td>${t.player_count}</td>
        <td class="mono">${g.GK ?? 0}/${g.DEF ?? 0}/${g.MID ?? 0}/${g.ATT ?? 0}</td>
        <td class="mono">≤${t.max_club ?? "—"}</td>
        <td class="money">${eur(t.sum_market_value_eur)}</td>
        <td class="money">${wageSum(t.sum_wage_pw)}</td>
        <td>${budgetBadge(t, rules)}</td>
        <td class="forms-cell">${forms}</td>
        <td class="mono">${gws}</td>
      </tr>`;
    })
    .join("");

  $("panel").innerHTML = `
    <h2 class="section-title">Сводка</h2>
    <div class="summary-grid">${summaryHtml}</div>

    <h2 class="section-title">Команды</h2>
    <div class="table-wrap">
      <table class="compact-table">
        <thead>
          <tr>
            <th>Команда</th>
            <th>Игроки</th>
            <th>GK/DEF/MID/ATT</th>
            <th>Макс. клуб</th>
            <th>Σ стоимость</th>
            <th>Σ зарплата p/w</th>
            <th>Бюджет</th>
            <th>Составы</th>
            <th>Туры</th>
          </tr>
        </thead>
        <tbody>${teamRows}</tbody>
      </table>
    </div>

    ${renderUnpickedPool()}
  `;

  $("panel").querySelectorAll("[data-goto-team]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = "team";
      state.teamId = Number(btn.getAttribute("data-goto-team"));
      const team = teams.find((t) => t.id === state.teamId);
      const gws = team?.gameweeks || [];
      state.gw = gws[0]?.gw ?? null;
      renderTabs();
      renderPanel();
    });
  });
  wirePoolFilters();
  wirePoolPager();
  wirePoolSort();
}

function lineupRows(players, withSlot) {
  return (players || [])
    .map((p) => {
      // is_home null + opponent set = multi-fixture label (already has H/A).
      const ha =
        p.is_home == null
          ? p.opponent
            ? esc(p.opponent)
            : "—"
          : p.is_home
            ? `H · ${esc(p.opponent || "—")}`
            : `A · ${esc(p.opponent || "—")}`;
      return `<tr>
        ${withSlot ? `<td class="mono">${esc((p.slot_roles || []).join("/"))}</td>` : ""}
        <td class="photo-cell">${portraitCell(p)}</td>
        <td>${playerNameCell(p)}</td>
        <td>${esc(p.position_display)}</td>
        <td class="mono">${esc(p.fantasy_line || "—")}</td>
        <td>${esc(p.club_name)}</td>
        <td>${ha}</td>
        <td class="mono">${p.xPts != null ? Number(p.xPts).toFixed(2) : "—"}</td>
      </tr>`;
    })
    .join("");
}

function renderTeam(team) {
  const rules = state.data.rules || {};
  const g = team.groups || {};
  const forms = (team.formations || []).length
    ? team.formations.map((f) => `<span class="form-chip">${esc(f)}</span>`).join("")
    : `<span class="form-chip empty">${tr("primer.noXi")}</span>`;

  const rosterSorted = sortBy(team.players || [], state.teamSort.roster, ROSTER_GET, ROSTER_NUM);
  const rosterRows = rosterSorted
    .map(
      (p) => `<tr>
        <td class="mono">${p.pick ?? ""}</td>
        <td class="photo-cell">${portraitCell(p)}</td>
        <td>${playerNameCell(p)}</td>
        <td>${esc(p.position_display)}</td>
        <td>${esc(p.club_name)}</td>
        <td>${esc(p.league_id)}</td>
        <td class="mono">${p.fm_rating ?? "—"}</td>
        <td class="money">${eur(p.market_value_eur)}</td>
        <td class="money">${wageSum(p.wage_pw)}</td>
      </tr>`,
    )
    .join("");

  const gws = team.gameweeks || [];
  if (gws.length && (state.gw == null || !gws.some((x) => x.gw === state.gw))) {
    state.gw = gws[0].gw;
  }
  const gw = gws.find((x) => x.gw === state.gw) || gws[0] || null;

  const gwOptions = gws
    .map(
      (x) =>
        `<option value="${x.gw}"${x.gw === state.gw ? " selected" : ""}>GW${x.gw} · ${esc(x.formation_label)} · ${Number(x.xPtsTotal).toFixed(1)} xPts</option>`,
    )
    .join("");

  const xiSorted = gw ? sortBy(gw.xi || [], state.teamSort.xi, LINEUP_GET, LINEUP_NUM) : [];
  const benchSorted = gw
    ? sortBy(gw.bench || [], state.teamSort.bench, LINEUP_GET, LINEUP_NUM)
    : [];
  const rs = state.teamSort.roster;
  const xs = state.teamSort.xi;
  const bs = state.teamSort.bench;

  const lineupHtml = gw
    ? `
      <div class="lineup-meta">
        <span class="form-chip">${esc(gw.formation_label)}</span>
        <span class="lineup-xpts">Σ xPts <strong>${Number(gw.xPtsTotal).toFixed(2)}</strong></span>
        <span class="muted">XI ${gw.xi?.length ?? 0} + запас ${gw.bench?.length ?? 0}</span>
      </div>
      <h3 class="subhead">Старт (XI)</h3>
      <div class="table-wrap nested">
        <table class="compact-table">
          <thead>
            <tr>
              ${sortTh(tr("primer.slot"), "slot", xs, "xi")}
              ${sortTh("", "name", xs, "xi")}
              ${sortTh(tr("common.player"), "name", xs, "xi")}
              ${sortTh(tr("common.posDot"), "pos", xs, "xi")}
              ${sortTh(tr("primer.lineCol"), "line", xs, "xi")}
              ${sortTh(tr("common.club"), "club", xs, "xi")}
              ${sortTh(tr("primer.matchCol"), "match", xs, "xi")}
              ${sortTh("xPts", "xpts", xs, "xi")}
            </tr>
          </thead>
          <tbody>${lineupRows(xiSorted, true)}</tbody>
        </table>
      </div>
      <h3 class="subhead">Запас (7, в т.ч. 1 GK)</h3>
      <div class="table-wrap nested">
        <table class="compact-table">
          <thead>
            <tr>
              ${sortTh("", "name", bs, "bench")}
              ${sortTh(tr("common.player"), "name", bs, "bench")}
              ${sortTh(tr("common.posDot"), "pos", bs, "bench")}
              ${sortTh(tr("primer.lineCol"), "line", bs, "bench")}
              ${sortTh(tr("common.club"), "club", bs, "bench")}
              ${sortTh(tr("primer.matchCol"), "match", bs, "bench")}
              ${sortTh("xPts", "xpts", bs, "bench")}
            </tr>
          </thead>
          <tbody>${lineupRows(benchSorted, false)}</tbody>
        </table>
      </div>
    `
    : `<p class="meta inline">${tr("primer.noGwLineups")}</p>`;

  $("panel").innerHTML = `
    <section class="team-block">
      <div class="team-head">
        <div>
          <h2 class="team-title">${esc(team.name)}</h2>
          <p class="team-sub">
            ${team.player_count} игроков ·
            GK/DEF/MID/ATT ${g.GK ?? 0}/${g.DEF ?? 0}/${g.MID ?? 0}/${g.ATT ?? 0} ·
            макс. клуб ${team.max_club ?? "—"} ·
            Σ MV ${eur(team.sum_market_value_eur)} ·
            Σ wage ${wageSum(team.sum_wage_pw)}
            ${budgetBadge(team, rules)}
          </p>
          <div class="league-strip">${leagueStrip(team)}</div>
          <div class="form-chips">${forms}</div>
        </div>
      </div>

      <h3 class="subhead">Состав</h3>
      <div class="table-wrap nested">
        <table class="compact-table">
          <thead>
            <tr>
              ${sortTh("#", "pick", rs, "roster")}
              ${sortTh("", "name", rs, "roster")}
              ${sortTh(tr("common.player"), "name", rs, "roster")}
              ${sortTh(tr("common.posDot"), "pos", rs, "roster")}
              ${sortTh(tr("common.club"), "club", rs, "roster")}
              ${sortTh(tr("common.league"), "league", rs, "roster")}
              ${sortTh(tr("common.rating"), "rating", rs, "roster")}
              ${sortTh(tr("common.value"), "mv", rs, "roster")}
              ${sortTh(tr("common.wage"), "wage", rs, "roster")}
            </tr>
          </thead>
          <tbody>${rosterRows}</tbody>
        </table>
      </div>

      <div class="gw-bar">
        <h3 class="subhead">Фэнтези-состав по туру</h3>
        <label class="gw-select">
          <span>Тур</span>
          <select id="gw-select"${gws.length ? "" : " disabled"}>
            ${gwOptions || "<option>—</option>"}
          </select>
        </label>
      </div>
      <div id="lineup-panel">${lineupHtml}</div>
    </section>
  `;

  const sel = $("gw-select");
  if (sel) {
    sel.addEventListener("change", () => {
      state.gw = Number(sel.value);
      renderTeam(team);
    });
  }
  wireTeamSortHeaders(team);
}

function renderPanel() {
  if (state.tab === "overview") {
    renderOverview();
    return;
  }
  const team = (state.data.teams || []).find((t) => t.id === state.teamId);
  if (!team) {
    $("panel").innerHTML = `<p class="meta">${tr("primer.teamNotFound")}</p>`;
    return;
  }
  renderTeam(team);
}

function focusMyTeam(me) {
  state.isAdmin = Boolean(me?.isAdmin);
  state.myTeamId = me?.team?.id ?? null;
  state.claimedTeamIds = new Set(
    Array.isArray(me?.claimedTeamIds) ? me.claimedTeamIds : [],
  );
  if (!state.data) return;
  // Non-admins with an assignment land on their team; admin keeps overview.
  if (state.myTeamId && !state.isAdmin && state.tab === "overview") {
    const team = (state.data.teams || []).find((t) => t.id === state.myTeamId);
    if (team) {
      state.tab = "team";
      state.teamId = team.id;
      const gws = team.gameweeks || [];
      if (gws.length) state.gw = gws[0].gw;
    }
  }
  renderTabs();
  renderPanel();
}

function updateMeta() {
  const data = state.data;
  if (!data) return;
  const rules = data.rules || {};
  let when = "—";
  if (data.generated_at) {
    const d = new Date(data.generated_at);
    if (!Number.isNaN(d.getTime())) {
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
      when = `${date}, ${time}`;
    }
  }
  const gwCount = Math.max(0, ...(data.teams || []).map((t) => t.gameweeks?.length ?? 0));
  $("meta").textContent = tr("primer.meta", {
    teams: rules.teams ?? 16,
    rounds: rules.rounds ?? 26,
    mv: eur(rules.mv_cap),
    wage: wageSum(rules.wage_cap),
    minLeague: rules.min_per_league ?? 3,
    maxClub: rules.max_per_club ?? 3,
    minGk: rules.min_gk ?? 3,
    gw: gwCount,
    when,
  });
}

async function load() {
  const res = await fetch("/api/primer");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("meta").textContent = body.hint || body.error || tr("common.errorStatus", { status: res.status });
    return;
  }
  const data = await res.json();
  state.data = data;
  try {
    await loadUnpickedPool();
  } catch (err) {
    console.warn("primer unpicked pool", err);
    state.poolPlayers = data.unselected || [];
    initPoolFilterBounds();
  }
  updateMeta();

  if (window.__din8styAuth) {
    focusMyTeam(window.__din8styAuth);
  } else {
    renderTabs();
    renderPanel();
  }
}

document.addEventListener("din8sty:auth", (e) => {
  focusMyTeam(e.detail);
});

load().catch((err) => {
  $("meta").textContent = err.message || tr("common.errorLoad");
});

document.addEventListener("din8sty:lang", () => {
  if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
  // No top-level render() here — boot always fires din8sty:lang; reloading loops forever.
  if (!state.data) return;
  updateMeta();
  renderTabs();
  renderPanel();
});
