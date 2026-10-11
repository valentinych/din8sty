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

const DRAFT_ROOM_VIEW_KEY = "din8sty.draftRoomView";
const HIDE_PICKED_KEY = "din8sty.top4.hidePicked";
/** Dual-range steps — keep in sync with pool filter <input step>. */
const MV_RANGE_STEP = 100_000;
const WAGE_RANGE_STEP = 1_000;
/** League-cap fallbacks when pool is empty / all MV·wage missing (never remaining budget). */
const FALLBACK_MV_MAX = 1_200_000_000;
const FALLBACK_WAGE_MAX = 5_000_000;

function loadHidePicked() {
  try {
    return localStorage.getItem(HIDE_PICKED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveHidePicked(value) {
  try {
    localStorage.setItem(HIDE_PICKED_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function pickedPlayerIdSet() {
  const ids = state.data?.live?.picked_player_ids;
  if (!Array.isArray(ids) || !ids.length) return null;
  return new Set(ids.map((id) => String(id)));
}

/** TM crest URLs wrongly stored as portraits — never treat as a player photo. */
function isRealPortraitUrl(url) {
  if (!url) return false;
  return !/\/wappen\//i.test(String(url));
}

/** Photo if real, else current club crest (when API provides it). */
function resolvePlayerAvatarUrl(portraitUrl, clubCrestUrl) {
  if (isRealPortraitUrl(portraitUrl)) return String(portraitUrl);
  if (clubCrestUrl) return String(clubCrestUrl);
  return null;
}

function drChipPhotoHtml(p) {
  const src = resolvePlayerAvatarUrl(p.portrait_url, p.club_crest);
  return src
    ? `<img class="dr-chip-photo" src="${esc(src)}" alt="" loading="lazy" />`
    : `<span class="dr-chip-photo placeholder"></span>`;
}

function loadDraftRoomViewMode() {
  try {
    const v = localStorage.getItem(DRAFT_ROOM_VIEW_KEY);
    if (v === "list" || v === "pitch") return v;
  } catch {
    /* ignore */
  }
  return "pitch";
}

function saveDraftRoomViewMode(mode) {
  try {
    localStorage.setItem(DRAFT_ROOM_VIEW_KEY, mode);
  } catch {
    /* ignore */
  }
}

const TOP4_TAB_SLUGS = {
  draft: "draft",
  "draft-room": "draftRoom",
  draftRoom: "draftRoom",
  squads: "squads",
  stats: "stats",
  statistics: "stats",
  live: "live",
  "live-standing": "live",
  results: "results",
  transfers: "transfers",
  gws: "gws",
  schedule: "schedule",
  rules: "rules",
  season: "season2526",
  season2526: "season2526",
  "season-2026": "season2627",
  season2627: "season2627",
};

function tabFromPath() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "live";
  const m = path.match(/^\/top4(?:\.html)?(?:\/([^/]+))?$/);
  if (!m) return null;
  const slug = m[1];
  if (!slug) return "draft";
  return TOP4_TAB_SLUGS[slug] || "draft";
}

function tabFromQuery() {
  const t = new URLSearchParams(location.search).get("tab");
  if (!t) return null;
  return TOP4_TAB_SLUGS[t] || null;
}

function initialTab() {
  return tabFromPath() || tabFromQuery() || "draft";
}

function tabTitleKey(tab) {
  if (tab === "season2526") return "league.tab.season";
  if (tab === "season2627") return "league.tab.season2627";
  if (tab === "draftRoom") return "league.tab.draftRoom";
  return `league.tab.${tab}`;
}

function syncTop4Title() {
  const base = tr("top4.title");
  if (state.tab === "draft") {
    document.title = base;
    return;
  }
  document.title = `${tr(tabTitleKey(state.tab))} · ${base}`;
}

let state = {
  tab: initialTab(),
  data: null,
  players: [],
  wishlist: [],
  wishlistEditable: false,
  wishlistSaving: false,
  wishlistOwner: null,
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
    mvMax: FALLBACK_MV_MAX,
    wageMin: 0,
    wageMax: FALLBACK_WAGE_MAX,
    hidePicked: loadHidePicked(),
  },
  bounds: {
    mvMin: 0,
    mvMax: FALLBACK_MV_MAX,
    wageMin: 0,
    wageMax: FALLBACK_WAGE_MAX,
  },
  /** True after initial /api/top4 + players load — gates auth-triggered refresh. */
  bootstrapped: false,
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
    loadedSlug: null,
    bySlug: {},
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
  results: {
    loaded: false,
    data: null,
    sortKey: "total",
    sortDir: -1,
    bound: false,
    /** @type {Record<string, object>} */
    gwCache: {},
    /** @type {object | null} */
    gwDetail: null,
    gwPending: null,
  },
  transfers: {
    loaded: false,
    data: null,
    sub: "dump",
    bound: false,
  },
  liveStand: {
    loaded: false,
    data: null,
    /** @type {Set<number>} */
    open: new Set(),
    bound: false,
    /** @type {{ teamId: number, playerId: string } | null} */
    breakdown: null,
  },
  gws: {
    loaded: false,
    data: null,
    /** Persist expand across re-renders; both start collapsed. */
    open: { current: false, next: false },
    bound: false,
  },
  draftRoom: {
    loaded: false,
    /** True when live picks changed while draft-room UI was not refreshed. */
    poolStale: false,
    sets: [],
    pool: [],
    formations: [],
    maxSets: 10,
    wishlistCount: 0,
    squadCount: 0,
    rules: null,
    editingId: null,
    draft: null,
    saving: false,
    bound: false,
    /** @type {'pitch' | 'list'} */
    viewMode: loadDraftRoomViewMode(),
    /** @type {{ slot: number, field: 'starter'|'replace1'|'replace2' } | null} */
    pick: null,
    /** @type {{ playerId: string, slot?: number, field?: string } | null} */
    dragFrom: null,
    /** Selected pool player waiting for a slot click. */
    selectedId: null,
  },
  /** Draft panel DOM is behind a poll while user is on another tab. */
  liveUiStale: false,
  /** Fill-vacancy modal context (after algo autos removed). */
  fillVacancy: null,
};

const TOP4_LEAGUE_SHORT = {
  GB1: "ENG",
  ES1: "SPA",
  IT1: "ITA",
  L1: "GER",
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
  if (v >= 1_000_000_000) {
    const b = v / 1_000_000_000;
    return `€${b.toFixed(b >= 10 || Number.isInteger(b) ? 0 : 1)}B`;
  }
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

/** Exact euro integer for squads tab — no K/M rounding. e.g. €175 000 000 */
function eurExact(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `€${Math.round(v).toLocaleString("ru-RU")}`;
}

/** Percent of league cap: round(sum / cap * 100), 0 decimals. */
function capPct(sum, cap) {
  const s = Number(sum);
  const c = Number(cap);
  if (!Number.isFinite(s) || !Number.isFinite(c) || c <= 0) return 0;
  return Math.round((s / c) * 100);
}

function statusLabel(status, data) {
  const full =
    data &&
    (data.slots?.taken || 0) >= (data.slots?.total || 0) &&
    (data.slots?.total || 0) > 0;
  if (status === "open" && full) return tr("league.err.registration_closed");
  return (
    {
      open: tr("league.status.open"),
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
  const next = `${location.pathname}${location.search}` || "/top4.html";
  return `/api/auth/login?next=${encodeURIComponent(next)}`;
}

async function loadPlayers() {
  const data = await api(
    `/api/players?leagues=${encodeURIComponent("GB1,ES1,IT1,L1")}&sort=rating-desc&limit=5000`,
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

/** Index / squads «Набрал» FP — `/api/players`.fp (TM primary, GW2+, multipliers, no ×1.2). */
function playerFp(p) {
  const direct = Number(p?.fp ?? p?.scored);
  if (Number.isFinite(direct)) return direct;
  return NaN;
}

function playerFpLookup(p, fpById) {
  const n = playerFp(p);
  if (Number.isFinite(n)) return n;
  const fromPool = fpById?.get(String(p?.id));
  return Number.isFinite(fromPool) ? fromPool : 0;
}

function playerFpByIdMap() {
  const map = new Map();
  for (const p of state.players || []) {
    const n = Number(p.fp);
    if (Number.isFinite(n)) map.set(String(p.id), n);
  }
  return map;
}

/** Same chips as squads / player index (`lu-avail is-inj` / `is-dsq`). */
function availBadgeHtml(avail) {
  if (!avail) return "";
  const title =
    avail.kind === "suspension"
      ? tr("lineup.suspended", { reason: avail.reason || "DSQ" })
      : tr("lineup.injured", { reason: avail.reason || "" });
  return avail.kind === "suspension"
    ? `<span class="lu-avail is-dsq" title="${esc(title)}">DSQ</span>`
    : `<span class="lu-avail is-inj" title="${esc(title)}" aria-label="${esc(title)}">+</span>`;
}

function playerAvailByIdMap() {
  const map = new Map();
  for (const p of state.players || []) {
    if (p.availability) map.set(String(p.id), p.availability);
  }
  return map;
}

function resolvePlayerAvail(p, availById) {
  return p?.availability || availById?.get(String(p?.id)) || null;
}

/** Mirror TOP4_DRAFT_CONFIG + canAddPlayerToTeam (primerDraft) for pool button gating. */
function leagueShortLabel(leagueId) {
  const row = TOP4_LEAGUES.find((l) => l.id === leagueId);
  return row ? row.label.split("·")[0].trim() : leagueId;
}

/** Current-roster club/league counts — same keys as buildPickEligibilityCtx. */
function rosterClubLeagueCounts(roster) {
  const clubs = new Map();
  const leagues = Object.create(null);
  for (const p of roster || []) {
    const cid = String(p.club_id || p.club_name || "");
    if (cid) {
      const cur = clubs.get(cid) || {
        n: 0,
        name: p.club_name || cid,
        crest: p.club_crest || null,
      };
      cur.n += 1;
      if (!cur.crest && p.club_crest) cur.crest = p.club_crest;
      if (p.club_name) cur.name = p.club_name;
      clubs.set(cid, cur);
    }
    const lid = String(p.league_id || "");
    if (lid) leagues[lid] = (leagues[lid] || 0) + 1;
  }
  return { clubs, leagues };
}

function squadLimitWarnings(roster, rules) {
  const { clubs, leagues } = rosterClubLeagueCounts(roster);
  const maxClub = rules.maxPerClub || 3;
  const minLeague = rules.minPerLeague || 3;
  const overClubs = [];
  const fullClubs = [];
  for (const club of clubs.values()) {
    if (club.n >= maxClub) fullClubs.push(club);
    if (club.n > maxClub) overClubs.push(club);
  }
  overClubs.sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
  fullClubs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const shortLeagues = [];
  for (const id of rules.leagueIds || TOP4_LEAGUES.map((l) => l.id)) {
    const n = leagues[id] || 0;
    if (n < minLeague) shortLeagues.push({ id, n, label: leagueShortLabel(id) });
  }
  return { overClubs, fullClubs, shortLeagues };
}

function draftPickRules() {
  const r = state.data?.rules || {};
  const leagues = Array.isArray(r.leagues)
    ? r.leagues.map((l) => String(l.id || l)).filter(Boolean)
    : TOP4_LEAGUES.map((l) => l.id);
  return {
    rounds: Number(r.rounds) || 26,
    mvCap: Number(r.mv_cap) || 1_200_000_000,
    wageCap: Number(r.wage_cap) || 5_000_000,
    minPerLeague: Number(r.min_per_league) || 3,
    maxPerClub: Number(r.max_per_club) || 3,
    minGk: Number(r.min_gk) || 3,
    leagueIds: leagues.length ? leagues : TOP4_LEAGUES.map((l) => l.id),
    reserveMv: Number(r.reserve_mv) || 5_000_000,
    reserveWage: Number(r.reserve_wage) || 70_000,
  };
}

function isPoolGk(p) {
  return playerLine(p) === "GK" || primaryRole(p) === "GK";
}

/** Current manager/consigliere owner's live squad as full pool players when possible. */
function myLiveSquadPlayers() {
  const owner = (wishlistOwnerEmail() || "").toLowerCase();
  if (!owner) return [];
  const team = (state.data?.squads?.teams || []).find(
    (t) => String(t.email || "").toLowerCase() === owner,
  );
  if (!team?.players?.length) return [];
  const byId = new Map((state.players || []).map((p) => [String(p.id), p]));
  return team.players.map((sp) => {
    const full = byId.get(String(sp.id));
    if (full) return full;
    return {
      id: sp.id,
      club_id: sp.club_id || "",
      club_name: sp.club_name || "",
      league_id: sp.league_id || "",
      market_value_eur: sp.market_value_eur || 0,
      wage_pw: sp.wage_pw || 0,
      trusted_wage_pw: sp.wage_pw || 0,
      position: String(sp.position_display || "").toUpperCase().startsWith("GK") ? "GK" : "",
      detail_role: null,
      detail_label: null,
      position_display: sp.position_display || "",
    };
  });
}

/**
 * Client mirror of canAddPlayerToTeam (primerDraft).
 * enforceRosterMins=true matches POST /api/top4/draft/pick.
 * Pass precomputed `ctx` from buildPickEligibilityCtx() when rendering a table.
 */
function pickEligibility(player, enforceRosterMins, ctx) {
  if (!ctx) {
    if (state.data?.status !== "drafting") return { ok: true, reason: null };
    if (!wishlistOwnerEmail()) return { ok: true, reason: null };
    ctx = buildPickEligibilityCtx();
  }
  if (!ctx.active) return { ok: true, reason: null };
  if (!player) return { ok: false, reason: "budget" };

  const { rules, clubCounts, leagueCounts, gkHave, sumMv, sumWage, squadLen } = ctx;

  const clubId = String(player.club_id || "");
  if (clubId && (clubCounts[clubId] || 0) + 1 > rules.maxPerClub) {
    return { ok: false, reason: "club" };
  }

  const mvLeft = rules.mvCap - sumMv - playerMv(player);
  const wageLeft = rules.wageCap - sumWage - playerWage(player);
  // Server: affordableLoose is the hard MV/wage ceiling.
  if (mvLeft < 0 || wageLeft < 0) return { ok: false, reason: "budget" };

  if (enforceRosterMins) {
    const remainingAfter = Math.max(0, rules.rounds - squadLen - 1);
    const nextLeagues = { ...leagueCounts };
    const plid = String(player.league_id || "");
    if (plid) nextLeagues[plid] = (nextLeagues[plid] || 0) + 1;
    let leagueNeed = 0;
    for (const id of rules.leagueIds) {
      leagueNeed += Math.max(0, rules.minPerLeague - (nextLeagues[id] || 0));
    }
    const nextGk = gkHave + (isPoolGk(player) ? 1 : 0);
    const gkNeed = Math.max(0, rules.minGk - nextGk);
    if (remainingAfter < leagueNeed || remainingAfter < gkNeed) {
      return { ok: false, reason: "mins" };
    }
  }

  return { ok: true, reason: null };
}

function buildPickEligibilityCtx(opts = {}) {
  const force = Boolean(opts.force);
  const override = opts.squad;
  if (!force && (state.data?.status !== "drafting" || !wishlistOwnerEmail())) {
    return { active: false };
  }
  if (force && !override && !wishlistOwnerEmail()) {
    return { active: false };
  }
  const rules = draftPickRules();
  const squad = override || myLiveSquadPlayers();
  let sumMv = 0;
  let sumWage = 0;
  const clubCounts = Object.create(null);
  const leagueCounts = Object.create(null);
  let gkHave = 0;
  for (const p of squad) {
    sumMv += playerMv(p);
    sumWage += playerWage(p);
    const cid = String(p.club_id || "");
    if (cid) clubCounts[cid] = (clubCounts[cid] || 0) + 1;
    const lid = String(p.league_id || "");
    if (lid) leagueCounts[lid] = (leagueCounts[lid] || 0) + 1;
    if (isPoolGk(p)) gkHave += 1;
  }
  return {
    active: true,
    rules,
    clubCounts,
    leagueCounts,
    gkHave,
    sumMv,
    sumWage,
    squadLen: squad.length,
  };
}

function pickBlockTitle(reason) {
  if (reason === "club") return tr("league.live.blockedClub");
  if (reason === "budget") return tr("league.live.blockedBudget");
  if (reason === "mins") return tr("league.live.blockedMins");
  if (reason === "taken") return tr("league.err.player_taken");
  if (reason === "league") return tr("league.err.not_in_draft_pool");
  return tr("league.live.blocked");
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

function snapRangeMax(value, step) {
  const v = Number(value) || 0;
  const s = Math.max(1, Number(step) || 1);
  return Math.max(s, Math.ceil(v / s) * s);
}

/**
 * Full-pool MV/wage span for dual-range filters.
 * Never clamp to remaining personal budget — budget gates picks/wishlist only.
 */
function computePoolBounds() {
  let mvMax = 0;
  let wageMax = 0;
  for (const p of state.players || []) {
    mvMax = Math.max(mvMax, playerMv(p));
    wageMax = Math.max(wageMax, playerWage(p));
  }
  const rules = typeof draftPickRules === "function" ? draftPickRules() : {};
  // Empty pool / all-zero MV·wage used to become Math.max(x,1) → UI «€0–€1» / «€0K–€0K».
  if (mvMax <= 1) mvMax = Number(rules.mvCap) || FALLBACK_MV_MAX;
  if (wageMax <= 1) wageMax = Number(rules.wageCap) || FALLBACK_WAGE_MAX;
  return {
    mvMin: 0,
    mvMax: snapRangeMax(mvMax, MV_RANGE_STEP),
    wageMin: 0,
    wageMax: snapRangeMax(wageMax, WAGE_RANGE_STEP),
  };
}

function rangeFiltersCorrupt(bounds = state.bounds, filters = state.filters) {
  const b = bounds;
  const f = filters;
  const mvLo = Number(f.mvMin);
  const mvHi = Number(f.mvMax);
  const wLo = Number(f.wageMin);
  const wHi = Number(f.wageMax);
  if (![mvLo, mvHi, wLo, wHi].every(Number.isFinite)) return true;
  if (mvHi < mvLo || wHi < wLo) return true;
  // Sentinel from old Math.max(x, 1) / empty-pool collapse. With step 100k / 1k,
  // a non-zero hi below one step is unreachable via the slider.
  if (b.mvMax >= MV_RANGE_STEP && mvHi > 0 && mvHi < MV_RANGE_STEP) return true;
  if (b.wageMax >= WAGE_RANGE_STEP && wHi > 0 && wHi < WAGE_RANGE_STEP) return true;
  return false;
}

function resetRangeFiltersToBounds() {
  const b = state.bounds;
  state.filters.mvMin = b.mvMin;
  state.filters.mvMax = b.mvMax;
  state.filters.wageMin = b.wageMin;
  state.filters.wageMax = b.wageMax;
}

/** Recompute full-pool bounds; reset selection when corrupt or opts.reset. */
function ensureFilterBounds(opts = {}) {
  const reset = Boolean(opts.reset);
  const prevMvBound = Number(state.bounds?.mvMax) || 0;
  const prevWageBound = Number(state.bounds?.wageMax) || 0;
  state.bounds = computePoolBounds();
  const expanded =
    (prevMvBound < MV_RANGE_STEP && state.bounds.mvMax >= MV_RANGE_STEP) ||
    (prevWageBound < WAGE_RANGE_STEP && state.bounds.wageMax >= WAGE_RANGE_STEP);
  const stuckLow =
    expanded &&
    Number(state.filters.mvMax) < MV_RANGE_STEP &&
    Number(state.filters.wageMax) < WAGE_RANGE_STEP;
  if (reset || rangeFiltersCorrupt() || stuckLow) resetRangeFiltersToBounds();
}

function initFilterBounds() {
  // Start at 0 so players with missing MV/wage stay visible at default range.
  ensureFilterBounds({ reset: true });
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
  ensureFilterBounds();
  const f = state.filters;
  const hidePicked =
    Boolean(f.hidePicked) &&
    (state.data?.status === "drafting" || state.tab === "transfers");
  const picked = !hidePicked
    ? null
    : state.tab === "transfers"
      ? transferTakenIdSet()
      : pickedPlayerIdSet();
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
    if (picked?.has(String(p.id))) return false;
    return true;
  });
}

function sortMetricValue(p, key) {
  if (key === "rating") return Number(p.fm_rating);
  if (key === "mv") return Number(p.market_value_eur);
  if (key === "wage") return playerWage(p);
  if (key === "fp") return playerFp(p);
  return NaN;
}

function compareBySortKey(a, b, key, dir) {
  const num = key === "rating" || key === "mv" || key === "wage" || key === "fp";
  let va;
  let vb;
  if (num) {
    va = sortMetricValue(a, key);
    vb = sortMetricValue(b, key);
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
  if (num) {
    c = (Number.isFinite(va) ? va : -1) - (Number.isFinite(vb) ? vb : -1);
  } else {
    c = String(va ?? "").localeCompare(String(vb ?? ""), "ru", { numeric: true });
  }
  return c * dir || String(a.name ?? "").localeCompare(String(b.name ?? ""));
}

function sortedPlayers() {
  const key = state.sortKey;
  const dir = state.sortDir;
  return filteredPlayers().sort((a, b) => compareBySortKey(a, b, key, dir));
}

function isMetricSortKey(key) {
  return key === "rating" || key === "mv" || key === "wage";
}

function sortTh(label, key) {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDir > 0 ? " ↑" : " ↓") : "";
  return `<th class="sortable${active ? " sorted" : ""}" data-sort="${esc(key)}">${esc(label)}${arrow}</th>`;
}

function renderRegs(data) {
  const regs = data.registrations || [];
  const slots = data.slots || { taken: 0, total: 10 };
  const rows = Array.from({ length: slots.total }, (_, i) => {
    const r = regs[i];
    if (!r) {
      return `<li class="top4-slot empty"><span class="top4-slot-n">${i + 1}</span><span class="muted">${tr("league.free")}</span></li>`;
    }
    const mine = data.me?.user?.email && r.email.toLowerCase() === data.me.user.email.toLowerCase();
    const logo = r.logo_url
      ? `<img class="top4-team-logo" src="${esc(r.logo_url)}" alt="" width="28" height="28" loading="lazy" />`
      : `<span class="top4-team-logo top4-team-logo--empty" aria-hidden="true"></span>`;
    return `<li class="top4-slot${mine ? " mine" : ""}">
      <span class="top4-slot-n">${i + 1}</span>
      ${logo}
      <span class="top4-slot-name">${esc(r.team_name || r.name || r.email)}</span>
      <span class="muted top4-slot-email">${esc(r.name || r.email)}</span>
    </li>`;
  }).join("");
  return `
    <div class="top4-regs">
      <div class="top4-regs-head">
        <h2 class="section-title">${tr("league.participants")} <span class="muted">${slots.taken}/${slots.total}</span></h2>
        <span class="status-pill ${data.status === "open" && (data.slots?.taken || 0) < (data.slots?.total || 9) ? "ok" : "bad"}">${esc(statusLabel(data.status, data))}</span>
      </div>
      <ul class="top4-slot-list">${rows}</ul>
    </div>`;
}

function renderRenameForm(myTeam) {
  return `<form class="top4-join" id="form-rename">
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
}

function renderConsigliereAssign(data) {
  const me = data.me || {};
  if (!me.user || !me.registered) return "";
  const myEmail = (me.user.email || "").toLowerCase();
  const current = (
    me.consigliere_email ||
    me.registration?.consigliere_email ||
    ""
  ).toLowerCase();
  const others = (data.registrations || []).filter(
    (r) => (r.email || "").toLowerCase() !== myEmail,
  );
  const options = [
    `<option value="">${esc(tr("league.consigliereNone"))}</option>`,
    ...others.map((r) => {
      const email = (r.email || "").toLowerCase();
      const team = r.team_name || r.name || email;
      const label =
        team && team.toLowerCase() !== email
          ? `${team} · ${email}`
          : email;
      const sel = email === current ? " selected" : "";
      return `<option value="${esc(email)}"${sel}>${esc(label)}</option>`;
    }),
  ].join("");
  return `
    <div class="top4-consigliere" id="consigliere-panel">
      <h2 class="section-title">consigliere</h2>
      <p class="muted">${tr("league.consigliereHint")}</p>
      <form class="top4-join" id="form-consigliere">
        <select name="consigliere" id="consigliere-input" aria-label="consigliere">
          ${options}
        </select>
        <button type="submit" class="auth-btn">${tr("league.consigliereSave")}</button>
      </form>
    </div>`;
}

/** Team rename + code + logo + consigliere for registered managers (Draft tab only).
 *  Collapsed during open registration; expanded once draft/lottery starts so logo
 *  settings stay discoverable after the rename form disappears. */
function renderTeamSettings(data) {
  const me = data.me || {};
  if (!me.user || !me.registered) return "";
  const open = data.status === "open";
  const myTeam = me.registration?.team_name || "";
  const myCode = me.registration?.team_code || "";
  const logoUrl = me.registration?.logo_url || "";
  const nameBlock = open
    ? renderRenameForm(myTeam)
    : `<span class="status-pill ok top4-team-name-pill">${
        logoUrl
          ? `<img class="top4-team-logo" src="${esc(logoUrl)}" alt="" width="28" height="28" />`
          : ""
      }${esc(myTeam || tr("league.inLeague"))}${
        myCode
          ? ` <span class="top4-team-code-pill mono" title="${esc(myTeam)}">${esc(myCode)}</span>`
          : ""
      }</span>`;
  const codeBlock = `
    <div class="top4-code-settings" id="code-panel">
      <h2 class="section-title">${esc(tr("league.teamCode"))}</h2>
      <p class="muted">${esc(tr("league.teamCodeHint"))}</p>
      <form class="top4-join" id="form-team-code">
        <input
          type="text"
          name="teamCode"
          id="team-code-input"
          required
          minlength="3"
          maxlength="3"
          pattern="[A-Za-z]{3}"
          value="${esc(myCode)}"
          placeholder="ABC"
          autocomplete="off"
          spellcheck="false"
          class="mono top4-team-code-input"
          title="${esc(tr("league.teamCodeHint"))}"
        />
        <button type="submit" class="auth-btn">${esc(tr("league.teamCodeSave"))}</button>
      </form>
      <p class="meta inline" id="code-msg" hidden></p>
    </div>`;
  const preview = logoUrl
    ? `<img class="top4-logo-preview" id="logo-preview" src="${esc(logoUrl)}" alt="" />`
    : `<span class="top4-logo-preview top4-logo-preview--empty" id="logo-preview" aria-hidden="true"></span>`;
  const removeBtn = logoUrl
    ? `<button type="button" class="auth-link" id="btn-logo-remove">${esc(tr("league.logoRemove"))}</button>`
    : "";
  const logoBlock = `
    <div class="top4-logo-settings" id="logo-panel">
      <h2 class="section-title">${esc(tr("league.logo"))}</h2>
      <p class="muted">${esc(tr("league.logoHint"))}</p>
      <div class="top4-logo-row">
        ${preview}
        <div class="top4-logo-controls">
          <label class="auth-btn top4-logo-file-label">
            ${esc(logoUrl ? tr("league.logoReplace") : tr("league.logoUpload"))}
            <input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden />
          </label>
          ${removeBtn}
        </div>
      </div>
      <p class="meta inline" id="logo-msg" hidden></p>
    </div>`;
  const consigliere = renderConsigliereAssign(data);
  // Expand after registration closes — logo/code/consigliere are the main controls then.
  const openAttr = open ? "" : " open";
  return `
    <details class="top4-team-settings"${openAttr}>
      <summary>${esc(tr("league.teamSettings"))}</summary>
      <div class="top4-team-settings-body">
        ${nameBlock}
        ${codeBlock}
        ${logoBlock}
        ${consigliere}
      </div>
    </details>`;
}

function renderActions(data) {
  const me = data.me || {};
  const full = (data.slots?.taken || 0) >= (data.slots?.total || 9);
  const open = data.status === "open";

  let userBtn = "";
  if (!me.user) {
    userBtn = `<a class="auth-btn" href="${esc(loginHref())}">${tr("league.loginJoin")}</a>`;
  } else if (open && !me.registered && !full) {
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
  }

  const complete = data.status === "complete";
  const lineupLink = complete
    ? `<a class="auth-btn" href="/lineup.html?league=top4">${tr("league.openLineup")}</a>`
    : "";

  // Admin ops (lottery / start draft / reset) stay on APIs only — not in normal UI.
  return `<div class="top4-actions">${userBtn}${lineupLink}<p class="meta inline" id="action-msg"></p></div>`;
}

function renderConsigliere(data) {
  const me = data.me || {};
  if (!me.user) return "";
  const clients = me.consigliere_for || [];
  if (!clients.length) return "";
  const list = clients
    .map(
      (c) =>
        `<li><strong>${esc(c.team_name)}</strong> <span class="muted">${esc(c.email)}</span></li>`,
    )
    .join("");
  const locked = me.wishlist_locked_by_manager
    ? `<p class="muted">${tr("league.consigliereLockedByManager")}</p>`
    : `<p class="muted">${tr("league.consigliereActingHint")}</p>`;
  return `
    <section class="top4-consigliere acting">
      <h2 class="section-title">${tr("league.consigliereActing")}</h2>
      ${locked}
      <ul class="top4-rules-list">${list}</ul>
      ${
        data.status === "complete"
          ? `<a class="auth-link" href="/lineup.html?league=top4">${tr("league.openLineup")}</a>`
          : ""
      }
    </section>`;
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

function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Client-side draft-hours helpers (mirrors src/draftHours.ts) for the live timer. */
function draftHoursConfigFromLive(hours) {
  const start = String(hours?.start || "10:00").split(":");
  const end = String(hours?.end || "20:00").split(":");
  return {
    timezone: hours?.tz || "Europe/Warsaw",
    startHour: Number(start[0]) || 10,
    startMinute: Number(start[1]) || 0,
    endHour: Number(end[0]) || 20,
    endMinute: Number(end[1]) || 0,
  };
}

function draftHoursPartsInTz(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

function draftHoursUtcFromWall(y, m, d, h, min, tz) {
  let utc = Date.UTC(y, m - 1, d, h, min, 0);
  for (let i = 0; i < 4; i++) {
    const p = draftHoursPartsInTz(utc, tz);
    const desired = Date.UTC(y, m - 1, d, h, min, 0);
    const actual = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, 0);
    utc += desired - actual;
  }
  return utc;
}

function draftHoursAddDays(y, m, d, days, tz) {
  const base = draftHoursUtcFromWall(y, m, d, 12, 0, tz);
  return draftHoursPartsInTz(base + days * 86_400_000, tz);
}

function draftHoursWorkingMs(startMs, endMs, config) {
  if (endMs <= startMs) return 0;
  const { timezone: tz, startHour, startMinute, endHour, endMinute } = config;
  const windowLen =
    (endHour * 60 + endMinute - (startHour * 60 + startMinute)) * 60_000;
  if (windowLen <= 0) return endMs - startMs;
  let total = 0;
  let { y, m, d } = draftHoursPartsInTz(startMs, tz);
  const endParts = draftHoursPartsInTz(endMs, tz);
  for (let n = 0; n < 400; n++) {
    const dayStart = draftHoursUtcFromWall(y, m, d, startHour, startMinute, tz);
    const dayEnd = draftHoursUtcFromWall(y, m, d, endHour, endMinute, tz);
    const from = Math.max(startMs, dayStart);
    const to = Math.min(endMs, dayEnd);
    if (to > from) total += to - from;
    if (
      y > endParts.y ||
      (y === endParts.y && m > endParts.m) ||
      (y === endParts.y && m === endParts.m && d >= endParts.d)
    ) {
      break;
    }
    ({ y, m, d } = draftHoursAddDays(y, m, d, 1, tz));
  }
  return total;
}

function isWithinDraftHoursClient(nowMs, config) {
  const { timezone: tz, startHour, startMinute, endHour, endMinute } = config;
  const { y, m, d } = draftHoursPartsInTz(nowMs, tz);
  const ws = draftHoursUtcFromWall(y, m, d, startHour, startMinute, tz);
  const we = draftHoursUtcFromWall(y, m, d, endHour, endMinute, tz);
  return nowMs >= ws && nowMs < we;
}

function pickTimerRemainingMsClient(pickAtMs, nowMs, timeoutSec, config) {
  const used = draftHoursWorkingMs(pickAtMs, nowMs, config);
  return Math.max(0, timeoutSec * 1000 - used);
}

/** Signature of live picks — changes when someone drafts a player. */
function livePickSignature(data) {
  const live = data?.live;
  if (!live) return `${data?.status || ""}:0:0:`;
  const n = live.pick_no ?? 0;
  const ids = Array.isArray(live.picked_player_ids) ? live.picked_player_ids : [];
  const len = ids.length || (live.recent_picks || []).length;
  // Last id catches rare same-length swaps; my_turn flips with the clock.
  const last = ids.length ? String(ids[ids.length - 1]) : "";
  const myTurn = data.me?.my_turn ? 1 : 0;
  return `${data.status}:${n}:${len}:${myTurn}:${last}`;
}

function myBankRow(data) {
  const live = data.live;
  if (!live) return null;
  const owner = (wishlistOwnerEmail() || data.me?.user?.email || "").toLowerCase();
  if (!owner) return null;
  return (live.banks || []).find((b) => b.email.toLowerCase() === owner) || null;
}

function renderLiveDraft(data) {
  const live = data.live;
  if (!live || data.status !== "drafting") return "";
  const onClock = live.on_clock;
  const turn = live.turn;
  const myTurn = Boolean(data.me?.my_turn);
  const hoursCfg = draftHoursConfigFromLive(live.draft_hours);
  const pickAtMs = turn?.pick_at ? Date.parse(turn.pick_at) : NaN;
  const paused = turn
    ? !isWithinDraftHoursClient(Date.now(), hoursCfg)
    : Boolean(turn?.paused);
  const remainingMs =
    turn && Number.isFinite(pickAtMs)
      ? pickTimerRemainingMsClient(pickAtMs, Date.now(), turn.timeout_sec || 0, hoursCfg)
      : turn?.remaining_ms ?? 0;
  const remaining = turn && !paused ? fmtClock(remainingMs) : tr("league.live.paused");
  const bankRemaining = turn ? fmtClock(turn.bank_remaining_sec * 1000) : "—";

  const minRoster = Number(data.rules?.rounds) || 26;
  const banksRows = (live.banks || [])
    .map((b) => {
      const isOnClock = Boolean(onClock && b.email.toLowerCase() === onClock.email.toLowerCase());
      return `<li class="top4-live-bank${isOnClock ? " on-clock" : ""}">
        <span class="top4-live-bank-team">${esc(b.team_name)}</span>
        <span class="mono">${fmtClock(b.bank_remaining_sec * 1000)}</span>
        <span class="muted mono">${b.player_count ?? 0}</span>
        ${b.draft_finished ? `<span class="status-pill" title="${esc(tr("league.live.finishTip"))}">${esc(tr("league.live.finished"))}</span>` : ""}
        ${!b.draft_finished && b.out_of_draft ? `<span class="status-pill ok" title="${esc(tr("league.live.oodTip"))}">OOD</span>` : ""}
      </li>`;
    })
    .join("");

  const recentRows = (live.recent_picks || [])
    .map((p) => {
      const auto =
        p.auto === 1
          ? `<span class="muted">(${esc(tr("league.live.autoWishlist"))})</span>`
          : p.auto === 2
            ? `<span class="muted">(${esc(tr("league.live.autoFallback"))})</span>`
            : "";
      return `<li>
        <span class="mono">#${p.pick_number}</span>
        <a class="player-link" href="/player.html?id=${encodeURIComponent(p.player.id)}">${esc(p.player.name)}</a>
        <span class="muted">${esc(p.player.position_display || "")} · ${esc(p.player.club_name || "")}</span>
        <span class="muted">${esc(p.team_name)}</span>
        ${auto}
      </li>`;
    })
    .join("");

  const myBank = myBankRow(data);
  const canToggleOod = canUseWishlist() && Boolean(myBank) && !myBank.draft_finished;
  const oodBtn = canToggleOod
    ? `<button type="button" class="auth-link" id="btn-toggle-ood">${esc(myBank.out_of_draft ? tr("league.live.oodOff") : tr("league.live.oodOn"))}</button>`
    : "";
  const canFinish = canUseWishlist() && Boolean(myBank);
  const finishReady = Boolean(myBank && (myBank.player_count ?? 0) >= minRoster);
  const finishBtn = canFinish
    ? myBank.draft_finished
      ? `<button type="button" class="auth-link" id="btn-toggle-finish">${esc(tr("league.live.finishOff"))}</button>`
      : finishReady
        ? `<button type="button" class="auth-link" id="btn-toggle-finish" title="${esc(tr("league.live.finishTip"))}">${esc(tr("league.live.finishOn"))}</button>`
        : `<button type="button" class="auth-link" id="btn-toggle-finish" disabled title="${esc(tr("league.err.finish_requires_26"))}">${esc(tr("league.live.finishOn"))}</button>`
    : "";
  const progress = `${esc(tr("league.live.pickNo", { n: live.pick_no }))} · ${esc(
    tr("league.live.managersLeft", { n: live.active_managers_left ?? 0 }),
  )} · ${esc(tr("league.live.round", { round: live.round }))}`;

  return `
    <section class="top4-live" id="top4-live">
      <div class="top4-live-head">
        <h2 class="section-title">${tr("league.live.title")} <span class="muted">${progress}</span></h2>
        ${
          live.draft_hours
            ? `<p class="muted">${esc(tr("league.draftHours"))}: ${esc(live.draft_hours.start)}–${esc(live.draft_hours.end)}</p>`
            : ""
        }
      </div>
      <div class="top4-live-turn${myTurn ? " my-turn" : ""}${paused ? " paused" : ""}">
        <div class="top4-live-onclock">
          <span class="muted">${tr("league.live.onClock")}</span>
          <strong>${onClock ? esc(onClock.team_name) : "—"}</strong>
          <span class="muted">${onClock ? esc(onClock.name || onClock.email) : ""}</span>
        </div>
        <div class="top4-live-timer">
          <span class="top4-live-timer-v mono" id="live-turn-clock">${esc(remaining)}</span>
          <span class="muted">${tr("league.live.turnLeft")}</span>
        </div>
        <div class="top4-live-timer">
          <span class="top4-live-timer-v mono" id="live-bank-clock">${esc(bankRemaining)}</span>
          <span class="muted">${tr("league.live.bankLeft")}</span>
        </div>
        ${myTurn ? `<span class="status-pill ok">${tr("league.live.yourTurn")}</span>` : ""}
        ${myBank?.draft_finished ? `<span class="status-pill">${esc(tr("league.live.finished"))}</span>` : ""}
        ${oodBtn}
        ${finishBtn}
      </div>
      <div class="top4-live-grid">
        <div>
          <h3 class="subhead">${tr("league.live.banks")}</h3>
          <ul class="top4-live-bank-list">${banksRows}</ul>
        </div>
        <div>
          <h3 class="subhead">${tr("league.live.recent")}</h3>
          <ol class="top4-live-recent">${recentRows || `<li class="muted">${tr("league.live.recentEmpty")}</li>`}</ol>
        </div>
      </div>
    </section>`;
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

function renderSquads() {
  const body = $("squads-body");
  if (!body) return;
  const teams = state.data?.squads?.teams || [];
  if (!teams.length) {
    body.innerHTML = `<p class="muted">${esc(tr("league.squads.empty"))}</p>`;
    return;
  }
  const rules = draftPickRules();
  const owner = (wishlistOwnerEmail() || "").toLowerCase();
  body.innerHTML = teams
    .map((t) => {
      const manager = t.name || t.email || "";
      const roster = t.players || [];
      const mv = roster.reduce((s, p) => s + (Number(p.market_value_eur) || 0), 0);
      const wage = roster.reduce((s, p) => s + (Number(p.wage_pw) || 0), 0);
      const activeCount = roster.length;
      const mvPct = capPct(mv, rules.mvCap);
      const wagePct = capPct(wage, rules.wageCap);
      const mvLeft = rules.mvCap - mv;
      const wageLeft = rules.wageCap - wage;
      const mine =
        Boolean(owner) && String(t.email || "").toLowerCase() === owner;
      const algoCount = (t.players || []).filter(
        (p) => Number(p.auto) === 2 && !p.replaced,
      ).length;
      const vacancies = Number(t.vacancies) || 0;
      const playerRow = (p, former) => {
          const canRemove =
            !former && mine && Number(p.auto) === 2 && !p.replaced;
          const removeBtn = canRemove
            ? `<button type="button" class="top4-replace-auto-btn" data-remove-auto="${esc(String(p.id))}" data-pick-number="${esc(String(p.pick_number ?? ""))}" data-player-name="${esc(p.name || "")}" title="${esc(tr("league.squads.removeAuto"))}" aria-label="${esc(tr("league.squads.removeAuto"))}">✕</button>`
            : "";
          const avail = !former ? p.availability : null;
          const availTitle = avail
            ? avail.kind === "suspension"
              ? tr("lineup.suspended", { reason: avail.reason || "DSQ" })
              : tr("lineup.injured", { reason: avail.reason || "" })
            : "";
          const availBadge = !avail
            ? ""
            : avail.kind === "suspension"
              ? `<span class="lu-avail is-dsq" title="${esc(availTitle)}">DSQ</span>`
              : `<span class="lu-avail is-inj" title="${esc(availTitle)}" aria-label="${esc(availTitle)}">+</span>`;
          const crest = p.club_crest
            ? `<img class="top4-squad-crest" src="${esc(p.club_crest)}" alt="" width="18" height="18" loading="lazy" />`
            : "";
          const mark = former
            ? `<span class="top4-squad-former-mark">${esc(tr("league.squads.formerShort"))}</span>`
            : p.out
              ? `<span class="lu-avail is-dsq top4-squad-out" title="OUT">OUT</span>`
              : (p.pick_number ?? "");
          return `<tr${former ? ' class="top4-squad-former"' : ""}>
            <td class="mono">${mark}</td>
            <td class="top4-squad-player-cell">
              <a class="player-link" href="/player.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a>
              ${availBadge}
              ${removeBtn}
            </td>
            <td class="top4-squad-fpts"><span class="top4-squad-fpts-chip mono" title="${esc(tr("squad.broughtTip"))}">${esc(resultsPts(p.brought))}</span></td>
            <td class="top4-squad-fpts"><span class="top4-squad-fpts-chip mono" title="${esc(tr("squad.scoredTip"))}">${esc(resultsPts(p.scored))}</span></td>
            <td>${esc(p.position_display || "")}</td>
            <td><span class="top4-squad-club">${crest}<span>${esc(p.club_name || "")}</span></span></td>
            <td class="money">${eurExact(p.market_value_eur)}</td>
            <td class="money">${eurExact(p.wage_pw)}</td>
          </tr>`;
        };
      const former = t.former || [];
      const formerRows = former.length
        ? `<tr class="top4-squad-former-head"><td colspan="8">${esc(tr("league.squads.former"))}</td></tr>${former.map((p) => playerRow(p, true)).join("")}`
        : "";
      const rows = (t.players || []).map((p) => playerRow(p, false)).join("") + formerRows;
      const empty = `<tr><td colspan="8" class="muted">${esc(tr("league.squads.noPicks"))}</td></tr>`;
      const actions =
        mine && (algoCount > 0 || vacancies > 0)
          ? `<div class="top4-squad-actions">
              ${
                algoCount > 0
                  ? `<button type="button" class="auth-link" data-remove-auto-all="${esc(String(t.team_id))}">${esc(tr("league.squads.removeAllAuto"))}</button>`
                  : ""
              }
              ${
                vacancies > 0
                  ? `<button type="button" class="auth-btn" data-fill-vacancy="${esc(String(t.team_id))}">${esc(tr("league.squads.fillVacancy"))}</button>`
                  : ""
              }
            </div>`
          : "";
      const vacNote =
        vacancies > 0 && state.data?.status !== "complete"
          ? ` · <span class="top4-squad-vacancy">${esc(tr("league.squads.needsReplace", { n: vacancies }))}</span>`
          : "";
      const limits = squadLimitWarnings(roster, rules);
      const warnBits = [
        ...limits.overClubs.map((c) => tr("league.squads.overClub", { club: c.name, n: c.n })),
        ...limits.shortLeagues.map((l) =>
          tr("league.squads.underLeague", { league: l.label, n: l.n }),
        ),
      ];
      const warnHtml = warnBits.length
        ? `<p class="top4-squad-limit-warn">${esc(warnBits.join(" · "))}</p>`
        : "";
      const fullCrests = limits.fullClubs
        .filter((c) => c.crest)
        .map(
          (c) =>
            `<img class="top4-squad-crest" src="${esc(c.crest)}" alt="${esc(c.name)}" title="${esc(c.name)} (${c.n})" width="22" height="22" loading="lazy" />`,
        )
        .join("");
      const fullPickedHtml = fullCrests
        ? `<p class="top4-squad-full-picked"><span>${esc(tr("league.squads.fullPicked"))}</span>${fullCrests}</p>`
        : "";
      return `<section class="team-block top4-squad-block${mine ? " mine" : ""}" id="squad-team-${t.team_id}">
        <h3 class="subhead top4-squad-head">${
          t.logo_url
            ? `<img class="top4-team-logo top4-team-logo--lg" src="${esc(t.logo_url)}" alt="" width="36" height="36" loading="lazy" />`
            : ""
        }<span>${esc(t.team_name)}${manager ? ` · ${esc(manager)}` : ""}</span></h3>
        ${warnHtml}
        <div class="top4-squad-caps">
          <p class="meta inline">${esc(tr("league.squads.count", { n: activeCount }))} · MV ${eurExact(mv)} (${mvPct}%) · wage ${eurExact(wage)} (${wagePct}%)${vacNote}</p>
          <p class="meta inline">${esc(tr("league.squads.remain", { mv: eurExact(mvLeft), wage: eurExact(wageLeft) }))}</p>
          ${fullPickedHtml}
        </div>
        ${actions}
        <div class="table-wrap nested">
          <table class="compact-table">
            <thead>
              <tr>
                <th>#</th>
                <th>${tr("common.player")}</th>
                <th class="top4-squad-fpts" title="${esc(tr("squad.broughtTip"))}">${esc(tr("league.squads.brought"))}</th>
                <th class="top4-squad-fpts" title="${esc(tr("squad.scoredTip"))}">${esc(tr("league.squads.scored"))}</th>
                <th>${tr("common.posDot")}</th>
                <th>${tr("common.club")}</th>
                <th>${tr("common.value")}</th>
                <th>${tr("common.wage")}</th>
              </tr>
            </thead>
            <tbody>${rows || empty}</tbody>
          </table>
        </div>
      </section>`;
    })
    .join("");

  body.querySelectorAll("[data-remove-auto]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void submitRemoveAuto({
        playerId: btn.getAttribute("data-remove-auto"),
        pickNumber: btn.getAttribute("data-pick-number"),
        playerName: btn.getAttribute("data-player-name") || "",
      });
    });
  });
  body.querySelectorAll("[data-remove-auto-all]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void submitRemoveAutoAll();
    });
  });
  body.querySelectorAll("[data-fill-vacancy]").forEach((btn) => {
    btn.addEventListener("click", () => openFillVacancyModal());
  });
}

/** Parse `CF (LW, RW)` → primary CF, all roles CF/LW/RW. */
function parsePositionDisplay(disp) {
  const raw = String(disp || "").trim();
  if (!raw || raw === "—") return { primary: null, all: [] };
  const m = raw.match(/^([A-Za-z0-9]+)(?:\s*\(([^)]*)\))?/);
  if (!m) return { primary: null, all: [] };
  const canon = (r) => {
    const u = String(r || "").trim().toUpperCase();
    return u === "ST" ? "CF" : u;
  };
  const primary = canon(m[1]);
  if (!primary) return { primary: null, all: [] };
  const extras = (m[2] || "")
    .split(",")
    .map((s) => canon(s))
    .filter((r) => r && r !== primary);
  return { primary, all: [primary, ...extras] };
}

function countMapInc(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedCountEntries(map) {
  return [...map.entries()].sort(
    (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "ru"),
  );
}

/** League short labels in ENG/SPA/ITA/GER order when present; else alpha. */
const LEAGUE_SORT = ["ENG", "SPA", "ITA", "GER"];

function sortLeagueRows(labels) {
  return [...labels].sort((a, b) => {
    const ia = LEAGUE_SORT.indexOf(a);
    const ib = LEAGUE_SORT.indexOf(b);
    if (ia >= 0 || ib >= 0) {
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    }
    return String(a).localeCompare(String(b), "ru");
  });
}

function teamCodeLabel(t) {
  const code = String(t.team_code || "").trim().toUpperCase();
  if (code) return code;
  const name = String(t.team_name || "").trim();
  if (name.length >= 3) return name.slice(0, 3).toUpperCase();
  return `T${t.team_id}`;
}

/**
 * Pivot matrix: columns = fantasy teams, rows = dimension values, cells = counts.
 * @param {"leagues"|"clubs"|"primaryPos"|"anyPos"} dim
 */
function buildStatsMatrix(teams, dim) {
  const cols = teams.map((t) => ({
    team_id: t.team_id,
    code: teamCodeLabel(t),
    title: t.team_name || t.name || t.email || "",
  }));
  const rowTotals = new Map();
  const cells = new Map(); // rowKey -> Map(team_id -> count)

  for (const t of teams) {
    const perTeam = new Map();
    for (const p of t.players || []) {
      if (dim === "leagues") {
        const lid = String(p.league_id || "");
        const label = TOP4_LEAGUE_SHORT[lid] || lid || "—";
        countMapInc(perTeam, label);
      } else if (dim === "clubs") {
        countMapInc(perTeam, String(p.club_name || "").trim() || "—");
      } else if (dim === "primaryPos") {
        const { primary } = parsePositionDisplay(p.position_display);
        if (primary) countMapInc(perTeam, primary);
      } else if (dim === "anyPos") {
        const { all } = parsePositionDisplay(p.position_display);
        for (const role of all) countMapInc(perTeam, role);
      }
    }
    for (const [label, n] of perTeam) {
      rowTotals.set(label, (rowTotals.get(label) || 0) + n);
      let row = cells.get(label);
      if (!row) {
        row = new Map();
        cells.set(label, row);
      }
      row.set(t.team_id, n);
    }
  }

  const rowKeys =
    dim === "leagues"
      ? sortLeagueRows([...rowTotals.keys()])
      : sortedCountEntries(rowTotals).map(([k]) => k);

  return { cols, rowKeys, cells, rowTotals };
}

/**
 * League × fantasy-team money matrices (rows = ENG/SPA/ITA/GER).
 * @param {"wageSum"|"wagePct"|"mvSum"|"mvPct"|"wageAvg"|"mvAvg"} metric
 */
function buildLeagueMetricMatrix(teams, metric) {
  const rules = draftPickRules();
  const wageCap = rules.wageCap;
  const mvCap = rules.mvCap;
  const cols = teams.map((t) => ({
    team_id: t.team_id,
    code: teamCodeLabel(t),
    title: t.team_name || t.name || t.email || "",
  }));
  /** @type {Map<string, Map<number|string, { wage: number, mv: number, count: number }>>} */
  const raw = new Map();
  /** @type {Map<string, { wage: number, mv: number, count: number }>} */
  const leagueAgg = new Map();
  /** @type {Map<number|string, { wage: number, mv: number, count: number }>} */
  const teamAgg = new Map();

  for (const t of teams) {
    const perTeam = new Map();
    let tw = 0;
    let tm = 0;
    let tc = 0;
    for (const p of t.players || []) {
      const lid = String(p.league_id || "");
      const label = TOP4_LEAGUE_SHORT[lid] || lid || "—";
      const w = playerWage(p);
      const m = playerMv(p);
      let agg = perTeam.get(label);
      if (!agg) {
        agg = { wage: 0, mv: 0, count: 0 };
        perTeam.set(label, agg);
      }
      agg.wage += w;
      agg.mv += m;
      agg.count += 1;
      tw += w;
      tm += m;
      tc += 1;
    }
    teamAgg.set(t.team_id, { wage: tw, mv: tm, count: tc });
    for (const [label, agg] of perTeam) {
      let row = raw.get(label);
      if (!row) {
        row = new Map();
        raw.set(label, row);
      }
      row.set(t.team_id, agg);
      const la = leagueAgg.get(label) || { wage: 0, mv: 0, count: 0 };
      la.wage += agg.wage;
      la.mv += agg.mv;
      la.count += agg.count;
      leagueAgg.set(label, la);
    }
  }

  const rowKeys = sortLeagueRows([...leagueAgg.keys()]);
  const empty = { wage: 0, mv: 0, count: 0 };

  function metricOf(agg) {
    if (metric === "wageSum") return agg.wage;
    if (metric === "mvSum") return agg.mv;
    if (metric === "wagePct") return capPct(agg.wage, wageCap);
    if (metric === "mvPct") return capPct(agg.mv, mvCap);
    if (metric === "wageAvg") return agg.count ? agg.wage / agg.count : 0;
    if (metric === "mvAvg") return agg.count ? agg.mv / agg.count : 0;
    return 0;
  }

  const cells = new Map();
  const rowTotals = new Map();
  for (const label of rowKeys) {
    const rowRaw = raw.get(label) || new Map();
    const row = new Map();
    for (const c of cols) {
      row.set(c.team_id, metricOf(rowRaw.get(c.team_id) || empty));
    }
    cells.set(label, row);
    rowTotals.set(label, metricOf(leagueAgg.get(label) || empty));
  }

  const colTotals = cols.map((c) => metricOf(teamAgg.get(c.team_id) || empty));
  let gw = 0;
  let gm = 0;
  let gc = 0;
  for (const a of teamAgg.values()) {
    gw += a.wage;
    gm += a.mv;
    gc += a.count;
  }
  const grandTotal = metricOf({ wage: gw, mv: gm, count: gc });

  let format;
  if (metric === "wagePct" || metric === "mvPct") {
    format = (n) => (n ? `${Math.round(n)}%` : "·");
  } else {
    // wage/mv sum + avg: exact euros like squads tab; · when 0 / no players
    format = (n) => (n ? eurExact(n) : "·");
  }

  return { cols, rowKeys, cells, rowTotals, colTotals, grandTotal, format };
}

function renderStatsMatrix(title, matrix) {
  const { cols, rowKeys, cells, rowTotals } = matrix;
  if (!cols.length) {
    return `<div class="top4-stats-matrix">
      <h3 class="top4-stats-matrix-title">${esc(title)}</h3>
      <p class="muted">${esc(tr("league.stats.noPicks"))}</p>
    </div>`;
  }
  if (!rowKeys.length) {
    return `<div class="top4-stats-matrix">
      <h3 class="top4-stats-matrix-title">${esc(title)}</h3>
      <p class="muted">${esc(tr("league.stats.noPicks"))}</p>
    </div>`;
  }
  const totalLabel = tr("league.stats.total");
  const format =
    typeof matrix.format === "function"
      ? matrix.format
      : (n) => (n ? String(n) : "·");
  const colTotals =
    matrix.colTotals ||
    cols.map((c) => {
      let s = 0;
      for (const label of rowKeys) {
        s += (cells.get(label) || new Map()).get(c.team_id) || 0;
      }
      return s;
    });
  let grandTotal = matrix.grandTotal;
  if (grandTotal == null) {
    grandTotal = 0;
    for (const n of colTotals) grandTotal += n;
  }
  const head =
    cols
      .map(
        (c) =>
          `<th class="top4-stats-col" title="${esc(c.title)}"><span class="top4-stats-code">${esc(c.code)}</span></th>`,
      )
      .join("") +
    `<th class="top4-stats-col top4-stats-total">${esc(totalLabel)}</th>`;
  const body = rowKeys
    .map((label) => {
      const row = cells.get(label) || new Map();
      const rowSum = rowTotals?.get(label) || 0;
      const tds =
        cols
          .map((c) => {
            const n = row.get(c.team_id) || 0;
            const text = format(n);
            return `<td class="mono${n ? "" : " muted"}">${text}</td>`;
          })
          .join("") +
        `<td class="mono top4-stats-total${rowSum ? "" : " muted"}">${format(rowSum)}</td>`;
      return `<tr><th scope="row" class="top4-stats-row">${esc(label)}</th>${tds}</tr>`;
    })
    .join("");
  const footTds =
    colTotals
      .map((n) => {
        const text = format(n);
        return `<td class="mono top4-stats-total${n ? "" : " muted"}">${text}</td>`;
      })
      .join("") +
    `<td class="mono top4-stats-total${grandTotal ? "" : " muted"}">${format(grandTotal)}</td>`;
  const foot = `<tr class="top4-stats-total-row"><th scope="row" class="top4-stats-row top4-stats-total">${esc(totalLabel)}</th>${footTds}</tr>`;
  return `<div class="top4-stats-matrix">
    <h3 class="top4-stats-matrix-title">${esc(title)}</h3>
    <div class="table-wrap nested top4-stats-scroll">
      <table class="compact-table top4-stats-pivot">
        <thead>
          <tr>
            <th class="top4-stats-corner">${esc(tr("league.stats.colLabel"))}</th>
            ${head}
          </tr>
        </thead>
        <tbody>${body}${foot}</tbody>
      </table>
    </div>
  </div>`;
}

function renderStats() {
  const body = $("stats-body");
  if (!body) return;
  const teams = state.data?.squads?.teams || [];
  if (!teams.length) {
    body.innerHTML = `<p class="muted">${esc(tr("league.stats.empty"))}</p>`;
    return;
  }
  body.innerHTML = [
    renderStatsMatrix(tr("common.leagues"), buildStatsMatrix(teams, "leagues")),
    renderStatsMatrix(tr("common.clubs"), buildStatsMatrix(teams, "clubs")),
    renderStatsMatrix(
      tr("league.stats.primaryPos"),
      buildStatsMatrix(teams, "primaryPos"),
    ),
    renderStatsMatrix(tr("league.stats.anyPos"), buildStatsMatrix(teams, "anyPos")),
    renderStatsMatrix(
      tr("league.stats.wageByLeague"),
      buildLeagueMetricMatrix(teams, "wageSum"),
    ),
    renderStatsMatrix(
      tr("league.stats.wagePctByLeague"),
      buildLeagueMetricMatrix(teams, "wagePct"),
    ),
    renderStatsMatrix(
      tr("league.stats.mvByLeague"),
      buildLeagueMetricMatrix(teams, "mvSum"),
    ),
    renderStatsMatrix(
      tr("league.stats.mvPctByLeague"),
      buildLeagueMetricMatrix(teams, "mvPct"),
    ),
    renderStatsMatrix(
      tr("league.stats.wageAvgByLeague"),
      buildLeagueMetricMatrix(teams, "wageAvg"),
    ),
    renderStatsMatrix(
      tr("league.stats.mvAvgByLeague"),
      buildLeagueMetricMatrix(teams, "mvAvg"),
    ),
  ].join("");
}

/** Taken players across all squads (works during drafting and after complete). */
function allTakenPlayerIdSet() {
  const fromLive = pickedPlayerIdSet();
  if (fromLive?.size) return fromLive;
  const set = new Set();
  for (const t of state.data?.squads?.teams || []) {
    for (const p of t.players || []) {
      if (p?.id) set.add(String(p.id));
    }
  }
  return set;
}

/**
 * Eligibility for filling a vacancy: current squad as-is (budget already freed by removals).
 */
function buildFillEligibilityCtx() {
  const status = state.data?.status;
  if (status !== "drafting" && status !== "complete") return { active: false };
  if (!wishlistOwnerEmail()) return { active: false };
  const rules = draftPickRules();
  const squad = myLiveSquadPlayers();
  let sumMv = 0;
  let sumWage = 0;
  const clubCounts = Object.create(null);
  const leagueCounts = Object.create(null);
  let gkHave = 0;
  for (const p of squad) {
    sumMv += playerMv(p);
    sumWage += playerWage(p);
    const cid = String(p.club_id || "");
    if (cid) clubCounts[cid] = (clubCounts[cid] || 0) + 1;
    const lid = String(p.league_id || "");
    if (lid) leagueCounts[lid] = (leagueCounts[lid] || 0) + 1;
    if (isPoolGk(p)) gkHave += 1;
  }
  return {
    active: true,
    rules,
    clubCounts,
    leagueCounts,
    gkHave,
    sumMv,
    sumWage,
    squadLen: squad.length,
  };
}

function myVacancyCount() {
  const owner = (wishlistOwnerEmail() || "").toLowerCase();
  if (!owner) return 0;
  const team = (state.data?.squads?.teams || []).find(
    (t) => String(t.email || "").toLowerCase() === owner,
  );
  return Number(team?.vacancies) || 0;
}

function closeFillVacancyModal() {
  const overlay = $("replace-auto-overlay");
  if (overlay) overlay.hidden = true;
  state.fillVacancy = null;
  const q = $("replace-auto-q");
  if (q) q.value = "";
}

function renderFillVacancyList() {
  const list = $("replace-auto-list");
  if (!list || !state.fillVacancy) return;

  const taken = allTakenPlayerIdSet();
  const eligCtx = buildFillEligibilityCtx();
  const q = String($("replace-auto-q")?.value || "")
    .trim()
    .toLowerCase();

  const candidates = (state.players || [])
    .filter((p) => {
      const id = String(p.id);
      if (taken.has(id)) return false;
      if (q && !String(p.name || "").toLowerCase().includes(q)) return false;
      const elig = pickEligibility(p, true, eligCtx);
      return elig.ok;
    })
    .sort(
      (a, b) =>
        (Number(b.fm_rating) || 0) - (Number(a.fm_rating) || 0) ||
        String(a.name || "").localeCompare(String(b.name || ""), "ru"),
    )
    .slice(0, 80);

  if (!candidates.length) {
    list.innerHTML = `<p class="muted">${esc(tr("league.squads.fillEmpty"))}</p>`;
    return;
  }

  list.innerHTML = `<table class="compact-table replace-auto-table">
    <thead>
      <tr>
        <th>${tr("common.player")}</th>
        <th>${tr("common.posDot")}</th>
        <th>${tr("common.club")}</th>
        <th>${tr("common.value")}</th>
        <th>${tr("common.wage")}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${candidates
        .map(
          (p) => `<tr>
            <td><a class="player-link" href="/player.html?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">${esc(p.name)}</a></td>
            <td>${esc(p.position_display || "")}</td>
            <td>${esc(p.club_name || "")}</td>
            <td class="money">${eurExact(p.market_value_eur)}</td>
            <td class="money">${eurExact(p.wage_pw)}</td>
            <td><button type="button" class="auth-btn top4-replace-pick-btn" data-new-player="${esc(String(p.id))}" data-new-name="${esc(p.name || "")}">${esc(tr("league.squads.fillConfirm"))}</button></td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;

  list.querySelectorAll("[data-new-player]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const newPlayerId = btn.getAttribute("data-new-player");
      const newName = btn.getAttribute("data-new-name") || newPlayerId;
      if (!newPlayerId || !state.fillVacancy) return;
      const ok = await askConfirm(
        tr("league.squads.fillConfirmAsk", { name: newName }),
      );
      if (!ok) return;
      await submitFillVacancy(newPlayerId);
    });
  });
}

function openFillVacancyModal() {
  const overlay = $("replace-auto-overlay");
  const title = $("replace-auto-title");
  const lead = $("replace-auto-lead");
  if (!overlay) return;
  if (myVacancyCount() <= 0) {
    setMsg(tr("league.err.no_vacancy"), true);
    return;
  }
  state.fillVacancy = { open: true };
  if (title) title.textContent = tr("league.squads.fillTitle");
  if (lead) {
    lead.textContent = tr("league.squads.fillLead", { n: myVacancyCount() });
  }
  const q = $("replace-auto-q");
  if (q) q.value = "";
  overlay.hidden = false;
  renderFillVacancyList();
  q?.focus();
}

async function applySquadMutation(res, doneMsg) {
  if (res?.squads) state.data.squads = res.squads;
  if (res?.live != null) state.data.live = res.live;
  if (res?.status) state.data.status = res.status;
  setMsg(doneMsg, false);
  await refresh({ force: true });
  if (state.tab === "squads") renderSquads();
  if (state.tab === "stats") renderStats();
}

async function submitRemoveAuto(opts) {
  if (!opts?.playerId) return;
  const ok = await askConfirm(
    tr("league.squads.removeConfirmAsk", {
      name: opts.playerName || opts.playerId,
    }),
  );
  if (!ok) return;
  const owner = wishlistOwnerEmail();
  const body = { playerId: opts.playerId };
  if (opts.pickNumber) body.pickNumber = Number(opts.pickNumber);
  if (owner) body.owner = owner;
  try {
    const res = await api("/api/top4/draft/remove-auto", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await applySquadMutation(res, tr("league.squads.removeDone"));
  } catch (err) {
    setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
  }
}

async function submitRemoveAutoAll() {
  const ok = await askConfirm(tr("league.squads.removeAllConfirmAsk"));
  if (!ok) return;
  const owner = wishlistOwnerEmail();
  const body = { all: true };
  if (owner) body.owner = owner;
  try {
    const res = await api("/api/top4/draft/remove-auto", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const n = Number(res?.removed) || 0;
    await applySquadMutation(
      res,
      tr("league.squads.removeAllDone", { n }),
    );
  } catch (err) {
    setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
  }
}

async function submitFillVacancy(newPlayerId) {
  if (!newPlayerId) return;
  const owner = wishlistOwnerEmail();
  const body = { newPlayerId };
  if (owner) body.owner = owner;
  try {
    const res = await api("/api/top4/draft/fill-vacancy", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res?.squads) state.data.squads = res.squads;
    if (res?.live != null) state.data.live = res.live;
    if (res?.status) state.data.status = res.status;
    setMsg(tr("league.squads.fillDone"), false);
    await refresh({ force: true });
    if (state.tab === "squads") renderSquads();
    if (state.tab === "stats") renderStats();
    const left = myVacancyCount();
    if (left > 0 && state.fillVacancy) {
      const lead = $("replace-auto-lead");
      if (lead) lead.textContent = tr("league.squads.fillLead", { n: left });
      renderFillVacancyList();
    } else {
      closeFillVacancyModal();
    }
  } catch (err) {
    setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
  }
}

function wireReplaceAutoModal() {
  const overlay = $("replace-auto-overlay");
  const closeBtn = $("replace-auto-close");
  const q = $("replace-auto-q");
  if (closeBtn) closeBtn.addEventListener("click", () => closeFillVacancyModal());
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeFillVacancyModal();
    });
  }
  if (q) {
    q.addEventListener("input", () => renderFillVacancyList());
  }
}

function errLabel(code, body) {
  if (body?.message && typeof body.message === "string") return body.message;
  return (
    {
      team_name_invalid: tr("league.err.team_name_invalid"),
      team_name_taken: tr("league.err.team_name_taken"),
      team_code_invalid: tr("league.err.team_code_invalid"),
      team_code_taken: tr("league.err.team_code_taken"),
      league_full: tr("league.err.league_full"),
      already_registered: tr("league.err.already_registered"),
      registration_closed: tr("league.err.registration_closed"),
      not_registered: tr("league.err.not_registered"),
      login_required: tr("league.err.login_required"),
      logo_empty: tr("league.err.logo_empty"),
      logo_too_large: tr("league.err.logo_too_large"),
      logo_invalid_type: tr("league.err.logo_invalid_type"),
      logo_invalid: tr("league.err.logo_invalid"),
      wishlist_locked: tr("league.err.wishlist_locked"),
      wishlist_changed: tr("league.err.wishlist_changed"),
      cannot_override_manager: tr("league.err.cannot_override_manager"),
      not_consigliere: tr("league.err.not_consigliere"),
      consigliere_email_invalid: tr("league.err.consigliere_email_invalid"),
      consigliere_self: tr("league.err.consigliere_self"),
      consigliere_not_participant: tr("league.err.consigliere_not_participant"),
      owner_required: tr("league.err.owner_required"),
      deadline_passed: tr("league.err.deadline_passed"),
      no_team: tr("league.err.primer_map"),
      not_your_turn: tr("league.err.not_your_turn"),
      player_taken: tr("league.err.player_taken"),
      pick_invalid: tr("league.err.pick_invalid"),
      draft_not_live: tr("league.err.draft_not_live"),
      draft_complete: tr("league.err.draft_complete"),
      draft_finished: tr("league.err.draft_finished"),
      finish_requires_26: tr("league.err.finish_requires_26"),
      not_in_draft: tr("league.err.not_in_draft"),
      not_in_draft_pool: tr("league.err.not_in_draft_pool"),
      player_not_found: tr("league.err.player_not_found"),
      invalid_draft_hours: tr("league.err.invalid_draft_hours"),
      pick_not_found: tr("league.err.pick_not_found"),
      not_your_pick: tr("league.err.not_your_pick"),
      not_algo_auto: tr("league.err.not_algo_auto"),
      already_replaced: tr("league.err.already_replaced"),
      same_player: tr("league.err.same_player"),
      no_algo_autos: tr("league.err.no_algo_autos"),
      no_vacancy: tr("league.err.no_vacancy"),
    }[code] || code
  );
}

function wishlistOwnerEmail() {
  return state.data?.me?.wishlist_owner || state.wishlistOwner || null;
}

function canUseWishlist() {
  const me = state.data?.me;
  if (!me?.user) return false;
  if (me.registered) return true;
  return Array.isArray(me.consigliere_for) && me.consigliere_for.length > 0;
}

function wishlistIdSet() {
  return new Set(
    (state.wishlist || []).map((w) => w.player_id).concat(state.data?.me?.wishlistIds || []),
  );
}

function renderWishlist() {
  if (!canUseWishlist()) return "";
  const me = state.data?.me;
  const items = state.wishlist || [];
  const editable = state.wishlistEditable;
  const owner = wishlistOwnerEmail();
  const acting =
    me?.consigliere_for?.length &&
    owner &&
    me.user?.email &&
    owner.toLowerCase() !== me.user.email.toLowerCase();
  const drafting = state.data?.status === "drafting";
  const myTurn = drafting && Boolean(me?.my_turn);
  const picked = drafting ? pickedPlayerIdSet() : null;
  const eligCtx = drafting ? buildPickEligibilityCtx() : null;
  const poolById = new Map((state.players || []).map((p) => [String(p.id), p]));
  const rows =
    items.length === 0
      ? `<p class="muted">${tr("league.wishlistEmpty")}</p>`
      : `<ol class="top4-wl-list" id="wishlist-list">${items
          .map((w, i) => {
            const id = String(w.player_id);
            const dragging = state.dragIndex === i;
            const over = state.overIndex === i && state.dragIndex != null && state.dragIndex !== i;
            const by =
              w.set_by === "consigliere"
                ? ` · <span class="muted">consigliere</span>`
                : "";
            const isPicked = Boolean(picked?.has(id));
            const player = poolById.get(id);
            const elig =
              !isPicked && eligCtx && player
                ? pickEligibility(player, true, eligCtx)
                : { ok: Boolean(player), reason: player ? null : "budget" };
            const blockTitle = elig.ok ? "" : pickBlockTitle(elig.reason);
            let draftAction = "";
            if (!isPicked && myTurn) {
              if (!elig.ok) {
                draftAction = `<button type="button" class="top4-wl-btn draft" data-pick="${esc(id)}" disabled title="${esc(blockTitle)}">${tr("league.live.draftBtn")}</button>`;
              } else {
                draftAction = `<button type="button" class="top4-wl-btn draft" data-pick="${esc(id)}" title="${tr("league.live.draftBtn")}">${tr("league.live.draftBtn")}</button>`;
              }
            }
            const removeBtn = editable
              ? `<button type="button" class="top4-wl-remove" data-remove="${esc(id)}" title="${tr("common.remove")}">✕</button>`
              : "";
            return `<li
              class="top4-wl-item${dragging ? " dragging" : ""}${over ? " over" : ""}${editable ? " can-drag" : ""}${isPicked ? " is-picked" : ""}"
              data-idx="${i}"
              data-id="${esc(id)}"
              ${editable ? 'draggable="true"' : ""}
            >
              <span class="top4-wl-handle" title="${editable ? tr("league.drag") : ""}">${editable ? "⠿" : ""} ${i + 1}.</span>
              <div class="top4-wl-body">
                <a class="player-link" href="/player.html?id=${encodeURIComponent(id)}">${esc(w.name)}</a>
                <span class="muted">${esc(w.position_display)} · ${esc(w.club_name)} · ${esc(w.league_id)} · ${w.fm_rating ?? "—"} · ${eur(w.market_value_eur)} · ${wageSum(w.wage_pw)}${by}</span>
              </div>
              <div class="top4-wl-item-actions">${draftAction}${removeBtn}</div>
            </li>`;
          })
          .join("")}</ol>`;

  return `
    <section class="top4-wishlist" id="wishlist">
      <div class="top4-wl-head">
        <h2 class="section-title">Wishlist <span class="muted">(${items.length})</span></h2>
        <span class="muted" id="wl-save-hint">${
          state.wishlistSaving
            ? tr("league.savingShort")
            : editable
              ? tr("league.dragHint")
              : tr("common.viewOnly")
        }</span>
      </div>
      ${acting ? `<p class="muted">${tr("league.consigliereWishlistFor", { email: owner })}</p>` : ""}
      ${rows}
    </section>`;
}

function renderPoolFilters(idPrefix = "") {
  ensureFilterBounds();
  const f = state.filters;
  const id = (s) => `${idPrefix}${s}`;
  const clubs = clubOptions();
  const roles = posOptions();
  const leagueOpts = TOP4_LEAGUES.map(
    (l) => `<option value="${esc(l.id)}"${f.league === l.id ? " selected" : ""}>${esc(l.label)}</option>`,
  ).join("");
  const clubOpts = clubs
    .map(
      ([cid, name]) =>
        `<option value="${esc(cid)}"${f.club === cid ? " selected" : ""}>${esc(name)}</option>`,
    )
    .join("");
  const posOpts = roles
    .map((r) => `<option value="${esc(r)}"${f.pos === r ? " selected" : ""}>${esc(r)}</option>`)
    .join("");

  return `
    <section class="filters top4-pool-filters" id="${id("pool-filters")}">
      <label>
        ${tr("common.league")}
        <select id="${id("f-league")}">
          <option value="">${tr("league.allTop4Lower")}</option>
          ${leagueOpts}
        </select>
      </label>
      <label>
        ${tr("common.club")}
        <select id="${id("f-club")}">
          <option value="">${tr("common.allClubs")}</option>
          ${clubOpts}
        </select>
      </label>
      <label>
        ${tr("common.line")}
        <select id="${id("f-line")}">
          <option value="">${tr("common.all")}</option>
          <option value="GK"${f.line === "GK" ? " selected" : ""}>GK</option>
          <option value="DEF"${f.line === "DEF" ? " selected" : ""}>DEF</option>
          <option value="MID"${f.line === "MID" ? " selected" : ""}>MID</option>
          <option value="ATT"${f.line === "ATT" ? " selected" : ""}>ATT</option>
        </select>
      </label>
      <label>
        ${tr("common.position")}
        <select id="${id("f-pos")}">
          <option value="">${tr("common.all")}</option>
          ${posOpts}
        </select>
      </label>
      <label>
        ${tr("league.nameFilter")}
        <input type="text" id="${id("f-name")}" placeholder="${tr("league.searchName")}" autocomplete="off" value="${esc(f.name)}" />
      </label>
      <label class="range-filter">
        ${tr("common.value")}
        <div class="dual-range" data-kind="mv">
          <input type="range" id="${id("f-mv-min")}" min="${state.bounds.mvMin}" max="${state.bounds.mvMax}" step="${MV_RANGE_STEP}" value="${f.mvMin}" />
          <input type="range" id="${id("f-mv-max")}" min="${state.bounds.mvMin}" max="${state.bounds.mvMax}" step="${MV_RANGE_STEP}" value="${f.mvMax}" />
        </div>
        <span class="range-label" id="${id("f-mv-label")}">${esc(eur(f.mvMin))} – ${esc(eur(f.mvMax))}</span>
      </label>
      <label class="range-filter">
        ${tr("common.wage")}
        <div class="dual-range" data-kind="wage">
          <input type="range" id="${id("f-wage-min")}" min="${state.bounds.wageMin}" max="${state.bounds.wageMax}" step="${WAGE_RANGE_STEP}" value="${f.wageMin}" />
          <input type="range" id="${id("f-wage-max")}" min="${state.bounds.wageMin}" max="${state.bounds.wageMax}" step="${WAGE_RANGE_STEP}" value="${f.wageMax}" />
        </div>
        <span class="range-label" id="${id("f-wage-label")}">${esc(wageSum(f.wageMin))} – ${esc(wageSum(f.wageMax))}</span>
      </label>
      <label class="checkbox-filter">
        <input type="checkbox" id="${id("f-hide-picked")}"${f.hidePicked ? " checked" : ""} />
        ${tr("league.hidePicked")}
      </label>
      <button type="button" class="auth-link" id="${id("f-reset")}">${tr("league.resetFilters")}</button>
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
  const canAdd = Boolean(canUseWishlist() && state.wishlistEditable);
  const inWl = wishlistIdSet();
  const drafting = state.data?.status === "drafting";
  const myTurn = drafting && Boolean(me?.my_turn);
  const picked = drafting ? pickedPlayerIdSet() : null;
  const eligCtx = drafting ? buildPickEligibilityCtx() : null;
  const rows = shown
    .map((p) => {
      const id = String(p.id);
      const added = inWl.has(id);
      const isPicked = Boolean(picked?.has(id));
      // Wishlist: hard limits only (club/MV/wage), matching assertTop4WishlistPlayerEligible.
      // Draft pick: also enforce roster mins (leagues/GK), matching POST /api/top4/draft/pick.
      const wlElig =
        !isPicked && eligCtx ? pickEligibility(p, false, eligCtx) : { ok: true, reason: null };
      const draftElig =
        !isPicked && eligCtx ? pickEligibility(p, true, eligCtx) : { ok: true, reason: null };
      const wlBlockTitle = wlElig.ok ? "" : pickBlockTitle(wlElig.reason);
      const draftBlockTitle = draftElig.ok ? "" : pickBlockTitle(draftElig.reason);
      // Picked players: empty action cell (pruned from wishlists; no draft either). Keep row dimming.
      let wlAction = "";
      if (!isPicked && canAdd) {
        if (added) {
          wlAction = `<button type="button" class="top4-wl-btn on" data-remove="${esc(id)}" title="${tr("league.removeWl")}">✓</button>`;
        } else if (!wlElig.ok) {
          wlAction = `<button type="button" class="top4-wl-btn" data-add="${esc(id)}" disabled title="${esc(wlBlockTitle)}">+ wishlist</button>`;
        } else {
          wlAction = `<button type="button" class="top4-wl-btn" data-add="${esc(id)}" title="${tr("league.addWl")}">+ wishlist</button>`;
        }
      }
      // Draft pick works on filtered/paginated rows: render() rewires [data-pick] after every filter change.
      let draftAction = "";
      if (!isPicked && myTurn) {
        if (!draftElig.ok) {
          draftAction = `<button type="button" class="top4-wl-btn draft" data-pick="${esc(id)}" disabled title="${esc(draftBlockTitle)}">${tr("league.live.draftBtn")}</button>`;
        } else {
          draftAction = `<button type="button" class="top4-wl-btn draft" data-pick="${esc(id)}" title="${tr("league.live.draftBtn")}">${tr("league.live.draftBtn")}</button>`;
        }
      }
      return `<tr${isPicked ? ' class="top4-pool-picked"' : ""}>
        <td class="top4-wl-action-cell">${wlAction}${draftAction}</td>
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
    <h2 class="section-title">${tr("league.poolOf", { title: tr("league.poolTop4"), total, all: state.players.length, pageHint })}</h2>
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
    tr("league.metaTop4", { rounds: rules.rounds ?? 26, mv: eur(rules.mv_cap), wage: wageSum(rules.wage_cap), minLeague: rules.min_per_league ?? 3, maxClub: rules.max_per_club ?? 3, minGk: rules.min_gk ?? 3 }) +
    `ENG/SPA/ITA/GER · ${statusLabel(data.status, data)}`;

  const showWl = canUseWishlist();
  $("panel").innerHTML = `
    <section class="top4-hero">
      <h1 class="team-title">${tr("league.hero4")}</h1>
      <p class="team-sub">${tr("league.heroLead4")}</p>
      ${renderActions(data)}
      ${renderTeamSettings(data)}
    </section>
    ${renderConsigliere(data)}
    ${renderRegs(data)}
    ${renderLotteryBlock(data)}
    ${renderLiveDraft(data)}
    ${renderDraft(data)}
    <div class="top4-draft-grid${showWl ? "" : " solo"}">
      <div class="top4-pool-col">${renderPool()}</div>
      ${showWl ? `<div class="top4-wl-col">${renderWishlist()}</div>` : ""}
    </div>
  `;

  wireActions();
  wireConsigliere();
  wireTeamCode();
  wireLogo();
  wireSort();
  wireWishlist();
  wireLiveDraft();
  wireFilters();
  wirePoolPager();
  applyTab(state.tab, { metaDraft: draftMeta, fromRender: true });
  ensureLiveTick();
  ensureLiveClock();
}

function syncRangeLabels() {
  const f = state.filters;
  const mvText = `${eur(f.mvMin)} – ${eur(f.mvMax)}`;
  const wageText = `${wageSum(f.wageMin)} – ${wageSum(f.wageMax)}`;
  for (const id of ["f-mv-label", "to-f-mv-label"]) {
    const el = $(id);
    if (el) el.textContent = mvText;
  }
  for (const id of ["f-wage-label", "to-f-wage-label"]) {
    const el = $(id);
    if (el) el.textContent = wageText;
  }
}

function applyDualRangeInputs(minEl, maxEl, kind) {
  if (!minEl || !maxEl) return false;
  let lo = Number(minEl.value);
  let hi = Number(maxEl.value);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    ensureFilterBounds({ reset: true });
    syncRangeLabels();
    return false;
  }
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
  if (rangeFiltersCorrupt()) {
    ensureFilterBounds({ reset: true });
    minEl.value = String(kind === "mv" ? state.filters.mvMin : state.filters.wageMin);
    maxEl.value = String(kind === "mv" ? state.filters.mvMax : state.filters.wageMax);
  }
  syncRangeLabels();
  return true;
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
  const hidePicked = $("f-hide-picked");
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
  hidePicked?.addEventListener("change", () => {
    state.filters.hidePicked = Boolean(hidePicked.checked);
    saveHidePicked(state.filters.hidePicked);
    state.poolPage = 1;
    render();
  });

  const bindDual = (minEl, maxEl, kind) => {
    if (!minEl || !maxEl) return;
    const onInput = () => {
      applyDualRangeInputs(minEl, maxEl, kind);
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
    // Recompute full-pool span first — old bounds may be the €0–€1 sentinel.
    ensureFilterBounds({ reset: true });
    // Keep hidePicked — it's a session preference, not a pool facet.
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
      await api("/api/top4/register", {
        method: "POST",
        body: JSON.stringify({ teamName }),
      });
      await refresh({ force: true });
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
      await api("/api/top4/team-name", {
        method: "PUT",
        body: JSON.stringify({ teamName }),
      });
      await refresh({ force: true });
      setMsg(tr("league.msg.nameSaved"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
  $("btn-unregister")?.addEventListener("click", async () => {
    try {
      await api("/api/top4/unregister", { method: "POST", body: "{}" });
      await refresh({ force: true });
      setMsg(tr("league.msg.unregistered"));
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
}

function askConfirm(message) {
  const overlay = $("confirm-overlay");
  const msgEl = $("confirm-msg");
  const yesBtn = $("confirm-yes");
  const noBtn = $("confirm-no");
  if (!overlay || !msgEl || !yesBtn || !noBtn) {
    return Promise.resolve(window.confirm(message));
  }
  const prev = document.activeElement;
  const inertEls = [];
  document.querySelectorAll("body > :not(#confirm-overlay)").forEach((el) => {
    if (!el.inert) {
      el.inert = true;
      inertEls.push(el);
    }
  });
  msgEl.textContent = message;
  yesBtn.textContent = tr("common.confirm");
  noBtn.textContent = tr("common.cancel");
  overlay.hidden = false;
  noBtn.focus();
  return new Promise((resolve) => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const finish = (value) => {
      overlay.hidden = true;
      inertEls.forEach((el) => {
        el.inert = false;
      });
      yesBtn.onclick = null;
      noBtn.onclick = null;
      overlay.onclick = null;
      document.removeEventListener("keydown", onKey);
      if (prev && typeof prev.focus === "function") {
        try {
          prev.focus();
        } catch (_) {}
      }
      resolve(value);
    };
    document.addEventListener("keydown", onKey);
    yesBtn.onclick = (e) => {
      e.stopPropagation();
      finish(true);
    };
    noBtn.onclick = (e) => {
      e.stopPropagation();
      finish(false);
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(false);
    };
  });
}

async function reorderWishlistByCurrentSort() {
  if (!state.wishlistEditable || !(state.wishlist || []).length) return;
  const key = state.sortKey;
  const dir = state.sortDir;
  if (!isMetricSortKey(key)) return;
  const next = [...state.wishlist].sort((a, b) => compareBySortKey(a, b, key, dir));
  if (next.every((w, i) => w.player_id === state.wishlist[i].player_id)) return;
  state.wishlist = next;
  state.wishlistSaving = true;
  render();
  try {
    await api("/api/top4/wishlist/order", {
      method: "PUT",
      body: JSON.stringify({
        playerIds: next.map((w) => w.player_id),
        ...wishlistOwnerPayload(),
      }),
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

function wireSort() {
  $("pool-table")?.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", async () => {
      const key = th.getAttribute("data-sort");
      if (!key) return;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        state.sortDir = key === "name" || key === "club" || key === "pos" || key === "league" ? 1 : -1;
      }
      state.poolPage = 1;
      render();
      const offerWl =
        isMetricSortKey(key) && state.wishlistEditable && (state.wishlist || []).length > 0;
      if (!offerWl) return;
      const move = await askConfirm(tr("league.confirmSortWishlist"));
      if (move) await reorderWishlistByCurrentSort();
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
  if (!canUseWishlist()) {
    state.wishlist = [];
    state.wishlistEditable = false;
    state.wishlistOwner = null;
    return;
  }
  try {
    const owner = state.data?.me?.wishlist_owner;
    const q = owner ? `?owner=${encodeURIComponent(owner)}` : "";
    const res = await api(`/api/top4/wishlist${q}`);
    state.wishlist = res.items || [];
    state.wishlistEditable = Boolean(res.editable);
    state.wishlistOwner = res.owner_email || owner || null;
  } catch {
    state.wishlist = [];
    state.wishlistEditable = false;
  }
}

function wishlistOwnerPayload() {
  const owner = wishlistOwnerEmail();
  return owner ? { owner } : {};
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
    await api("/api/top4/wishlist/order", {
      method: "PUT",
      body: JSON.stringify({
        playerIds: next.map((w) => w.player_id),
        ...wishlistOwnerPayload(),
      }),
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

function wireConsigliere() {
  $("form-consigliere")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("consigliere-input");
    const email = input?.value?.trim() || "";
    try {
      await api("/api/top4/consigliere", {
        method: "PUT",
        body: JSON.stringify({ consigliere_email: email || null }),
      });
      setMsg(
        email
          ? tr("league.msg.consigliereSaved")
          : tr("league.msg.consigliereCleared"),
      );
      await refresh({ force: true });
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
}

function setCodeMsg(text, bad = false) {
  const el = $("code-msg");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("warn", bad);
}

function wireTeamCode() {
  const input = $("team-code-input");
  input?.addEventListener("input", () => {
    input.value = input.value.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3);
  });
  $("form-team-code")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = input?.value?.trim().toUpperCase() || "";
    try {
      setCodeMsg(tr("league.msg.codeSaving"));
      await api("/api/top4/team-code", {
        method: "PUT",
        body: JSON.stringify({ teamCode: code }),
      });
      await refresh({ force: true });
      setCodeMsg(tr("league.msg.codeSaved"));
      setMsg(tr("league.msg.codeSaved"));
    } catch (err) {
      setCodeMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
}

function setLogoMsg(text, bad = false) {
  const el = $("logo-msg");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("warn", bad);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("logo_invalid"));
    reader.readAsDataURL(file);
  });
}

function wireLogo() {
  const input = $("logo-file-input");
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 1_500_000) {
      setLogoMsg(tr("league.err.logo_too_large"), true);
      return;
    }
    const preview = $("logo-preview");
    try {
      setLogoMsg(tr("league.msg.logoUploading"));
      const dataUrl = await fileToDataUrl(file);
      if (preview) {
        if (preview.tagName === "IMG") {
          preview.src = dataUrl;
        } else {
          preview.outerHTML = `<img class="top4-logo-preview" id="logo-preview" src="${dataUrl}" alt="" />`;
        }
      }
      await api("/api/top4/logo", {
        method: "PUT",
        body: JSON.stringify({ image: dataUrl }),
      });
      await refresh({ force: true });
      setLogoMsg(tr("league.msg.logoSaved"));
      setMsg(tr("league.msg.logoSaved"));
    } catch (err) {
      setLogoMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
  $("btn-logo-remove")?.addEventListener("click", async () => {
    try {
      setLogoMsg(tr("league.msg.logoRemoving"));
      await api("/api/top4/logo", { method: "DELETE" });
      await refresh({ force: true });
      setLogoMsg(tr("league.msg.logoRemoved"));
      setMsg(tr("league.msg.logoRemoved"));
    } catch (err) {
      setLogoMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });
}

function wireWishlist() {
  let dragFrom = null;

  $("panel")?.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      const id = btn.getAttribute("data-add");
      if (!id) return;
      try {
        await api("/api/top4/wishlist", {
          method: "POST",
          body: JSON.stringify({ playerId: id, ...wishlistOwnerPayload() }),
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
        const owner = wishlistOwnerEmail();
        const q = owner ? `?owner=${encodeURIComponent(owner)}` : "";
        await api(`/api/top4/wishlist/${encodeURIComponent(id)}${q}`, {
          method: "DELETE",
        });
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

function wireLiveDraft() {
  $("btn-toggle-ood")?.addEventListener("click", async () => {
    const myBank = myBankRow(state.data);
    try {
      await api("/api/top4/draft/out-of-draft", {
        method: "PUT",
        body: JSON.stringify({ value: !myBank?.out_of_draft, ...wishlistOwnerPayload() }),
      });
      await refresh({ force: true });
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });

  $("btn-toggle-finish")?.addEventListener("click", async () => {
    const myBank = myBankRow(state.data);
    if (!myBank) return;
    const minRoster = Number(state.data?.rules?.rounds) || 26;
    const finishing = !myBank.draft_finished;
    if (finishing && (myBank.player_count ?? 0) < minRoster) {
      setMsg(tr("league.err.finish_requires_26"), true);
      return;
    }
    try {
      await api("/api/top4/draft/finish", {
        method: "PUT",
        body: JSON.stringify({ value: finishing, ...wishlistOwnerPayload() }),
      });
      await refresh({ force: true });
    } catch (err) {
      setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
    }
  });

  $("panel")?.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      const id = btn.getAttribute("data-pick");
      if (!id) return;
      btn.disabled = true;
      try {
        await api("/api/top4/draft/pick", {
          method: "POST",
          body: JSON.stringify({ playerId: id, ...wishlistOwnerPayload() }),
        });
        await refresh({ force: true });
      } catch (err) {
        setMsg(errLabel(err.message, err.body) || tr("common.error"), true);
        btn.disabled = false;
      }
    });
  });
}

let liveTickTimer = null;
let liveClockTimer = null;

function updateLiveClockDom() {
  const data = state.data;
  const live = data?.live;
  const turn = live?.turn;
  const clock = $("live-turn-clock");
  const bankEl = $("live-bank-clock");
  const turnBox = document.querySelector("#top4-live .top4-live-turn");
  if (!turn || data.status !== "drafting") {
    if (liveClockTimer) {
      clearInterval(liveClockTimer);
      liveClockTimer = null;
    }
    return;
  }
  const hoursCfg = draftHoursConfigFromLive(live.draft_hours);
  const paused = !isWithinDraftHoursClient(Date.now(), hoursCfg);
  const pickAtMs = turn.pick_at ? Date.parse(turn.pick_at) : NaN;
  const remainingMs = Number.isFinite(pickAtMs)
    ? pickTimerRemainingMsClient(pickAtMs, Date.now(), turn.timeout_sec || 0, hoursCfg)
    : Math.max(0, turn.remaining_ms || 0);
  if (clock) {
    clock.textContent = paused ? tr("league.live.paused") : fmtClock(remainingMs);
  }
  if (bankEl) {
    bankEl.textContent = fmtClock((turn.bank_remaining_sec || 0) * 1000);
  }
  turnBox?.classList.toggle("paused", paused);
}

function ensureLiveClock() {
  const drafting = state.data?.status === "drafting" && state.data?.live?.turn;
  if (drafting && !liveClockTimer) {
    liveClockTimer = setInterval(updateLiveClockDom, 1000);
    updateLiveClockDom();
  } else if (!drafting && liveClockTimer) {
    clearInterval(liveClockTimer);
    liveClockTimer = null;
  } else if (drafting) {
    updateLiveClockDom();
  }
}

function ensureLiveTick() {
  const drafting = state.data?.status === "drafting";
  if (drafting && !liveTickTimer) {
    liveTickTimer = setInterval(async () => {
      try {
        await api("/api/top4/draft/tick", { method: "POST", body: "{}" });
        await refresh();
      } catch {
        /* transient poll failure — retry on next tick */
      }
    }, 5000);
  } else if (!drafting && liveTickTimer) {
    clearInterval(liveTickTimer);
    liveTickTimer = null;
  }
  ensureLiveClock();
}

/**
 * Fetch league state. Full panel rebuild only when picks change (or opts.force).
 * Polls keep state + timer in sync without remounting pool / wishlist / live board.
 */
async function refresh(opts = {}) {
  const force = Boolean(opts.force);
  const prevPickSig = livePickSignature(state.data);
  state.data = await api("/api/top4");
  renderTransferBanner();
  const pickChanged = prevPickSig !== livePickSignature(state.data);
  if (pickChanged) state.draftRoom.poolStale = true;

  // Pool must be present before render — empty players + sentinel bounds → «€0–€1» / 0 из 0.
  if (!state.players?.length) {
    try {
      await loadPlayers();
    } catch {
      /* leave empty; ensureFilterBounds falls back to league caps */
    }
  } else {
    ensureFilterBounds();
  }

  // Wishlist can be pruned after picks; skip on silent polls.
  if (force || pickChanged) {
    await loadWishlist();
  }

  // Draft-room: keep editor DOM stable across polls; remount only on new picks.
  if (state.tab === "draftRoom") {
    if (pickChanged || force) state.liveUiStale = true;
    if (!state.draftRoom.loaded || state.draftRoom.poolStale) {
      state.draftRoom.poolStale = false;
      try {
        await loadDraftRoom({ preserveEditor: state.draftRoom.editingId != null });
      } catch {
        /* transient — retry next poll / tab enter */
      }
    }
    ensureLiveTick();
    updateLiveClockDom();
    return;
  }

  if (!force && !pickChanged) {
    // Background poll: update clocks from fresh turn payload, leave DOM alone.
    ensureLiveTick();
    updateLiveClockDom();
    return;
  }

  state.liveUiStale = false;
  render();
}

async function load() {
  try {
    state.data = await api("/api/top4");
    renderTransferBanner();
    await Promise.all([loadPlayers(), loadWishlist()]);
    state.bootstrapped = true;
    render();
  } catch (e) {
    $("meta").textContent = e.message || tr("common.errorLoad");
  }
}

document.addEventListener("din8sty:auth", () => {
  state.draftRoom.loaded = false;
  state.draftRoom.poolStale = true;
  // Avoid force-render while pool is still loading (auth races load()) — that painted
  // empty players with bounds max=1 («€0–€1» / «€0K–€0K»).
  if (state.bootstrapped && state.data) refresh({ force: true }).catch(() => {});
});

/* —— Расписание (Топ-4 · GW2–43) —— */

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

function xiCell(f) {
  const teams = Array.isArray(f.xi_teams) ? f.xi_teams : [];
  if (!teams.length) return `<span class="sched-xi-empty">—</span>`;
  return `<span class="sched-xi">${teams
    .map(
      (t) =>
        `<span class="sched-xi-code" title="${esc(t.name || t.code)}">${esc(t.code)}</span>`,
    )
    .join("")}</span>`;
}

function fullCell(f) {
  const teams = Array.isArray(f.full_teams) ? f.full_teams : [];
  if (!teams.length) return `<span class="sched-xi-empty">—</span>`;
  return `<span class="sched-xi">${teams
    .map(
      (t) =>
        `<span class="sched-xi-code" title="${esc(t.name || t.code)}">${esc(t.code)}</span>`,
    )
    .join("")}</span>`;
}

function setSchedHeader(compact) {
  const thead = document.querySelector("#sched-table thead tr");
  if (!thead) return;
  const xiTh = `<th title="${esc(tr("schedule.xiHint"))}">${tr("schedule.xi")}</th>`;
  const fullTh = `<th title="${esc(tr("schedule.fullHint"))}">${tr("schedule.full")}</th>`;
  thead.innerHTML = compact
    ? `<th>${tr("common.date")}</th><th>GW</th><th>${tr("common.competition")}</th><th>${tr("common.opponent")}</th>${xiTh}${fullTh}<th>${tr("common.status")}</th>`
    : `<th>${tr("common.date")}</th><th>GW</th><th>${tr("common.competition")}</th><th>${tr("common.roundCol")}</th><th>${tr("common.homeTeam")}</th><th></th><th>${tr("common.awayTeam")}</th>${xiTh}${fullTh}<th>${tr("common.status")}</th>`;
  $("sched-table")?.classList.toggle("club-fixtures", compact);
  $("sched-table")?.classList.add("has-xi", "has-full");
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
  const allowed = new Set([
    "draft",
    "draftRoom",
    "squads",
    "stats",
    "live",
    "results",
    "transfers",
    "gws",
    "schedule",
    "rules",
    "season2526",
    "season2627",
  ]);
  state.tab = allowed.has(tab) ? tab : "draft";
  const isSched = state.tab === "schedule";
  const isRules = state.tab === "rules";
  const isSeason = state.tab === "season2526" || state.tab === "season2627";
  const isDraftRoom = state.tab === "draftRoom";
  const isSquads = state.tab === "squads";
  const isStats = state.tab === "stats";
  const isLive = state.tab === "live";
  const isResults = state.tab === "results";
  const isTransfers = state.tab === "transfers";
  const isGws = state.tab === "gws";
  $("panel")?.toggleAttribute(
    "hidden",
    isSched ||
      isRules ||
      isSeason ||
      isDraftRoom ||
      isSquads ||
      isStats ||
      isLive ||
      isResults ||
      isTransfers ||
      isGws,
  );
  $("schedule-root")?.toggleAttribute("hidden", !isSched);
  $("rules-root")?.toggleAttribute("hidden", !isRules);
  $("season-root")?.toggleAttribute("hidden", !isSeason);
  $("draft-room-root")?.toggleAttribute("hidden", !isDraftRoom);
  $("squads-root")?.toggleAttribute("hidden", !isSquads);
  $("stats-root")?.toggleAttribute("hidden", !isStats);
  $("live-root")?.toggleAttribute("hidden", !isLive);
  $("results-root")?.toggleAttribute("hidden", !isResults);
  $("transfers-root")?.toggleAttribute("hidden", !isTransfers);
  $("gws-root")?.toggleAttribute("hidden", !isGws);
  document.querySelectorAll("#top4-tabs .primer-tab").forEach((btn) => {
    const on = btn.getAttribute("data-tab") === state.tab;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
    if (on) btn.scrollIntoView({ inline: "nearest", block: "nearest" });
  });
  syncTop4Title();
  if (!isLive) {
    stopLiveStandPoll();
    closeFptsBreakdown();
  }
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
    $("meta").textContent = tr("league.metaRules4");
  } else if (isSeason) {
    $("meta").textContent = tr(
      state.tab === "season2627" ? "league.metaSeason2627" : "league.metaSeason",
    );
    if (state.season.loadedSlug !== seasonSlugForTab(state.tab)) {
      initSeason().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    } else {
      renderSeason();
    }
  } else if (isLive) {
    $("meta").textContent = tr("league.metaLive");
    if (!state.liveStand.loaded) {
      initLiveStanding().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    } else {
      renderLiveStanding();
    }
    ensureLiveStandPoll();
  } else if (isResults) {
    $("meta").textContent = tr("league.metaResults");
    if (!state.results.loaded) {
      initResults().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    } else {
      renderResults();
    }
  } else if (isTransfers) {
    $("meta").textContent = tr("league.metaTransfers");
    if (!state.transfers.loaded) {
      initTransfers().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    } else {
      renderTransfers();
    }
  } else if (isGws) {
    $("meta").textContent = tr("league.metaGws");
    if (!state.gws.loaded) {
      initGws().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    } else {
      renderGws();
    }
  } else if (isDraftRoom) {
    $("meta").textContent = tr("league.metaDraftRoom");
    if (!state.draftRoom.loaded || state.draftRoom.poolStale) {
      state.draftRoom.poolStale = false;
      loadDraftRoom().catch((err) => {
        $("meta").textContent = String(err?.message || err);
      });
    }
  } else if (isSquads) {
    $("meta").textContent = tr("league.metaSquads");
    renderSquads();
  } else if (isStats) {
    $("meta").textContent = tr("league.metaStats");
    renderStats();
  } else if (state.liveUiStale && state.data && !opts.fromRender) {
    // Returning to Draft after polls that skipped panel re-render while on draft-room.
    state.liveUiStale = false;
    render();
    return;
  } else if (opts.metaDraft != null) {
    $("meta").textContent = opts.metaDraft;
  } else if (state.data) {
    const rules = state.data.rules || {};
    $("meta").textContent =
      tr("league.metaTop4", { rounds: rules.rounds ?? 26, mv: eur(rules.mv_cap), wage: wageSum(rules.wage_cap), minLeague: rules.min_per_league ?? 3, maxClub: rules.max_per_club ?? 3, minGk: rules.min_gk ?? 3 }) +
      `ENG/SPA/ITA/GER · ${statusLabel(state.data.status, state.data)}`;
  }
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
  const top4 = new Set(TOP4_LEAGUES.map((l) => l.id));
  state.schedule.clubs = league
    ? data.clubs || []
    : (data.clubs || []).filter((c) => top4.has(c.league_id));
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
  // Filter by clubs from the selected domestic league (or all Top-4), so cups /
  // supers / Europe involving those clubs appear — not only f.league_id = GB1/…
  if (s.club) params.set("club", s.club);
  else if (s.league) params.set("club_leagues", s.league);
  else params.set("club_leagues", TOP4_LEAGUE_IDS);
  if (s.status) params.set("status", s.status);
  if (s.gameweek) params.set("gameweek", s.gameweek);
  params.set("xi", "1");

  const res = await fetch(`/api/fixtures?${params}`);
  const data = await res.json();
  $("meta").textContent = tr("league.schedShown4", { min: SCHED_GW_MIN, max: SCHED_GW_MAX, n: data.total ?? 0 });

  const compact = Boolean(s.club);
  setSchedHeader(compact);

  const body = $("sched-rows");
  if (!data.fixtures?.length) {
    body.innerHTML = `<tr><td colspan="${compact ? 7 : 10}" class="sub">${tr("common.noMatches")}</td></tr>`;
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
          <td class="xi-td">${xiCell(f)}</td>
          <td class="full-td">${fullCell(f)}</td>
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
        <td class="xi-td">${xiCell(f)}</td>
        <td class="full-td">${fullCell(f)}</td>
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
    for (const l of TOP4_LEAGUES) {
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

function seasonSlugForTab(tab) {
  return tab === "season2627" ? "2026-27" : "2025-26";
}

function renderSeasonCharts(players, opts = {}) {
  const minX = Number.isFinite(opts.minX) ? opts.minX : 34;
  renderSeasonScatter(
    "season-chart-club",
    players,
    "club_matches",
    tr("league.clubMatches"),
    tr("league.clubMatchesTitle"),
    { minX },
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
  const titleEl = $("season-title");
  if (titleEl) {
    const key = state.tab === "season2627" ? "league.seasonTitle2627" : "league.seasonTitle";
    titleEl.textContent = tr(key);
    titleEl.setAttribute("data-i18n", key);
  }
  syncSeasonClubSelect();
  const top = data.players?.[0];
  const lead = $("season-lead");
  if (lead) {
    const hintKey =
      state.tab === "season2627" ? "league.seasonAvgHint2627" : "league.seasonAvgHint";
    lead.innerHTML =
      tr("league.seasonLead", { season: esc(data.season), count: data.player_count ?? 0 }) +
      (top
        ? tr("league.seasonLeader", { name: esc(top.name), pts: seasonPts(top.total) })
        : "") +
      `<br/><span class="muted">${tr("league.seasonMult")}</span>` +
      `<br/><span class="muted">${tr(hintKey)}</span>` +
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
  const minX = Number.isFinite(data.chart_min_x) ? data.chart_min_x : 34;
  renderSeasonCharts(list, { minX });
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
    for (const l of TOP4_LEAGUES) {
      const opt = document.createElement("option");
      opt.value = l.id;
      opt.textContent = l.label;
      leagueSel.appendChild(opt);
    }
  }
  bindSeason();
  const slug = seasonSlugForTab(state.tab);
  if (state.season.loadedSlug !== slug) state.season.page = 1;
  if (state.season.bySlug[slug]) {
    state.season.data = state.season.bySlug[slug];
    state.season.loadedSlug = slug;
    state.season.loaded = true;
    renderSeason();
    return;
  }
  const res = await fetch(`/api/top4/season/${slug}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  if (seasonSlugForTab(state.tab) !== slug) return;
  state.season.bySlug[slug] = data;
  state.season.data = data;
  state.season.loadedSlug = slug;
  state.season.loaded = true;
  renderSeason();
}

function resultsPts(n) {
  if (n == null || !Number.isFinite(Number(n))) return "·";
  return Number(n).toFixed(2);
}

/** Team | TOTAL | current GW (GW2 if current is 1) | older GWs descending. FPTS from GW2+. */
function resultsDisplayGws(data) {
  const current = Number(data?.current_gw);
  const cap = Number.isFinite(current) ? Math.max(current, 2) : 2;
  return (data?.gws || [])
    .map(Number)
    .filter((g) => Number.isFinite(g) && g >= 2 && g <= cap)
    .sort((a, b) => b - a);
}

function sortedResultsTeams() {
  const data = state.results.data;
  if (!data?.teams) return [];
  const key = state.results.sortKey;
  const dir = state.results.sortDir;
  const gws = data.gws || [];
  return data.teams.slice().sort((a, b) => {
    let av;
    let bv;
    if (key === "name") {
      av = `${a.code || ""} ${a.name || ""}`.toLowerCase();
      bv = `${b.code || ""} ${b.name || ""}`.toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    if (key === "total") {
      av = Number(a.total) || 0;
      bv = Number(b.total) || 0;
    } else if (gws.includes(Number(key)) || gws.includes(key)) {
      const gk = String(key);
      av = a.byGw?.[gk];
      bv = b.byGw?.[gk];
      av = av == null ? -Infinity : Number(av);
      bv = bv == null ? -Infinity : Number(bv);
    } else {
      av = Number(a.total) || 0;
      bv = Number(b.total) || 0;
    }
    if (av !== bv) return (av - bv) * dir;
    return String(a.code || a.name).localeCompare(String(b.code || b.name));
  });
}

function liveStandPts(n) {
  return resultsPts(n);
}

function liveStandFmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100).replace(/\.0$/, "");
}

function liveStandPlayerLine(p) {
  const name = p?.name || "—";
  const total = liveStandPts(p?.total);
  const parts = Array.isArray(p?.parts) ? p.parts : [];
  const breakParts = parts
    .filter((part) => Number(part?.raw) || Number(part?.pts))
    .map(
      (part) =>
        `${liveStandFmtNum(part.raw)} × ${liveStandFmtNum(part.multiplier)}\u00a0${part.comp || "COMP"}`,
    )
    .join(" + ");
  let extra = breakParts ? `(${breakParts})` : "";
  if (p?.role_bonus && extra) extra += `\u00a0×1.2`;
  return {
    name,
    total,
    extra,
    position: p?.position || "",
    clubCrest: p?.club_crest || "",
  };
}

const LIVE_STAND_STARTED = new Set([
  "FT",
  "AET",
  "PEN",
  "1H",
  "2H",
  "HT",
  "ET",
  "BT",
  "P",
  "LIVE",
  "INT",
]);
const LIVE_STAND_SKIP = new Set(["CANC", "ABD", "AWD", "WO"]);

/** Cell kickoffs: not kicked off yet. NS/TBD with a past `date` is stale. */
function liveStandKickoffIsFuture(u) {
  const st = String(u?.status || "").toUpperCase();
  if (LIVE_STAND_STARTED.has(st) || LIVE_STAND_SKIP.has(st)) return false;
  const t = Date.parse(u?.date);
  return Number.isFinite(t) && t > Date.now();
}

function liveStandUpcomingHtml(p) {
  const ups = Array.isArray(p?.upcoming) ? p.upcoming : [];
  const bits = [];
  const titles = [];
  for (const u of ups) {
    if (!liveStandKickoffIsFuture(u)) continue;
    const when = formatGwsDeadline(u?.date);
    if (!when) continue;
    const ha = u.ha === "A" || u.ha === "H" ? u.ha : "";
    bits.push(ha ? `${ha} ${when}` : when);
    const full = formatGwsDeadlineFull(u.date);
    titles.push(ha && full ? `${ha} · ${full}` : full || when);
  }
  if (!bits.length) return "";
  const label = bits.join(" · ");
  const title = titles.filter(Boolean).join(" · ");
  return `<span class="top4-live-kickoff muted mono"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</span>`;
}

function liveStandSubBadge(p) {
  if (p.auto_sub) {
    const from = p.auto_sub_from ? String(p.auto_sub_from).trim() : "";
    const tip = from
      ? tr("league.liveStand.subOnTip", { name: from })
      : tr("league.liveStand.subOn");
    return `<span class="top4-live-sub is-on" title="${esc(tip)}" aria-label="${esc(tip)}">↑</span>`;
  }
  if (p.auto_sub_out) {
    const forName = p.auto_sub_for ? String(p.auto_sub_for).trim() : "";
    const tip = forName
      ? tr("league.liveStand.subOffTip", { name: forName })
      : tr("league.liveStand.subOff");
    return `<span class="top4-live-sub is-off" title="${esc(tip)}" aria-label="${esc(tip)}">↓</span>`;
  }
  return "";
}

function liveStandPlayerRowHtml(p, teamId) {
  const line = liveStandPlayerLine(p);
  const benchCls = p.kind === "bench" ? " is-bench" : "";
  const crest = line.clubCrest
    ? `<img class="top4-live-player-crest" src="${esc(line.clubCrest)}" alt="" width="22" height="22" loading="lazy" />`
    : `<span class="top4-live-player-crest top4-live-player-crest--empty" aria-hidden="true"></span>`;
  const breakHtml = line.extra
    ? `<span class="top4-live-player-break" title="${esc(line.extra)}">${esc(line.extra)}</span>`
    : "";
  const liveDot = p.match_live
    ? `<span class="top4-live-dot" title="${esc(tr("status.LIVE"))}" role="img" aria-label="${esc(tr("status.LIVE"))}"></span>`
    : "";
  const kickoffHtml = liveStandUpcomingHtml(p);
  return `<tr class="top4-live-player${benchCls}">
    <td class="top4-live-player-pos">${esc(line.position)}</td>
    <td class="top4-live-player-club">${crest}</td>
    <td class="top4-live-player-name" title="${esc(line.name)}"><span class="top4-live-player-label"><span class="top4-live-player-label-text">${esc(line.name)}</span>${liveStandSubBadge(p)}${liveDot}</span></td>
    <td class="top4-live-player-score"><div class="top4-live-player-score-inner"><button type="button" class="top4-live-fpts-btn top4-live-player-total mono" data-live-fpts data-live-fpts-team="${esc(String(teamId))}" data-live-fpts-player="${esc(String(p.id))}" aria-label="${esc(tr("league.liveStand.breakdownAria"))}">${esc(line.total)}</button>${kickoffHtml}${breakHtml}</div></td>
  </tr>`;
}

let fptsBdInertEls = [];
let fptsBdPrevFocus = null;
let fptsBdOnKey = null;

function liveStandPlayersTableHtml(players, teamId) {
  const list = players || [];
  if (!list.length) {
    return `<p class="muted top4-gws-empty">${esc(tr("league.liveStand.noLineup"))}</p>`;
  }
  const xi = list.filter((p) => p.kind !== "bench");
  const bench = list.filter((p) => p.kind === "bench");
  const benchBlock = bench.length
    ? `<tbody class="top4-live-bench">
        <tr class="top4-live-player-section">
          <th scope="rowgroup" colspan="4">${esc(tr("league.liveStand.bench"))}</th>
        </tr>
        ${bench.map((p) => liveStandPlayerRowHtml(p, teamId)).join("")}
      </tbody>`
    : "";
  return `<table class="top4-live-player-table">
    <thead>
      <tr>
        <th class="top4-live-player-pos">${esc(tr("common.posShort"))}</th>
        <th class="top4-live-player-club"></th>
        <th class="top4-live-player-name">${esc(tr("common.player"))}</th>
        <th class="top4-live-player-score">${esc(tr("league.liveStand.fpts"))}</th>
      </tr>
    </thead>
    <tbody class="top4-live-xi">${xi.map((p) => liveStandPlayerRowHtml(p, teamId)).join("")}</tbody>
    ${benchBlock}
  </table>`;
}

function findLiveStandPlayer(teamId, playerId) {
  const teams = state.liveStand.data?.teams || [];
  const team = teams.find((t) => Number(t.team_id) === Number(teamId));
  if (!team) return null;
  return (team.players || []).find((pl) => String(pl.id) === String(playerId)) || null;
}

function findBreakdownPlayer(teamId, playerId) {
  const detail = state.results.gwDetail;
  if (detail && Number(detail.team_id) === Number(teamId)) {
    const fromGw = (detail.players || []).find(
      (pl) => String(pl.id) === String(playerId),
    );
    if (fromGw) return fromGw;
  }
  return findLiveStandPlayer(teamId, playerId);
}

function liveStandSignedPts(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return liveStandFmtNum(v || 0);
  const s = liveStandFmtNum(Math.abs(v));
  return v < 0 ? `−${s}` : `+${s}`;
}

function fptsLineLabel(line) {
  const key = `league.liveStand.ev.${line.key}`;
  let label = tr(key);
  if (label === key) label = String(line.key || "");
  const count = Number(line.count);
  const alwaysCount = line.key === "saves" || line.key === "conceded";
  if (Number.isFinite(count) && count > 0 && (alwaysCount || count > 1)) {
    label += ` ×${liveStandFmtNum(count)}`;
  }
  return label;
}

function fptsBdLineHtml(line) {
  const detail = line.detail
    ? `<span class="fpts-bd-detail">${esc(String(line.detail))}</span>`
    : "";
  return `<li class="fpts-bd-line">
    <span class="fpts-bd-label">${esc(fptsLineLabel(line))}</span>
    ${detail}
    <span class="fpts-bd-pts mono">${esc(liveStandSignedPts(line.pts))}</span>
  </li>`;
}

function fptsBdStatusLabel(status) {
  const st = String(status || "").toUpperCase();
  if (!st) return "";
  const key = `status.${st}`;
  const label = tr(key);
  return label === key ? st : label;
}

function fptsBdMatchScore(m) {
  const home = m.home || "H";
  const away = m.away || "A";
  if (m.home_goals == null || m.away_goals == null) return `${home} – ${away}`;
  return `${home} ${m.home_goals}–${m.away_goals} ${away}`;
}

function fptsBdMatchHead(part, showComp) {
  const match = part?.match;
  let html = "";
  if (showComp || match) {
    html += `<p class="fpts-bd-comp">${esc(part.comp || "COMP")}</p>`;
  }
  if (match) {
    const when = formatGwsDeadline(match.date);
    const ha = match.ha === "A" || match.ha === "H" ? match.ha : "";
    const whenBit = when ? (ha ? `${ha} ${when}` : when) : "";
    const st = fptsBdStatusLabel(match.status);
    const bits = [whenBit, fptsBdMatchScore(match), st].filter(Boolean);
    html += `<p class="fpts-bd-score">${esc(bits.join(" · "))}</p>`;
  }
  return html;
}

function renderFptsBreakdownBody(p) {
  const parts = Array.isArray(p?.parts) ? p.parts : [];
  const withLines = parts.filter(
    (part) =>
      (Array.isArray(part.lines) && part.lines.length) || part.match,
  );
  const showHeads = withLines.length > 1 || withLines.some((part) => part.match);
  let html = "";
  if (!withLines.length) {
    html = `<p class="muted fpts-bd-empty">${esc(tr("league.liveStand.noEvents"))}</p>`;
  } else {
    html = withLines
      .map((part) => {
        const head = fptsBdMatchHead(part, showHeads);
        const mul =
          Number(part.multiplier) !== 1
            ? `<li class="fpts-bd-line fpts-bd-mul"><span class="fpts-bd-label">×${esc(liveStandFmtNum(part.multiplier))}\u00a0${esc(part.comp || "COMP")}</span></li>`
            : "";
        const lines = Array.isArray(part.lines) ? part.lines : [];
        return `<div class="fpts-bd-match">${head}<ul class="fpts-bd-list">${lines.map(fptsBdLineHtml).join("")}${mul}</ul></div>`;
      })
      .join("");
  }
  const hasRaw = withLines.some((part) => Number(part.raw));
  if (p?.role_bonus && hasRaw) {
    html += `<ul class="fpts-bd-list fpts-bd-bonus"><li class="fpts-bd-line fpts-bd-mul"><span class="fpts-bd-label">${esc(tr("league.liveStand.roleBonus"))}\u00a0×1.2</span></li></ul>`;
  }
  return html;
}

function fillFptsBreakdown(p) {
  const card = document.querySelector("#fpts-breakdown-overlay .fpts-bd-card");
  card?.classList.remove("is-team-gw");
  const nameEl = $("fpts-bd-name");
  if (nameEl) nameEl.textContent = p?.name || "—";
  const clubEl = $("fpts-bd-club");
  if (clubEl) {
    const crest = p?.club_crest
      ? `<img class="fpts-bd-crest" src="${esc(p.club_crest)}" alt="" width="18" height="18" />`
      : "";
    const club = p?.club_name || "";
    clubEl.innerHTML = `${crest}<span>${esc(club)}</span>`;
  }
  const body = $("fpts-bd-body");
  if (body) body.innerHTML = renderFptsBreakdownBody(p);
  const totalLabel = $("fpts-bd-total-label");
  if (totalLabel) totalLabel.textContent = tr("league.liveStand.total");
  const totalEl = $("fpts-bd-total");
  if (totalEl) totalEl.textContent = liveStandPts(p?.total ?? 0);
  syncFptsBackBtn();
}

function syncFptsBackBtn() {
  const back = $("fpts-bd-back");
  if (!back) return;
  const show = !!(state.results.gwDetail && state.liveStand.breakdown);
  back.hidden = !show;
  back.classList.toggle("is-on", show);
  const aria = tr("league.results.backToXi");
  back.setAttribute(
    "aria-label",
    !aria || aria === "league.results.backToXi" ? "←" : aria,
  );
}

function closeFptsBreakdown() {
  const overlay = $("fpts-breakdown-overlay");
  const wasOpen = overlay && !overlay.hidden;
  if (overlay) overlay.hidden = true;
  fptsBdInertEls.forEach((el) => {
    el.inert = false;
  });
  fptsBdInertEls = [];
  if (fptsBdOnKey) {
    document.removeEventListener("keydown", fptsBdOnKey);
    fptsBdOnKey = null;
  }
  const prev = fptsBdPrevFocus;
  fptsBdPrevFocus = null;
  state.liveStand.breakdown = null;
  state.results.gwDetail = null;
  state.results.gwPending = null;
  const back = $("fpts-bd-back");
  if (back) {
    back.hidden = true;
    back.classList.remove("is-on");
  }
  document.querySelector("#fpts-breakdown-overlay .fpts-bd-card")?.classList.remove("is-team-gw");
  if (wasOpen && prev && typeof prev.focus === "function") {
    try {
      prev.focus();
    } catch (_) {}
  }
}

function fptsOverlayOnEscape(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  if (state.results.gwDetail && state.liveStand.breakdown) {
    state.liveStand.breakdown = null;
    fillResultsGwCard(state.results.gwDetail);
    $("fpts-bd-close")?.focus();
    return;
  }
  closeFptsBreakdown();
}

function openFptsBreakdown(teamId, playerId, opener, keepTeamGw) {
  if (!keepTeamGw) state.results.gwDetail = null;
  const p = findBreakdownPlayer(teamId, playerId);
  if (!p) return;
  const overlay = $("fpts-breakdown-overlay");
  if (!overlay) return;
  state.liveStand.breakdown = {
    teamId: Number(teamId),
    playerId: String(playerId),
  };
  fillFptsBreakdown(p);
  if (!overlay.hidden) {
    $("fpts-bd-close")?.focus();
    return;
  }
  fptsBdPrevFocus = opener || document.activeElement;
  fptsBdInertEls = [];
  document.querySelectorAll("body > :not(#fpts-breakdown-overlay)").forEach((el) => {
    if (!el.inert) {
      el.inert = true;
      fptsBdInertEls.push(el);
    }
  });
  overlay.hidden = false;
  if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(overlay);
  fptsBdOnKey = fptsOverlayOnEscape;
  document.addEventListener("keydown", fptsBdOnKey);
  $("fpts-bd-close")?.focus();
}

function wireFptsBreakdownOnce() {
  const overlay = $("fpts-breakdown-overlay");
  const closeBtn = $("fpts-bd-close");
  const backBtn = $("fpts-bd-back");
  if (!overlay || overlay.dataset.wired === "1") return;
  overlay.dataset.wired = "1";
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeFptsBreakdown();
  });
  backBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.results.gwDetail) {
      state.liveStand.breakdown = null;
      fillResultsGwCard(state.results.gwDetail);
    }
  });
  overlay.addEventListener("click", (e) => {
    const fptsBtn = e.target.closest("[data-live-fpts]");
    if (fptsBtn && overlay.contains(fptsBtn)) {
      e.preventDefault();
      e.stopPropagation();
      openFptsBreakdown(
        fptsBtn.getAttribute("data-live-fpts-team"),
        fptsBtn.getAttribute("data-live-fpts-player"),
        fptsBtn,
        true,
      );
      return;
    }
    if (e.target === overlay) closeFptsBreakdown();
  });
}

function bindLiveStandingOnce() {
  if (state.liveStand.bound) return;
  const tbody = $("live-rows");
  if (!tbody) return;
  state.liveStand.bound = true;
  wireFptsBreakdownOnce();
  tbody.addEventListener("click", (e) => {
    const fptsBtn = e.target.closest("[data-live-fpts]");
    if (fptsBtn && tbody.contains(fptsBtn)) {
      e.preventDefault();
      e.stopPropagation();
      openFptsBreakdown(
        fptsBtn.getAttribute("data-live-fpts-team"),
        fptsBtn.getAttribute("data-live-fpts-player"),
        fptsBtn,
      );
      return;
    }
    const row = e.target.closest("[data-live-team]");
    if (!row || !tbody.contains(row)) return;
    const id = Number(row.getAttribute("data-live-team"));
    if (!Number.isFinite(id)) return;
    if (state.liveStand.open.has(id)) state.liveStand.open.delete(id);
    else state.liveStand.open.add(id);
    renderLiveStanding();
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("[data-live-team]");
    if (!row) return;
    e.preventDefault();
    row.click();
  });
}

function renderLiveStanding() {
  const data = state.liveStand.data;
  const lead = $("live-lead");
  const thead = $("live-thead");
  const tbody = $("live-rows");
  const syncedEl = $("live-synced");
  bindLiveStandingOnce();
  if (!data) {
    if (lead) lead.textContent = tr("common.loading");
    if (syncedEl) {
      syncedEl.hidden = true;
      syncedEl.textContent = "";
    }
    return;
  }
  if (syncedEl) {
    const when = formatGwsDeadline(data.synced_at);
    if (when) {
      syncedEl.hidden = false;
      syncedEl.textContent = tr("league.liveStand.synced", { time: when });
    } else {
      syncedEl.hidden = true;
      syncedEl.textContent = "";
    }
  }
  if (lead) {
    lead.textContent = tr("league.liveStand.lead", {
      gw: data.gw ?? data.current_gw ?? "—",
      label: data.gw_label || "",
    });
  }
  if (thead) {
    thead.innerHTML = `<tr>
      <th class="top4-live-rank">${esc(tr("league.liveStand.rank"))}</th>
      <th>${esc(tr("league.liveStand.team"))}</th>
      <th class="top4-results-num top4-results-total">${esc(tr("league.liveStand.fpts"))}</th>
    </tr>`;
  }
  if (!tbody) return;
  const teams = data.teams || [];
  if (!teams.length) {
    tbody.innerHTML = `<tr><td colspan="3">${esc(tr("league.liveStand.empty"))}</td></tr>`;
    return;
  }
  tbody.innerHTML = teams
    .map((t, i) => {
      const open = state.liveStand.open.has(t.team_id);
      const logo = t.logo_url
        ? `<img class="top4-team-logo top4-team-logo--lg" src="${esc(t.logo_url)}" alt="" width="48" height="48" loading="lazy" />`
        : `<span class="top4-team-logo top4-team-logo--lg top4-team-logo--empty" aria-hidden="true"></span>`;
      const code = t.code
        ? `<span class="top4-results-team-code">${esc(t.code)}</span>`
        : "";
      const empty = t.total == null;
      const pts = empty ? "·" : liveStandPts(t.total);
      const players = t.players || [];
      const body =
        empty || !players.length
          ? `<p class="muted top4-gws-empty">${esc(tr("league.liveStand.noLineup"))}</p>`
          : liveStandPlayersTableHtml(players, t.team_id);
      return `<tr class="top4-live-row${open ? " is-open" : ""}" data-live-team="${esc(String(t.team_id))}" tabindex="0" aria-expanded="${open ? "true" : "false"}">
        <td class="mono top4-live-rank">${i + 1}</td>
        <td class="top4-results-team-cell">
          <span class="top4-results-team${t.code ? " has-code" : ""}" title="${esc(t.name || "")}"><span class="top4-live-chevron" aria-hidden="true"></span>${logo}<span class="top4-results-team-text"><span class="top4-results-team-name">${esc(t.name || "")}</span>${code}</span></span>
        </td>
        <td class="mono top4-results-num top4-results-total${empty ? " muted" : ""}"><strong>${esc(pts)}</strong></td>
      </tr>
      <tr class="top4-live-players"${open ? "" : " hidden"}>
        <td colspan="3">${body}</td>
      </tr>`;
    })
    .join("");
  if (state.liveStand.breakdown && !state.results.gwDetail) {
    const { teamId, playerId } = state.liveStand.breakdown;
    const p = findLiveStandPlayer(teamId, playerId);
    if (p) fillFptsBreakdown(p);
  }
}

async function loadLiveStanding() {
  const res = await fetch("/api/top4/live");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  state.liveStand.data = await res.json();
  state.liveStand.loaded = true;
}

async function initLiveStanding() {
  await loadLiveStanding();
  renderLiveStanding();
  ensureLiveStandPoll();
}

let liveStandTimer = null;

function stopLiveStandPoll() {
  if (liveStandTimer) {
    clearInterval(liveStandTimer);
    liveStandTimer = null;
  }
}

function ensureLiveStandPoll() {
  if (state.tab !== "live") {
    stopLiveStandPoll();
    return;
  }
  if (liveStandTimer) return;
  liveStandTimer = setInterval(() => {
    if (state.tab !== "live" || document.visibilityState === "hidden") return;
    loadLiveStanding()
      .then(() => {
        if (state.tab === "live") renderLiveStanding();
      })
      .catch(() => {
        /* retry next tick */
      });
  }, 30000);
}

function renderResults() {
  const data = state.results.data;
  const lead = $("results-lead");
  const notes = $("results-notes");
  const thead = $("results-thead");
  const tbody = $("results-rows");
  if (!data) {
    if (lead) lead.textContent = tr("common.loading");
    return;
  }
  const gws = resultsDisplayGws(data);
  if (lead) {
    lead.textContent = tr("league.results.lead", {
      from: gws.length ? Math.min(...gws) : 2,
      current: data.current_gw ?? "—",
    });
  }
  if (notes) {
    notes.innerHTML = (data.notes || [])
      .map((n) => `<li>${esc(n)}</li>`)
      .join("");
  }
  const th = (key, label, extraClass = "") => {
    const active = state.results.sortKey === key;
    const arrow = active ? (state.results.sortDir < 0 ? " ↓" : " ↑") : "";
    const cls = `sortable${active ? " sorted" : ""}${extraClass ? ` ${extraClass}` : ""}`;
    return `<th class="${cls}" data-results-sort="${esc(String(key))}">${esc(label)}${arrow}</th>`;
  };
  if (thead) {
    thead.innerHTML = `<tr>${th("name", tr("league.results.team"))}${th("total", tr("league.results.total"), "top4-results-num top4-results-total")}${gws
      .map((g) => th(String(g), `GW${g}`, "top4-results-num top4-results-gw"))
      .join("")}</tr>`;
    thead.querySelectorAll("[data-results-sort]").forEach((el) => {
      el.addEventListener("click", () => {
        const k = el.getAttribute("data-results-sort");
        if (state.results.sortKey === k) state.results.sortDir *= -1;
        else {
          state.results.sortKey = k;
          state.results.sortDir = k === "name" ? 1 : -1;
        }
        renderResults();
      });
    });
  }
  if (tbody) {
    const rows = sortedResultsTeams();
    tbody.innerHTML = rows.length
      ? rows
          .map((t) => {
            const logo = t.logo_url
              ? `<img class="top4-team-logo top4-team-logo--lg" src="${esc(t.logo_url)}" alt="" width="48" height="48" loading="lazy" />`
              : `<span class="top4-team-logo top4-team-logo--lg top4-team-logo--empty" aria-hidden="true"></span>`;
            const code = t.code
              ? `<span class="top4-results-team-code">${esc(t.code)}</span>`
              : "";
            const gwCells = gws
              .map((g) => {
                const v = t.byGw?.[String(g)];
                const empty = v == null;
                if (empty) {
                  return `<td class="mono top4-results-num top4-results-gw muted">${esc(resultsPts(v))}</td>`;
                }
                const ariaRaw = tr("league.results.gwAria", {
                  team: t.name || t.code || "",
                  gw: g,
                });
                const aria =
                  !ariaRaw || ariaRaw === "league.results.gwAria"
                    ? `${t.name || t.code || ""} · GW${g}`
                    : ariaRaw;
                return `<td class="mono top4-results-num top4-results-gw"><button type="button" class="top4-results-gw-btn" data-results-team="${esc(String(t.team_id))}" data-results-gw="${esc(String(g))}" aria-label="${esc(aria)}">${esc(resultsPts(v))}</button></td>`;
              })
              .join("");
            return `<tr>
              <td class="top4-results-team-cell">
                <span class="top4-results-team${t.code ? " has-code" : ""}" title="${esc(t.name || "")}">${logo}<span class="top4-results-team-text"><span class="top4-results-team-name">${esc(t.name || "")}</span>${code}</span></span>
              </td>
              <td class="mono top4-results-num top4-results-total"><strong>${esc(resultsPts(t.total))}</strong></td>
              ${gwCells}
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="${gws.length + 2}">${esc(tr("league.results.empty"))}</td></tr>`;
    bindResultsOnce();
  }
}

function bindResultsOnce() {
  if (state.results.bound) return;
  const tbody = $("results-rows");
  if (!tbody) return;
  state.results.bound = true;
  wireFptsBreakdownOnce();
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-results-gw]");
    if (!btn || !tbody.contains(btn)) return;
    const teamId = Number(btn.getAttribute("data-results-team"));
    const gw = Number(btn.getAttribute("data-results-gw"));
    if (!Number.isFinite(teamId) || !Number.isFinite(gw)) return;
    openResultsGwPopup(teamId, gw, btn);
  });
}

function fillResultsGwCard(data) {
  const overlay = $("fpts-breakdown-overlay");
  const card = overlay?.querySelector(".fpts-bd-card");
  card?.classList.add("is-team-gw");
  state.liveStand.breakdown = null;
  const nameEl = $("fpts-bd-name");
  if (nameEl) nameEl.textContent = data?.name || "—";
  const clubEl = $("fpts-bd-club");
  if (clubEl) {
    const crest = data?.logo_url
      ? `<img class="fpts-bd-crest" src="${esc(data.logo_url)}" alt="" width="18" height="18" />`
      : "";
    const bits = [];
    if (data?.gw_label) bits.push(String(data.gw_label));
    else if (data?.gw) bits.push(`GW${data.gw}`);
    if (data?.formation) bits.push(String(data.formation));
    clubEl.innerHTML = `${crest}<span>${esc(bits.join(" · "))}</span>`;
  }
  const body = $("fpts-bd-body");
  if (body) {
    if (data?._loading) {
      body.innerHTML = `<p class="muted fpts-bd-empty">${esc(tr("common.loading"))}</p>`;
    } else if (data?.total == null) {
      body.innerHTML = `<p class="muted fpts-bd-empty">${esc(tr("league.liveStand.noLineup"))}</p>`;
    } else {
      body.innerHTML = liveStandPlayersTableHtml(data.players || [], data.team_id);
    }
  }
  const totalLabel = $("fpts-bd-total-label");
  if (totalLabel) totalLabel.textContent = tr("league.liveStand.total");
  const totalEl = $("fpts-bd-total");
  if (totalEl) {
    totalEl.textContent = data?.total == null ? "·" : liveStandPts(data.total);
  }
  syncFptsBackBtn();
}

function ensureFptsOverlayOpen(opener) {
  const overlay = $("fpts-breakdown-overlay");
  if (!overlay) return null;
  if (!overlay.hidden) return overlay;
  fptsBdPrevFocus = opener || document.activeElement;
  fptsBdInertEls = [];
  document.querySelectorAll("body > :not(#fpts-breakdown-overlay)").forEach((el) => {
    if (!el.inert) {
      el.inert = true;
      fptsBdInertEls.push(el);
    }
  });
  overlay.hidden = false;
  if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(overlay);
  fptsBdOnKey = fptsOverlayOnEscape;
  document.addEventListener("keydown", fptsBdOnKey);
  $("fpts-bd-close")?.focus();
  return overlay;
}

async function openResultsGwPopup(teamId, gw, opener) {
  const key = `${teamId}:${gw}`;
  state.results.gwPending = key;
  const cached = state.results.gwCache[key];
  const team = (state.results.data?.teams || []).find(
    (t) => Number(t.team_id) === Number(teamId),
  );
  wireFptsBreakdownOnce();
  if (!ensureFptsOverlayOpen(opener)) return;
  if (cached) {
    state.results.gwDetail = cached;
    fillResultsGwCard(cached);
    return;
  }
  fillResultsGwCard({
    team_id: teamId,
    name: team?.name || "—",
    logo_url: team?.logo_url || null,
    gw,
    gw_label: "",
    formation: null,
    total: team?.byGw?.[String(gw)] ?? null,
    players: [],
    _loading: true,
  });
  try {
    const res = await fetch(`/api/top4/results/${teamId}/${gw}`);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    state.results.gwCache[key] = payload;
    if (state.results.gwPending !== key) return;
    const overlay = $("fpts-breakdown-overlay");
    if (!overlay || overlay.hidden) return;
    state.results.gwDetail = payload;
    fillResultsGwCard(payload);
  } catch (err) {
    if (state.results.gwPending !== key) return;
    const body = $("fpts-bd-body");
    if (body) {
      body.innerHTML = `<p class="muted fpts-bd-empty">${esc(String(err?.message || err))}</p>`;
    }
  }
}

async function initResults() {
  const res = await fetch("/api/top4/results");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  state.results.data = await res.json();
  state.results.loaded = true;
  renderResults();
}

function renderTransferBanner() {
  const host = $("top4-to-banner");
  if (!host) return;
  const t = state.data?.transfers;
  if (!t?.can_open || !t.preview_gw) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  host.innerHTML = `
    <span class="top4-to-banner-label">${esc(tr("to.banner", { gw: t.preview_gw }))}</span>
    <button type="button" class="top4-to-open" id="btn-open-to">${esc(tr("to.open"))}</button>`;
  $("btn-open-to")?.addEventListener("click", async () => {
    const btn = $("btn-open-to");
    if (btn) btn.disabled = true;
    try {
      await api("/api/top4/transfers/open", { method: "POST", body: "{}" });
      state.data = await api("/api/top4");
      renderTransferBanner();
      state.transfers.loaded = false;
      history.pushState({ tab: "transfers" }, "", "/top4/transfers");
      applyTab("transfers");
    } catch (err) {
      if (btn) btn.disabled = false;
      host.insertAdjacentHTML(
        "beforeend",
        `<span class="muted"> ${esc(err.message || err)}</span>`,
      );
    }
  });
}

function hydrateTransferSquad(players) {
  const byId = new Map((state.players || []).map((p) => [String(p.id), p]));
  return (players || []).map((sp) => {
    const full = byId.get(String(sp.id));
    if (full) return full;
    return {
      id: sp.id,
      club_id: sp.club_id || "",
      club_name: sp.club_name || "",
      league_id: sp.league_id || "",
      market_value_eur: sp.market_value_eur || 0,
      wage_pw: sp.wage_pw || 0,
      trusted_wage_pw: sp.wage_pw || 0,
      position: String(sp.position_display || "").toUpperCase().startsWith("GK") ? "GK" : "",
      detail_role: null,
      detail_label: null,
      position_display: sp.position_display || "",
    };
  });
}

function transferTakenIdSet() {
  const ids = new Set();
  for (const team of state.data?.squads?.teams || []) {
    for (const p of team.players || []) ids.add(String(p.id));
  }
  const my = state.transfers.data?.my;
  if (my?.players) {
    const mine = new Set(my.players.map((p) => String(p.id)));
    const myTeamId = String(my.team_id || "");
    const myEmail = String(my.email || "").toLowerCase();
    for (const team of state.data?.squads?.teams || []) {
      const match =
        String(team.team_id || "") === myTeamId ||
        String(team.email || "").toLowerCase() === myEmail;
      if (!match) continue;
      for (const p of team.players || []) ids.delete(String(p.id));
    }
    for (const id of mine) ids.add(id);
  }
  return ids;
}

function transferEligibilityCtx() {
  const my = state.transfers.data?.my;
  if (!my) return { active: false };
  return buildPickEligibilityCtx({ force: true, squad: hydrateTransferSquad(my.players) });
}

function transferPickEligibility(player, ctx, taken) {
  if (!player) return { ok: false, reason: "budget" };
  if (taken.has(String(player.id))) return { ok: false, reason: "taken" };
  const lid = String(player.league_id || "");
  const leagues = ctx?.rules?.leagueIds || TOP4_LEAGUES.map((l) => l.id);
  if (!lid || !leagues.includes(lid)) return { ok: false, reason: "league" };
  return pickEligibility(player, true, ctx);
}

function resetPoolFiltersKeepHidePicked() {
  state.filters.league = "";
  state.filters.club = "";
  state.filters.line = "";
  state.filters.pos = "";
  state.filters.name = "";
  ensureFilterBounds({ reset: true });
  state.poolPage = 1;
}

function applyTransferSort(key) {
  if (!key) return;
  if (state.sortKey === key) state.sortDir *= -1;
  else {
    state.sortKey = key;
    state.sortDir = key === "name" || key === "club" || key === "pos" || key === "league" ? 1 : -1;
  }
  state.poolPage = 1;
}

function renderTransferPickPool(showPickBtn) {
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
  const taken = transferTakenIdSet();
  const eligCtx = transferEligibilityCtx();
  const rows = shown
    .map((p) => {
      const id = String(p.id);
      const elig = transferPickEligibility(p, eligCtx, taken);
      const blockTitle = elig.ok ? "" : pickBlockTitle(elig.reason);
      const pickBtn =
        showPickBtn && elig.ok
          ? `<button type="button" class="auth-link" data-to-pick="${esc(id)}">${esc(tr("to.pick"))}</button>`
          : "";
      const cls = elig.ok ? "" : ' class="top4-to-ineligible"';
      const title = blockTitle ? ` title="${esc(blockTitle)}"` : "";
      return `<tr${cls}${title}>
        <td><a class="player-link" href="/player.html?id=${encodeURIComponent(id)}">${esc(p.name)}</a>${availBadgeHtml(p.availability)}</td>
        <td>${esc(p.position_display)}</td>
        <td>${esc(p.club_name)}</td>
        <td>${esc(p.league_id)}</td>
        <td class="mono">${p.fm_rating ?? "—"}</td>
        <td class="mono">${esc(resultsPts(playerFp(p)))}</td>
        <td class="money">${eur(p.market_value_eur)}</td>
        <td class="money">${wageSum(playerWage(p))}</td>
        <td>${pickBtn}</td>
      </tr>`;
    })
    .join("");
  const pageHint =
    total === 0 ? "" : tr("common.pageOf", { from, to, page, pages: totalPages });
  return `
    <p class="muted">${tr("league.poolOf", { title: tr("league.poolTop4"), total, all: state.players.length, pageHint })}</p>
    ${renderPoolFilters("to-")}
    ${renderPoolPager(page, totalPages, from, to, total)}
    <div class="table-wrap">
      <table class="compact-table top4-transfers-pool" id="to-pool-table">
        <thead>
          <tr>
            ${sortTh(tr("common.player"), "name")}
            ${sortTh(tr("common.posDot"), "pos")}
            ${sortTh(tr("common.club"), "club")}
            ${sortTh(tr("common.league"), "league")}
            ${sortTh(tr("common.rating"), "rating")}
            ${sortTh(tr("index.fpCol"), "fp")}
            ${sortTh(tr("common.value"), "mv")}
            ${sortTh(tr("common.wage"), "wage")}
            <th></th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="9" class="muted">${tr("common.noPlayersFilter")}</td></tr>`}</tbody>
      </table>
    </div>
    ${renderPoolPager(page, totalPages, from, to, total)}`;
}

function renderTransfers() {
  const lead = $("transfers-lead");
  const body = $("transfers-body");
  if (!body) return;
  const data = state.transfers.data;
  if (!data) {
    const adminEmpty = $("transfers-admin");
    if (adminEmpty) {
      adminEmpty.hidden = true;
      adminEmpty.innerHTML = "";
    }
    return;
  }
  const win = data.window;
  if (!win || win.status === "closed") {
    if (lead) lead.textContent = tr("to.closed");
    const adminClosed = $("transfers-admin");
    if (adminClosed) {
      adminClosed.hidden = true;
      adminClosed.innerHTML = "";
    }
    body.innerHTML = "";
    return;
  }
  if (win.status === "complete") {
    if (lead) lead.textContent = tr("to.complete");
  } else if (lead) {
    lead.textContent = [
      tr("to.round", { n: win.round, total: win.rounds || 10 }),
      win.on_clock ? tr("to.onClock", { team: win.on_clock.name || win.on_clock.code || "" }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const adminHost = $("transfers-admin");
  const showAdminPass = Boolean(data.is_admin && win.status === "open" && win.on_clock);
  if (adminHost) {
    adminHost.hidden = !showAdminPass;
    adminHost.innerHTML = showAdminPass
      ? `<button type="button" class="top4-to-open" id="btn-to-admin-pass">${esc(tr("to.adminPass"))}</button>`
      : "";
    if (!state.transfers.adminBound) {
      state.transfers.adminBound = true;
      adminHost.addEventListener("click", async (e) => {
        if (!e.target.closest("#btn-to-admin-pass")) return;
        const team =
          state.transfers.data?.window?.on_clock?.name ||
          state.transfers.data?.window?.on_clock?.code ||
          "";
        if (!(await askConfirm(tr("to.adminPassConfirm", { team })))) return;
        try {
          await api("/api/top4/transfers/admin-pass", { method: "POST", body: "{}" });
          await initTransfers();
          state.data = await api("/api/top4");
          renderTransferBanner();
          renderTransfers();
        } catch (err) {
          $("meta").textContent = String(err.message || err);
        }
      });
    }
  }

  const my = data.my;
  const myTurn = Boolean(my?.my_turn && win.status === "open");
  const sub = state.transfers.sub === "pick" ? "pick" : "dump";
  const fpById = playerFpByIdMap();
  const availById = playerAvailByIdMap();
  const rosterRows = (my?.players || [])
    .map((p) => {
      const dumpBtn =
        myTurn && my.dump_left > 0
          ? `<button type="button" class="auth-link" data-to-dump="${esc(p.id)}">${esc(tr("to.dump"))}</button>`
          : "";
      return `<tr>
        <td><a class="player-link" href="/player.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a>${availBadgeHtml(resolvePlayerAvail(p, availById))}${p.out ? ' <span class="top4-squad-out">OUT</span>' : ""}</td>
        <td>${esc(p.position_display || "")}</td>
        <td>${esc(p.club_name || "")}</td>
        <td class="mono">${esc(resultsPts(playerFpLookup(p, fpById)))}</td>
        <td class="money">${eur(p.market_value_eur)}</td>
        <td class="money">${wageSum(p.wage_pw)}</td>
        <td>${dumpBtn}</td>
      </tr>`;
    })
    .join("");

  const moves = (data.moves || [])
    .slice()
    .reverse()
    .slice(0, 30)
    .map((m) => {
      const who = (data.order || []).find((o) => o.team_id === m.team_id);
      const label =
        m.kind === "dump"
          ? tr("to.dump")
          : m.kind === "pick"
            ? tr("to.pick")
            : tr("to.pass");
      return `<li>${esc(who?.name || m.email)} · ${esc(label)}${m.player_name ? ` · ${esc(m.player_name)}` : ""}</li>`;
    })
    .join("");

  const dumpPane = my
    ? `<div class="table-wrap"><table class="compact-table top4-transfers-roster">
         <thead><tr><th>${tr("common.player")}</th><th>${tr("common.posDot")}</th><th>${tr("common.club")}</th><th class="mono" title="${esc(tr("index.fpColTip"))}">${tr("index.fpCol")}</th><th>MV</th><th>wage</th><th></th></tr></thead>
         <tbody>${rosterRows || `<tr><td colspan="7" class="muted">${esc(tr("squad.emptyRoster"))}</td></tr>`}</tbody>
       </table></div>`
    : "";
  const pickPane = my ? renderTransferPickPool(myTurn && my.pick_left > 0) : "";

  body.innerHTML = `
    ${
      my
        ? `<p class="top4-transfers-clock">${esc(tr("to.left", { dumps: my.dumps, picks: my.picks }))}<br>${esc(tr("to.budget", { mv: eur(my.mv_left), wage: wageSum(my.wage_left) }))}</p>
           ${myTurn ? `<p class="muted">${esc(tr("to.dumpHint"))}. ${esc(tr("to.pickHint"))}.</p>
           <div class="top4-transfers-actions">
             <button type="button" class="auth-link" id="btn-to-pass">${esc(tr("to.pass"))}</button>
           </div>` : `<p class="muted">${esc(tr("to.notYourTurn"))}</p>`}
           <div class="top4-to-tabs" role="tablist">
             <button type="button" class="primer-tab${sub === "dump" ? " active" : ""}" data-to-sub="dump" role="tab" aria-selected="${sub === "dump"}">${esc(tr("to.dump"))}</button>
             <button type="button" class="primer-tab${sub === "pick" ? " active" : ""}" data-to-sub="pick" role="tab" aria-selected="${sub === "pick"}">${esc(tr("to.pick"))}</button>
           </div>
           ${sub === "pick" ? pickPane : dumpPane}`
        : ""
    }
    <h3 class="subhead">${esc(tr("league.tab.transfers"))}</h3>
    <ol class="top4-rules-list">${moves || `<li class="muted">${esc(tr("to.emptyMoves"))}</li>`}</ol>`;

  if (!state.transfers.bound) {
    state.transfers.bound = true;
    body.addEventListener("click", async (e) => {
      const subBtn = e.target.closest("[data-to-sub]");
      if (subBtn) {
        state.transfers.sub = subBtn.getAttribute("data-to-sub") === "pick" ? "pick" : "dump";
        renderTransfers();
        return;
      }
      if (e.target.closest(".pool-prev")) {
        if (state.poolPage <= 1) return;
        state.poolPage -= 1;
        renderTransfers();
        return;
      }
      if (e.target.closest(".pool-next")) {
        state.poolPage += 1;
        renderTransfers();
        return;
      }
      if (e.target.closest("#to-f-reset")) {
        resetPoolFiltersKeepHidePicked();
        renderTransfers();
        return;
      }
      const sortEl = e.target.closest("#to-pool-table th.sortable");
      if (sortEl) {
        applyTransferSort(sortEl.getAttribute("data-sort"));
        renderTransfers();
        return;
      }
      const dump = e.target.closest("[data-to-dump]");
      const pick = e.target.closest("[data-to-pick]");
      const pass = e.target.closest("#btn-to-pass");
      try {
        if (dump) {
          await api("/api/top4/transfers/dump", {
            method: "POST",
            body: JSON.stringify({ playerId: dump.getAttribute("data-to-dump") }),
          });
        } else if (pick) {
          await api("/api/top4/transfers/pick", {
            method: "POST",
            body: JSON.stringify({ playerId: pick.getAttribute("data-to-pick") }),
          });
        } else if (pass) {
          await api("/api/top4/transfers/pass", { method: "POST", body: "{}" });
        } else return;
        await initTransfers();
        state.data = await api("/api/top4");
        renderTransferBanner();
        renderTransfers();
      } catch (err) {
        $("meta").textContent = String(err.message || err);
      }
    });
    body.addEventListener("input", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const id = t.id;
      if (id === "to-f-name") {
        state.filters.name = t.value;
        state.poolPage = 1;
        const caret = t.selectionStart;
        renderTransfers();
        const el = $("to-f-name");
        if (el && typeof caret === "number") {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
        return;
      }
      if (id === "to-f-mv-min" || id === "to-f-mv-max") {
        applyDualRangeInputs($("to-f-mv-min"), $("to-f-mv-max"), "mv");
        return;
      }
      if (id === "to-f-wage-min" || id === "to-f-wage-max") {
        applyDualRangeInputs($("to-f-wage-min"), $("to-f-wage-max"), "wage");
        return;
      }
    });
    body.addEventListener("change", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const id = t.id;
      if (id === "to-f-league") {
        state.filters.league = t.value;
        state.filters.club = "";
        state.filters.pos = "";
        state.poolPage = 1;
        renderTransfers();
        return;
      }
      if (id === "to-f-club") {
        state.filters.club = t.value;
        state.poolPage = 1;
        renderTransfers();
        return;
      }
      if (id === "to-f-line") {
        state.filters.line = t.value;
        state.filters.pos = "";
        state.poolPage = 1;
        renderTransfers();
        return;
      }
      if (id === "to-f-pos") {
        state.filters.pos = t.value;
        state.poolPage = 1;
        renderTransfers();
        return;
      }
      if (id === "to-f-hide-picked") {
        state.filters.hidePicked = Boolean(t.checked);
        saveHidePicked(state.filters.hidePicked);
        state.poolPage = 1;
        renderTransfers();
        return;
      }
      if (
        id === "to-f-mv-min" ||
        id === "to-f-mv-max" ||
        id === "to-f-wage-min" ||
        id === "to-f-wage-max"
      ) {
        state.poolPage = 1;
        renderTransfers();
      }
    });
  }
}

async function initTransfers() {
  if (!state.players?.length) {
    try {
      await loadPlayers();
    } catch {
      /* pool stays empty */
    }
  }
  state.transfers.data = await api("/api/top4/transfers");
  state.transfers.loaded = true;
  renderTransfers();
}

const GWS_TZ = "Europe/Warsaw";

function gwsI18nLocale() {
  return typeof globalThis.Din8styI18n?.locale === "function"
    ? globalThis.Din8styI18n.locale()
    : "ru";
}

function gwsDeadlineParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: GWS_TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const day = get("day");
  const month = get("month");
  const hour = String(get("hour") || "").padStart(2, "0");
  const minute = String(get("minute") || "").padStart(2, "0");
  if (!day || !month) return null;
  return { day, month, hour, minute };
}

/** Compact Warsaw deadline, e.g. `16.08 16:00`. */
function formatGwsDeadline(iso) {
  const p = gwsDeadlineParts(iso);
  if (!p) return "";
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

function formatGwsDeadlineFull(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(gwsI18nLocale(), {
    timeZone: GWS_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

function gwsPlayerLine(p, reserveLabel) {
  if (!p || (!p.id && p.short === "—")) {
    const pos = p?.pos ? `<span class="top4-gws-pos">${esc(p.pos)}</span>` : "";
    const tag = reserveLabel
      ? `<span class="top4-gws-r">${esc(reserveLabel)}</span>`
      : "";
    return `<li class="top4-gws-player muted">${tag}${pos}<span class="top4-gws-chip">—</span></li>`;
  }
  const pos = p.pos ? `<span class="top4-gws-pos">${esc(p.pos)}</span>` : "";
  const tag = reserveLabel
    ? `<span class="top4-gws-r">${esc(reserveLabel)}</span>`
    : "";
  const href = p.id ? `/player.html?id=${encodeURIComponent(p.id)}` : "#";
  const club = p.club
    ? `<span class="top4-gws-club mono">${esc(p.club)}</span>`
    : "";
  const opp = p.opp
    ? `<span class="top4-gws-opp mono">${esc(p.opp)}</span>`
    : "";
  const title = [p.name || p.short, p.club, p.opp].filter(Boolean).join(" · ");
  return `<li class="top4-gws-player">${tag}${pos}<span class="top4-gws-chip" title="${esc(title)}">${club}<a class="top4-gws-name" href="${esc(href)}">${esc(p.short || p.name || "—")}</a>${opp}</span></li>`;
}

function renderGwsGwBlock(gw, label, kind) {
  const data = state.gws.data;
  const teams = data?.teams || [];
  const title =
    kind === "current"
      ? tr("league.gws.current", { gw, label })
      : tr("league.gws.next", { gw, label });
  const openAttr = state.gws.open?.[kind] ? " open" : "";
  if (!teams.length) {
    return `<details class="top4-gws-block" data-gw-kind="${esc(kind)}"${openAttr}>
      <summary class="top4-gws-summary">${esc(title)}</summary>
      <p class="muted">${esc(tr("league.gws.emptyTeams"))}</p>
    </details>`;
  }
  const cols = teams
    .map((t) => {
      const code = t.code || `T${t.team_id}`;
      const lu = t.lineups?.[String(gw)] ?? null;
      const deadlineIso = t.deadlines?.[String(gw)] ?? null;
      const deadlineShort = formatGwsDeadline(deadlineIso);
      const deadlineFull = formatGwsDeadlineFull(deadlineIso);
      const deadlineLabel = tr("league.gws.deadline");
      const headerTitle = [
        t.name || "",
        deadlineFull ? `${deadlineLabel} ${deadlineFull}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const deadlineHtml = deadlineShort
        ? `<span class="top4-gws-deadline">· <span class="top4-gws-deadline-label">${esc(deadlineLabel)}</span> <span class="mono">${esc(deadlineShort)}</span></span>`
        : "";
      let body;
      if (!lu) {
        body = `<p class="top4-gws-empty muted">${esc(tr("league.gws.noLineup"))}</p>`;
      } else {
        const xi = (lu.xi || []).map((p) => gwsPlayerLine(p, null)).join("");
        const reserves = (lu.reserves || [])
          .map((p, i) => gwsPlayerLine(p, p.r || `R${i + 1}`))
          .join("");
        body = `<p class="top4-gws-formation mono">${esc(lu.formation || "")}</p>
          <ol class="top4-gws-xi">${xi}</ol>
          <ul class="top4-gws-reserves">${reserves}</ul>`;
      }
      return `<div class="top4-gws-col">
        <h4 class="top4-gws-team" title="${esc(headerTitle)}">${esc(code)}${deadlineHtml}</h4>
        ${body}
      </div>`;
    })
    .join("");
  return `<details class="top4-gws-block" data-gw-kind="${esc(kind)}"${openAttr}>
    <summary class="top4-gws-summary">${esc(title)}</summary>
    <div class="top4-gws-cols">${cols}</div>
  </details>`;
}

function bindGwsOnce() {
  if (state.gws.bound) return;
  state.gws.bound = true;
  $("gws-body")?.addEventListener("toggle", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement)) return;
    const kind = el.getAttribute("data-gw-kind");
    if (kind !== "current" && kind !== "next") return;
    if (!state.gws.open) state.gws.open = { current: false, next: false };
    state.gws.open[kind] = el.open;
  });
}

function renderGws() {
  const data = state.gws.data;
  const lead = $("gws-lead");
  const body = $("gws-body");
  if (!data) return;
  bindGwsOnce();
  if (lead) {
    lead.textContent = tr("league.gws.lead", {
      current: data.currentGw ?? "—",
      next: data.nextGw ?? "—",
    });
  }
  if (body) {
    body.innerHTML =
      renderGwsGwBlock(data.currentGw, data.currentLabel, "current") +
      renderGwsGwBlock(data.nextGw, data.nextLabel, "next");
  }
}

async function initGws() {
  const res = await fetch("/api/top4/gws-lineups");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  state.gws.data = await res.json();
  state.gws.loaded = true;
  renderGws();
}

function wireTabs() {
  const initial = initialTab();
  state.tab = initial;
  applyTab(initial);
}

async function loadDraftRoom(opts = {}) {
  const preserveEditor = Boolean(opts.preserveEditor);
  const poolScroll = preserveEditor ? ($("draft-room-pool")?.scrollTop ?? 0) : 0;
  const editorScroll = preserveEditor ? ($("draft-room-editor")?.scrollTop ?? 0) : 0;
  const me = state.data?.me;
  if (!me?.user) {
    state.draftRoom.loaded = true;
    state.draftRoom.sets = [];
    state.draftRoom.pool = [];
    renderDraftRoom();
    return;
  }
  if (!me.registered) {
    state.draftRoom.loaded = true;
    state.draftRoom.sets = [];
    state.draftRoom.pool = [];
    renderDraftRoom();
    return;
  }
  const res = await fetch("/api/top4/draft-room/sets", { credentials: "include" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  state.draftRoom.sets = data.sets || [];
  state.draftRoom.pool = data.pool || [];
  state.draftRoom.formations = data.formations || [];
  state.draftRoom.maxSets = data.max_sets ?? 10;
  state.draftRoom.wishlistCount = data.wishlist_count ?? 0;
  state.draftRoom.squadCount = data.squad_count ?? 0;
  state.draftRoom.rules = data.rules || state.data?.rules || null;
  state.draftRoom.loaded = true;
  if (
    state.draftRoom.editingId != null &&
    !state.draftRoom.sets.some((s) => s.id === state.draftRoom.editingId)
  ) {
    state.draftRoom.editingId = null;
    state.draftRoom.draft = null;
  }
  renderDraftRoom();
  if (preserveEditor) {
    const pool = $("draft-room-pool");
    if (pool) pool.scrollTop = poolScroll;
    const editor = $("draft-room-editor");
    if (editor) editor.scrollTop = editorScroll;
  }
}

function draftRoomSetLabel(set) {
  if (set?.name) return set.name;
  return tr("draftRoom.unnamed", { id: set?.id ?? "?" });
}

function draftRoomFormationLabel(id) {
  const f = state.draftRoom.formations.find((x) => x.id === id);
  return f?.label || id || "—";
}

const DR_LABEL_TO_ROLE = {
  GOALKEEPER: "GK",
  "CENTRE-BACK": "CB",
  "LEFT-BACK": "LB",
  "RIGHT-BACK": "RB",
  SWEEPER: "CB",
  "DEFENSIVE MIDFIELD": "DM",
  "CENTRAL MIDFIELD": "CM",
  "ATTACKING MIDFIELD": "AM",
  "LEFT MIDFIELD": "LM",
  "RIGHT MIDFIELD": "RM",
  "LEFT WINGER": "LW",
  "RIGHT WINGER": "RW",
  "CENTRE-FORWARD": "CF",
  STRIKER: "CF",
  "SECOND STRIKER": "SS",
};

function drCanonRole(r) {
  const n = String(r || "")
    .trim()
    .toUpperCase();
  const mapped = DR_LABEL_TO_ROLE[n] || n;
  return mapped === "ST" ? "CF" : mapped;
}

function drPlayerRoles(p) {
  if (!p) return [];
  const raw = [];
  if (p.detail_role) raw.push(p.detail_role);
  if (p.detail_label) raw.push(p.detail_label);
  if (p.side_role) {
    for (const part of String(p.side_role).split(",")) {
      const t = part.trim();
      if (t) raw.push(t);
    }
  }
  if (p.position) {
    const coarse = drCanonRole(p.position);
    if (coarse && !["GK", "DEF", "MID", "ATT"].includes(coarse)) raw.push(p.position);
  }
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const c = drCanonRole(r);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function drPlayerMatchesSlot(p, roles) {
  if (!p || !roles?.length) return false;
  const wanted = roles.map((r) => drCanonRole(r));
  const all = drPlayerRoles(p);
  if (wanted.some((w) => all.includes(w))) return true;
  const coarse = drCanonRole(p.position || "");
  return wanted.some((w) => coarse === w);
}

function drIdealRoleForSlot(p, slotRoles) {
  if (!p || !slotRoles?.length) return null;
  const primary = p.detail_role || p.detail_label || p.position;
  if (!primary) return null;
  const c = drCanonRole(primary);
  return slotRoles.map(drCanonRole).includes(c) ? c : null;
}

function drPoolById() {
  const m = new Map();
  for (const p of state.draftRoom.pool) m.set(String(p.player_id), p);
  return m;
}

function draftRoomRules() {
  return (
    state.draftRoom.rules ||
    state.data?.rules || {
      rounds: 26,
      mv_cap: 1_200_000_000,
      wage_cap: 5_000_000,
      min_per_league: 3,
      max_per_club: 3,
      min_gk: 3,
    }
  );
}

function draftRoomUniquePlayers(draft) {
  const byId = drPoolById();
  const seen = new Set();
  const players = [];
  for (const s of draft?.slots || []) {
    for (const field of ["starter", "replace1", "replace2"]) {
      const id = s?.[field];
      if (!id) continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const p = byId.get(key);
      if (p) players.push(p);
    }
  }
  return players;
}

function isDraftRoomGk(p) {
  return playerLine(p) === "GK" || primaryRole(p) === "GK";
}

function computeDraftRoomCaps(draft) {
  const rules = draftRoomRules();
  const players = draftRoomUniquePlayers(draft);
  const minLeague = rules.min_per_league ?? 3;
  const maxClub = rules.max_per_club ?? 3;
  const minGk = rules.min_gk ?? 3;
  const minSquad = rules.rounds ?? 26;
  const mvCap = rules.mv_cap ?? 1_200_000_000;
  const wageCap = rules.wage_cap ?? 5_000_000;

  let mv = 0;
  let wage = 0;
  let gk = 0;
  const leagues = { GB1: 0, ES1: 0, IT1: 0, L1: 0 };
  const clubs = new Map();

  for (const p of players) {
    mv += playerMv(p);
    wage += playerWage(p);
    if (isDraftRoomGk(p)) gk += 1;
    const lid = String(p.league_id || "");
    if (Object.prototype.hasOwnProperty.call(leagues, lid)) leagues[lid] += 1;
    const clubKey = String(p.club_id || p.club_name || "");
    if (!clubKey) continue;
    const cur = clubs.get(clubKey) || { name: p.club_name || clubKey, n: 0 };
    cur.n += 1;
    clubs.set(clubKey, cur);
  }

  const overClubs = [...clubs.values()]
    .filter((c) => c.n > maxClub)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const leagueFails = Object.keys(leagues).filter((id) => leagues[id] < minLeague);

  return {
    count: players.length,
    mv,
    wage,
    gk,
    leagues,
    overClubs,
    leagueFails,
    mvCap,
    wageCap,
    minLeague,
    maxClub,
    minGk,
    minSquad,
    mvOk: mv <= mvCap,
    wageOk: wage <= wageCap,
    countOk: players.length >= minSquad,
    leaguesOk: leagueFails.length === 0,
    clubsOk: overClubs.length === 0,
    gkOk: gk >= minGk,
  };
}

function draftRoomCapsHtml(draft) {
  const c = computeDraftRoomCaps(draft);
  const leaguesHtml = Object.keys(TOP4_LEAGUE_SHORT)
    .map((id) => {
      const n = c.leagues[id] ?? 0;
      const short = TOP4_LEAGUE_SHORT[id];
      const bad = n < c.minLeague;
      return `<span class="top4-dr-cap-chip${bad ? " is-bad" : ""}" title="${esc(`${short}: ${n} / ≥${c.minLeague}`)}">${esc(short)} ${n}</span>`;
    })
    .join("");

  const clubsTitle = c.overClubs.length
    ? c.overClubs.map((x) => `${x.name} ${x.n}`).join(", ")
    : tr("draftRoom.caps.clubsOk", { max: c.maxClub });
  const clubsLabel = c.overClubs.length
    ? c.overClubs.map((x) => `${x.name} ${x.n}`).join(", ")
    : `≤${c.maxClub}`;

  return `<div class="top4-dr-caps" role="status" aria-live="polite">
      <span class="top4-dr-cap${c.mvOk ? "" : " is-bad"}" title="${esc(tr("draftRoom.caps.mvTip"))}">
        <span class="top4-dr-cap-k">MV</span>
        <span class="top4-dr-cap-v">${esc(eur(c.mv))} / ${esc(eur(c.mvCap))}</span>
      </span>
      <span class="top4-dr-cap${c.wageOk ? "" : " is-bad"}" title="${esc(tr("draftRoom.caps.wageTip"))}">
        <span class="top4-dr-cap-k">${esc(tr("draftRoom.caps.wage"))}</span>
        <span class="top4-dr-cap-v">${esc(wageSum(c.wage))} / ${esc(wageSum(c.wageCap))}</span>
      </span>
      <span class="top4-dr-cap${c.countOk ? "" : " is-bad"}" title="${esc(tr("draftRoom.caps.squadTip", { min: c.minSquad }))}">
        <span class="top4-dr-cap-k">${esc(tr("draftRoom.caps.squad"))}</span>
        <span class="top4-dr-cap-v">${c.count} / ${c.minSquad}</span>
      </span>
      <span class="top4-dr-cap top4-dr-cap-leagues${c.leaguesOk ? "" : " is-bad"}" title="${esc(tr("draftRoom.caps.leaguesTip", { min: c.minLeague }))}">
        <span class="top4-dr-cap-k">${esc(tr("draftRoom.caps.leagues"))}</span>
        <span class="top4-dr-cap-v top4-dr-cap-chips">${leaguesHtml}</span>
      </span>
      <span class="top4-dr-cap${c.clubsOk ? "" : " is-bad"}" title="${esc(clubsTitle)}">
        <span class="top4-dr-cap-k">${esc(tr("draftRoom.caps.clubs"))}</span>
        <span class="top4-dr-cap-v">${esc(clubsLabel)}</span>
      </span>
      <span class="top4-dr-cap${c.gkOk ? "" : " is-bad"}" title="${esc(tr("draftRoom.caps.gkTip", { min: c.minGk }))}">
        <span class="top4-dr-cap-k">GK</span>
        <span class="top4-dr-cap-v">${c.gk} / ${c.minGk}</span>
      </span>
    </div>`;
}

function drSurname(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/);
  return parts[parts.length - 1] || name;
}

function clearDraftRoomPick() {
  state.draftRoom.pick = null;
  state.draftRoom.selectedId = null;
}

/** Player ids already placed in XI / R1 / R2 for the current draft-room set. */
function drAssignedIdSet(draft) {
  const assignedIds = new Set();
  for (const s of draft?.slots || []) {
    if (s?.starter) assignedIds.add(String(s.starter));
    if (s?.replace1) assignedIds.add(String(s.replace1));
    if (s?.replace2) assignedIds.add(String(s.replace2));
  }
  return assignedIds;
}

/** True when player is in the live-draft squad (not merely placed on the pitch). */
function drIsReallyDrafted(p) {
  return p?.source === "squad" || p?.source === "both";
}

function assignDraftRoomPlayer(playerId, slotIndex, field, opts = {}) {
  const draft = state.draftRoom.draft;
  if (!draft?.slots?.[slotIndex]) return;
  const f = state.draftRoom.formations.find((x) => x.id === draft.formation);
  const roles = f?.slots?.[slotIndex]?.roles || [];
  const p = drPoolById().get(String(playerId));
  if (!p || !drPlayerMatchesSlot(p, roles)) return;
  if (!["starter", "replace1", "replace2"].includes(field)) return;

  // Move semantics when dragging from another option cell.
  if (opts.fromSlot != null && opts.fromField) {
    const src = draft.slots[opts.fromSlot];
    if (src && src[opts.fromField] === playerId) {
      src[opts.fromField] = null;
    }
  } else {
    // Pool assign: refuse players already used elsewhere in this set.
    const pid = String(playerId);
    const already = drAssignedIdSet(draft);
    const cur = draft.slots[slotIndex]?.[field];
    if (already.has(pid) && String(cur || "") !== pid) return;
  }

  draft.slots[slotIndex][field] = String(playerId);
  clearDraftRoomPick();
  renderDraftRoomEditor();
}

function clearDraftRoomOption(slotIndex, field) {
  const draft = state.draftRoom.draft;
  if (!draft?.slots?.[slotIndex]) return;
  if (!["starter", "replace1", "replace2"].includes(field)) return;
  draft.slots[slotIndex][field] = null;
  renderDraftRoomEditor();
}

function beginEditDraftRoomSet(set) {
  state.draftRoom.editingId = set.id;
  state.draftRoom.draft = {
    id: set.id,
    name: set.name || "",
    formation: set.formation,
    slots: (set.slots || []).map((s) => ({
      starter: s.starter || null,
      replace1: s.replace1 || null,
      replace2: s.replace2 || null,
    })),
  };
  clearDraftRoomPick();
  renderDraftRoom();
}

function ensureDraftSlotsForFormation(formationId) {
  const f = state.draftRoom.formations.find((x) => x.id === formationId);
  const n = f?.slots?.length || 11;
  const prev = state.draftRoom.draft?.slots || [];
  const slots = [];
  for (let i = 0; i < n; i++) {
    slots.push(
      prev[i]
        ? {
            starter: prev[i].starter || null,
            replace1: prev[i].replace1 || null,
            replace2: prev[i].replace2 || null,
          }
        : { starter: null, replace1: null, replace2: null },
    );
  }
  if (state.draftRoom.draft) {
    state.draftRoom.draft.formation = formationId;
    state.draftRoom.draft.slots = slots;
  }
  clearDraftRoomPick();
}

function drOptChipHtml(p, slotIndex, field, compact) {
  if (!p) return "";
  const textMode = state.draftRoom.viewMode === "list";
  const src = tr(`draftRoom.src.${p.source}`) || p.source;
  // Same red glow as pool: live-draft picks (squad/both), not wishlist-only.
  const assigned = drIsReallyDrafted(p) ? " is-assigned" : "";
  return `<button type="button" class="dr-chip${compact ? " is-compact" : ""}${assigned}${textMode ? " is-text" : ""}" draggable="true"
      data-dr-player="${esc(p.player_id)}" data-dr-from-slot="${slotIndex}" data-dr-from-field="${esc(field)}"
      title="${esc(`${p.name} · ${p.position_display || "?"} · ${p.club_name} (${src})`)}">
      ${
        textMode
          ? ""
          : drChipPhotoHtml(p)
      }
      <span class="dr-chip-body">
        <span class="dr-chip-name">${esc(drSurname(p.name))}</span>
        ${compact || textMode ? "" : `<span class="dr-chip-meta muted">${esc(p.position_display || "")}</span>`}
      </span>
    </button>`;
}

function drOptionCellHtml(slotIndex, field, playerId, byId, picking) {
  const p = playerId ? byId.get(String(playerId)) : null;
  const isStarter = field === "starter";
  const label =
    field === "starter"
      ? tr("draftRoom.starterShort")
      : field === "replace1"
        ? tr("draftRoom.r1Short")
        : tr("draftRoom.r2Short");
  const fieldCls =
    field === "starter" ? "is-starter" : field === "replace1" ? "is-r1" : "is-r2";
  const filled = p ? " is-filled" : "";
  const pickingCls = picking ? " is-picking" : "";
  return `<div class="dr-opt ${fieldCls}${filled}${pickingCls}"
      data-dr-slot="${slotIndex}" data-dr-field="${esc(field)}"
      title="${esc(label)}">
      <span class="dr-opt-label">${esc(label)}</span>
      ${
        p
          ? `${drOptChipHtml(p, slotIndex, field, !isStarter)}
             <button type="button" class="dr-opt-clear" data-dr-clear-slot="${slotIndex}" data-dr-clear-field="${esc(field)}"
               title="${esc(tr("draftRoom.clear"))}" aria-label="${esc(tr("draftRoom.clear"))}">×</button>`
          : `<span class="dr-opt-empty">${esc(label)}</span>`
      }
    </div>`;
}

function drPoolChipHtml(p, pickRoles, inFormation) {
  let pickCls = "";
  let title = "";
  let drag = 'draggable="true"';
  const alreadyInFormation = Boolean(inFormation);
  const reallyDrafted = drIsReallyDrafted(p);
  // Red glow for live-draft picks (squad/both), even when not yet on XI/R1/R2.
  if (reallyDrafted) pickCls += " is-assigned";
  if (alreadyInFormation) {
    // Block double-assign for anyone already on XI/R1/R2.
    pickCls += " is-in-formation";
    title = tr("draftRoom.alreadyAssigned");
    drag = "";
  } else if (pickRoles) {
    const eligible = drPlayerMatchesSlot(p, pickRoles);
    const ideal = eligible ? drIdealRoleForSlot(p, pickRoles) : null;
    if (eligible) {
      pickCls += ideal ? " is-eligible is-ideal" : " is-eligible";
      title = ideal
        ? tr("lineup.idealRole", { role: ideal })
        : tr("lineup.fitsSlot");
    } else {
      pickCls += " is-ineligible";
      title = tr("lineup.noFitSlot");
      drag = "";
    }
  }
  const textMode = state.draftRoom.viewMode === "list";
  const selected =
    !alreadyInFormation && state.draftRoom.selectedId === String(p.player_id)
      ? " is-selected"
      : "";
  const src = tr(`draftRoom.src.${p.source}`) || p.source;
  const blocked = alreadyInFormation || pickCls.includes("is-ineligible");
  return `<button type="button" class="dr-chip${pickCls}${selected}${textMode ? " is-text" : ""}" data-dr-player="${esc(p.player_id)}" data-dr-from="pool"
      ${title ? `title="${esc(title)}"` : ""} ${drag}
      ${blocked ? 'aria-disabled="true" tabindex="-1"' : ""}>
      ${
        textMode
          ? ""
          : drChipPhotoHtml(p)
      }
      <span class="dr-chip-body">
        <span class="dr-chip-name">${esc(drSurname(p.name))}</span>
        <span class="dr-chip-meta muted">${esc(p.position_display || "?")} · ${esc(p.club_name)}</span>
        <span class="dr-chip-src muted">${esc(src)}</span>
      </span>
    </button>`;
}

function drListSlotsHtml(f, draft, byId, pick) {
  return (f?.slots || [])
    .map((slotMeta, i) => {
      const s = draft.slots[i] || { starter: null, replace1: null, replace2: null };
      const label = slotMeta.label || (slotMeta.roles || []).join("/") || `#${i + 1}`;
      const anyPicking = pick?.slot === i ? " is-slot-picking" : "";
      return `<div class="top4-dr-list-row${anyPicking}" data-dr-slot-wrap="${i}">
          <span class="top4-dr-list-pos">${esc(label)}</span>
          <div class="top4-dr-list-opts">
            ${drOptionCellHtml(i, "starter", s.starter, byId, pick?.slot === i && pick?.field === "starter")}
            ${drOptionCellHtml(i, "replace1", s.replace1, byId, pick?.slot === i && pick?.field === "replace1")}
            ${drOptionCellHtml(i, "replace2", s.replace2, byId, pick?.slot === i && pick?.field === "replace2")}
          </div>
        </div>`;
    })
    .join("");
}

function renderDraftRoomEditor() {
  const editor = $("draft-room-editor");
  if (!editor) return;
  const draft = state.draftRoom.draft;
  if (!draft) {
    editor.hidden = true;
    editor.innerHTML = "";
    return;
  }
  editor.hidden = false;
  const formationOpts = state.draftRoom.formations
    .map((f) => {
      const sel = f.id === draft.formation ? " selected" : "";
      return `<option value="${esc(f.id)}"${sel}>${esc(f.label)}</option>`;
    })
    .join("");
  const f = state.draftRoom.formations.find((x) => x.id === draft.formation);
  const byId = drPoolById();
  const pick = state.draftRoom.pick;
  const pickRoles =
    pick != null && f ? f.slots[pick.slot]?.roles || [] : null;
  const pickLabel =
    pick != null && f
      ? `${f.slots[pick.slot]?.label || `#${pick.slot + 1}`} · ${
          pick.field === "starter"
            ? tr("draftRoom.starter")
            : pick.field === "replace1"
              ? tr("draftRoom.replace1")
              : tr("draftRoom.replace2")
        }`
      : null;

  const pitchSlots = (f?.slots || [])
    .map((slotMeta, i) => {
      const s = draft.slots[i] || { starter: null, replace1: null, replace2: null };
      const label = slotMeta.label || (slotMeta.roles || []).join("/") || `#${i + 1}`;
      const x = slotMeta.x ?? 50;
      const y = slotMeta.y ?? 50;
      const anyPicking =
        pick?.slot === i
          ? " is-slot-picking"
          : "";
      return `<div class="dr-slot${anyPicking}" data-dr-slot-wrap="${i}"
          style="left:${x}%; top:${100 - y}%">
          <span class="dr-slot-pos">${esc(label)}</span>
          ${drOptionCellHtml(i, "starter", s.starter, byId, pick?.slot === i && pick?.field === "starter")}
          ${drOptionCellHtml(i, "replace1", s.replace1, byId, pick?.slot === i && pick?.field === "replace1")}
          ${drOptionCellHtml(i, "replace2", s.replace2, byId, pick?.slot === i && pick?.field === "replace2")}
        </div>`;
    })
    .join("");

  const assignedIds = drAssignedIdSet(draft);
  // Hide anyone already on XI/R1/R2; ✕ clear re-renders and they return to Пул.
  // Red glow for squad/both stays on pitch chips (drOptChipHtml), not via pool listing.
  // Remaining order: drafted (squad/both) first, then wishlist-only; name secondary.
  const availablePool = state.draftRoom.pool
    .filter((p) => !assignedIds.has(String(p.player_id)))
    .sort((a, b) => {
      const aDrafted = drIsReallyDrafted(a) ? 0 : 1;
      const bDrafted = drIsReallyDrafted(b) ? 0 : 1;
      if (aDrafted !== bDrafted) return aDrafted - bDrafted;
      return String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
      });
    });
  const poolHtml = availablePool.length
    ? availablePool
        .map((p) => drPoolChipHtml(p, pickRoles, false))
        .join("")
    : `<p class="muted">${esc(tr("draftRoom.poolEmpty"))}</p>`;

  const isList = state.draftRoom.viewMode === "list";
  const viewToggle = `
      <div class="lu-view-toggle" role="group" aria-label="${esc(tr("lineup.viewAria"))}">
        <button type="button" class="lu-view-btn${isList ? " is-active" : ""}" data-dr-view-mode="list"
          aria-pressed="${isList ? "true" : "false"}">${esc(tr("lineup.viewList"))}</button>
        <button type="button" class="lu-view-btn${!isList ? " is-active" : ""}" data-dr-view-mode="pitch"
          aria-pressed="${!isList ? "true" : "false"}">${esc(tr("lineup.viewPitch"))}</button>
      </div>`;

  const mainPanel = isList
    ? `<section class="top4-dr-slots-panel" aria-label="${esc(tr("lineup.slotsAria"))}">
        <div class="top4-dr-list-rows">${drListSlotsHtml(f, draft, byId, pick)}</div>
        <p class="lu-hint muted">${
          pickLabel
            ? esc(tr("draftRoom.pickHint", { slot: pickLabel }))
            : esc(tr("lineup.hintList"))
        }</p>
      </section>`
    : `<section class="top4-dr-pitch-wrap" aria-label="${esc(tr("lineup.pitchAria"))}">
        <div class="lu-pitch top4-dr-pitch" id="draft-room-pitch">${pitchSlots}</div>
        <p class="lu-hint muted">${
          pickLabel
            ? esc(tr("draftRoom.pickHint", { slot: pickLabel }))
            : esc(tr("draftRoom.hintPitch"))
        }</p>
      </section>`;

  editor.innerHTML = `
    <div class="top4-dr-editor-head">
      <button type="button" class="auth-link" id="draft-room-back">${esc(tr("draftRoom.back"))}</button>
      ${viewToggle}
      <span class="muted" id="draft-room-save-status"></span>
    </div>
    ${draftRoomCapsHtml(draft)}
    <div class="top4-dr-fields">
      <label>
        <span>${esc(tr("draftRoom.name"))}</span>
        <input type="text" id="draft-room-name" maxlength="40" value="${esc(draft.name)}" placeholder="${esc(tr("draftRoom.namePh"))}" />
      </label>
      <label>
        <span>${esc(tr("draftRoom.formation"))}</span>
        <select id="draft-room-formation">${formationOpts}</select>
      </label>
    </div>
    <div class="top4-dr-layout${isList ? " is-list" : ""}">
      ${mainPanel}
      <aside class="top4-dr-pool${isList ? " is-list" : ""}" aria-label="${esc(tr("draftRoom.pool"))}">
        <h3 class="subhead">${
          pickLabel
            ? esc(tr("draftRoom.poolFor", { slot: pickLabel }))
            : esc(tr("draftRoom.pool"))
        }</h3>
        <div class="top4-dr-pool-list${pickRoles ? " is-picking" : ""}${isList ? " is-list" : ""}" id="draft-room-pool">${poolHtml}</div>
      </aside>
    </div>
    <div class="top4-dr-actions">
      <button type="button" class="auth-link" id="draft-room-save"${state.draftRoom.saving ? " disabled" : ""}>${esc(tr("draftRoom.save"))}</button>
      <button type="button" class="auth-link danger" id="draft-room-delete">${esc(tr("draftRoom.delete"))}</button>
    </div>`;
}

function renderDraftRoom() {
  const root = $("draft-room-root");
  if (!root) return;
  const meta = $("draft-room-meta");
  const list = $("draft-room-list");
  const newBtn = $("draft-room-new");
  const me = state.data?.me;
  wireDraftRoomOnce();

  if (!me?.user || !me.registered) {
    if (meta) meta.textContent = tr("draftRoom.login");
    if (list) list.innerHTML = "";
    if (newBtn) newBtn.disabled = true;
    const editor = $("draft-room-editor");
    if (editor) {
      editor.hidden = true;
      editor.innerHTML = "";
    }
    return;
  }

  const n = state.draftRoom.sets.length;
  const max = state.draftRoom.maxSets;
  if (meta) {
    meta.textContent =
      tr("draftRoom.limit", { n, max }) +
      " · " +
      tr("draftRoom.poolHint", {
        wl: state.draftRoom.wishlistCount,
        sq: state.draftRoom.squadCount,
        pool: state.draftRoom.pool.length,
      });
  }
  if (newBtn) newBtn.disabled = n >= max || state.draftRoom.editingId != null;

  if (state.draftRoom.editingId != null) {
    if (list) list.innerHTML = "";
    renderDraftRoomEditor();
    return;
  }

  const editor = $("draft-room-editor");
  if (editor) {
    editor.hidden = true;
    editor.innerHTML = "";
  }

  if (!list) return;
  if (!state.draftRoom.sets.length) {
    list.innerHTML = `<li class="muted">${esc(tr("draftRoom.empty"))}</li>`;
    return;
  }
  list.innerHTML = state.draftRoom.sets
    .map((set) => {
      const filled = (set.slots || []).filter((s) => s.starter).length;
      return `<li>
        <button type="button" class="top4-dr-set" data-edit-set="${set.id}">
          <strong>${esc(draftRoomSetLabel(set))}</strong>
          <span class="muted">${esc(draftRoomFormationLabel(set.formation))} · ${filled}/11</span>
        </button>
      </li>`;
    })
    .join("");
}

function wireDraftRoomOnce() {
  if (state.draftRoom.bound) return;
  state.draftRoom.bound = true;
  const root = $("draft-room-root");
  if (!root) return;

  root.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    if (t.closest("#draft-room-new")) {
      if (state.draftRoom.sets.length >= state.draftRoom.maxSets) return;
      try {
        state.draftRoom.saving = true;
        const res = await fetch("/api/top4/draft-room/sets", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ formation: "4-4-2", name: "" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        state.draftRoom.sets = data.sets || [];
        if (data.set) beginEditDraftRoomSet(data.set);
        else renderDraftRoom();
      } catch (err) {
        $("meta").textContent = String(err?.message || err);
      } finally {
        state.draftRoom.saving = false;
      }
      return;
    }

    const editBtn = t.closest("[data-edit-set]");
    if (editBtn) {
      const id = Number(editBtn.getAttribute("data-edit-set"));
      const set = state.draftRoom.sets.find((s) => s.id === id);
      if (set) beginEditDraftRoomSet(set);
      return;
    }

    if (t.closest("#draft-room-back")) {
      state.draftRoom.editingId = null;
      state.draftRoom.draft = null;
      clearDraftRoomPick();
      renderDraftRoom();
      return;
    }

    const viewBtn = t.closest("[data-dr-view-mode]");
    if (viewBtn) {
      const mode = viewBtn.getAttribute("data-dr-view-mode");
      if (mode !== "list" && mode !== "pitch") return;
      if (state.draftRoom.viewMode === mode) return;
      state.draftRoom.viewMode = mode;
      saveDraftRoomViewMode(mode);
      renderDraftRoomEditor();
      return;
    }

    if (t.closest("#draft-room-save")) {
      await saveDraftRoomSet();
      return;
    }

    if (t.closest("#draft-room-delete")) {
      await deleteDraftRoomSetUi();
      return;
    }

    const clearBtn = t.closest("[data-dr-clear-slot]");
    if (clearBtn) {
      e.stopPropagation();
      const si = Number(clearBtn.getAttribute("data-dr-clear-slot"));
      const field = clearBtn.getAttribute("data-dr-clear-field");
      if (Number.isInteger(si) && field) clearDraftRoomOption(si, field);
      return;
    }

    const poolChip = t.closest(".dr-chip[data-dr-from='pool']");
    if (poolChip) {
      // is-assigned = red glow for live-draft picks; still assignable to formation.
      // Only block when already on XI/R1/R2 or ineligible for the active slot.
      if (
        poolChip.classList.contains("is-ineligible") ||
        poolChip.classList.contains("is-in-formation")
      ) {
        return;
      }
      const pid = poolChip.getAttribute("data-dr-player");
      if (!pid) return;
      const pick = state.draftRoom.pick;
      if (pick) {
        assignDraftRoomPlayer(pid, pick.slot, pick.field);
        return;
      }
      state.draftRoom.selectedId =
        state.draftRoom.selectedId === pid ? null : pid;
      renderDraftRoomEditor();
      return;
    }

    const opt = t.closest(".dr-opt[data-dr-slot]");
    if (opt) {
      const si = Number(opt.getAttribute("data-dr-slot"));
      const field = opt.getAttribute("data-dr-field");
      if (!Number.isInteger(si) || !field) return;
      if (state.draftRoom.selectedId) {
        assignDraftRoomPlayer(state.draftRoom.selectedId, si, field);
        return;
      }
      const cur = state.draftRoom.pick;
      if (cur && cur.slot === si && cur.field === field) {
        clearDraftRoomPick();
      } else {
        state.draftRoom.pick = { slot: si, field };
        state.draftRoom.selectedId = null;
      }
      renderDraftRoomEditor();
    }
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement || t instanceof HTMLInputElement)) return;
    if (!state.draftRoom.draft) return;

    if (t.id === "draft-room-name") {
      state.draftRoom.draft.name = t.value;
      return;
    }
    if (t.id === "draft-room-formation") {
      ensureDraftSlotsForFormation(t.value);
      renderDraftRoomEditor();
    }
  });

  root.addEventListener("dragstart", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const chip = el?.closest?.(".dr-chip[data-dr-player]");
    if (
      !chip ||
      chip.classList.contains("is-ineligible") ||
      chip.classList.contains("is-in-formation")
    ) {
      e.preventDefault?.();
      return;
    }
    const pid = chip.getAttribute("data-dr-player");
    if (!pid) return;
    const fromSlot = chip.getAttribute("data-dr-from-slot");
    const fromField = chip.getAttribute("data-dr-from-field");
    state.draftRoom.dragFrom = {
      playerId: pid,
      slot: fromSlot != null && fromSlot !== "" ? Number(fromSlot) : undefined,
      field: fromField || undefined,
    };
    try {
      e.dataTransfer.setData("text/plain", pid);
      e.dataTransfer.effectAllowed = "move";
    } catch {
      /* ignore */
    }
    chip.classList.add("is-dragging");
  });

  root.addEventListener("dragend", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    el?.closest?.(".dr-chip")?.classList.remove("is-dragging");
    state.draftRoom.dragFrom = null;
    root.querySelectorAll(".dr-opt.is-drop").forEach((node) => node.classList.remove("is-drop"));
  });

  root.addEventListener("dragover", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const opt = el?.closest?.(".dr-opt[data-dr-slot]");
    if (!opt || !state.draftRoom.draft) return;
    const pid = state.draftRoom.dragFrom?.playerId;
    if (!pid) return;
    const si = Number(opt.getAttribute("data-dr-slot"));
    const f = state.draftRoom.formations.find(
      (x) => x.id === state.draftRoom.draft.formation,
    );
    const p = drPoolById().get(String(pid));
    if (!p || !drPlayerMatchesSlot(p, f?.slots?.[si]?.roles || [])) return;
    e.preventDefault();
    opt.classList.add("is-drop");
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      /* ignore */
    }
  });

  root.addEventListener("dragleave", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const opt = el?.closest?.(".dr-opt[data-dr-slot]");
    if (!opt) return;
    const related = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    if (related && opt.contains(related)) return;
    opt.classList.remove("is-drop");
  });

  root.addEventListener("drop", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const opt = el?.closest?.(".dr-opt[data-dr-slot]");
    if (!opt) return;
    e.preventDefault();
    opt.classList.remove("is-drop");
    const si = Number(opt.getAttribute("data-dr-slot"));
    const field = opt.getAttribute("data-dr-field");
    const pid =
      (e.dataTransfer && e.dataTransfer.getData("text/plain")) ||
      state.draftRoom.dragFrom?.playerId;
    if (!pid || !field || !Number.isInteger(si)) return;
    const from = state.draftRoom.dragFrom;
    assignDraftRoomPlayer(pid, si, field, {
      fromSlot: from?.slot,
      fromField: from?.field,
    });
  });
}

async function saveDraftRoomSet() {
  const draft = state.draftRoom.draft;
  if (!draft?.id) return;
  state.draftRoom.saving = true;
  renderDraftRoomEditor();
  try {
    const res = await fetch(`/api/top4/draft-room/sets/${draft.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        formation: draft.formation,
        slots: draft.slots,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.draftRoom.sets = data.sets || [];
    if (data.set) beginEditDraftRoomSet(data.set);
    state.draftRoom.saving = false;
    renderDraftRoomEditor();
    const status = $("draft-room-save-status");
    if (status) status.textContent = tr("draftRoom.saved");
  } catch (err) {
    state.draftRoom.saving = false;
    renderDraftRoomEditor();
    $("meta").textContent = String(err?.message || err);
  }
}

async function deleteDraftRoomSetUi() {
  const draft = state.draftRoom.draft;
  if (!draft?.id) return;
  if (!confirm(tr("draftRoom.confirmDelete"))) return;
  try {
    const res = await fetch(`/api/top4/draft-room/sets/${draft.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.draftRoom.sets = data.sets || [];
    state.draftRoom.editingId = null;
    state.draftRoom.draft = null;
    clearDraftRoomPick();
    renderDraftRoom();
  } catch (err) {
    $("meta").textContent = String(err?.message || err);
  }
}

load().then(() => {
  wireTabs();
  wireReplaceAutoModal();
  wireFptsBreakdownOnce();
});

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
