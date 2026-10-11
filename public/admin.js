const $ = (id) => document.getElementById(id);

const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loginHref() {
  return `/api/auth/login?next=${encodeURIComponent("/admin.html")}`;
}

async function loadMappings() {
  const res = await fetch("/api/admin/mappings", { credentials: "same-origin" });
  if (res.status === 401) {
    $("meta").innerHTML = tr("admin.needLogin", { href: esc(loginHref()) });
    $("panel").innerHTML = "";
    return null;
  }
  if (!res.ok) {
    $("meta").textContent = tr("common.errorStatus", { status: res.status });
    return null;
  }
  return res.json();
}

async function saveMapping(email, teamId) {
  const res = await fetch("/api/admin/mappings", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, team_id: teamId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function teamOptions(teams, selectedId) {
  const opts = [`<option value="">${tr("admin.unassigned")}</option>`];
  for (const t of teams) {
    const sel = selectedId === t.id ? " selected" : "";
    opts.push(`<option value="${t.id}"${sel}>${esc(t.name)}</option>`);
  }
  return opts.join("");
}

function render(data) {
  const mapByEmail = new Map(data.mappings.map((m) => [m.email.toLowerCase(), m]));
  const rows = data.mappings
    .map(
      (m) => `<tr data-email="${esc(m.email)}">
        <td class="mono">${esc(m.email)}</td>
        <td>
          <select class="admin-team-select" data-email="${esc(m.email)}">
            ${teamOptions(data.teams, m.team_id)}
          </select>
        </td>
        <td class="muted mono">${esc(m.updated_at?.slice(0, 19) ?? "")}</td>
        <td class="muted">${esc(m.updated_by ?? "")}</td>
      </tr>`,
    )
    .join("");

  const assignedIds = new Set(data.mappings.map((m) => m.team_id));
  const freeTeams = data.teams.filter((t) => !assignedIds.has(t.id));

  $("meta").textContent = tr("admin.meta", { teams: data.teams.length, maps: data.mappings.length });
  $("panel").innerHTML = `
    <section class="admin-section">
      <p class="meta"><a href="/admin-fm.html">${tr("admin.fmLink")}</a></p>
    </section>
    <section class="admin-section">
      <h2 class="section-title">${tr("admin.assign")}</h2>
      <form id="assign-form" class="admin-form">
        <label>
          Email (panenka / Google)
          <input id="email" type="email" required placeholder="player@gmail.com" autocomplete="email" />
        </label>
        <label>
          ${tr("common.team")}
          <select id="team" required>
            ${teamOptions(data.teams, null)}
          </select>
        </label>
        <button type="submit" class="auth-btn">${tr("common.save")}</button>
      </form>
      <p class="meta inline" id="form-status"></p>
      ${
        freeTeams.length
          ? `<p class="meta">${tr("admin.freeTeams", { list: freeTeams.map((t) => esc(t.name)).join(", ") })}</p>`
          : `<p class="meta">${tr("admin.allAssigned")}</p>`
      }
    </section>

    <section class="admin-section">
      <h2 class="section-title">${tr("admin.current")}</h2>
      <div class="table-wrap">
        <table class="compact-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>${tr("common.team")}</th>
              <th>${tr("common.updated")}</th>
              <th>${tr("common.byWhom")}</th>
            </tr>
          </thead>
          <tbody id="map-rows">
            ${
              rows ||
              `<tr><td colspan="4" class="muted">${tr("admin.none")}</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;

  $("assign-form").onsubmit = async (e) => {
    e.preventDefault();
    const email = $("email").value.trim();
    const teamRaw = $("team").value;
    const teamId = teamRaw ? Number(teamRaw) : null;
    const status = $("form-status");
    status.textContent = tr("common.saving");
    try {
      await saveMapping(email, teamId);
      status.textContent = tr("common.saved");
      const refreshed = await loadMappings();
      if (refreshed) render(refreshed);
    } catch (err) {
      status.textContent = err.message || tr("common.error");
    }
  };

  $("map-rows").onchange = async (e) => {
    const sel = e.target.closest("select.admin-team-select");
    if (!sel) return;
    const email = sel.getAttribute("data-email");
    const teamId = sel.value ? Number(sel.value) : null;
    sel.disabled = true;
    try {
      await saveMapping(email, teamId);
      const refreshed = await loadMappings();
      if (refreshed) render(refreshed);
    } catch (err) {
      alert(err.message || tr("common.error"));
      sel.disabled = false;
    }
  };

  void mapByEmail;
}

async function main() {
  const data = await loadMappings();
  if (data) render(data);
  document.addEventListener("din8sty:lang", async () => {
    if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
    const refreshed = await loadMappings();
    if (refreshed) render(refreshed);
  });
}

main();
