const $ = (id) => document.getElementById(id);

const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

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
  return `€${k.toLocaleString(typeof globalThis.Din8styI18n?.locale === "function" ? globalThis.Din8styI18n.locale() : "ru")}K`;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function load() {
  const res = await fetch("/api/leagues/top26");
  if (!res.ok) {
    $("meta").textContent = tr("common.errorStatus", { status: res.status });
    return;
  }
  const data = await res.json();
  const leagues = data.leagues || [];
  $("meta").textContent = tr("top26.metaSort");

  $("rows").innerHTML = leagues
    .map(
      (l) => `
    <tr>
      <td>
        <strong>${esc(l.name)}</strong>
        <div class="sub">${esc(l.country)}</div>
      </td>
      <td>${l.players ?? 0}</td>
      <td class="money">${eur(l.sum_market_value_eur)}</td>
      <td class="money">${wageSum(l.sum_wage_pw)}</td>
    </tr>`,
    )
    .join("");

  const quota = data.quota;
  if (!quota) {
    $("quota-meta").textContent = tr("top26.noQuota");
    return;
  }

  const qLeagues = quota.leagues || [];
  const totals = quota.totals || {};
  const per16 = quota.per_manager_16 || {};
  $("quota-meta").textContent = tr("top26.mixed", { n: totals.players ?? 0 });

  $("quota-rows").innerHTML = qLeagues
    .map(
      (l) => `
    <tr>
      <td>
        <strong>${esc(l.name)}</strong>
        <div class="sub">${esc(l.country)}</div>
      </td>
      <td>${l.quota ?? l.players ?? 0}</td>
      <td class="money">${eur(l.sum_market_value_eur)}</td>
      <td class="money">${wageSum(l.sum_wage_pw)}</td>
    </tr>`,
    )
    .join("");

  $("quota-foot").innerHTML = `
    <tr class="totals-row">
      <td><strong>${tr("top26.total")}</strong></td>
      <td>${totals.players ?? 0}</td>
      <td class="money">${eur(totals.sum_market_value_eur)}</td>
      <td class="money">${wageSum(totals.sum_wage_pw)}</td>
    </tr>
    <tr class="totals-row per-manager">
      <td colspan="2"><strong>${tr("top26.per16")}</strong></td>
      <td class="money">${eur(per16.sum_market_value_eur)}</td>
      <td class="money">${wageSum(per16.sum_wage_pw)}</td>
    </tr>`;
}

load().catch((err) => {
  $("meta").textContent = err.message || tr("common.errorLoad");
});
document.addEventListener("din8sty:lang", () => {
  if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
  load().catch(() => {});
});
