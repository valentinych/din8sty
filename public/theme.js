/** Din8sty theme — persist light/dark in localStorage; default dark. */
(function (global) {
  const STORAGE_KEY = "din8sty:theme";

  function read() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
    } catch (_) {
      return "dark";
    }
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const color = theme === "light" ? "#f3f6ef" : "#0f1c14";
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", color);
  }

  function save(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {}
  }

  function t(key) {
    if (typeof global.t === "function") {
      const s = global.t(key);
      if (s && s !== key) return s;
    }
    return key === "theme.toDark" ? "Тёмная тема" : "Светлая тема";
  }

  function labelKey(theme) {
    return theme === "light" ? "theme.toDark" : "theme.toLight";
  }

  function syncToggle() {
    const theme = read();
    document.querySelectorAll(".theme-toggle").forEach((btn) => {
      const label = t(labelKey(theme));
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
      btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    });
  }

  function withoutThemeTransitions(fn) {
    const style = document.createElement("style");
    style.appendChild(document.createTextNode("*,*::before,*::after{transition:none !important}"));
    document.head.appendChild(style);
    fn();
    void document.body.offsetHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => style.remove());
    });
  }

  function setTheme(theme) {
    withoutThemeTransitions(() => {
      const next = theme === "light" ? "light" : "dark";
      apply(next);
      save(next);
      syncToggle();
    });
  }

  function toggle() {
    setTheme(read() === "light" ? "dark" : "light");
  }

  function mount(host) {
    if (!host) return;
    let btn = host.querySelector(".theme-toggle");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-toggle";
      btn.innerHTML =
        '<svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>' +
        '<path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
        "</svg>" +
        '<svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M16.4 13.1A7 7 0 0 1 10.9 4.2 8.2 8.2 0 1 0 19.8 13.1a7 7 0 0 1-3.4 0z" fill="currentColor"/>' +
        "</svg>";
      btn.addEventListener("click", toggle);
    }
    host.appendChild(btn);
    syncToggle();
  }

  function ensure() {
    const host = document.getElementById("lang-switcher-host");
    if (host) mount(host);
  }

  apply(read());

  global.Din8styTheme = {
    getTheme: read,
    setTheme,
    toggle,
    mount,
    sync: syncToggle,
  };

  function boot() {
    ensure();
    document.addEventListener("din8sty:lang", syncToggle);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
