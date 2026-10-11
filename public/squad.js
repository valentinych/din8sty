/** Manager squad FPTS by played GW. */
(function () {
  const $ = (id) => document.getElementById(id);
  const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

  const state = {
    data: null,
    sortKey: "brought",
    sortDir: -1,
    breakdown: null,
  };

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function fmtPts(n) {
    if (n == null || !Number.isFinite(Number(n))) return "·";
    return Number(n).toFixed(2);
  }

  function fmtNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 100) / 100).replace(/\.0$/, "");
  }

  function signedPts(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v === 0) return fmtNum(v || 0);
    const s = fmtNum(Math.abs(v));
    return v < 0 ? `−${s}` : `+${s}`;
  }

  function teamQuery() {
    try {
      return new URLSearchParams(location.search).get("team");
    } catch {
      return null;
    }
  }

  function cmp(a, b, dir) {
    if (a < b) return -1 * dir;
    if (a > b) return 1 * dir;
    return 0;
  }

  function sortPlayers(players, gws) {
    const key = state.sortKey;
    const dir = state.sortDir;
    const list = players.slice();
    list.sort((a, b) => {
      if (key === "name") {
        return (
          cmp(String(a.name || ""), String(b.name || ""), dir) ||
          cmp(String(a.id), String(b.id), 1)
        );
      }
      if (key === "brought" || key === "scored") {
        const av = Number(a[key]) || 0;
        const bv = Number(b[key]) || 0;
        return cmp(av, bv, dir) || cmp(String(a.name || ""), String(b.name || ""), 1);
      }
      const gw = Number(key);
      if (Number.isFinite(gw) && gws.includes(gw)) {
        const av = Number(a.byGw?.[String(gw)]?.fpts) || 0;
        const bv = Number(b.byGw?.[String(gw)]?.fpts) || 0;
        return cmp(av, bv, dir) || cmp(String(a.name || ""), String(b.name || ""), 1);
      }
      return 0;
    });
    return list;
  }

  function thHtml(key, label, extraClass, title) {
    const active = state.sortKey === String(key);
    const arrow = active ? (state.sortDir < 0 ? " ↓" : " ↑") : "";
    const cls = `sortable${active ? " sorted" : ""}${extraClass ? ` ${extraClass}` : ""}`;
    const tip = title ? ` title="${esc(title)}"` : "";
    return `<th class="${cls}" data-squad-sort="${esc(String(key))}"${tip}>${esc(label)}${arrow}</th>`;
  }

  let fptsBdInertEls = [];
  let fptsBdPrevFocus = null;
  let fptsBdOnKey = null;

  function fptsLineLabel(line) {
    const key = `league.liveStand.ev.${line.key}`;
    let label = tr(key);
    if (label === key) label = String(line.key || "");
    const count = Number(line.count);
    const alwaysCount = line.key === "saves" || line.key === "conceded";
    if (Number.isFinite(count) && count > 0 && (alwaysCount || count > 1)) {
      label += ` ×${fmtNum(count)}`;
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
    <span class="fpts-bd-pts mono">${esc(signedPts(line.pts))}</span>
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
      const st = fptsBdStatusLabel(match.status);
      html += `<p class="fpts-bd-score">${esc(fptsBdMatchScore(match))}${st ? ` · ${esc(st)}` : ""}</p>`;
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
              ? `<li class="fpts-bd-line fpts-bd-mul"><span class="fpts-bd-label">×${esc(fmtNum(part.multiplier))}\u00a0${esc(part.comp || "COMP")}</span></li>`
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
    if (totalEl) totalEl.textContent = fmtPts(p?.total ?? 0);
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
    state.breakdown = null;
    if (wasOpen && prev && typeof prev.focus === "function") {
      try {
        prev.focus();
      } catch (_) {}
    }
  }

  function findBreakdown(playerId, gw) {
    const p = (state.data?.players || []).find(
      (pl) => String(pl.id) === String(playerId),
    );
    if (!p) return null;
    const cell = p.byGw?.[String(gw)];
    if (!cell) return null;
    return {
      name: p.name,
      club_crest: p.club_crest,
      club_name: p.club_name,
      role_bonus: cell.role_bonus,
      parts: cell.parts,
      total: cell.fpts,
    };
  }

  function openFptsBreakdown(playerId, gw, opener) {
    const p = findBreakdown(playerId, gw);
    if (!p) return;
    const overlay = $("fpts-breakdown-overlay");
    if (!overlay) return;
    state.breakdown = { playerId: String(playerId), gw: String(gw) };
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
    fptsBdOnKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFptsBreakdown();
      }
    };
    document.addEventListener("keydown", fptsBdOnKey);
    $("fpts-bd-close")?.focus();
  }

  function wireFptsBreakdownOnce() {
    const overlay = $("fpts-breakdown-overlay");
    const closeBtn = $("fpts-bd-close");
    if (!overlay || overlay.dataset.wired === "1") return;
    overlay.dataset.wired = "1";
    closeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFptsBreakdown();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeFptsBreakdown();
    });
  }

  function playerCellHtml(p) {
    const crest = p.club_crest
      ? `<img class="top4-squad-crest" src="${esc(p.club_crest)}" alt="" width="18" height="18" loading="lazy" />`
      : "";
    const pos = p.position
      ? `<span class="muted squad-pos">${esc(p.position)}</span>`
      : "";
    return `<span class="squad-player">
      ${crest}
      <a class="player-link" href="/player.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a>
      ${pos}
    </span>`;
  }

  function gwCellTitle(cell) {
    const bits = [];
    if (cell.xi) bits.push(tr("squad.xiHint"));
    const matches = (cell.parts || []).filter((part) => part.match);
    if (matches.length > 1) {
      bits.push(
        matches
          .map((part) => `${fptsBdMatchScore(part.match)} ${fmtPts(part.pts)}`)
          .join("; "),
      );
    }
    return bits.length ? ` title="${esc(bits.join(" · "))}"` : "";
  }

  function gwCellHtml(p, gw) {
    const cell = p.byGw?.[String(gw)];
    if (!cell) return `<td class="squad-num muted">·</td>`;
    const xiCls = cell.xi ? " is-xi" : "";
    return `<td class="squad-num${xiCls}">
      <button type="button" class="top4-live-fpts-btn squad-fpts-btn mono" data-squad-fpts data-player="${esc(p.id)}" data-gw="${esc(String(gw))}" aria-label="${esc(tr("league.liveStand.breakdownAria"))}"${gwCellTitle(cell)}>${esc(fmtPts(cell.fpts))}</button>
    </td>`;
  }

  function render() {
    const data = state.data;
    const app = $("app");
    const meta = $("meta");
    if (!app || !data) return;
    wireFptsBreakdownOnce();

    const gws = (data.gws || []).map(Number).filter((g) => Number.isFinite(g));
    const players = sortPlayers(data.players || [], gws);
    const teams = data.teams || [];
    const teamOpts = teams
      .map((t) => {
        const sel = Number(t.id) === Number(data.team?.id) ? " selected" : "";
        return `<option value="${esc(String(t.id))}"${sel}>${esc(t.name)}</option>`;
      })
      .join("");
    const teamPicker =
      teams.length > 1
        ? `<label class="gw-select">${tr("squad.team")}
            <select id="squad-team">${teamOpts}</select>
          </label>`
        : "";
    const logo = data.team?.logo_url
      ? `<img class="top4-team-logo" src="${esc(data.team.logo_url)}" alt="" width="32" height="32" />`
      : "";
    const code = data.team?.code
      ? `<span class="squad-team-code">${esc(data.team.code)}</span>`
      : "";

    if (meta) {
      meta.textContent = tr("squad.lead", {
        n: players.length,
        gws: gws.length,
      });
    }

    const thead = `<tr>${thHtml("name", tr("squad.player"), "squad-player-th")}${gws
      .map((g) => thHtml(String(g), `GW${g}`, "squad-num"))
      .join("")}${thHtml("brought", tr("squad.brought"), "squad-num squad-total", tr("squad.broughtTip"))}${thHtml("scored", tr("squad.scored"), "squad-num squad-total", tr("squad.scoredTip"))}</tr>`;

    const body =
      players.length === 0
        ? `<tr><td colspan="${3 + gws.length}" class="muted">${esc(tr("squad.emptyRoster"))}</td></tr>`
        : players
            .map(
              (p) => `<tr>
        <td class="squad-player-td">${playerCellHtml(p)}</td>
        ${gws.map((g) => gwCellHtml(p, g)).join("")}
        <td class="squad-num squad-total mono">${esc(fmtPts(p.brought))}</td>
        <td class="squad-num squad-total mono">${esc(fmtPts(p.scored))}</td>
      </tr>`,
            )
            .join("");

    const emptyGws =
      gws.length === 0
        ? `<p class="muted squad-empty">${esc(tr("squad.empty"))}</p>`
        : "";

    app.hidden = false;
    app.innerHTML = `
      <div class="squad-toolbar">
        <div class="squad-team-name">${logo}<span>${esc(data.team?.name || "")}</span>${code}</div>
        ${teamPicker}
      </div>
      ${emptyGws}
      <div class="table-wrap squad-table-wrap">
        <table class="squad-table compact-table">
          <thead>${thead}</thead>
          <tbody id="squad-rows">${body}</tbody>
        </table>
      </div>`;

    app.querySelectorAll("[data-squad-sort]").forEach((el) => {
      el.addEventListener("click", () => {
        const k = el.getAttribute("data-squad-sort");
        if (!k) return;
        if (state.sortKey === k) state.sortDir *= -1;
        else {
          state.sortKey = k;
          state.sortDir = k === "name" ? 1 : -1;
        }
        render();
      });
    });
    $("squad-team")?.addEventListener("change", (e) => {
      const id = e.target.value;
      const u = new URL(location.href);
      u.searchParams.set("team", id);
      location.assign(u.pathname + u.search);
    });
    $("squad-rows")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-squad-fpts]");
      if (!btn) return;
      e.preventDefault();
      openFptsBreakdown(
        btn.getAttribute("data-player"),
        btn.getAttribute("data-gw"),
        btn,
      );
    });
  }

  async function load() {
    const meta = $("meta");
    const params = new URLSearchParams();
    const teamQ = teamQuery();
    if (teamQ) params.set("team_id", teamQ);
    const qs = params.toString();
    const res = await fetch(`/api/top4/my-squad${qs ? `?${qs}` : ""}`, {
      credentials: "same-origin",
    });
    if (res.status === 401) {
      if (meta) {
        meta.innerHTML = tr("squad.login", {
          href: "/api/auth/login?next=" + encodeURIComponent("/squad.html"),
        });
      }
      $("app").hidden = true;
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (meta) meta.textContent = data.message || data.error || tr("common.errorLoad");
      $("app").hidden = true;
      return;
    }
    state.data = data;
    render();
  }

  function boot() {
    load().catch((err) => {
      const meta = $("meta");
      if (meta) meta.textContent = tr("squad.error", { err: err.message || err });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  document.addEventListener("din8sty:lang", () => {
    if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
    if (state.data) render();
    if (state.breakdown) {
      const p = findBreakdown(state.breakdown.playerId, state.breakdown.gw);
      if (p) fillFptsBreakdown(p);
    }
  });
})();
