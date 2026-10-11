const $ = (id) => document.getElementById(id);

const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

const TOP8_LEAGUES = [
  { id: "GB1", label: "ENG · PL" },
  { id: "ES1", label: "SPA · LaLiga" },
  { id: "IT1", label: "ITA · Serie A" },
  { id: "L1", label: "GER · Bundesliga" },
  { id: "FR1", label: "FRA · Ligue 1" },
  { id: "PO1", label: "POR · Liga Portugal" },
  { id: "BE1", label: "BEL · Jupiler" },
  { id: "NL1", label: "NED · Eredivisie" },
];

const TOP8_LEAGUE_IDS = TOP8_LEAGUES.map((l) => l.id).join(",");
const SCHED_GW_MIN = 1;
const SCHED_GW_MAX = 43;
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

function initialTab() {
  const t = new URLSearchParams(location.search).get("tab");
  if (t === "schedule" || t === "rules" || t === "season2526") return t;
  return "draft";
}

let state = {
  tab: initialTab(),
  data: null,
  players: [],
  wishlist: [],
  wishlistEditable: false,
  wishlistSaving: false,
  sortKey: "rating",
  sortDir: -1,
  poolPage: 1,
  dragIndex: null,
  overIndex: null,
  filters: {
    league: "",
    club: "",
    line: "",
    pos: "",
    name: "",
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
  schedule: {
    league: "",
    club: "",
    status: "",
    gameweek: "",
    clubs: [],
    loaded: false,
    bound: false,
  },
  season: {
    loaded: false,
    data: null,
    q: "",
    league: "",
    club: "",
    line: "",
    sortKey: "total",
    sortDir: -1,
    page: 1,
    bound: false,
  },
};

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function eur(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(v >= 100_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}K`;
  return `€${v}`;
}

function wageSum(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `€${Math.round(v / 1000).toLocaleString("ru-RU")}K`;
}

function statusLabel(status) {
  return (
    {
      open: tr("league.status.open"),
      postponed: tr("league.status.postponed"),
      lottery_done: tr("league.status.lottery_done"),
      drafting: tr("league.status.drafting"),
      complete: tr("league.status.complete"),
    }[status] || status
  );
}

async function api(path, opts = {}) {
  // Only set JSON Content-Type when there is a body. Fastify rejects DELETE/GET
  // with Content-Type: application/json and an empty body (FST_ERR_CTP_EMPTY_JSON_BODY).
  const { headers: optHeaders, body, ...rest } = opts;
  const headers = { ...(optHeaders || {}) };
  if (body != null && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    credentials: "same-origin",
    headers,
    body,
    ...rest,
  });
  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(resBody.error || `HTTP ${res.status}`);
    err.body = resBody;
    err.status = res.status;
    throw err;
  }
  return resBody;
}

function loginHref() {
  return `/api/auth/login?next=${encodeURIComponent("/top8.html")}`;
}

async function loadPlayers() {
  const data = await api(
    `/api/players?leagues=${encodeURIComponent(TOP8_LEAGUE_IDS)}&sort=rating-desc&limit=5000`,
  );
  state.players = data.players || [];
  initFilterBounds();
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

function initFilterBounds() {
  let mvMax = 0;
  let wageMax = 0;
  for (const p of state.players) {
    mvMax = Math.max(mvMax, playerMv(p));
    wageMax = Math.max(wageMax, playerWage(p));
  }
  // Start at 0 so players with missing MV/wage stay visible at default range.
  state.bounds = { mvMin: 0, mvMax: Math.max(mvMax, 1), wageMin: 0, wageMax: Math.max(wageMax, 1) };
  state.filters.mvMin = 0;
  state.filters.mvMax = state.bounds.mvMax;
  state.filters.wageMin = 0;
  state.filters.wageMax = state.bounds.wageMax;
}

function clubOptions() {
  const map = new Map();
  for (const p of state.players) {
    if (state.filters.league && p.league_id !== state.filters.league) continue;
    const id = String(p.club_id || p.club_name || "");
    if (!id) continue;
    if (!map.has(id)) map.set(id, p.club_name || id);
  }
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
}

function posOptions() {
  const set = new Set();
  for (const p of state.players) {
    if (state.filters.league && p.league_id !== state.filters.league) continue;
    if (state.filters.line && playerLine(p) !== state.filters.line) continue;
    for (const r of playerRoles(p)) set.add(r);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function filteredPlayers() {
  const f = state.filters;
  return state.players.filter((p) => {
    if (f.league && p.league_id !== f.league) return false;
    if (f.club && String(p.club_id || p.club_name) !== f.club) return false;
    if (f.line && playerLine(p) !== f.line) return false;
    if (f.pos) {
      const roles = playerRoles(p);
      if (!roles.includes(f.pos)) return false;
    }
    const q = (f.name || "").trim().toLowerCase();
    if (q && !String(p.name || "").toLowerCase().includes(q)) return false;
    const mv = playerMv(p);
    const w = playerWage(p);
    if (mv < f.mvMin || mv > f.mvMax) return false;
    if (w < f.wageMin || w > f.wageMax) return false;
    return true;
  });
}

function sortedPlayers() {
  const key = state.sortKey;
  const dir = state.sortDir;
  const num = new Set(["rating", "mv", "wage"]);
  return filteredPlayers().sort((a, b) => {
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
    } else if (key === "club") {
      va = a.club_name;
      vb = b.club_name;
    } else if (key === "league") {
      va = a.league_id;
      vb = b.league_id;
    } else if (key === "pos") {
      va = a.position_display;
      vb = b.position_display;
    } else {
      va = a.name;
      vb = b.name;
    }
    let c;
    if (num.has(key)) {
      const na = Number(va);
      const nb = Number(vb);
      c = (Number.isFinite(na) ? na : -1) - (Number.isFinite(nb) ? nb : -1);
    } else {
      c = String(va ?? "").localeCompare(String(vb ?? ""), "ru", { numeric: true });
    }
    return c * dir || String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
}

function sortTh(label, key) {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDir > 0 ? " ↑" : " ↓") : "";
  return `<th class="sortable${active ? " sorted" : ""}" data-sort="${esc(key)}">${esc(label)}${arrow}</th>`;
}

function renderRegs(data) {
  const regs = data.registrations || [];
  const slots = data.slots || { taken: 0, total: 16 };
  const locked = data.status === "postponed";
  const rows = Array.from({ length: slots.total }, (_, i) => {
    const r = regs[i];
    const lock = locked
      ? `<span class="top4-slot-lock" title="${esc(tr("league.locked"))}" aria-hidden="true">🔒</span>`
      : "";
    if (!r) {
      return `<li class="top4-slot empty${locked ? " locked" : ""}">
        <span class="top4-slot-n">${i + 1}</span>
        ${lock}
        <span class="muted">${locked ? tr("league.locked") : tr("league.free")}</span>
      </li>`;
    }
    const mine = data.me?.user?.email && r.email.toLowerCase() === data.me.user.email.toLowerCase();
    return `<li class="top4-slot${mine ? " mine" : ""}${locked ? " locked" : ""}">
      <span class="top4-slot-n">${i + 1}</span>
      ${lock}
      <span class="top4-slot-name">${esc(r.team_name || r.name || r.email)}</span>
      <span class="muted top4-slot-email">${esc(r.name || r.email)}</span>
    </li>`;
  }).join("");
  const pillClass =
    data.status === "open" ? "ok" : data.status === "postponed" ? "closed" : "bad";
  return `
    <div class="top4-regs">
      <div class="top4-regs-head">
        <h2 class="section-title">${tr("league.participants")} <span class="muted">${slots.taken}/${slots.total}</span></h2>
        <span class="status-pill ${pillClass}">${esc(statusLabel(data.status))}</span>
      </div>
      <ul class="top4-slot-list">${rows}</ul>
    </div>`;
}

function renderActions(data) {
  const me = data.me || {};
  const full = (data.slots?.taken || 0) >= (data.slots?.total || 16);
  const open = data.status === "open";
  const postponed = data.status === "postponed";
  const lotteryDone = data.status === "lottery_done";
  const myTeam = me.registration?.team_name || "";

  let userBtn = "";
  if (postponed) {
    userBtn = me.registered
      ? `<span class="status-pill closed">${esc(myTeam || tr("league.inLeague"))} · 🔒</span>`
      : `<span class="status-pill closed">${esc(tr("league.err.registration_closed"))}</span>`;
  } else if (!me.user) {
    userBtn = `<a class="auth-btn" href="${esc(loginHref())}">${tr("league.loginJoin")}</a>`;
  } else if (open && !me.registered) {
    userBtn = `<form class="top4-join" id="form-register">
      <input
        type="text"
        name="teamName"
        id="team-name-input"
        required
        minlength="2"
        maxlength="40"
        placeholder="${tr("league.teamNamePh")}"
        autocomplete="organization"
      />
      <button type="submit" class="auth-btn"${full ? " disabled" : ""}>${tr("league.join")}</button>
      <p class="muted">${tr("league.joinHint")}</p>
    </form>`;
  } else if (open && me.registered) {
    userBtn = `<form class="top4-join" id="form-rename">
      <input
        type="text"
        name="teamName"
        id="team-name-input"
        required
        minlength="2"
        maxlength="40"
        value="${esc(myTeam)}"
        placeholder="${tr("league.teamNamePh")}"
        autocomplete="organization"
      />
      <button type="submit" class="auth-btn">${tr("league.saveName")}</button>
      <button type="button" class="auth-link" id="btn-unregister">${tr("league.unregister")}</button>
    </form>`;
  } else if (me.registered) {
    userBtn = `<span class="status-pill ok">${esc(myTeam || tr("league.inLeague"))}</span>`;
  }

  let admin = "";
  if (me.isAdmin) {
    admin = `<div class="top4-admin">
      <button type="button" class="auth-btn" id="btn-lottery"${full && (open || lotteryDone) ? "" : " disabled"}>${tr("league.lottery")}</button>
      <button type="button" class="auth-btn" id="btn-draft"${lotteryDone ? "" : " disabled"}>${tr("league.startDraft")}</button>
      <button type="button" class="auth-link" id="btn-reset">${tr("league.reset")}</button>
    </div>`;
  }

  return `<div class="top4-actions">${userBtn}${admin}<p class="meta inline" id="action-msg"></p></div>`;
}

function renderLotteryBlock(data) {
  const lottery = data.lottery;
  if (!lottery?.length) return "";
  const rows = lottery
    .slice()
    .sort((a, b) => a.draft_slot - b.draft_slot)
    .map(
      (e) => `<tr>
        <td class="mono">${e.draft_slot}</td>
        <td>${esc(e.team_name)}</td>
        <td>${esc(e.name || e.email)}</td>
        <td class="muted">${esc(e.email)}</td>
      </tr>`,
    )
    .join("");
  return `
    <h2 class="section-title">${tr("league.draftOrder")}</h2>
    <div class="table-wrap">
      <table class="compact-table">
        <thead><tr><th>#</th><th>${tr("common.team")}</th><th>${tr("common.manager")}</th><th>Email</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderDraft(data) {
  const draft = data.draft;
  if (!draft?.teams) return "";
  const managers = new Map((draft.managers || []).map((m) => [m.team_id, m]));
  const cards = draft.teams
    .map((t) => {
      const m = managers.get(t.id);
      return `<a class="summary-card" href="#team-${t.id}">
        <span class="summary-label">${esc(t.name)}${m?.name || m?.email ? ` · ${esc(m.name || m.email)}` : ""}</span>
        <span class="summary-value">${t.player_count}</span>
        <span class="muted">${eur(t.sum_market_value_eur)} · ${wageSum(t.sum_wage_pw)}</span>
      </a>`;
    })
    .join("");

  const teamBlocks = draft.teams
    .map((t) => {
      const m = managers.get(t.id);
      const rows = (t.players || [])
        .map(
          (p) => `<tr>
            <td class="mono">${p.pick ?? ""}</td>
            <td><a class="player-link" href="/player.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a></td>
            <td>${esc(p.position_display)}</td>
            <td>${esc(p.club_name)}</td>
            <td>${esc(p.league_id)}</td>
            <td class="mono">${p.fm_rating ?? "—"}</td>
            <td class="money">${eur(p.market_value_eur)}</td>
            <td class="money">${wageSum(p.wage_pw)}</td>
          </tr>`,
        )
        .join("");
      return `<section class="team-block" id="team-${t.id}">
        <h3 class="subhead">${esc(t.name)}${m ? ` · ${esc(m.name || m.email)}` : ""}</h3>
        <p class="meta inline">${t.player_count} · MV ${eur(t.sum_market_value_eur)} · wage ${wageSum(t.sum_wage_pw)}</p>
        <div class="table-wrap nested">
          <table class="compact-table">
            <thead><tr><th>#</th><th>${tr("common.player")}</th><th>${tr("common.posDot")}</th><th>${tr("common.club")}</th><th>${tr("common.league")}</th><th>${tr("common.rating")}</th><th>Стоимость</th><th>Зарплата</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
    })
    .join("");

  return `
    <h2 class="section-title">${tr("league.afterDraft")}</h2>
    <div class="summary-grid">${cards}</div>
    ${teamBlocks}`;
}

function errLabel(code, body) {
  if (body?.message && typeof body.message === "string") return body.message;
  return (
    {
      team_name_invalid: tr("league.err.team_name_invalid"),
      team_name_taken: tr("league.err.team_name_taken"),
      league_full: tr("league.err.league_full"),
      already_registered: tr("league.err.already_registered"),
      registration_closed: tr("league.err.registration_closed"),
      not_registered: tr("league.err.not_registered"),
      login_required: tr("league.err.login_required"),
      wishlist_locked: tr("league.err.wishlist_locked"),
      wishlist_changed: tr("league.err.wishlist_changed"),
      no_team:
        tr("league.err.primer_map"),
    }[code] || code
  );
}

function wishlistIdSet() {
  return new Set(
    (state.wishlist || []).map((w) => w.player_id).concat(state.data?.me?.wishlistIds || []),
  );
}

function renderWishlist() {
  const me = state.data?.me;
  if (!me?.registered) return "";
  const items = state.wishlist || [];
  const editable = state.wishlistEditable;
  const rows =
    items.length === 0
      ? `<p class="muted">${tr("league.wishlistEmpty")}</p>`
      : `<ol class="top4-wl-list" id="wishlist-list">${items
          .map((w, i) => {
            const dragging = state.dragIndex === i;
            const over = state.overIndex === i && state.dragIndex != null && state.dragIndex !== i;
            return `<li
              class="top4-wl-item${dragging ? " dragging" : ""}${over ? " over" : ""}${editable ? " can-drag" : ""}"
              data-idx="${i}"
              data-id="${esc(w.player_id)}"
              ${editable ? 'draggable="true"' : ""}
            >
              <span class="top4-wl-handle" title="${editable ? tr("league.drag") : ""}">${editable ? "⠿" : ""} ${i + 1}.</span>
              <div class="top4-wl-body">
                <a class="player-link" href="/player.html?id=${encodeURIComponent(w.player_id)}">${esc(w.name)}</a>
                <span class="muted">${esc(w.position_display)} · ${esc(w.club_name)} · ${esc(w.league_id)} · ${w.fm_rating ?? "—"}</span>
              </div>
              ${
                editable
                  ? `<button type="button" class="top4-wl-remove" data-remove="${esc(w.player_id)}" title="${tr("common.remove")}">✕</button>`
                  : ""
              }
            </li>`;
          })
          .join("")}</ol>`;

  return `
    <section class="top4-wishlist" id="wishlist">
      <div class="top4-wl-head">
        <h2 class="section-title">Wishlist <span class="muted">(${items.length})</span></h2>
        <span class="muted" id="wl-save-hint">${state.wishlistSaving ? tr("league.savingShort") : editable ? tr("league.dragHint") : tr("common.viewOnly")}</span>
      </div>
      ${rows}
    </section>`;
}

function renderPoolFilters() {
  const f = state.filters;
  const clubs = clubOptions();
  const roles = posOptions();
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
        ${tr("common.league")}
        <select id="f-league">
          <option value="">${tr("league.allTop8Lower")}</option>
          ${leagueOpts}
        </select>
      </label>
      <label>
        ${tr("common.club")}
        <select id="f-club">
          <option value="">${tr("common.allClubs")}</option>
          ${clubOpts}
        </select>
      </label>
      <label>
        ${tr("common.line")}
        <select id="f-line">
          <option value="">${tr("common.all")}</option>
          <option value="GK"${f.line === "GK" ? " selected" : ""}>GK</option>
          <option value="DEF"${f.line === "DEF" ? " selected" : ""}>DEF</option>
          <option value="MID"${f.line === "MID" ? " selected" : ""}>MID</option>
          <option value="ATT"${f.line === "ATT" ? " selected" : ""}>ATT</option>
        </select>
      </label>
      <label>
        ${tr("common.position")}
        <select id="f-pos">
          <option value="">${tr("common.all")}</option>
          ${posOpts}
        </select>
      </label>
      <label>
        ${tr("league.nameFilter")}
        <input type="text" id="f-name" placeholder="${tr("league.searchName")}" autocomplete="off" value="${esc(f.name)}" />
      </label>
      <label class="range-filter">
        ${tr("common.value")}
        <div class="dual-range" data-kind="mv">
          <input type="range" id="f-mv-min" min="${state.bounds.mvMin}" max="${state.bounds.mvMax}" step="100000" value="${f.mvMin}" />
          <input type="range" id="f-mv-max" min="${state.bounds.mvMin}" max="${state.bounds.mvMax}" step="100000" value="${f.mvMax}" />
        </div>
        <span class="range-label" id="f-mv-label">${esc(eur(f.mvMin))} – ${esc(eur(f.mvMax))}</span>
      </label>
      <label class="range-filter">
        ${tr("common.wage")}
        <div class="dual-range" data-kind="wage">
          <input type="range" id="f-wage-min" min="${state.bounds.wageMin}" max="${state.bounds.wageMax}" step="1000" value="${f.wageMin}" />
          <input type="range" id="f-wage-max" min="${state.bounds.wageMin}" max="${state.bounds.wageMax}" step="1000" value="${f.wageMax}" />
        </div>
        <span class="range-label" id="f-wage-label">${esc(wageSum(f.wageMin))} – ${esc(wageSum(f.wageMax))}</span>
      </label>
      <button type="button" class="auth-link" id="f-reset">${tr("league.resetFilters")}</button>
    </section>`;
}

function renderPoolPager(page, totalPages, from, to, total) {
  if (total === 0) return "";
  const prevDis = page <= 1 ? " disabled" : "";
  const nextDis = page >= totalPages ? " disabled" : "";
  return `
    <div class="top4-pool-pager">
      <button type="button" class="auth-link pool-prev"${prevDis}>${tr("common.prevShort")}</button>
      <span class="muted">${from}–${to} · стр. ${page} из ${totalPages}</span>
      <button type="button" class="auth-link pool-next"${nextDis}>${tr("common.next")}</button>
    </div>`;
}

function renderPool() {
  const players = sortedPlayers();
  const total = players.length;
  const totalPages = Math.max(1, Math.ceil(total / POOL_PAGE_SIZE) || 1);
  if (state.poolPage > totalPages) state.poolPage = totalPages;
  if (state.poolPage < 1) state.poolPage = 1;
  const page = state.poolPage;
  const start = total === 0 ? 0 : (page - 1) * POOL_PAGE_SIZE;
  const shown = players.slice(start, start + POOL_PAGE_SIZE);
  const from = total === 0 ? 0 : start + 1;
  const to = start + shown.length;
  const me = state.data?.me;
  const canAdd = Boolean(me?.registered && state.wishlistEditable);
  const inWl = wishlistIdSet();
  const rows = shown
    .map((p) => {
      const id = String(p.id);
      const added = inWl.has(id);
      const action = canAdd
        ? added
          ? `<button type="button" class="top4-wl-btn on" data-remove="${esc(id)}" title="${tr("league.removeWl")}">✓</button>`
          : `<button type="button" class="top4-wl-btn" data-add="${esc(id)}" title="${tr("league.addWl")}">+ wishlist</button>`
        : "";
      return `<tr>
        <td class="top4-wl-action-cell">${action}</td>
        <td><a class="player-link" href="/player.html?id=${encodeURIComponent(id)}">${esc(p.name)}</a></td>
        <td>${esc(p.position_display)}</td>
        <td>${esc(p.club_name)}</td>
        <td>${esc(p.league_id)}</td>
        <td class="mono">${p.fm_rating ?? "—"}</td>
        <td class="money">${eur(p.market_value_eur)}</td>
        <td class="money">${wageSum(playerWage(p))}</td>
      </tr>`;
    })
    .join("");
  const pageHint =
    total === 0 ? "" : tr("common.pageOf", { from, to, page, pages: totalPages });
  return `
    <h2 class="section-title">${tr("league.poolOf", { title: tr("league.poolTop8"), total, all: state.players.length, pageHint })}</h2>
    ${renderPoolFilters()}
    ${renderPoolPager(page, totalPages, from, to, total)}
    <div class="table-wrap">
      <table class="compact-table" id="pool-table">
        <thead>
          <tr>
            <th></th>
            ${sortTh(tr("common.player"), "name")}
            ${sortTh(tr("common.posDot"), "pos")}
            ${sortTh(tr("common.club"), "club")}
            ${sortTh(tr("common.league"), "league")}
            ${sortTh(tr("common.rating"), "rating")}
            ${sortTh(tr("common.value"), "mv")}
            ${sortTh(tr("common.wage"), "wage")}
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="8" class="muted">${tr("common.noPlayersFilter")}</td></tr>`}</tbody>
      </table>
    </div>
    ${renderPoolPager(page, totalPages, from, to, total)}`;
}

function render() {
  const data = state.data;
  if (!data) return;
  const rules = data.rules || {};
  const draftMeta =
    tr("league.metaTop8", { teams: rules.teams ?? 16, rounds: rules.rounds ?? 26, mv: eur(rules.mv_cap), wage: wageSum(rules.wage_cap), minLeague: rules.min_per_league ?? 3, maxClub: rules.max_per_club ?? 3, minGk: rules.min_gk ?? 3 }) +
    `ENG/SPA/ITA/GER/FRA/POR/BEL/NED · ${statusLabel(data.status)}`;

  const showWl = Boolean(data.me?.registered);
  $("panel").innerHTML = `
    <section class="top4-hero">
      <h1 class="team-title">${tr("league.hero8")}</h1>
      <p class="team-sub">Пул: ENG · SPA · ITA · GER · FRA · POR · BEL · NED (как в Пример). Набор 16 менеджеров → жеребьёвка → snake-драфт. Лимиты: MV ≤ €900M, wage ≤ €3.5M/нед.</p>
      ${renderActions(data)}
    </section>
    ${renderRegs(data)}
    ${renderLotteryBlock(data)}
    ${renderDraft(data)}
    <div class="top4-draft-grid${showWl ? "" : " solo"}">
      <div class="top4-pool-col">${renderPool()}</div>
      ${showWl ? `<div class="top4-wl-col">${renderWishlist()}</div>` : ""}
    </div>
  `;

  wireActions();
  wireSort();
  wireWishlist();
  wireFilters();
  wirePoolPager();
  applyTab(state.tab, { metaDraft: draftMeta });
}

function syncRangeLabels() {
  const f = state.filters;
  const mvLabel = $("f-mv-label");
  const wageLabel = $("f-wage-label");
  if (mvLabel) mvLabel.textContent = `${eur(f.mvMin)} – ${eur(f.mvMax)}`;
  if (wageLabel) wageLabel.textContent = `${wageSum(f.wageMin)} – ${wageSum(f.wageMax)}`;
}

function wireFilters() {
  const league = $("f-league");
  const club = $("f-club");
  const line = $("f-line");
  const pos = $("f-pos");
  const name = $("f-name");
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
    render();
  });
  club?.addEventListener("change", () => {
    state.filters.club = club.value;
    state.poolPage = 1;
    render();
  });
  line?.addEventListener("change", () => {
    state.filters.line = line.value;
    state.filters.pos = "";
    state.poolPage = 1;
    render();
  });
  pos?.addEventListener("change", () => {
    state.filters.pos = pos.value;
    state.poolPage = 1;
    render();
  });
  name?.addEventListener("input", () => {
    state.filters.name = name.value;
    state.poolPage = 1;
    const caret = name.selectionStart;
    render();
    const el = $("f-name");
    if (el) {
      el.focus();
      if (typeof caret === "number") el.setSelectionRange(caret, caret);
    }
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
      syncRangeLabels();
    };
    const onChange = () => {
      onInput();
      state.poolPage = 1;
      render();
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
    state.filters.name = "";
    state.filters.mvMin = state.bounds.mvMin;
    state.filters.mvMax = state.bounds.mvMax;
    state.filters.wageMin = state.bounds.wageMin;
    state.filters.wageMax = state.bounds.wageMax;
    state.poolPage = 1;
    render();
  });
}

function wirePoolPager() {
  document.querySelectorAll(".pool-prev").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.poolPage <= 1) return;
      state.poolPage -= 1;
      render();
    });
  });
  document.querySelectorAll(".pool-next").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.poolPage += 1;
      render();
    });
  });
}

function setMsg(text, bad = false) {
  const el = $("action-msg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("warn", bad);
}

function wireActions() {
  const data = state.data;
  $("form-register")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("team-name-input");
    const teamName = input?.value?.trim() || "";
    try {
      setMsg(tr("league.msg.applying"));
      await api("/api/top8/register", {
        method: "POST",
        body: JSON.stringify({ teamName }),
      });
      await refresh();
      setMsg(tr("league.msg.joined"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
  $("form-rename")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("team-name-input");
    const teamName = input?.value?.trim() || "";
    try {
      setMsg(tr("league.msg.savingName"));
      await api("/api/top8/team-name", {
        method: "PUT",
        body: JSON.stringify({ teamName }),
      });
      await refresh();
      setMsg(tr("league.msg.nameSaved"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
  $("btn-unregister")?.addEventListener("click", async () => {
    try {
      await api("/api/top8/unregister", { method: "POST", body: "{}" });
      await refresh();
      setMsg(tr("league.msg.unregistered"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
  $("btn-lottery")?.addEventListener("click", async () => {
    try {
      setMsg(tr("league.msg.lotteryRun"));
      const res = await api("/api/top8/lottery", { method: "POST", body: "{}" });
      await playLotteryAnimation(res.lottery || []);
      await refresh();
      setMsg(tr("league.msg.lotteryDone"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
  $("btn-draft")?.addEventListener("click", async () => {
    try {
      setMsg(tr("league.msg.drafting"));
      await api("/api/top8/draft/start", { method: "POST", body: "{}" });
      await refresh();
      setMsg(tr("league.msg.draftDone"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
  $("btn-reset")?.addEventListener("click", async () => {
    if (!confirm(tr("league.confirmReset8"))) return;
    try {
      await api("/api/top8/reset", { method: "POST", body: "{}" });
      await refresh();
      setMsg(tr("league.msg.resetDone"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
}

function wireSort() {
  $("pool-table")?.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");
      if (!key) return;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        state.sortDir = key === "name" || key === "club" || key === "pos" || key === "league" ? 1 : -1;
      }
      state.poolPage = 1;
      render();
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function playLotteryAnimation(lottery) {
  const overlay = $("lottery-overlay");
  const spin = $("lottery-spin");
  const results = $("lottery-results");
  if (!overlay || !spin || !results) return;
  overlay.hidden = false;
  results.innerHTML = "";
  const names = lottery.map((e) => e.team_name || e.name || e.email);
  const ordered = lottery.slice().sort((a, b) => a.draft_slot - b.draft_slot);

  for (let i = 0; i < 24; i++) {
    spin.textContent = names[i % names.length] || "…";
    await sleep(60 + i * 8);
  }

  for (const e of ordered) {
    spin.textContent = `${e.draft_slot}. ${e.team_name}`;
    const li = document.createElement("li");
    li.innerHTML = `<strong>${e.draft_slot}. ${esc(e.team_name)}</strong> — ${esc(e.name || e.email)}`;
    results.appendChild(li);
    await sleep(420);
  }
  spin.textContent = tr("league.lotteryDoneSpin");
  await sleep(900);
  overlay.hidden = true;
}

async function loadWishlist() {
  const me = state.data?.me;
  if (!me?.registered) {
    state.wishlist = [];
    state.wishlistEditable = false;
    return;
  }
  try {
    const res = await api("/api/top8/wishlist");
    state.wishlist = res.items || [];
    state.wishlistEditable = Boolean(res.editable);
  } catch {
    state.wishlist = [];
    state.wishlistEditable = false;
  }
}

async function moveWishlistItem(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.wishlist.length) return;
  const next = [...state.wishlist];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  state.wishlist = next;
  state.wishlistSaving = true;
  render();
  try {
    await api("/api/top8/wishlist/order", {
      method: "PUT",
      body: JSON.stringify({ playerIds: next.map((w) => w.player_id) }),
    });
  } catch (err) {
    setMsg(errLabel(err.message, err.body) || tr("league.errOrder"), true);
    await loadWishlist();
  } finally {
    state.wishlistSaving = false;
    state.dragIndex = null;
    state.overIndex = null;
    render();
  }
}

function wireWishlist() {
  let dragFrom = null;

  $("panel")?.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-add");
      if (!id) return;
      try {
        await api("/api/top8/wishlist", {
          method: "POST",
          body: JSON.stringify({ playerId: id }),
        });
        await loadWishlist();
        if (state.data?.me) state.data.me.wishlistIds = state.wishlist.map((w) => w.player_id);
        render();
      } catch (err) {
        setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
      }
    });
  });

  $("panel")?.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-remove");
      if (!id) return;
      try {
        await api(`/api/top8/wishlist/${encodeURIComponent(id)}`, { method: "DELETE" });
        await loadWishlist();
        if (state.data?.me) state.data.me.wishlistIds = state.wishlist.map((w) => w.player_id);
        render();
      } catch (err) {
        setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
      }
    });
  });

  const list = $("wishlist-list");
  if (!list || !state.wishlistEditable) return;

  list.querySelectorAll(".top4-wl-item").forEach((li) => {
    li.addEventListener("dragstart", () => {
      dragFrom = Number(li.getAttribute("data-idx"));
      state.dragIndex = dragFrom;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      dragFrom = null;
      state.dragIndex = null;
      state.overIndex = null;
      list.querySelectorAll(".top4-wl-item").forEach((el) => el.classList.remove("dragging", "over"));
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      const idx = Number(li.getAttribute("data-idx"));
      state.overIndex = idx;
      list.querySelectorAll(".top4-wl-item").forEach((el) => el.classList.remove("over"));
      if (dragFrom != null && dragFrom !== idx) li.classList.add("over");
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("over");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const to = Number(li.getAttribute("data-idx"));
      const from = dragFrom;
      dragFrom = null;
      if (from != null) moveWishlistItem(from, to);
    });
  });
}

async function refresh() {
  state.data = await api("/api/top8");
  await loadWishlist();
  render();
}

async function load() {
  try {
    state.data = await api("/api/top8");
    await Promise.all([loadPlayers(), loadWishlist()]);
    render();
  } catch (e) {
    $("meta").textContent = e.message || tr("common.errorLoad");
  }
}

document.addEventListener("din8sty:auth", () => {
  if (state.data) refresh().catch(() => {});
});

/* —— Расписание (Топ-8 · GW2–43) —— */

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
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
  const crestSrc = crest ? esc(crest) : "";
  return `<div class="player">
    ${crestSrc ? `<img class="crest" src="${crestSrc}" alt="" loading="lazy" />` : `<span class="crest"></span>`}
    <span>${esc(label)}</span>
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
  const crestSrc = crest ? esc(crest) : "";
  return `<div class="opponent-cell">
    <span class="ha" title="${ha === "H" ? tr("common.home") : ha === "A" ? tr("common.away") : ""}">${esc(ha)}</span>
    <span class="ha-sep" aria-hidden="true">·</span>
    ${crestSrc ? `<img class="crest" src="${crestSrc}" alt="" loading="lazy" />` : `<span class="crest"></span>`}
    <span class="opp-name">${esc(label)}</span>
    <span class="opp-code" title="${esc(label)}">${esc(code)}</span>
  </div>`;
}

function resultCell(f) {
  const status = f.status || "—";
  const hasScore = f.home_goals != null && f.away_goals != null;
  if (hasScore) {
    return `<span class="result-cell">${scoreCell(f)} <span class="badge">${esc(status)}</span></span>`;
  }
  return `<span class="badge">${esc(status)}</span>`;
}

function setSchedHeader(compact) {
  const thead = document.querySelector("#sched-table thead tr");
  if (!thead) return;
  thead.innerHTML = compact
    ? `<th>${tr("common.date")}</th><th>GW</th><th>${tr("common.competition")}</th><th>${tr("common.opponent")}</th><th>${tr("common.status")}</th>`
    : `<th>${tr("common.date")}</th><th>GW</th><th>${tr("common.competition")}</th><th>${tr("common.roundCol")}</th><th>${tr("common.homeTeam")}</th><th></th><th>${tr("common.awayTeam")}</th><th>${tr("common.status")}</th>`;
  $("sched-table")?.classList.toggle("club-fixtures", compact);
  $("sched-table-wrap")?.classList.toggle("club-fixtures-wrap", compact);
}

function pickDefaultSchedGw(gameweeks) {
  const season = (gameweeks || []).filter((g) => {
    const n = Number(g.gameweek);
    return n >= SCHED_GW_MIN && n <= SCHED_GW_MAX;
  });
  if (!season.length) return "";
  const now = Date.now();
  const current = season.find((g) => {
    const start = Date.parse(g.start);
    const end = Date.parse(g.end);
    return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
  });
  if (current) return String(current.gameweek);
  const upcoming = season.find((g) => Date.parse(g.start) > now);
  if (upcoming) return String(upcoming.gameweek);
  return String(season[0].gameweek);
}

function applyTab(tab, opts = {}) {
  const allowed = new Set(["draft", "schedule", "rules", "season2526"]);
  state.tab = allowed.has(tab) ? tab : "draft";
  const isSched = state.tab === "schedule";
  const isRules = state.tab === "rules";
  const isSeason = state.tab === "season2526";
  $("panel")?.toggleAttribute("hidden", isSched || isRules || isSeason);
  $("schedule-root")?.toggleAttribute("hidden", !isSched);
  $("rules-root")?.toggleAttribute("hidden", !isRules);
  $("season-root")?.toggleAttribute("hidden", !isSeason);
  document.querySelectorAll("#top8-tabs .primer-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === state.tab);
  });
  if (isSched) {
    if (!state.schedule.loaded) {
      initSchedule().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    } else {
      loadSchedFixtures().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    }
  } else if (isRules) {
    $("meta").textContent = tr("league.metaRules8");
  } else if (isSeason) {
    $("meta").textContent = tr("league.metaSeason");
    if (!state.season.loaded) {
      initSeason().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    } else {
      renderSeason();
    }
  } else if (opts.metaDraft != null) {
    $("meta").textContent = opts.metaDraft;
  } else if (state.data) {
    const rules = state.data.rules || {};
    $("meta").textContent =
      tr("league.metaTop8", { teams: rules.teams ?? 16, rounds: rules.rounds ?? 26, mv: eur(rules.mv_cap), wage: wageSum(rules.wage_cap), minLeague: rules.min_per_league ?? 3, maxClub: rules.max_per_club ?? 3, minGk: rules.min_gk ?? 3 }) +
      `ENG/SPA/ITA/GER/FRA/POR/BEL/NED · ${statusLabel(state.data.status)}`;
  }
  const url = new URL(location.href);
  if (isSched) url.searchParams.set("tab", "schedule");
  else if (isRules) url.searchParams.set("tab", "rules");
  else if (isSeason) url.searchParams.set("tab", "season2526");
  else url.searchParams.delete("tab");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function loadSchedGameweeks() {
  const res = await fetch("/api/gameweeks");
  const data = await res.json();
  const sel = $("sched-gameweek");
  const prev = state.schedule.gameweek;
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
  } else {
    const def = pickDefaultSchedGw(data.gameweeks);
    state.schedule.gameweek = def;
    sel.value = def;
  }
}

async function loadSchedClubs() {
  const league = state.schedule.league;
  const url = league ? `/api/clubs?league=${encodeURIComponent(league)}` : "/api/clubs";
  const res = await fetch(url);
  const data = await res.json();
  const top8 = new Set(TOP8_LEAGUES.map((l) => l.id));
  state.schedule.clubs = league
    ? data.clubs || []
    : (data.clubs || []).filter((c) => top8.has(c.league_id));
  const sel = $("sched-club");
  const prev = state.schedule.club;
  sel.innerHTML = `<option value="">${tr("common.allClubs")}</option>`;
  for (const c of state.schedule.clubs) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if (prev && state.schedule.clubs.some((c) => c.id === prev)) {
    sel.value = prev;
  } else {
    state.schedule.club = "";
    sel.value = "";
  }
}

async function loadSchedFixtures() {
  const s = state.schedule;
  const params = new URLSearchParams();
  params.set("gw_min", String(SCHED_GW_MIN));
  params.set("gw_max", String(SCHED_GW_MAX));
  if (s.league) params.set("league", s.league);
  else params.set("leagues", TOP8_LEAGUE_IDS);
  if (s.club) params.set("club", s.club);
  if (s.status) params.set("status", s.status);
  if (s.gameweek) params.set("gameweek", s.gameweek);

  const res = await fetch(`/api/fixtures?${params}`);
  const data = await res.json();
  $("meta").textContent = tr("league.schedShown8", { min: SCHED_GW_MIN, max: SCHED_GW_MAX, n: data.total ?? 0 });

  const compact = Boolean(s.club);
  setSchedHeader(compact);

  const body = $("sched-rows");
  if (!data.fixtures?.length) {
    body.innerHTML = `<tr><td colspan="${compact ? 5 : 8}" class="sub">${tr("common.noMatches")}</td></tr>`;
    return;
  }

  body.innerHTML = data.fixtures
    .map((f) => {
      const round = (f.round || "").replace(/^Regular Season - /, tr("common.round"));
      const gw =
        f.gameweek != null
          ? `<span class="badge">GW${esc(f.gameweek)}</span>`
          : `<span class="sub">—</span>`;
      const competition = f.competition_name || f.league_name || f.league_id || "";
      if (compact) {
        return `<tr>
          <td class="when-cell">${fmtWhen(f.date)}</td>
          <td class="gw-cell">${gw}</td>
          <td class="comp-cell">
            <span class="comp-name">${esc(competition)}</span>
            ${round ? `<span class="sub">${esc(round)}</span>` : ""}
          </td>
          <td class="opp-cell">${opponentCell(f, s.club)}</td>
          <td class="result-td">${resultCell(f)}</td>
        </tr>`;
      }
      return `<tr>
        <td>${fmtWhen(f.date)}</td>
        <td>${gw}</td>
        <td>${esc(competition)}</td>
        <td class="sub">${esc(round)}</td>
        <td>${teamCell(f.home_name, f.home_crest, f.home_club_name)}</td>
        <td class="score-cell">${scoreCell(f)}</td>
        <td>${teamCell(f.away_name, f.away_crest, f.away_club_name)}</td>
        <td><span class="badge">${esc(f.status || "—")}</span></td>
      </tr>`;
    })
    .join("");
}

function bindSchedule() {
  if (state.schedule.bound) return;
  state.schedule.bound = true;
  $("sched-gameweek")?.addEventListener("change", (e) => {
    state.schedule.gameweek = e.target.value;
    loadSchedFixtures();
  });
  $("sched-league")?.addEventListener("change", async (e) => {
    state.schedule.league = e.target.value;
    await loadSchedClubs();
    await loadSchedFixtures();
  });
  $("sched-club")?.addEventListener("change", (e) => {
    state.schedule.club = e.target.value;
    loadSchedFixtures();
  });
  $("sched-status")?.addEventListener("change", (e) => {
    state.schedule.status = e.target.value;
    loadSchedFixtures();
  });
}

async function initSchedule() {
  const leagueSel = $("sched-league");
  if (leagueSel && leagueSel.options.length <= 1) {
    for (const l of TOP8_LEAGUES) {
      const opt = document.createElement("option");
      opt.value = l.id;
      opt.textContent = l.label;
      leagueSel.appendChild(opt);
    }
  }
  bindSchedule();
  await Promise.all([loadSchedGameweeks(), loadSchedClubs()]);
  await loadSchedFixtures();
  state.schedule.loaded = true;
}

const SEASON_BUCKETS = [
  ["domestic", tr("league.comp.domestic")],
  ["ucl", "UCL"],
  ["el", "EL"],
  ["uecl", "UECL"],
  ["national_cup", tr("league.comp.cups")],
  ["league_cup", "LgCup"],
  ["supercup", "Super"],
];

function seasonPts(n) {
  const v = Number(n) || 0;
  return v.toFixed(1);
}

function seasonClubKey(p) {
  if (p.af_team_id != null && p.af_team_id !== "") return String(p.af_team_id);
  return String(p.club_name || "");
}

function seasonClubOptions() {
  const league = state.season.league;
  const map = new Map();
  for (const p of state.season.data?.players || []) {
    if (league && p.league_id !== league) continue;
    const key = seasonClubKey(p);
    if (!key || key === "—") continue;
    if (!map.has(key)) map.set(key, p.club_name || key);
  }
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
}

function syncSeasonClubSelect() {
  const sel = $("season-club");
  if (!sel) return;
  const clubs = seasonClubOptions();
  const prev = state.season.club;
  const stillValid = prev && clubs.some(([id]) => id === prev);
  if (prev && !stillValid) state.season.club = "";
  sel.innerHTML =
    `<option value="">${tr("common.allClubs")}</option>` +
    clubs
      .map(
        ([id, name]) =>
          `<option value="${esc(id)}"${state.season.club === id ? " selected" : ""}>${esc(name)}</option>`,
      )
      .join("");
}

function filteredSeasonPlayers() {
  const s = state.season;
  const q = (s.q || "").trim().toLowerCase();
  let list = (s.data?.players || []).slice();
  if (s.league) list = list.filter((p) => p.league_id === s.league);
  if (s.club) list = list.filter((p) => seasonClubKey(p) === s.club);
  if (s.line) list = list.filter((p) => p.fantasy_line === s.line);
  if (q) {
    list = list.filter(
      (p) =>
        String(p.name || "").toLowerCase().includes(q) ||
        String(p.club_name || "").toLowerCase().includes(q),
    );
  }
  const key = s.sortKey;
  const dir = s.sortDir;
  list.sort((a, b) => {
    let va;
    let vb;
    if (key === "name") {
      va = a.name || "";
      vb = b.name || "";
      return dir * String(va).localeCompare(String(vb), "ru");
    }
    if (key === "club") {
      va = a.club_name || "";
      vb = b.club_name || "";
      return dir * String(va).localeCompare(String(vb), "ru");
    }
    if (key === "league") {
      va = a.league_id || "";
      vb = b.league_id || "";
      return dir * String(va).localeCompare(String(vb));
    }
    if (key === "line") {
      va = a.fantasy_line || "";
      vb = b.fantasy_line || "";
      return dir * String(va).localeCompare(String(vb));
    }
    if (SEASON_BUCKETS.some(([k]) => k === key)) {
      va = a.breakdown?.[key] ?? 0;
      vb = b.breakdown?.[key] ?? 0;
    } else if (key === "club_matches") {
      va = a.club_matches ?? 0;
      vb = b.club_matches ?? 0;
    } else if (key === "player_matches") {
      va = a.player_matches ?? a.player_apps ?? 0;
      vb = b.player_matches ?? b.player_apps ?? 0;
    } else if (key === "ppg_club") {
      va = a.ppg_club ?? 0;
      vb = b.ppg_club ?? 0;
    } else if (key === "ppg_player") {
      va = a.ppg_player ?? 0;
      vb = b.ppg_player ?? 0;
    } else {
      va = a.total ?? 0;
      vb = b.total ?? 0;
    }
    if (va === vb) return String(a.name).localeCompare(String(b.name), "ru");
    return dir * (va < vb ? -1 : 1);
  });
  return list;
}

function renderSeasonScatter(containerId, players, xKey, xLabel, tipXLabel, opts = {}) {
  const root = $(containerId);
  if (!root) return;
  const tip = $("season-chart-tip");
  const W = 560;
  const H = 300;
  const pad = { t: 18, r: 14, b: 40, l: 46 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const minX = Number.isFinite(opts.minX) ? opts.minX : 0;

  const pts = players
    .map((p) => ({
      name: p.name || "—",
      club: p.club_name || "—",
      total: Number(p.total) || 0,
      x: Number(p[xKey]) || 0,
    }))
    .filter((p) => p.total > 0 || p.x > 0);

  if (!pts.length) {
    root.innerHTML = `<h3 class="season-chart-title">${esc(xLabel)}</h3><p class="muted">${tr("league.noChartData")}</p>`;
    return;
  }

  let maxX = 0;
  let maxY = 0;
  for (const p of pts) {
    if (p.x > maxX) maxX = p.x;
    if (p.total > maxY) maxY = p.total;
  }
  maxX = Math.max(minX + 1, Math.ceil(maxX * 1.05));
  maxY = Math.max(1, Math.ceil(maxY * 1.08));
  const xRange = maxX - minX;

  const xScale = (v) =>
    pad.l + ((Math.min(maxX, Math.max(minX, v)) - minX) / xRange) * iw;
  const yScale = (v) => pad.t + ih - (v / maxY) * ih;

  const gridX = 4;
  const gridY = 4;
  let grids = "";
  for (let i = 0; i <= gridX; i++) {
    const x = pad.l + (iw * i) / gridX;
    const label = Math.round(minX + (xRange * i) / gridX);
    grids += `<line class="season-chart-grid" x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + ih}" />`;
    grids += `<text class="season-chart-axis" x="${x}" y="${H - 12}" text-anchor="middle">${label}</text>`;
  }
  for (let i = 0; i <= gridY; i++) {
    const y = pad.t + ih - (ih * i) / gridY;
    const label = Math.round((maxY * i) / gridY);
    grids += `<line class="season-chart-grid" x1="${pad.l}" y1="${y}" x2="${pad.l + iw}" y2="${y}" />`;
    grids += `<text class="season-chart-axis" x="${pad.l - 8}" y="${y + 3}" text-anchor="end">${label}</text>`;
  }

  const dots = pts
    .map((p, i) => {
      const cx = xScale(p.x);
      const cy = yScale(p.total);
      return `<circle class="season-chart-dot" data-i="${i}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2" />`;
    })
    .join("");

  root.innerHTML = `
    <h3 class="season-chart-title">${tr("league.ptsVs", { label: esc(xLabel) })}</h3>
    <svg class="season-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(xLabel)}">
      ${grids}
      <text class="season-chart-axis-title" x="${pad.l + iw / 2}" y="${H - 2}" text-anchor="middle">${esc(xLabel)}</text>
      <text class="season-chart-axis-title" x="14" y="${pad.t + ih / 2}" text-anchor="middle" transform="rotate(-90 14 ${pad.t + ih / 2})">${tr("league.pts")}</text>
      ${dots}
    </svg>`;

  const svg = root.querySelector(".season-chart-svg");
  svg?.querySelectorAll(".season-chart-dot").forEach((dot) => {
    const show = (ev) => {
      const i = Number(dot.getAttribute("data-i"));
      const p = pts[i];
      if (!p || !tip) return;
      tip.hidden = false;
      tip.innerHTML =
        `<strong>${esc(p.name)}</strong> · ${esc(p.club)}` +
        `<br/>Очки: <strong>${seasonPts(p.total)}</strong> · ${esc(tipXLabel)}: <strong>${p.x}</strong>`;
      const rect = root.getBoundingClientRect();
      const charts = $("season-charts")?.getBoundingClientRect();
      const left = ev.clientX - (charts?.left ?? rect.left) + 12;
      const top = ev.clientY - (charts?.top ?? rect.top) + 12;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, top)}px`;
      svg.querySelectorAll(".season-chart-dot.is-hot").forEach((d) => d.classList.remove("is-hot"));
      dot.classList.add("is-hot");
    };
    dot.addEventListener("pointerenter", show);
    dot.addEventListener("pointermove", show);
    dot.addEventListener("pointerleave", () => {
      if (tip) tip.hidden = true;
      dot.classList.remove("is-hot");
    });
  });
}

function renderSeasonCharts(players) {
  renderSeasonScatter(
    "season-chart-club",
    players,
    "club_matches",
    tr("league.clubMatches"),
    tr("league.clubMatchesTitle"),
    { minX: 34 },
  );
  renderSeasonScatter(
    "season-chart-player",
    players,
    "player_matches",
    tr("league.playerMatches"),
    tr("league.playerMatchesTitle"),
  );
}

function renderSeason() {
  const data = state.season.data;
  if (!data) return;
  syncSeasonClubSelect();
  const top = data.players?.[0];
  const lead = $("season-lead");
  if (lead) {
    lead.innerHTML =
      tr("league.seasonLead", { season: esc(data.season), count: data.player_count ?? 0 }) +
      (top
        ? tr("league.seasonLeader", { name: esc(top.name), pts: seasonPts(top.total) })
        : "") +
      `<br/><span class="muted">${tr("league.seasonMult")}</span>` +
      `<br/><span class="muted">${tr("league.seasonAvgHint")}</span>` +
      (data.cs_meta
        ? `<br/><span class="muted">${tr("league.csMeta", { with: data.cs_meta.fixtures_with_stats, total: data.cs_meta.cs_team_fixtures })}` +
          (data.cs_meta.fixtures_missing_stats
            ? tr("league.csMissing", { n: data.cs_meta.fixtures_missing_stats })
            : "") +
          `.</span>`
        : "");
  }
  const notes = $("season-notes");
  if (notes) {
    notes.innerHTML = (data.notes || [])
      .map((n) => `<li>${esc(n)}</li>`)
      .join("");
  }

  const list = filteredSeasonPlayers();
  renderSeasonCharts(list);
  const totalPages = Math.max(1, Math.ceil(list.length / POOL_PAGE_SIZE));
  if (state.season.page > totalPages) state.season.page = totalPages;
  if (state.season.page < 1) state.season.page = 1;
  const page = state.season.page;
  const slice = list.slice((page - 1) * POOL_PAGE_SIZE, page * POOL_PAGE_SIZE);

  const th = (key, label, title) => {
    const active = state.season.sortKey === key;
    const arrow = active ? (state.season.sortDir < 0 ? " ↓" : " ↑") : "";
    const tip = title ? ` title="${esc(title)}"` : "";
    return `<th class="sortable${active ? " sorted" : ""}" data-season-sort="${esc(key)}"${tip}>${esc(label)}${arrow}</th>`;
  };
  const thead = $("season-thead");
  if (thead) {
    thead.innerHTML =
      `${th("name", tr("common.player"))}${th("line", tr("common.line"))}${th("club", tr("common.club"))}${th("league", tr("common.league"))}${th("total", "Σ")}` +
      `${th("club_matches", tr("league.th.clubM"), tr("league.th.clubMTip"))}` +
      `${th("player_matches", tr("league.th.playerM"), tr("league.th.playerMTip"))}` +
      `${th("ppg_club", tr("league.th.ppgClub"), tr("league.th.ppgClubTip"))}` +
      `${th("ppg_player", tr("league.th.ppgPlayer"), tr("league.th.ppgPlayerTip"))}` +
      SEASON_BUCKETS.map(([k, lab]) => th(k, lab)).join("");
  }
  const tbody = $("season-rows");
  if (tbody) {
    tbody.innerHTML = slice
      .map((p) => {
        const bd = p.breakdown || {};
        const pMatches = p.player_matches ?? p.player_apps ?? 0;
        return `<tr>
          <td>${esc(p.name)}</td>
          <td class="mono">${esc(p.fantasy_line || "—")}</td>
          <td>${esc(p.club_name || "—")}</td>
          <td class="mono">${esc(p.league_id || "—")}</td>
          <td class="mono"><strong>${seasonPts(p.total)}</strong></td>
          <td class="mono">${p.club_matches ?? 0}</td>
          <td class="mono">${pMatches}</td>
          <td class="mono">${seasonPts(p.ppg_club)}</td>
          <td class="mono">${seasonPts(p.ppg_player)}</td>
          ${SEASON_BUCKETS.map(
            ([k]) => `<td class="mono">${seasonPts(bd[k] || 0)}</td>`,
          ).join("")}
        </tr>`;
      })
      .join("");
  }

  const pager = $("season-pager");
  if (pager) {
    const prevDis = page <= 1 ? " disabled" : "";
    const nextDis = page >= totalPages ? " disabled" : "";
    pager.innerHTML = `
      <button type="button" class="auth-link season-prev"${prevDis}>${tr("common.prevShort")}</button>
      <span class="muted">${page} / ${totalPages} · ${list.length} игроков</span>
      <button type="button" class="auth-link season-next"${nextDis}>${tr("common.next")}</button>`;
    pager.querySelector(".season-prev")?.addEventListener("click", () => {
      if (state.season.page <= 1) return;
      state.season.page -= 1;
      renderSeason();
    });
    pager.querySelector(".season-next")?.addEventListener("click", () => {
      state.season.page += 1;
      renderSeason();
    });
  }

  thead?.querySelectorAll("[data-season-sort]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.getAttribute("data-season-sort");
      if (state.season.sortKey === key) state.season.sortDir *= -1;
      else {
        state.season.sortKey = key;
        state.season.sortDir = key === "name" || key === "club" || key === "league" || key === "line" ? 1 : -1;
      }
      state.season.page = 1;
      renderSeason();
    });
  });
}

function bindSeason() {
  if (state.season.bound) return;
  state.season.bound = true;
  $("season-league")?.addEventListener("change", (e) => {
    state.season.league = e.target.value;
    state.season.club = "";
    state.season.page = 1;
    renderSeason();
  });
  $("season-club")?.addEventListener("change", (e) => {
    state.season.club = e.target.value;
    state.season.page = 1;
    renderSeason();
  });
  $("season-line")?.addEventListener("change", (e) => {
    state.season.line = e.target.value;
    state.season.page = 1;
    renderSeason();
  });
  $("season-q")?.addEventListener("input", (e) => {
    state.season.q = e.target.value;
    state.season.page = 1;
    renderSeason();
  });
}

async function initSeason() {
  const leagueSel = $("season-league");
  if (leagueSel && leagueSel.options.length <= 1) {
    for (const l of TOP8_LEAGUES) {
      const opt = document.createElement("option");
      opt.value = l.id;
      opt.textContent = l.label;
      leagueSel.appendChild(opt);
    }
  }
  bindSeason();
  const res = await fetch("/api/top8/season/2025-26");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const lead = $("season-lead");
    if (lead) {
      lead.textContent =
        err.error === "season_not_found"
          ? tr("league.seasonNoData8")
          : err.error || `HTTP ${res.status}`;
    }
    throw new Error(
      err.error === "season_not_found"
        ? "season_not_found — npm run top8:season:sync"
        : err.error || `HTTP ${res.status}`,
    );
  }
  state.season.data = await res.json();
  state.season.loaded = true;
  renderSeason();
}

function wireTabs() {
  const initial = initialTab();
  $("top8-tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    applyTab(btn.getAttribute("data-tab"));
  });
  if (initial !== "draft") applyTab(initial);
}

load().then(() => wireTabs());


document.addEventListener("din8sty:lang", () => {
  if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
  if (typeof state !== "undefined" && state.data && typeof renderDraft === "function") {
    try {
      const tab = document.querySelector(".primer-tab.active")?.getAttribute("data-tab") || "draft";
      if (typeof applyTab === "function") applyTab(tab);
      else if (typeof renderPanel === "function") renderPanel();
    } catch (e) {
      console.warn(e);
    }
  }
});
