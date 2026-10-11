const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loginHref() {
  return `/api/auth/login?next=${encodeURIComponent("/admin-fm.html")}`;
}

function formatMv(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}K`;
  return `€${v}`;
}

async function loadMissing() {
  const res = await fetch("/api/admin/fm-missing", { credentials: "same-origin" });
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

async function submitMatch(playerId, fm) {
  const res = await fetch("/api/admin/fm-match", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player_id: playerId, fm }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

function render(data) {
  const rows = data.players
    .map(
      (p) => `<tr data-id="${esc(p.id)}">
        <td>
          <a href="/player.html?id=${esc(p.id)}">${esc(p.name)}</a>
          <div class="muted mono">${esc(p.id)}</div>
        </td>
        <td>${esc(p.club_name)}</td>
        <td class="mono muted">${esc(formatMv(p.market_value_eur))}</td>
        <td>
          <form class="admin-fm-row" data-id="${esc(p.id)}">
            <input
              type="text"
              name="fm"
              required
              placeholder="${tr("adminFm.ph")}"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="submit" class="auth-btn">${tr("adminFm.link")}</button>
            <span class="admin-fm-status muted" aria-live="polite"></span>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  $("meta").textContent = tr("adminFm.meta", { total: data.total, n: data.players.length });
  $("panel").innerHTML = `
    <section class="admin-section">
      <h2 class="section-title">${tr("adminFm.titleH2")}</h2>
      <p class="meta">
        ${tr("adminFm.hint")}
      </p>
      <div class="table-wrap">
        <table class="compact-table">
          <thead>
            <tr>
              <th>${tr("adminFm.playerCol")}</th>
              <th>${tr("common.club")}</th>
              <th>MV</th>
              <th>FMInside ID / URL</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              `<tr><td colspan="4" class="muted">${tr("adminFm.allMatched")}</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;

  $("panel").querySelectorAll("form.admin-fm-row").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const playerId = form.getAttribute("data-id");
      const input = form.querySelector('input[name="fm"]');
      const status = form.querySelector(".admin-fm-status");
      const btn = form.querySelector("button");
      const fm = input.value.trim();
      if (!playerId || !fm) return;
      btn.disabled = true;
      status.textContent = tr("adminFm.scraping");
      status.classList.remove("ok", "warn");
      try {
        const result = await submitMatch(playerId, fm);
        const m = result.match;
        status.classList.add("ok");
        status.textContent = `OK · CA ${m.fm_rating}` +
          (m.fm_potential != null ? `/${m.fm_potential}` : "") +
          (m.fm_wage_display ? ` · ${m.fm_wage_display}` : "") +
          tr("adminFm.remaining", { n: result.remaining });
        const tr = form.closest("tr");
        if (tr) {
          tr.classList.add("admin-fm-done");
          input.disabled = true;
        }
        $("meta").textContent = tr("adminFm.updated", { n: result.remaining });
      } catch (err) {
        status.classList.add("warn");
        status.textContent = err.message || tr("common.error");
        btn.disabled = false;
      }
    });
  });
}

async function main() {
  const data = await loadMissing();
  if (data) render(data);
}

main();

document.addEventListener("din8sty:lang", async () => {
  if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
  // No location.reload() — boot always fires din8sty:lang; reloading loops forever.
  const data = await loadMissing();
  if (data) render(data);
});
