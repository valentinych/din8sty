const $ = (id) => document.getElementById(id);

const HIDE_PICKED_KEY = "din8sty.index.hidePicked";
const HIDE_NON_TOP4_KEY = "din8sty.index.hideNonTop4";

function loadBool(key, fallback = false) {
  try {
    const v = localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function saveBool(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const state = {
  league: "",
  club: "",
  line: "",
  pos: "",
  sort: "value-desc",
  q: "",
  hidePicked: loadBool(HIDE_PICKED_KEY),
  hideNonTop4: loadBool(HIDE_NON_TOP4_KEY),
  clubs: [],
};

function eur(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(v >= 100_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}K`;
  return `€${v}`;
}

function ratingBadge(n) {
  if (n == null) return `<span class="badge">—</span>`;
  const cls = n >= 80 ? "hi" : n >= 70 ? "mid" : "";
  return `<span class="badge ${cls}">${n}</span>`;
}

function tr(key, vars) {
  return typeof globalThis.t === "function" ? globalThis.t(key, vars) : key;
}

function isAdminUser() {
  return Boolean(window.__din8styAuth?.isAdmin);
}

function formatRefreshAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  if (!parts.day || !parts.month || !parts.hour || !parts.minute) return "";
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`;
}

function availBadgeHtml(avail) {
  if (!avail) return "";
  const title =
    avail.kind === "suspension"
      ? tr("lineup.suspended", { reason: avail.reason || "DSQ" })
      : tr("lineup.injured", { reason: avail.reason || "" });
  return avail.kind === "suspension"
    ? `<span class="lu-avail is-dsq" title="${escapeHtml(title)}">DSQ</span>`
    : `<span class="lu-avail is-inj" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">+</span>`;
}

function renderRefreshedAt(iso) {
  const el = $("index-refreshed");
  if (!el) return;
  if (!iso) {
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  const when = formatRefreshAt(iso);
  if (!when) {
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  el.title = when;
  el.textContent = tr("index.refreshedAt", { when });
}

function syncRefreshButton() {
  const btn = $("index-refresh");
  if (btn) btn.hidden = !isAdminUser();
}

async function loadStats() {
  const res = await fetch("/api/stats");
  const data = await res.json();
  const totals = data.totals || {};
  const tr = typeof globalThis.t === "function" ? globalThis.t : (k) => k;
  $("stats").innerHTML = `
    <div><dt>${tr("common.players")}</dt><dd>${totals.players ?? 0}</dd></div>
    <div><dt>${tr("common.clubs")}</dt><dd>${totals.clubs ?? 0}</dd></div>
    <div><dt>FM match</dt><dd>${totals.fm_matched ?? 0}</dd></div>
    <div><dt>Capology match</dt><dd>${totals.capology_wage ?? 0}</dd></div>
  `;
}

async function loadLeagues() {
  const res = await fetch("/api/leagues");
  const data = await res.json();
  const sel = $("league");
  for (const l of data.leagues) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = `${l.name} (${l.players ?? 0})`;
    sel.appendChild(opt);
  }
}

async function loadPositions() {
  const res = await fetch("/api/positions");
  const data = await res.json();
  const sel = $("pos");
  const prev = state.pos;
  sel.innerHTML = `<option value="">${typeof globalThis.t === "function" ? globalThis.t("common.all") : "Все"}</option>`;
  for (const role of data.roles || []) {
    const opt = document.createElement("option");
    opt.value = role;
    opt.textContent = role;
    sel.appendChild(opt);
  }
  if (prev && (data.roles || []).includes(prev)) {
    sel.value = prev;
  } else {
    state.pos = "";
    sel.value = "";
  }
}

async function loadClubs() {
  const url = state.league ? `/api/clubs?league=${encodeURIComponent(state.league)}` : "/api/clubs";
  const res = await fetch(url);
  const data = await res.json();
  state.clubs = data.clubs || [];
  const sel = $("club");
  const prev = state.club;
  sel.innerHTML = `<option value="">${typeof globalThis.t === "function" ? globalThis.t("common.allClubs") : "Все клубы"}</option>`;
  for (const c of state.clubs) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if (prev && state.clubs.some((c) => c.id === prev)) {
    sel.value = prev;
  } else {
    state.club = "";
    sel.value = "";
  }
}

async function loadPlayers() {
  const params = new URLSearchParams();
  if (state.league) params.set("league", state.league);
  if (state.club) params.set("club", state.club);
  if (state.line) params.set("line", state.line);
  if (state.pos) params.set("pos", state.pos);
  if (state.sort) params.set("sort", state.sort);
  if (state.q) params.set("q", state.q);
  if (state.hidePicked) params.set("hide_picked", "1");
  if (state.hideNonTop4) params.set("hide_non_top4", "1");
  params.set("limit", "5000");

  const res = await fetch(`/api/players?${params}`);
  const data = await res.json();
  $("meta").textContent =
    typeof globalThis.t === "function"
      ? globalThis.t("index.shown", { n: data.players.length, total: data.total })
      : `Показано ${data.players.length} из ${data.total}`;
  renderRefreshedAt(data.availability_synced_at);
  syncRefreshButton();

  const fpSorted = state.sort === "fp-desc" || state.sort === "fp-asc";
  const fpTh = document.querySelector("th[data-sort='fp']");
  if (fpTh) {
    fpTh.classList.toggle("sorted", fpSorted);
    const label =
      typeof globalThis.t === "function" ? globalThis.t("index.fpCol") : "FP";
    const arrow = fpSorted ? (state.sort === "fp-asc" ? " ↑" : " ↓") : "";
    fpTh.textContent = `${label}${arrow}`;
  }

  const body = $("rows");
  body.innerHTML = data.players
    .map((p) => {
      const href = `/player.html?id=${encodeURIComponent(p.id)}`;
      const photo = p.portrait_url
        ? `<a class="photo-link" href="${href}"><img src="${p.portrait_url}" alt="" loading="lazy" /></a>`
        : `<a class="photo-link" href="${href}"><span class="crest"></span></a>`;
      const fpNum = Number(p.fp);
      const fpText = Number.isFinite(fpNum) ? fpNum.toFixed(2) : "0.00";
      return `<tr>
        <td>${photo}</td>
        <td>
          <a class="player-link" href="${href}">
            <div class="player">
              <div>
                <div class="index-name">
                  <div class="name">${escapeHtml(p.name)}</div>
                  ${availBadgeHtml(p.availability)}
                </div>
                <div class="sub">${escapeHtml(p.nationality || "")}</div>
              </div>
            </div>
          </a>
        </td>
        <td>
          <div class="player">
            ${p.club_crest ? `<img class="crest" src="${p.club_crest}" alt="" loading="lazy" />` : ""}
            <span>${escapeHtml(p.club_name || "")}</span>
          </div>
        </td>
        <td class="mono"${p.draft_team_name ? ` title="${escapeHtml(p.draft_team_name)}"` : ""}>${
          p.draft_team_code ? escapeHtml(p.draft_team_code) : "·"
        }</td>
        <td class="mono">${escapeHtml(fpText)}</td>
        <td>${escapeHtml(p.league_name || p.league_id || "")}</td>
        <td>${escapeHtml(p.position_display || p.position || "—")}</td>
        <td>${p.age ?? "—"}</td>
        <td class="money">${eur(p.market_value_eur)}</td>
        <td>${ratingBadge(p.fm_rating)}</td>
        <td>${ratingBadge(p.fm_potential)}</td>
        <td class="money" title="${escapeHtml(p.trusted_wage_source || "")}">${eur(p.trusted_wage_pw)}</td>
        <td class="money">${p.fm_wage_display || eur(p.fm_wage_pw)}</td>
        <td class="money">${p.capology_wage_display || eur(p.capology_wage_pw)}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let timer = null;
function bind() {
  $("league").addEventListener("change", async (e) => {
    state.league = e.target.value;
    await loadClubs();
    await loadPlayers();
  });
  $("club").addEventListener("change", (e) => {
    state.club = e.target.value;
    loadPlayers();
  });
  $("line").addEventListener("change", (e) => {
    state.line = e.target.value;
    loadPlayers();
  });
  $("pos").addEventListener("change", (e) => {
    state.pos = e.target.value;
    loadPlayers();
  });
  $("sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    loadPlayers();
  });
  $("hide-picked").addEventListener("change", (e) => {
    state.hidePicked = Boolean(e.target.checked);
    saveBool(HIDE_PICKED_KEY, state.hidePicked);
    loadPlayers();
  });
  $("hide-non-top4").addEventListener("change", (e) => {
    state.hideNonTop4 = Boolean(e.target.checked);
    saveBool(HIDE_NON_TOP4_KEY, state.hideNonTop4);
    loadPlayers();
  });
  document.querySelector("th[data-sort='fp']")?.addEventListener("click", () => {
    state.sort = state.sort === "fp-desc" ? "fp-asc" : "fp-desc";
    const sel = $("sort");
    if (sel) sel.value = state.sort;
    loadPlayers();
  });
  $("q").addEventListener("input", (e) => {
    state.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(loadPlayers, 200);
  });
  $("index-refresh")?.addEventListener("click", refreshAvailability);
  document.addEventListener("din8sty:auth", () => {
    syncRefreshButton();
  });
}

async function refreshAvailability() {
  if (!isAdminUser()) return;
  const btn = $("index-refresh");
  if (btn) {
    btn.disabled = true;
    btn.textContent = tr("index.refreshing");
  }
  try {
    const res = await fetch("/api/availability/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("meta").textContent = data.message || data.error || tr("index.refreshErr");
      return;
    }
    if (data.lastUpdated) renderRefreshedAt(data.lastUpdated);
    await loadPlayers();
  } catch (err) {
    $("meta").textContent = String(err);
  } finally {
    const again = $("index-refresh");
    if (again) {
      again.disabled = false;
      again.textContent = tr("index.refresh");
      again.hidden = !isAdminUser();
    }
  }
}

async function init() {
  const hidePicked = $("hide-picked");
  const hideNonTop4 = $("hide-non-top4");
  if (hidePicked) hidePicked.checked = state.hidePicked;
  if (hideNonTop4) hideNonTop4.checked = state.hideNonTop4;
  bind();
  syncRefreshButton();
  await Promise.all([loadStats(), loadLeagues(), loadClubs(), loadPositions()]);
  await loadPlayers();
  document.addEventListener("din8sty:lang", async () => {
    if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
    syncRefreshButton();
    await loadStats();
    await loadClubs();
    await loadPositions();
    await loadPlayers();
  });
}

init().catch((err) => {
  console.error(err);
  $("meta").textContent = String(err);
});
