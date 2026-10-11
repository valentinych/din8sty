/** Shared auth bar: login via panenka.games, show team, admin link. */
(function () {
  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function t(key, vars) {
    return typeof globalThis.t === "function" ? globalThis.t(key, vars) : key;
  }

  function mountTarget() {
    let el = document.getElementById("auth-bar");
    if (el) return el;
    const header = document.querySelector("header.top");
    if (!header) return null;
    el = document.createElement("div");
    el.id = "auth-bar";
    el.className = "auth-bar";
    header.appendChild(el);
    return el;
  }

  async function loadMe() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!res.ok) return { user: null, isAdmin: false, team: null };
      return await res.json();
    } catch {
      return { user: null, isAdmin: false, team: null };
    }
  }

  function loginHref() {
    const next = location.pathname + location.search + location.hash;
    return `/api/auth/login?next=${encodeURIComponent(next || "/")}`;
  }

  function render(el, me) {
    if (!me.user) {
      el.innerHTML = `<a class="auth-btn" href="${esc(loginHref())}">${t("auth.login")}</a>`;
      return;
    }
    // Primer celestial mapping only matters on Пример / admin.
    // Lineup defaults to Top-4 draft team (shown in page meta), not primer.
    const path = location.pathname || "";
    const showPrimerTeamHint = path.includes("primer") || path.includes("admin");
    const team = me.team
      ? path.includes("primer") || path.includes("admin")
        ? `<span class="auth-team" title="${esc(t("auth.primerTeamTitle"))}">${esc(me.team.name)}</span>`
        : ""
      : showPrimerTeamHint
        ? `<span class="auth-team muted">${esc(t("auth.noPrimerTeam"))}</span>`
        : "";
    const admin = me.isAdmin
      ? `<a class="auth-link" href="/admin.html">${t("auth.admin")}</a>`
      : "";
    el.innerHTML = `
      <div class="auth-user">
        <span class="auth-email" title="${esc(me.user.email)}">${esc(me.user.email)}</span>
        ${team}
      </div>
      ${admin}
      <a class="auth-link" href="/api/auth/logout?next=${encodeURIComponent(location.pathname || "/")}">${t("auth.logout")}</a>
    `;
  }

  async function init() {
    const el = mountTarget();
    if (!el) return;
    const me = await loadMe();
    window.__din8styAuth = me;
    render(el, me);
    document.dispatchEvent(new CustomEvent("din8sty:auth", { detail: me }));
    document.addEventListener("din8sty:lang", () => {
      if (window.__din8styAuth) render(el, window.__din8styAuth);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
