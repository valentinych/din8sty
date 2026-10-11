const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

const statusEl = document.getElementById("status");
const pageEl = document.getElementById("player-page");

function eur(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(v >= 100_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}K`;
  return `€${v}`;
}

function height(h) {
  if (h == null) return "—";
  const n = Number(h);
  if (!Number.isFinite(n)) return "—";
  return n > 3 ? `${Math.round(n)} cm` : `${n.toFixed(2)} m`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
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
  return `${date}, ${time}`;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ratingBadge(n) {
  if (n == null) return `<span class="badge">—</span>`;
  const cls = n >= 80 ? "hi" : n >= 70 ? "mid" : "";
  return `<span class="badge ${cls}">${n}</span>`;
}

function dl(items) {
  return `<dl class="facts">${items
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v ?? "—"}</dd></div>`)
    .join("")}</dl>`;
}

function linkOrDash(url, label) {
  if (!url) return "—";
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label || url)}</a>`;
}

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
  return `<div class="player">
    ${crest ? `<img class="crest" src="${esc(crest)}" alt="" loading="lazy" />` : `<span class="crest"></span>`}
    <span>${esc(label)}</span>
  </div>`;
}

/** Compact H/A · crest · opponent for the focus club's fixtures. */
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
    // Mapping miss — fall back to home vs away labels without duplicating focus.
    ha = "?";
    name = `${f.home_club_name || f.home_name || "—"} — ${f.away_club_name || f.away_name || "—"}`;
    crest = null;
    clubName = null;
    clubCode = null;
  }
  const label = clubName || name || "—";
  const code = clubCode || label;
  return `<div class="opponent-cell">
    <span class="ha" title="${ha === "H" ? tr("common.home") : ha === "A" ? tr("common.away") : ""}">${esc(ha)}</span>
    <span class="ha-sep" aria-hidden="true">·</span>
    ${crest ? `<img class="crest" src="${esc(crest)}" alt="" loading="lazy" />` : `<span class="crest"></span>`}
    <span class="opp-name">${esc(label)}</span>
    <span class="opp-code" title="${esc(label)}">${esc(code)}</span>
  </div>`;
}

/** Score when known; otherwise status only (skip empty — for NS). */
function resultCell(f) {
  const status = f.status || "—";
  const hasScore = f.home_goals != null && f.away_goals != null;
  if (hasScore) {
    return `<span class="result-cell">${scoreCell(f)} <span class="badge">${esc(status)}</span></span>`;
  }
  return `<span class="badge">${esc(status)}</span>`;
}

function renderTransfers(transfers) {
  if (!transfers?.length) {
    return `<section class="panel wide">
      <h2>${tr("player.clubHistory")}</h2>
      <p class="hint">${tr("player.noTransfers")}</p>
    </section>`;
  }

  const rows = transfers
    .map((t) => {
      const from = t.from_club_name
        ? `${t.from_club_crest ? `<img class="crest" src="${esc(t.from_club_crest)}" alt="" loading="lazy" />` : ""}<span>${esc(t.from_club_name)}</span>`
        : "—";
      const to = t.to_club_name
        ? `${t.to_club_crest ? `<img class="crest" src="${esc(t.to_club_crest)}" alt="" loading="lazy" />` : ""}<span>${esc(t.to_club_name)}</span>`
        : "—";
      return `<tr>
        <td>${esc(t.season || "—")}</td>
        <td>${fmtDate(t.date)}</td>
        <td><div class="player">${from}</div></td>
        <td><div class="player">${to}</div></td>
        <td>${esc(t.market_value || "—")}</td>
        <td>${esc(t.fee || "—")}${t.upcoming ? ' <span class="badge">upcoming</span>' : ""}</td>
      </tr>`;
    })
    .join("");

  return `<section class="panel wide">
    <h2>${tr("player.clubHistoryN", { n: transfers.length })}</h2>
    <div class="table-wrap nested">
      <table class="fixtures-table">
        <thead>
          <tr>
            <th>${tr("player.season")}</th>
            <th>${tr("common.date")}</th>
            <th>${tr("player.from")}</th>
            <th>${tr("player.to")}</th>
            <th>MV</th>
            <th>${tr("player.fee")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderCoaches(coaches) {
  if (!coaches?.length) {
    return `<section class="panel wide">
      <h2>${tr("player.coaches")}</h2>
      <p class="hint">${tr("player.noCoaches")}</p>
    </section>`;
  }

  const rows = coaches
    .map((c) => {
      const name = c.trainer_name || c.trainer_id || "—";
      const tmHref = c.trainer_id
        ? `https://www.transfermarkt.com/x/profil/trainer/${esc(c.trainer_id)}`
        : "";
      const nameCell = tmHref
        ? `<a href="${tmHref}" target="_blank" rel="noopener">${esc(name)}</a>`
        : esc(name);
      return `<tr>
        <td>${nameCell}</td>
        <td>${esc(c.apps ?? "—")}</td>
        <td>${fmtDate(c.first_date)}</td>
        <td>${fmtDate(c.last_date)}</td>
      </tr>`;
    })
    .join("");

  return `<section class="panel wide">
    <h2>${tr("player.coachesN", { n: coaches.length })}</h2>
    <div class="table-wrap nested">
      <table class="fixtures-table">
        <thead>
          <tr>
            <th>${tr("player.coach")}</th>
            <th>${tr("player.apps")}</th>
            <th>${tr("player.firstGame")}</th>
            <th>${tr("player.lastGame")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderClubFixtures(p, fixtures) {
  const clubId = p.club_id;
  const clubName = p.club_name || tr("player.clubFallback");
  const scheduleLink = clubId
    ? `<p class="hint"><a href="/schedule.html?club=${esc(clubId)}">${tr("player.allFixtures", { club: esc(clubName) })}</a></p>`
    : "";

  if (!clubId) {
    return `<section class="panel wide">
      <h2>${tr("player.clubSchedule")}</h2>
      <p class="hint">${tr("player.noClub")}</p>
    </section>`;
  }

  if (!fixtures.length) {
    return `<section class="panel wide">
      <h2>${tr("player.clubSchedule")}</h2>
      ${scheduleLink}
      <p class="hint">${tr("player.noFixtures", { club: esc(clubName) })}</p>
    </section>`;
  }

  // Keep the player page short — full list lives on /schedule.html.
  const PREVIEW = 8;
  const preview = fixtures.slice(0, PREVIEW);
  const more = fixtures.length - preview.length;

  const rows = preview
    .map((f) => {
      const round = (f.round || "").replace(/^Regular Season - /, tr("common.round"));
      const gw =
        f.gameweek != null
          ? `<span class="badge">GW${esc(f.gameweek)}</span>`
          : `<span class="sub">—</span>`;
      const competition = f.competition_name || f.league_name || f.league_id || "";
      return `<tr>
        <td class="when-cell">${fmtWhen(f.date)}</td>
        <td class="gw-cell">${gw}</td>
        <td class="comp-cell">
          <span class="comp-name">${esc(competition)}</span>
          ${round ? `<span class="sub">${esc(round)}</span>` : ""}
        </td>
        <td class="opp-cell">${opponentCell(f, clubId)}</td>
        <td class="result-td">${resultCell(f)}</td>
      </tr>`;
    })
    .join("");

  return `<section class="panel wide">
    <h2>${tr("player.clubScheduleN", { n: fixtures.length })}</h2>
    ${scheduleLink}
    <div class="table-wrap nested club-fixtures-wrap">
      <table class="fixtures-table club-fixtures">
        <thead>
          <tr>
            <th>${tr("common.date")}</th>
            <th>GW</th>
            <th>${tr("common.competition")}</th>
            <th>${tr("common.opponent")}</th>
            <th>${tr("common.status")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${
      more > 0
        ? `<p class="hint">${tr("player.shownOf", { n: preview.length, total: fixtures.length, href: "/schedule.html?club=" + esc(clubId) })}</p>`
        : ""
    }
  </section>`;
}

function render(p, fixtures = []) {
  document.title = `${p.name} · Din8sty`;
  const tm = p.tm || {};
  const nat = tm.nationality_detail || {};
  const mv = tm.market_value_detail || {};
  const posDet = tm.positions_detail || {};
  const matches = tm.matches || [];
  const events = tm.events || [];
  const extras = (posDet.extras || [])
    .map((x) => x.label || x.name)
    .filter(Boolean)
    .join(", ");

  const flag = nat.flag_url
    ? `<img class="flag" src="${esc(nat.flag_url)}" alt="" />`
    : "";

  pageEl.innerHTML = `
    <section class="player-hero">
      ${
        p.portrait_url
          ? `<img class="portrait" src="${esc(p.portrait_url)}" alt="" />`
          : `<div class="portrait placeholder"></div>`
      }
      <div>
        <p class="eyebrow">
          ${p.club_crest ? `<img class="crest inline" src="${esc(p.club_crest)}" alt="" />` : ""}
          ${esc(p.club_name || "—")}
          ${p.shirt_number != null ? ` · #${p.shirt_number}` : ""}
          ${esc(p.league_name ? ` · ${p.league_name}` : "")}
        </p>
        <h1>${esc(p.name)}</h1>
        <p class="meta-line">
          ${flag}
          ${esc(p.nationality || nat.name || "—")}
          ${nat.fifa_code ? `(${esc(nat.fifa_code)})` : ""}
          ${nat.confederation?.name ? ` · ${esc(nat.confederation.name)}` : ""}
          ${tm.passport_name ? ` · ${esc(tm.passport_name)}` : ""}
        </p>
        <div class="chip-row">
          <span class="chip">${esc(p.position_display || p.position || "—")}</span>
          ${extras ? `<span class="chip">${tr("player.more", { list: esc(extras) })}</span>` : ""}
          <span class="chip">${eur(p.market_value_eur)}</span>
          ${
            p.trusted_wage_pw != null
              ? `<span class="chip" title="source: ${esc(p.trusted_wage_source || "")}">Wage ${eur(p.trusted_wage_pw)}</span>`
              : ""
          }
          ${p.fm_rating != null ? `<span class="chip">CA ${ratingBadge(p.fm_rating)}</span>` : ""}
          ${p.fm_potential != null ? `<span class="chip">PA ${ratingBadge(p.fm_potential)}</span>` : ""}
          ${
            p.availability
              ? `<span class="chip player-avail is-${esc(p.availability.kind)}" title="${esc(
                  p.availability.kind === "suspension"
                    ? tr("player.suspended", { reason: p.availability.reason || "DSQ" })
                    : tr("player.injured", { reason: p.availability.reason || "" }),
                )}">${
                  p.availability.kind === "suspension"
                    ? `DSQ · ${esc(p.availability.reason || "")}`
                    : `+ ${esc(p.availability.reason || tr("player.injuredShort"))}`
                }</span>`
              : ""
          }
        </div>
      </div>
    </section>

    <section class="player-grid">
      <article class="panel">
        <h2>${tr("player.profile")}</h2>
        ${dl([
          [tr("player.age"), p.age],
          [tr("player.dob"), fmtDate(p.date_of_birth || tm.date_of_birth_tm)],
          [tr("player.pob"), esc(tm.place_of_birth)],
          [tr("player.cob"), esc(tm.birth_country?.name)],
          [tr("player.gender"), esc(tm.gender)],
          [tr("player.height"), height(p.height)],
          [tr("player.foot"), esc(p.preferred_foot || tm.preferred_foot_detail)],
          [tr("player.contract"), esc(p.contract_until)],
          [tr("player.renewal"), fmtDate(tm.last_contract_renewal)],
          [tr("player.agency"), esc(tm.agency?.name)],
          [tr("player.outfitter"), esc(tm.outfitter?.name)],
          [tr("player.secondNat"), esc(nat.second?.name)],
          [tr("player.shortName"), esc(tm.short_name)],
        ])}
        ${
          tm.former_clubs_note
            ? `<p class="note"><strong>${tr("player.formerClubs")}</strong> ${esc(tm.former_clubs_note)}</p>`
            : ""
        }
      </article>

      <article class="panel">
        <h2>${tr("player.valueSec")}</h2>
        ${dl([
          [
            tr("player.current"),
            `${eur(p.market_value_eur ?? mv.current)}${
              mv.current_determined ? ` · ${fmtDate(mv.current_determined)}` : ""
            }`,
          ],
          [
            tr("player.previous"),
            `${eur(mv.previous)}${mv.previous_determined ? ` · ${fmtDate(mv.previous_determined)}` : ""}`,
          ],
          [
            tr("player.peak"),
            `${eur(mv.highest)}${mv.highest_determined ? ` · ${fmtDate(mv.highest_determined)}` : ""}`,
          ],
          [
            tr("player.trend"),
            mv.delta_value
              ? `${esc(mv.delta_value)}${mv.delta_type ? ` (${esc(mv.delta_type)})` : ""}`
              : "—",
          ],
        ])}
      </article>

      <article class="panel">
        <h2>${tr("player.positions")}</h2>
        ${dl([
          [tr("player.display"), esc(p.position_display)],
          [tr("common.line"), esc(p.position)],
          [tr("player.role"), esc(p.detail_role)],
          [tr("player.label"), esc(p.detail_label)],
          [tr("player.sides"), esc(p.side_role)],
          [
            tr("player.tmPrimary"),
            posDet.main
              ? `${esc(posDet.main.label || "—")} — ${esc(posDet.main.name || "—")}${
                  posDet.main.group ? ` · ${esc(posDet.main.group)}` : ""
                }`
              : "—",
          ],
        ])}
      </article>

      <article class="panel">
        <h2>Wage</h2>
        ${dl([
          ["Wage", eur(p.trusted_wage_pw)],
          [tr("player.source"), esc(p.trusted_wage_source)],
          ["Wage p/w (FM)", esc(p.fm_wage_display) || eur(p.fm_wage_pw)],
          ["Wage p/w (Capology)", esc(p.capology_wage_display) || eur(p.capology_wage_pw)],
        ])}
      </article>

      <article class="panel">
        <h2>Football Manager</h2>
        ${dl([
          ["Current Ability", ratingBadge(p.fm_rating)],
          ["Potential Ability", ratingBadge(p.fm_potential)],
          ["Wage p/w (FM)", esc(p.fm_wage_display) || eur(p.fm_wage_pw)],
          [tr("player.wageNum"), p.fm_wage_pw != null ? eur(p.fm_wage_pw) : "—"],
          [tr("player.fmName"), esc(p.fm_matched_name)],
          [tr("player.synced"), fmtDateTime(p.fm_synced_at)],
          ["FMInside", linkOrDash(p.fm_url, tr("player.open"))],
        ])}
      </article>

      <article class="panel">
        <h2>Capology</h2>
        ${dl([
          ["Wage p/w (EUR)", esc(p.capology_wage_display) || eur(p.capology_wage_pw)],
          [tr("player.wageNum"), p.capology_wage_pw != null ? eur(p.capology_wage_pw) : "—"],
          [tr("player.origCur"), esc(p.capology_currency_orig)],
          [tr("player.synced"), fmtDateTime(p.capology_synced_at)],
        ])}
      </article>

      <article class="panel">
        <h2>${tr("player.clubLeague")}</h2>
        <div class="club-row">
          ${p.club_crest ? `<img src="${esc(p.club_crest)}" alt="" />` : ""}
          <div>
            <strong>${esc(p.club_name || "—")}</strong>
            <p class="meta-line">
              ${esc(p.club_short_name || "")}
              ${p.club_ranking != null ? ` · rank ${p.club_ranking}` : ""}
              ${p.club_market_value != null ? ` · ${eur(p.club_market_value)}` : ""}
            </p>
            <p class="meta-line">${esc(p.league_name || p.league_id)} · ${esc(p.league_country || "")}</p>
          </div>
        </div>
        ${dl([
          ["Club ID", esc(p.club_id)],
          ["League ID", esc(p.league_id)],
          [tr("player.number"), p.shirt_number ?? "—"],
        ])}
      </article>

      <article class="panel">
        <h2>${tr("player.links")}</h2>
        ${dl([
          ["TM player ID", esc(p.id)],
          ["Transfermarkt", linkOrDash(p.tm_url, tr("player.tmProfile"))],
          ["Portrait", linkOrDash(p.portrait_url, tr("player.photo"))],
        ])}
      </article>
    </section>

    ${renderTransfers(p.transfers || [])}

    ${renderCoaches(p.coaches || [])}

    ${renderClubFixtures(p, fixtures)}

    ${
      (tm.clubs_history || []).length > 1
        ? `<section class="panel wide">
            <h2>${tr("player.tmSquad")}</h2>
            ${(tm.clubs_history || [])
              .map(
                (c) => `
              <div class="club-row">
                ${c.club_crest ? `<img src="${esc(c.club_crest)}" alt="" />` : ""}
                <div>
                  <strong>${esc(c.club_name || c.club_id)}</strong>
                  <p class="meta-line">${esc(c.club_city || "—")} · #${c.shirt_number ?? "—"} ${
                    c.is_captain ? tr("player.captain") : ""
                  }</p>
                </div>
              </div>`,
              )
              .join("")}
          </section>`
        : ""
    }

    ${
      (tm.assignments || []).length
        ? `<section class="panel wide">
            <h2>${tr("player.clubAssign")}</h2>
            <ul class="plain">
              ${(tm.assignments || [])
                .map((a) => {
                  const type = a.type || a.assignmentType || "—";
                  const clubId = a.clubId ?? a.club_id ?? "—";
                  const start = a.start || a.startDate || "—";
                  return `<li>${esc(type)} · club ${esc(clubId)} · start ${esc(start)}</li>`;
                })
                .join("")}
            </ul>
          </section>`
        : ""
    }

    <section class="panel wide">
      <h2>${tr("player.matches", { n: matches.length })}</h2>
      <div class="table-wrap nested">
        <table>
          <thead>
            <tr>
              <th>${tr("common.date")}</th>
              <th>${tr("common.competition")}</th>
              <th>${tr("player.match")}</th>
              <th>${tr("player.role")}</th>
              <th>#</th>
              <th>${tr("common.position")}</th>
            </tr>
          </thead>
          <tbody>
            ${
              matches.length
                ? matches
                    .map((m) => {
                      const score =
                        m.home_score != null && m.away_score != null
                          ? `${m.home_score}:${m.away_score}`
                          : "—";
                      return `<tr>
                        <td>${fmtDateTime(m.date_utc)}</td>
                        <td>${esc(m.competition_id || "—")}</td>
                        <td>${esc(m.home_club_name || "—")} ${score} ${esc(m.away_club_name || "—")}</td>
                        <td>${m.is_starter ? tr("player.starter") : tr("player.bench")}</td>
                        <td>${m.shirt_number ?? "—"}</td>
                        <td>${esc(m.position_label || "—")}</td>
                      </tr>`;
                    })
                    .join("")
                : `<tr><td colspan="6">${tr("player.noSquadMatches")}</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel wide">
      <h2>${tr("player.events", { n: events.length })}</h2>
      <div class="table-wrap nested">
        <table>
          <thead>
            <tr><th>${tr("common.date")}</th><th>${tr("player.match")}</th><th>${tr("player.mins")}</th><th>${tr("player.type")}</th><th>${tr("player.action")}</th><th>${tr("player.role")}</th></tr>
          </thead>
          <tbody>
            ${
              events.length
                ? events
                    .map(
                      (e) => `<tr>
                        <td>${fmtDateTime(e.date_utc)}</td>
                        <td>${esc(e.home_club_name || "—")} — ${esc(e.away_club_name || "—")}</td>
                        <td>${e.minute ?? "—"}'</td>
                        <td>${esc(e.event_label || e.event_type || "—")}</td>
                        <td>${esc(e.action || e.reason || "—")}</td>
                        <td>${e.role === "active" ? tr("player.active") : tr("player.related")}</td>
                      </tr>`,
                    )
                    .join("")
                : `<tr><td colspan="6">${tr("player.noEvents")}</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function loadClubFixtures(clubId) {
  if (!clubId) return [];
  const res = await fetch(`/api/fixtures?club=${encodeURIComponent(clubId)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.fixtures || [];
}

async function boot() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    statusEl.textContent = tr("player.noId");
    return;
  }
  try {
    const res = await fetch(`/api/players/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(res.status === 404 ? tr("player.notFound") : `HTTP ${res.status}`);
    const data = await res.json();
    const fixtures = await loadClubFixtures(data.club_id);
    render(data, fixtures);
  } catch (err) {
    statusEl.textContent = tr("player.loadFail", { err: err.message });
  }
}

boot();


document.addEventListener("din8sty:lang", () => {
  if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
  // No location.reload() — boot always fires din8sty:lang; reloading loops forever.
  boot();
});
