/** Lineup editor: drag-and-drop pitch + formation + GW opponents + checkbox picker. */
(function () {
  const $ = (id) => document.getElementById(id);

const tr = (k, v) => (typeof globalThis.t === "function" ? globalThis.t(k, v) : k);

  const PRIMARY_XPTS_BONUS = 1.2;
  const VIEW_STORAGE_KEY = "din8sty.lineupView";
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

  function loadViewMode() {
    try {
      const v = localStorage.getItem(VIEW_STORAGE_KEY);
      if (v === "list" || v === "pitch") return v;
    } catch {
      /* ignore */
    }
    return "pitch";
  }

  function saveViewMode(mode) {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
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

  function surname(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/);
    return parts[parts.length - 1] || name;
  }

  /** mode: "code" (pitch) | "full" (pool names) | "compact" (list rows). */
  function oppLabel(p, mode = "code") {
    if (!p) return "";
    const name =
      mode === "full" ? p.opponent_name || p.opponent : p.opponent;
    if (p.is_home == null && name) {
      // Multi-fixture already encoded as `H · ARS A · ATM`; compact → `(H) ARS (A) ATM`.
      return mode === "compact" ? String(name).replace(/\b([HA]) · /g, "($1) ") : name;
    }
    if (!name) return mode === "compact" ? "" : "—";
    if (mode === "compact") return `(${p.is_home ? "H" : "A"}) ${name}`;
    return `${p.is_home ? "H" : "A"} · ${name}`;
  }

  const LABEL_TO_ROLE = {
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

  function canonRole(r) {
    const n = String(r || "")
      .trim()
      .toUpperCase();
    const mapped = LABEL_TO_ROLE[n] || n;
    return mapped === "ST" ? "CF" : mapped;
  }

  function primaryRoleOf(p) {
    if (!p) return null;
    const main = p.detail_role || p.detail_label || p.position;
    return main ? canonRole(main) : null;
  }

  function playerRoles(p) {
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
      const coarse = canonRole(p.position);
      if (coarse && !["GK", "DEF", "MID", "ATT"].includes(coarse)) raw.push(p.position);
    }
    const seen = new Set();
    const out = [];
    for (const r of raw) {
      const c = canonRole(r);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  }

  function playerMatchesSlot(p, roles) {
    if (!p || !roles?.length) return false;
    const wanted = roles.map((r) => canonRole(r));
    const all = playerRoles(p);
    if (wanted.some((w) => all.includes(w))) return true;
    const coarse = canonRole(p.position || "");
    return wanted.some((w) => coarse === w);
  }

  function playerMatchesRole(p, role) {
    if (!p || !role) return false;
    const wanted = canonRole(role);
    if (playerRoles(p).includes(wanted)) return true;
    return canonRole(p.position || "") === wanted;
  }

  function defaultRoleForSlot(p, slotRoles) {
    if (!p || !slotRoles?.length) return null;
    const overlap = slotRoles.map(canonRole).filter((r) => playerMatchesRole(p, r));
    if (!overlap.length) return null;
    const primary = primaryRoleOf(p);
    if (primary && overlap.includes(primary)) return primary;
    return overlap[0];
  }

  /** Primary role if it is accepted by the slot (+20% case); else null. */
  function idealRoleForSlot(p, slotRoles) {
    const primary = primaryRoleOf(p);
    if (!primary || !slotRoles?.length) return null;
    const wanted = slotRoles.map(canonRole);
    return wanted.includes(primary) ? primary : null;
  }

  /** Player roles ∩ roles hosted by one pitch slot (badge cycle stays in-slot). */
  function slotRoleVariants(p, slotRoles) {
    if (!p || !slotRoles?.length) return [];
    const out = [];
    const seen = new Set();
    for (const role of slotRoles) {
      const r = canonRole(role);
      if (!r || seen.has(r) || !playerMatchesRole(p, r)) continue;
      seen.add(r);
      out.push(r);
    }
    return out;
  }

  function effectiveXPts(p, assignedRole) {
    const base = Number(p?.xPts);
    if (!Number.isFinite(base)) return null;
    const primary = primaryRoleOf(p);
    if (primary && assignedRole && canonRole(assignedRole) === primary) {
      return Math.round(base * PRIMARY_XPTS_BONUS * 100) / 100;
    }
    return base;
  }

  function hasPrimaryBonus(p, assignedRole) {
    const primary = primaryRoleOf(p);
    return !!(primary && assignedRole && canonRole(assignedRole) === primary);
  }

  function xPtsLabel(p, assignedRole) {
    const eff = effectiveXPts(p, assignedRole);
    if (eff == null) return "—";
    return Number(eff).toFixed(2);
  }

  function hasFormField(p) {
    return p != null && Object.prototype.hasOwnProperty.call(p, "form");
  }

  function formValueLabel(p) {
    const n = Number(p?.form_n);
    const v = Number(p?.form);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(v)) return "—";
    const mean = Number(v).toFixed(2);
    return n < 5 ? `${mean} (${n})` : mean;
  }

  function formMetaHtml(p, withSep = true) {
    if (!hasFormField(p)) return "";
    const sep = withSep ? " · " : "";
    return `<span class="lu-chip-form">${sep}${esc(tr("lineup.form"))} ${esc(formValueLabel(p))}</span>`;
  }

  const FPTS_LINE_BY_ROLE = {
    GK: "GKP",
    LB: "DEF",
    CB: "DEF",
    RB: "DEF",
    LWB: "DEF",
    RWB: "DEF",
    DEF: "DEF",
    DM: "MID",
    CM: "MID",
    AM: "MID",
    LM: "MID",
    RM: "MID",
    MID: "MID",
    LW: "FWD",
    RW: "FWD",
    SS: "FWD",
    CF: "FWD",
    ST: "FWD",
    ATT: "FWD",
  };

  function fptsLineOf(role) {
    const r = canonRole(role);
    return FPTS_LINE_BY_ROLE[r] || "MID";
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function formatGwFpts(n) {
    if (!Number.isFinite(n)) return "0.00";
    return round2(n).toFixed(2);
  }

  function hasGwFpts(p) {
    return p != null && p.gw_fpts != null && typeof p.gw_fpts === "object";
  }

  /** XI: slot-line FPTS with ×1.2 if assigned = primary. Bench/pool: scored (primary, no ×1.2). */
  function gwFptsForChip(p, from, assignedRole) {
    if (!hasGwFpts(p)) return null;
    const f = p.gw_fpts;
    if (from === "slot") {
      const line = fptsLineOf(assignedRole);
      let pts = Number(f[line]);
      if (!Number.isFinite(pts)) pts = Number(f.scored) || 0;
      if (hasPrimaryBonus(p, assignedRole)) pts = round2(pts * PRIMARY_XPTS_BONUS);
      return pts;
    }
    const scored = Number(f.scored);
    return Number.isFinite(scored) ? scored : 0;
  }

  function gwFptsHtml(p, from, assignedRole) {
    const pts = gwFptsForChip(p, from, assignedRole);
    if (pts == null) return "";
    const brought = from === "slot";
    const title = brought
      ? tr("lineup.gwFptsBroughtTip")
      : tr("lineup.gwFptsScoredTip");
    const bonus = brought && hasPrimaryBonus(p, assignedRole);
    return `<span class="lu-chip-fpts${bonus ? " is-bonus" : ""}" title="${esc(title)}">${esc(formatGwFpts(pts))}</span>`;
  }

  /** Primary + secondaries compact, e.g. `RW (LW, AM)`. */
  function positionsLabel(p) {
    if (!p) return "";
    if (p.position_display) return String(p.position_display);
    const roles = playerRoles(p);
    if (!roles.length) return "";
    const primary = primaryRoleOf(p) || roles[0];
    const extras = roles.filter((r) => r !== primary);
    return extras.length ? `${primary} (${extras.join(", ")})` : primary;
  }

  /** Escaped HTML for pool/bench pos line; marks ideal primary when picking a slot. */
  function positionsLabelHtml(p, idealRole) {
    if (!p) return "";
    const ideal = idealRole ? canonRole(idealRole) : null;
    if (p.position_display) {
      const raw = String(p.position_display);
      if (!ideal) return esc(raw);
      // Highlight primary token at start, e.g. `RW (LW, AM)` or bare `RW`.
      const m = raw.match(/^([A-Za-z0-9]+)\b(.*)$/);
      if (m && canonRole(m[1]) === ideal) {
        return `<span class="lu-pos-ideal" title="${tr("lineup.idealTitle")}">${esc(m[1])}</span>${esc(m[2])}`;
      }
      return esc(raw);
    }
    const roles = playerRoles(p);
    if (!roles.length) return "";
    const primary = primaryRoleOf(p) || roles[0];
    const extras = roles.filter((r) => r !== primary);
    const primaryHtml =
      ideal && canonRole(primary) === ideal
        ? `<span class="lu-pos-ideal" title="${tr("lineup.idealTitle")}">${esc(primary)}</span>`
        : esc(primary);
    return extras.length ? `${primaryHtml} (${esc(extras.join(", "))})` : primaryHtml;
  }

  function isGk(p) {
    if (!p) return false;
    const vals = [p.position, p.detail_role, p.detail_label]
      .filter(Boolean)
      .map((v) => String(v).trim().toUpperCase());
    return vals.some((v) => v === "GK" || v === "GKP");
  }

  function playerLine(p) {
    if (!p) return "";
    for (const r of playerRoles(p)) {
      if (ROLE_TO_LINE[r]) return ROLE_TO_LINE[r];
    }
    const coarse = canonRole(p.position || "");
    if (coarse === "GK" || coarse === "DEF" || coarse === "MID" || coarse === "ATT") {
      return coarse;
    }
    return ROLE_TO_LINE[coarse] || "";
  }

  function matchesListFilter(p) {
    if (!p) return false;
    if (state.listLine) {
      const line = playerLine(p);
      if (line !== state.listLine) return false;
    }
    const q = String(state.listQuery || "")
      .trim()
      .toLowerCase();
    if (q && !String(p.name || "").toLowerCase().includes(q)) return false;
    return true;
  }

  const BENCH_SIZE = 7;

  function emptyRoles(n) {
    return Array.from({ length: n }, () => null);
  }

  function emptyBench() {
    return Array.from({ length: BENCH_SIZE }, () => null);
  }

  function playerMatchesBench(p, benchIndex) {
    if (!p || benchIndex < 0 || benchIndex >= BENCH_SIZE) return false;
    if (benchIndex === 0) return isGk(p);
    return !isGk(p);
  }

  function benchRoleVariants(p, benchIndex) {
    if (!playerMatchesBench(p, benchIndex)) return [];
    if (benchIndex === 0) return ["GK"];
    const out = [];
    const seen = new Set();
    for (const r of playerRoles(p)) {
      const c = canonRole(r);
      if (!c || c === "GK" || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  }

  function defaultRoleForBench(p, benchIndex) {
    const variants = benchRoleVariants(p, benchIndex);
    if (!variants.length) return null;
    if (benchIndex === 0) return "GK";
    const primary = primaryRoleOf(p);
    if (primary && variants.includes(primary)) return primary;
    return variants[0];
  }

  function benchSlotLabel(index) {
    return index === 0 ? "GK" : "OUT";
  }

  const state = {
    data: null,
    teamId: null,
    gw: null,
    formationId: null,
    /** Dual 3/5 schemes: wings dropped to FB line (LM→LB, RM→RB). */
    back5: false,
    slots: [],
    slotRoles: [],
    bench: emptyBench(),
    benchRoles: emptyBench(),
    dirty: false,
    selectedId: null,
    pickSlotIndex: null, // formation slot index in “pick player for slot” mode
    dragFrom: null, // { type: 'pool'|'slot'|'bench', id?, index? }
    checkedIds: new Set(),
    feedback: null,
    viewMode: loadViewMode(), // 'pitch' | 'list'
    listLine: "", // '' | GK | DEF | MID | ATT
    listQuery: "",
    deadlineTimer: null,
    deadlineReloaded: false,
  };

  function clearPickMode() {
    state.pickSlotIndex = null;
  }

  function clearSelectionModes() {
    state.selectedId = null;
    state.pickSlotIndex = null;
  }

  function rosterById() {
    const m = new Map();
    for (const p of state.data?.roster || []) m.set(p.id, p);
    return m;
  }

  function isGwLocked(p) {
    return Boolean(p?.locked);
  }

  function isInCurrentLineup(playerId) {
    return state.slots.includes(playerId) || state.bench.includes(playerId);
  }

  /** Locked players already on XI/bench may stay/move; cannot newly pick from pool. */
  function cannotNewlySelect(p) {
    return isGwLocked(p) && !isInCurrentLineup(p.id);
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

  function formatRemain(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return d > 0 ? `${d}д ${hm}` : hm;
  }

  function stopDeadlineTick() {
    if (state.deadlineTimer) {
      clearInterval(state.deadlineTimer);
      state.deadlineTimer = null;
    }
  }

  function updateDeadlineDom() {
    const el = $("lu-deadline");
    const iso = state.data?.deadline_at;
    if (!el || !iso) return;
    const end = Date.parse(iso);
    if (!Number.isFinite(end)) return;
    const ms = end - Date.now();
    if (ms <= 0) {
      el.textContent = tr("lineup.deadlinePassed");
      el.classList.add("is-passed");
      el.title = tr("lineup.deadlineHint");
      if (!state.deadlineReloaded && lineupLeague() === "top4") {
        state.deadlineReloaded = true;
        stopDeadlineTick();
        load(state.teamId, state.gw);
      }
      return;
    }
    el.textContent = tr("lineup.deadlineIn", { time: formatRemain(ms) });
    el.classList.remove("is-passed");
    el.title = tr("lineup.deadlineHint");
  }

  function startDeadlineTick() {
    stopDeadlineTick();
    if (lineupLeague() !== "top4" || !state.data?.deadline_at) return;
    updateDeadlineDom();
    state.deadlineTimer = setInterval(updateDeadlineDom, 1000);
  }

  function baseFormation() {
    return (state.data?.formations || []).find((f) => f.id === state.formationId) || null;
  }

  /** Active pitch view (base or «5 сзади» coords/labels). */
  function currentFormation() {
    const base = baseFormation();
    if (!base) return null;
    if (state.back5 && base.back5_slots?.length) {
      return { ...base, slots: base.back5_slots };
    }
    return base;
  }

  function supportsBack5(form) {
    return Boolean(form?.back5_slots?.length);
  }

  /** Infer back-five mode from assigned LB/RB on wing slots. */
  function inferBack5(form, roles) {
    if (!supportsBack5(form)) return false;
    for (let i = 0; i < form.back5_slots.length; i++) {
      const lead = canonRole(form.back5_slots[i].roles[0] || "");
      if (lead !== "LB" && lead !== "RB") continue;
      const r = roles[i] ? canonRole(roles[i]) : "";
      if (r === "LB" || r === "RB") return true;
    }
    return false;
  }

  /** Prefer LB/RB (on) or LM/RM (off) on wing slots when the player qualifies. */
  function remapWingRolesForBack5(on) {
    const base = baseFormation();
    if (!supportsBack5(base)) return;
    const byId = rosterById();
    const view = on ? base.back5_slots : base.slots;
    for (let i = 0; i < view.length; i++) {
      const roles = view[i].roles.map(canonRole);
      const hasLb = roles.includes("LB");
      const hasRb = roles.includes("RB");
      const hasLm = roles.includes("LM");
      const hasRm = roles.includes("RM");
      if (!(hasLb || hasRb) || !(hasLm || hasRm)) continue;
      const pid = state.slots[i];
      if (!pid) continue;
      const p = byId.get(pid);
      if (!p) continue;
      const prefer = on
        ? hasLb
          ? "LB"
          : "RB"
        : hasLm
          ? "LM"
          : "RM";
      const fallback = on
        ? hasLm
          ? "LM"
          : "RM"
        : hasLb
          ? "LB"
          : "RB";
      if (playerMatchesRole(p, prefer)) setSlotRole(i, prefer);
      else if (playerMatchesRole(p, fallback)) setSlotRole(i, fallback);
    }
  }

  function setBack5(on) {
    const base = baseFormation();
    if (!supportsBack5(base)) {
      state.back5 = false;
      return;
    }
    if (state.back5 === on) return;
    state.back5 = on;
    remapWingRolesForBack5(on);
    state.dirty = true;
    clearSelectionModes();
    render();
  }

  function usedIds() {
    const s = new Set(state.slots.filter(Boolean));
    for (const id of state.bench) if (id) s.add(id);
    return s;
  }

  function setFeedback(text) {
    state.feedback = text || null;
  }

  function roleForIndex(i) {
    return state.slotRoles[i] ?? null;
  }

  function setSlotRole(i, role) {
    const next = state.slotRoles.slice();
    while (next.length <= i) next.push(null);
    next[i] = role ? canonRole(role) : null;
    state.slotRoles = next;
  }

  function benchRoleForIndex(i) {
    return state.benchRoles[i] ?? null;
  }

  function setBenchRole(i, role) {
    const next = state.benchRoles.slice();
    while (next.length <= i) next.push(null);
    next[i] = role ? canonRole(role) : null;
    state.benchRoles = next;
  }

  /** Drop player from XI and/or bench without render. */
  function removePlayerEverywhere(playerId, slots, roles, bench, benchRoles) {
    const nextSlots = slots.map((id) => (id === playerId ? null : id));
    const nextRoles = nextSlots.map((id, i) => (id ? roles[i] ?? null : null));
    const nextBench = bench.map((id) => (id === playerId ? null : id));
    const nextBenchRoles = nextBench.map((id, i) =>
      id ? benchRoles[i] ?? null : null,
    );
    return {
      slots: nextSlots,
      roles: nextRoles,
      bench: nextBench,
      benchRoles: nextBenchRoles,
    };
  }

  function checkedPlayers() {
    const byId = rosterById();
    return [...state.checkedIds]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => Number(b.xPts || 0) - Number(a.xPts || 0));
  }

  /** Max Σ xPts assignment of players → formation slots (same idea as primer). */
  function bestFormationAssignment(players, formation) {
    if (!formation?.slots?.length || !players?.length) return null;
    const slots = formation.slots;
    const candidates = slots.map((slot) => {
      const idxs = [];
      for (let i = 0; i < players.length; i++) {
        if (playerMatchesSlot(players[i], slot.roles)) idxs.push(i);
      }
      idxs.sort((a, b) => {
        const ra = defaultRoleForSlot(players[a], slot.roles);
        const rb = defaultRoleForSlot(players[b], slot.roles);
        return (
          Number(effectiveXPts(players[b], rb) || 0) -
          Number(effectiveXPts(players[a], ra) || 0)
        );
      });
      return idxs;
    });
    if (candidates.some((c) => c.length === 0)) return null;

    const order = slots
      .map((_, i) => i)
      .sort((a, b) => candidates[a].length - candidates[b].length);

    const used = new Array(players.length).fill(false);
    const assignment = new Array(slots.length).fill(-1);
    let bestScore = -Infinity;
    let bestAssign = null;

    function upperBound(k, current) {
      let bound = current;
      for (let t = k; t < order.length; t++) {
        const si = order[t];
        let best = -Infinity;
        for (const pi of candidates[si]) {
          if (used[pi]) continue;
          const role = defaultRoleForSlot(players[pi], slots[si].roles);
          best = Math.max(best, Number(effectiveXPts(players[pi], role) || 0));
        }
        if (best === -Infinity) return -Infinity;
        bound += best;
      }
      return bound;
    }

    function solve(k, current) {
      if (k === order.length) {
        if (current > bestScore) {
          bestScore = current;
          bestAssign = assignment.slice();
        }
        return;
      }
      if (upperBound(k, current) <= bestScore) return;
      const si = order[k];
      for (const pi of candidates[si]) {
        if (used[pi]) continue;
        used[pi] = true;
        assignment[si] = pi;
        const role = defaultRoleForSlot(players[pi], slots[si].roles);
        solve(k + 1, current + Number(effectiveXPts(players[pi], role) || 0));
        used[pi] = false;
        assignment[si] = -1;
      }
    }

    solve(0, 0);
    if (!bestAssign) return null;
    const slotIds = bestAssign.map((pi) => players[pi].id);
    const roles = bestAssign.map((pi, si) =>
      defaultRoleForSlot(players[pi], slots[si].roles),
    );
    return {
      slots: slotIds,
      roles,
      score: bestScore,
    };
  }

  /** Greedy fill (scarce slots first); return unfilled slot labels. */
  function partialAssignmentGaps(players, formation) {
    const slots = formation.slots;
    const candidates = slots.map((slot) => {
      const idxs = [];
      for (let i = 0; i < players.length; i++) {
        if (playerMatchesSlot(players[i], slot.roles)) idxs.push(i);
      }
      idxs.sort((a, b) => Number(players[b].xPts || 0) - Number(players[a].xPts || 0));
      return idxs;
    });

    const order = slots
      .map((_, i) => i)
      .sort((a, b) => candidates[a].length - candidates[b].length || a - b);

    const used = new Array(players.length).fill(false);
    const filled = new Array(slots.length).fill(false);
    let filledCount = 0;
    for (const si of order) {
      for (const pi of candidates[si]) {
        if (used[pi]) continue;
        used[pi] = true;
        filled[si] = true;
        filledCount += 1;
        break;
      }
    }
    const unfilled = [];
    for (let i = 0; i < slots.length; i++) {
      if (!filled[i]) unfilled.push(slots[i].label);
    }
    return { filled: filledCount, unfilled };
  }

  function formatMissingRoles(labels) {
    const counts = new Map();
    for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);
    return [...counts.entries()]
      .map(([label, n]) => (n === 1 ? tr("lineup.needOne", { label }) : tr("lineup.needN", { n, label })))
      .join(" · ");
  }

  function selectionStatus() {
    const selected = checkedPlayers();
    const gks = selected.filter(isGk);
    const outfield = selected.filter((p) => !isGk(p));
    return {
      selected,
      gks,
      outfield,
      gkOk: gks.length === 1,
      outOk: outfield.length >= 10,
      ready: gks.length === 1 && outfield.length >= 10,
    };
  }

  /** Players used for formation fit: exactly 1 GK (best xPts) + all outfield checked. */
  function proposalPlayers() {
    const { selected, gks, outfield, ready } = selectionStatus();
    if (!ready) return null;
    const gk = [...gks].sort((a, b) => Number(b.xPts || 0) - Number(a.xPts || 0))[0];
    return [gk, ...outfield];
  }

  function suggestFromChecked() {
    const status = selectionStatus();
    if (status.gks.length === 0) {
      return { kind: "need", text: tr("lineup.needGk") };
    }
    if (status.gks.length > 1) {
      return {
        kind: "need",
        text: tr("lineup.oneGk", { n: status.gks.length }),
      };
    }
    if (!status.outOk) {
      const need = 10 - status.outfield.length;
      return {
        kind: "need",
        text: tr("lineup.needOutfield", { n: need }),
      };
    }

    const players = proposalPlayers();
    const forms = state.data?.formations || [];
    const fitting = [];
    for (const f of forms) {
      const asg = bestFormationAssignment(players, f);
      if (asg) fitting.push({ formation: f, assignment: asg });
    }
    if (fitting.length) {
      fitting.sort((a, b) => b.assignment.score - a.assignment.score);
      return { kind: "ok", fitting };
    }

    // Closest formation by fewest missing slots
    let best = null;
    for (const f of forms) {
      const gaps = partialAssignmentGaps(players, f);
      if (
        !best ||
        gaps.unfilled.length < best.gaps.unfilled.length ||
        (gaps.unfilled.length === best.gaps.unfilled.length &&
          gaps.filled > best.gaps.filled)
      ) {
        best = { formation: f, gaps };
      }
    }
    if (!best || !best.gaps.unfilled.length) {
      return { kind: "need", text: tr("lineup.noFormation") };
    }
    return {
      kind: "gaps",
      formation: best.formation,
      text: tr("lineup.noFit", { label: best.formation.label, gaps: formatMissingRoles(best.gaps.unfilled) }),
    };
  }

  function applySuggestedFormation(formationId) {
    const players = proposalPlayers();
    const forms = state.data?.formations || [];
    const form = forms.find((f) => f.id === formationId);
    if (!players || !form) return;
    const asg = bestFormationAssignment(players, form);
    if (!asg) return;
    state.formationId = form.id;
    state.back5 = false;
    state.slots = asg.slots.slice();
    state.slotRoles = asg.roles.slice();
    // XI takes priority — drop any suggested XI players still on bench
    const xiSet = new Set(state.slots.filter(Boolean));
    state.bench = state.bench.map((id) => (id && xiSet.has(id) ? null : id));
    state.benchRoles = state.bench.map((id, i) =>
      id ? state.benchRoles[i] ?? null : null,
    );
    state.dirty = true;
    clearSelectionModes();
    setFeedback(null);
    render();
  }

  function clearAll() {
    const form = currentFormation();
    const n = form?.slots?.length || state.slots.length || 11;
    state.slots = Array.from({ length: n }, () => null);
    state.slotRoles = emptyRoles(n);
    state.bench = emptyBench();
    state.benchRoles = emptyBench();
    state.checkedIds = new Set();
    clearSelectionModes();
    state.dirty = true;
    setFeedback(null);
    render();
  }

  function initSlotsFromData() {
    const data = state.data;
    const forms = data.formations || [];
    const saved = data.saved;
    const suggested = data.suggested;

    let formationId =
      saved?.formation ||
      suggested?.formation ||
      forms[0]?.id ||
      null;
    if (!forms.some((f) => f.id === formationId)) {
      formationId = forms[0]?.id || null;
    }
    state.formationId = formationId;
    const form = forms.find((f) => f.id === formationId);
    const n = form?.slots?.length || 11;
    state.back5 = false;

    if (saved?.slots?.length) {
      state.slots = Array.from({ length: n }, (_, i) => saved.slots[i] ?? null);
      state.slotRoles = Array.from({ length: n }, (_, i) => {
        const r = saved.roles?.[i];
        return r ? canonRole(r) : null;
      });
      state.bench = Array.from(
        { length: BENCH_SIZE },
        (_, i) => saved.bench?.[i] ?? null,
      );
      state.benchRoles = Array.from({ length: BENCH_SIZE }, (_, i) => {
        const r = saved.bench_roles?.[i];
        return r ? canonRole(r) : null;
      });
      state.back5 = inferBack5(form, state.slotRoles);
    } else if (suggested?.slots?.length && suggested.formation === formationId) {
      state.slots = Array.from({ length: n }, (_, i) => suggested.slots[i] ?? null);
      state.slotRoles = emptyRoles(n);
      const sugBench = suggested.bench || [];
      state.bench = Array.from(
        { length: BENCH_SIZE },
        (_, i) => sugBench[i] ?? null,
      );
      state.benchRoles = emptyBench();
    } else {
      state.slots = Array.from({ length: n }, () => null);
      state.slotRoles = emptyRoles(n);
      state.bench = emptyBench();
      state.benchRoles = emptyBench();
    }
    // Drop ineligible / unknown; fill missing roles
    const byId = rosterById();
    const formSlots = form?.slots || [];
    for (let i = 0; i < state.slots.length; i++) {
      const pid = state.slots[i];
      if (!pid) {
        state.slotRoles[i] = null;
        continue;
      }
      const p = byId.get(pid);
      if (!p || !playerMatchesSlot(p, formSlots[i]?.roles || [])) {
        state.slots[i] = null;
        state.slotRoles[i] = null;
        continue;
      }
      const role = state.slotRoles[i];
      const slotRoles = formSlots[i]?.roles || [];
      if (
        !role ||
        !slotRoles.map(canonRole).includes(canonRole(role)) ||
        !playerMatchesRole(p, role)
      ) {
        state.slotRoles[i] = defaultRoleForSlot(p, slotRoles);
      }
    }
    const xiSet = new Set(state.slots.filter(Boolean));
    for (let i = 0; i < BENCH_SIZE; i++) {
      const pid = state.bench[i];
      if (!pid) {
        state.benchRoles[i] = null;
        continue;
      }
      const p = byId.get(pid);
      if (!p || xiSet.has(pid) || !playerMatchesBench(p, i)) {
        state.bench[i] = null;
        state.benchRoles[i] = null;
        continue;
      }
      xiSet.add(pid); // prevent duplicates across bench
      const role = state.benchRoles[i];
      const variants = benchRoleVariants(p, i);
      if (!role || !variants.includes(canonRole(role))) {
        state.benchRoles[i] = defaultRoleForBench(p, i);
      }
    }
    state.checkedIds = new Set();
    state.dirty = false;
    setFeedback(null);
  }

  function applyFormation(nextId) {
    if (nextId === state.formationId) return;
    const forms = state.data?.formations || [];
    const next = forms.find((f) => f.id === nextId);
    if (!next) return;
    const byId = rosterById();
    const nextSlots = next.slots.map(() => null);
    const nextRoles = emptyRoles(next.slots.length);
    const used = new Set();
    for (let i = 0; i < next.slots.length; i++) {
      const pid = state.slots[i] ?? null;
      if (!pid || used.has(pid)) continue;
      const p = byId.get(pid);
      if (p && playerMatchesSlot(p, next.slots[i].roles)) {
        nextSlots[i] = pid;
        used.add(pid);
        const prevRole = state.slotRoles[i];
        if (
          prevRole &&
          next.slots[i].roles.map(canonRole).includes(canonRole(prevRole)) &&
          playerMatchesRole(p, prevRole)
        ) {
          nextRoles[i] = canonRole(prevRole);
        } else {
          nextRoles[i] = defaultRoleForSlot(p, next.slots[i].roles);
        }
      }
    }
    // Keep bench, but drop anyone who stayed on XI
    const nextBench = state.bench.map((id) => (id && used.has(id) ? null : id));
    const nextBenchRoles = nextBench.map((id, i) =>
      id ? state.benchRoles[i] ?? null : null,
    );
    state.formationId = nextId;
    state.back5 = false;
    state.slots = nextSlots;
    state.slotRoles = nextRoles;
    state.bench = nextBench;
    state.benchRoles = nextBenchRoles;
    state.dirty = true;
    clearSelectionModes();
    setFeedback(null);
    render();
  }

  function placePlayer(playerId, slotIndex) {
    const form = currentFormation();
    if (!form) return;
    const byId = rosterById();
    const p = byId.get(playerId);
    if (!p) return;
    if (cannotNewlySelect(p)) {
      setFeedback(tr("lineup.playerLocked"));
      return;
    }
    const roles = form.slots[slotIndex]?.roles;
    if (!playerMatchesSlot(p, roles)) return;

    let next = state.slots.slice();
    let nextRoles = state.slotRoles.slice();
    let nextBench = state.bench.slice();
    let nextBenchRoles = state.benchRoles.slice();
    while (nextRoles.length < next.length) nextRoles.push(null);

    const prevIdx = next.findIndex((id) => id === playerId);
    const prevBenchIdx = nextBench.findIndex((id) => id === playerId);
    const occupant = next[slotIndex];
    const occupantRole = nextRoles[slotIndex];

    if (prevIdx === slotIndex) {
      clearSelectionModes();
      render();
      return;
    }

    // Leaving bench (or pool) → pitch
    if (prevBenchIdx >= 0) {
      const cleared = removePlayerEverywhere(
        playerId,
        next,
        nextRoles,
        nextBench,
        nextBenchRoles,
      );
      next = cleared.slots;
      nextRoles = cleared.roles;
      nextBench = cleared.bench;
      nextBenchRoles = cleared.benchRoles;

      if (occupant) {
        // Try swap onto the vacated bench slot if eligible
        if (playerMatchesBench(byId.get(occupant), prevBenchIdx)) {
          nextBench[prevBenchIdx] = occupant;
          nextBenchRoles[prevBenchIdx] =
            occupantRole &&
            benchRoleVariants(byId.get(occupant), prevBenchIdx).includes(
              canonRole(occupantRole),
            )
              ? canonRole(occupantRole)
              : defaultRoleForBench(byId.get(occupant), prevBenchIdx);
        }
        // else occupant drops to pool
      }
      next[slotIndex] = playerId;
      nextRoles[slotIndex] = defaultRoleForSlot(p, roles);
    } else if (prevIdx >= 0) {
      // Swap if moving between pitch slots
      next[prevIdx] = occupant ?? null;
      nextRoles[prevIdx] = occupant
        ? defaultRoleForSlot(byId.get(occupant), form.slots[prevIdx]?.roles || [])
        : null;
      next[slotIndex] = playerId;
      nextRoles[slotIndex] = defaultRoleForSlot(p, roles);
      if (
        occupant &&
        occupantRole &&
        (form.slots[prevIdx]?.roles || []).map(canonRole).includes(canonRole(occupantRole)) &&
        playerMatchesRole(byId.get(occupant), occupantRole)
      ) {
        nextRoles[prevIdx] = canonRole(occupantRole);
      }
    } else {
      // From pool — displace occupant to pool
      next[slotIndex] = playerId;
      nextRoles[slotIndex] = defaultRoleForSlot(p, roles);
    }
    state.slots = next;
    state.slotRoles = nextRoles;
    state.bench = nextBench;
    state.benchRoles = nextBenchRoles;
    state.dirty = true;
    clearSelectionModes();
    setFeedback(null);
    render();
  }

  function placeOnBench(playerId, benchIndex) {
    if (benchIndex < 0 || benchIndex >= BENCH_SIZE) return;
    const byId = rosterById();
    const form = currentFormation();
    const p = byId.get(playerId);
    if (!p || !playerMatchesBench(p, benchIndex)) return;
    if (cannotNewlySelect(p)) {
      setFeedback(tr("lineup.playerLocked"));
      return;
    }

    let next = state.slots.slice();
    let nextRoles = state.slotRoles.slice();
    let nextBench = state.bench.slice();
    let nextBenchRoles = state.benchRoles.slice();

    const prevIdx = next.findIndex((id) => id === playerId);
    const prevBenchIdx = nextBench.findIndex((id) => id === playerId);
    const occupant = nextBench[benchIndex];
    const occupantRole = nextBenchRoles[benchIndex];

    if (prevBenchIdx === benchIndex) return;

    if (prevBenchIdx >= 0) {
      // Swap between bench slots — only if occupant fits the vacated slot (or empty)
      if (
        occupant &&
        !playerMatchesBench(byId.get(occupant), prevBenchIdx)
      ) {
        setFeedback(tr("lineup.gkOnly"));
        return;
      }
      nextBench[prevBenchIdx] = occupant ?? null;
      nextBenchRoles[prevBenchIdx] = occupant
        ? occupantRole &&
          benchRoleVariants(byId.get(occupant), prevBenchIdx).includes(
            canonRole(occupantRole),
          )
          ? canonRole(occupantRole)
          : defaultRoleForBench(byId.get(occupant), prevBenchIdx)
        : null;
      nextBench[benchIndex] = playerId;
      nextBenchRoles[benchIndex] = defaultRoleForBench(p, benchIndex);
    } else if (prevIdx >= 0) {
      // From pitch → bench; try swap occupant onto vacated pitch slot
      const pitchRoles = form?.slots[prevIdx]?.roles || [];
      next[prevIdx] = null;
      nextRoles[prevIdx] = null;
      if (occupant) {
        const op = byId.get(occupant);
        if (op && playerMatchesSlot(op, pitchRoles)) {
          next[prevIdx] = occupant;
          nextRoles[prevIdx] =
            occupantRole &&
            pitchRoles.map(canonRole).includes(canonRole(occupantRole)) &&
            playerMatchesRole(op, occupantRole)
              ? canonRole(occupantRole)
              : defaultRoleForSlot(op, pitchRoles);
        }
        // else occupant to pool
      }
      nextBench[benchIndex] = playerId;
      nextBenchRoles[benchIndex] = defaultRoleForBench(p, benchIndex);
    } else {
      // From pool
      nextBench[benchIndex] = playerId;
      nextBenchRoles[benchIndex] = defaultRoleForBench(p, benchIndex);
      // Occupant displaced to pool automatically by overwrite
    }

    state.slots = next;
    state.slotRoles = nextRoles;
    state.bench = nextBench;
    state.benchRoles = nextBenchRoles;
    state.dirty = true;
    clearSelectionModes();
    setFeedback(null);
    render();
  }

  function clearSlot(slotIndex) {
    if (!state.slots[slotIndex]) return;
    state.slots = state.slots.map((id, i) => (i === slotIndex ? null : id));
    state.slotRoles = state.slotRoles.map((r, i) => (i === slotIndex ? null : r));
    state.dirty = true;
    clearSelectionModes();
    setFeedback(null);
    render();
  }

  function clearBenchSlot(benchIndex) {
    if (!state.bench[benchIndex]) return;
    state.bench = state.bench.map((id, i) => (i === benchIndex ? null : id));
    state.benchRoles = state.benchRoles.map((r, i) =>
      i === benchIndex ? null : r,
    );
    state.dirty = true;
    clearSelectionModes();
    setFeedback(null);
    render();
  }

  function returnToPool(playerId) {
    const cleared = removePlayerEverywhere(
      playerId,
      state.slots,
      state.slotRoles,
      state.bench,
      state.benchRoles,
    );
    state.slots = cleared.slots;
    state.slotRoles = cleared.roles;
    state.bench = cleared.bench;
    state.benchRoles = cleared.benchRoles;
    state.dirty = true;
    clearSelectionModes();
    setFeedback(null);
    render();
  }

  /**
   * Cycle assigned role for a filled slot among roles that slot hosts.
   * Never moves or swaps players — drag-and-drop (or chip→slot tap) does that.
   */
  function cycleSlotVariant(slotIndex) {
    const form = currentFormation();
    if (!form || !state.data?.can_edit) return;
    const pid = state.slots[slotIndex];
    const p = pid ? rosterById().get(pid) : null;
    if (!p) return;

    const slotRoles = form.slots[slotIndex]?.roles || [];
    const variants = slotRoleVariants(p, slotRoles);
    if (variants.length < 2) {
      setFeedback(tr("lineup.noOtherPosSlot"));
      return;
    }

    const currentRole =
      roleForIndex(slotIndex) || defaultRoleForSlot(p, slotRoles);
    const curIdx = Math.max(0, variants.indexOf(canonRole(currentRole)));
    const nextRole = variants[(curIdx + 1) % variants.length];
    setSlotRole(slotIndex, nextRole);
    state.dirty = true;
    clearSelectionModes();
    setFeedback(
      hasPrimaryBonus(p, nextRole) ? tr("lineup.primaryPos", { role: nextRole }) : `${nextRole}`,
    );
    render();
  }

  function cycleBenchVariant(benchIndex) {
    if (!state.data?.can_edit) return;
    const pid = state.bench[benchIndex];
    const p = pid ? rosterById().get(pid) : null;
    if (!p) return;
    const variants = benchRoleVariants(p, benchIndex);
    if (variants.length < 2) {
      setFeedback(tr("lineup.noOtherPosBench"));
      return;
    }
    const currentRole =
      benchRoleForIndex(benchIndex) || defaultRoleForBench(p, benchIndex);
    const curIdx = Math.max(0, variants.indexOf(canonRole(currentRole)));
    const nextRole = variants[(curIdx + 1) % variants.length];
    setBenchRole(benchIndex, nextRole);
    state.dirty = true;
    clearSelectionModes();
    setFeedback(
      hasPrimaryBonus(p, nextRole) ? tr("lineup.primaryPos", { role: nextRole }) : `${nextRole}`,
    );
    render();
  }

  function lineupLeague() {
    try {
      return new URLSearchParams(location.search).get("league") || "top4";
    } catch {
      return "top4";
    }
  }

  async function load(_ignoredTeamId, gw) {
    const meta = $("meta");
    const params = new URLSearchParams();
    const league = lineupLeague();
    if (league && league !== "primer") params.set("league", league);
    // Primer: always load mapped team. Top-4: allow ?team= for consigliere multi-team.
    if (league === "top4") {
      const teamQ = new URLSearchParams(location.search).get("team");
      if (teamQ) params.set("team_id", teamQ);
    }
    if (gw) params.set("gw", String(gw));
    const nextPath =
      league === "top4" ? "/lineup.html?league=top4" : "/lineup.html?league=primer";
    const res = await fetch(`/api/lineup?${params}`, { credentials: "same-origin" });
    if (res.status === 401) {
      meta.innerHTML = `${tr("lineup.login", { href: "/api/auth/login?next=" + encodeURIComponent(nextPath) })}`;
      $("app").hidden = true;
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      meta.textContent = data.message || data.error || tr("common.errorLoad");
      $("app").hidden = true;
      return;
    }
    state.data = data;
    state.teamId = data.team.id;
    state.gw = data.gw;
    state.deadlineReloaded = Boolean(data.deadline_passed);
    initSlotsFromData();
    const vac = Number(data.team?.vacancies || 0);
    const vacNote =
      vac > 0 ? ` · ${tr("league.squads.needsReplace", { n: vac })}` : "";
    meta.textContent = `${data.team.name} · GW${data.gw}${vacNote}`;
    $("app").hidden = false;
    render();
  }

  async function refreshInfo() {
    if (lineupLeague() !== "top4") return;
    if (state.dirty) {
      setFeedback(tr("lineup.refreshSaveFirst"));
      return;
    }
    const btn = $("lineup-refresh");
    if (btn) {
      btn.disabled = true;
      btn.textContent = tr("lineup.refreshing");
    }
    try {
      const res = await fetch("/api/lineup/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          league: "top4",
          team_id: state.teamId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback(data.message || data.error || tr("lineup.refreshErr"));
        return;
      }
      await load(state.teamId, state.gw);
      setFeedback(tr("lineup.refreshOk"));
    } catch (err) {
      setFeedback(tr("lineup.error", { err: err.message || err }));
    } finally {
      const again = $("lineup-refresh");
      if (again) {
        again.disabled = false;
        again.textContent = tr("lineup.refresh");
      }
    }
  }

  async function save() {
    if (!state.data?.can_edit) return;
    const byId = rosterById();
    const lockedIn = [...state.slots, ...state.bench].filter((id) => {
      const p = id ? byId.get(id) : null;
      return p && isGwLocked(p);
    });
    if (lockedIn.length) {
      $("meta").textContent = tr("lineup.notSaved", {
        err: tr("lineup.err.playerAlreadyPlayed"),
      });
      setFeedback(tr("lineup.playerLocked"));
      return;
    }
    const btn = $("lineup-save");
    if (btn) {
      btn.disabled = true;
      btn.textContent = tr("common.saving");
    }
    try {
      const league = lineupLeague();
      const res = await fetch("/api/lineup", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          league: league === "top4" ? "top4" : "primer",
          team_id: state.teamId,
          gw: state.gw,
          formation: state.formationId,
          slots: state.slots,
          roles: state.slotRoles,
          bench: state.bench,
          bench_roles: state.benchRoles,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errKey =
          data.error === "player_already_played"
            ? tr("lineup.err.playerAlreadyPlayed")
            : data.error || res.status;
        $("meta").textContent = tr("lineup.notSaved", { err: errKey });
        return;
      }
      state.data.saved = data.saved;
      state.dirty = false;
      $("meta").textContent = tr("lineup.saved", { team: state.data.team.name, gw: state.gw });
      setFeedback(null);
      render();
    } catch (err) {
      $("meta").textContent = tr("lineup.error", { err: err.message || err });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = tr("common.save");
      }
    }
  }

  function chipHtml(p, opts = {}) {
    const from = opts.from || "pool";
    const idx = opts.index;
    const assignedRole = opts.assignedRole ?? null;
    const pickEligible = opts.pickEligible; // true | false | undefined
    const idealRole = opts.idealRole || null;
    const selected = state.selectedId === p.id ? " is-selected" : "";
    const lockCls = isGwLocked(p) ? " is-locked" : "";
    const pickCls =
      cannotNewlySelect(p)
        ? ""
        : pickEligible === true
        ? idealRole
          ? " is-eligible is-ideal"
          : " is-eligible"
        : pickEligible === false
          ? " is-ineligible"
          : "";
    const drag =
      state.data?.can_edit && pickEligible !== false && !cannotNewlySelect(p)
        ? 'draggable="true"'
        : "";
    const bonus = hasPrimaryBonus(p, assignedRole);
    const onPitchOrBench = from === "slot" || from === "bench";
    const slotRoles =
      from === "slot" && idx != null
        ? currentFormation()?.slots[idx]?.roles || []
        : [];
    const variants =
      from === "slot"
        ? slotRoleVariants(p, slotRoles)
        : from === "bench" && idx != null
          ? benchRoleVariants(p, idx)
          : [];
    const canCycle = onPitchOrBench && state.data?.can_edit && variants.length > 1;
    const roleShown =
      assignedRole ||
      (from === "slot" && idx != null
        ? defaultRoleForSlot(p, slotRoles)
        : from === "bench" && idx != null
          ? defaultRoleForBench(p, idx)
          : null);

    const cycleAttr =
      from === "slot"
        ? `data-cycle-slot="${idx}"`
        : from === "bench"
          ? `data-cycle-bench="${idx}"`
          : "";

    const roleBadge =
      onPitchOrBench && roleShown
        ? `<span class="lu-role-badge${bonus ? " is-primary" : ""}${canCycle ? " is-cycle" : ""}"
             ${canCycle ? cycleAttr : ""}
             title="${esc(
               canCycle
                 ? tr("lineup.changePos", { variants: variants.join(" → ") })
                 : bonus
                   ? tr("lineup.primaryShort")
                   : roleShown,
             )}"
             ${canCycle ? 'role="button" tabindex="0"' : ""}>
             ${esc(roleShown)}${canCycle ? " ⇄" : ""}
           </span>`
        : "";

    const posHtml = onPitchOrBench
      ? (() => {
          const posLabel = positionsLabel(p);
          return posLabel ? `<span class="lu-chip-pos">${esc(posLabel)}</span>` : "";
        })()
      : (() => {
          const html = positionsLabelHtml(p, idealRole);
          return html ? `<span class="lu-chip-pos">${html}</span>` : "";
        })();

    // Bench chips don't use the pool pos line — show ideal role cue when picking.
    const idealCue =
      from === "bench" && idealRole
        ? `<span class="lu-ideal-cue" title="${tr("lineup.idealCue")}">${esc(idealRole)}</span>`
        : "";

    const listMode = state.viewMode === "list";
    const xPtsHtml = onPitchOrBench
      ? `<span class="lu-chip-xpts${bonus ? " is-bonus" : ""}">${esc(xPtsLabel(p, assignedRole))} xPts</span>`
      : `<span class="lu-chip-xpts">${esc(xPtsLabel(p, null))} xPts</span>`;
    const formHtml = formMetaHtml(p, !listMode);
    const metaBits = `${xPtsHtml}${formHtml}`;

    const title = cannotNewlySelect(p)
      ? tr("lineup.playerLocked")
      : pickEligible === true
        ? idealRole
          ? tr("lineup.idealRole", { role: idealRole })
          : tr("lineup.fitsSlot")
        : pickEligible === false
          ? tr("lineup.noFitSlot")
          : isGwLocked(p)
            ? tr("lineup.playerLocked")
            : "";

    const photoSrc = resolvePlayerAvatarUrl(p.portrait_url, p.club_crest);
    const opp = oppLabel(p, listMode ? "compact" : onPitchOrBench ? "code" : "full");
    const oppHtml = listMode && !opp ? "" : `<span class="lu-chip-opp">${esc(opp)}</span>`;
    const avail = p.availability;
    const availTitle = avail
      ? avail.kind === "suspension"
        ? tr("lineup.suspended", { reason: avail.reason || "DSQ" })
        : tr("lineup.injured", { reason: avail.reason || "" })
      : "";
    const chipTitle = [title, availTitle].filter(Boolean).join(" · ");
    const availBadge = !avail
      ? ""
      : avail.kind === "suspension"
        ? `<span class="lu-avail is-dsq" title="${esc(availTitle)}">DSQ</span>`
              : `<span class="lu-avail is-inj" title="${esc(availTitle)}" aria-label="${esc(availTitle)}">+</span>`;
    const listStats = listMode
      ? `<span class="lu-chip-stats">${roleBadge}${idealCue}${xPtsHtml}</span>`
      : "";
    const metaHtml = listMode
      ? `<span class="lu-chip-sub">${oppHtml}${posHtml}</span>`
      : `${roleBadge}${roleBadge ? " " : ""}${idealCue}${idealCue ? " " : ""}${metaBits}`;

    return `
      <button type="button" class="lu-chip${selected}${pickCls}${lockCls}${listMode ? " is-text" : ""}" data-player-id="${esc(p.id)}"
        data-from="${esc(from)}" data-slot-index="${from === "slot" || from === "bench" ? (idx ?? "") : ""}"
        ${chipTitle ? `title="${esc(chipTitle)}"` : ""}
        ${pickEligible === false || cannotNewlySelect(p) ? 'aria-disabled="true" tabindex="-1"' : ""} ${drag}>
        ${
          listMode
            ? ""
            : photoSrc
              ? `<img class="lu-chip-photo" src="${esc(photoSrc)}" alt="" loading="lazy" />`
              : `<span class="lu-chip-photo placeholder"></span>`
        }
        ${listMode ? "" : availBadge}
        <span class="lu-chip-body">
          <span class="lu-chip-id" role="button" tabindex="0" aria-expanded="false" aria-haspopup="dialog"
            data-player-id="${esc(p.id)}" aria-label="${esc(tr("lineup.playerCardAria", { name: p.name }))}">
            <span class="lu-chip-name-row">
              <span class="lu-chip-name">${esc(surname(p.name))}</span>
              ${listMode ? gwFptsHtml(p, from, assignedRole) : ""}
              ${listMode ? availBadge : ""}
            </span>
            ${listMode ? "" : `${oppHtml}${posHtml}`}
          </span>
          ${listStats}
          <span class="lu-chip-meta">${metaHtml}</span>
          ${listMode ? formHtml : ""}
        </span>
        ${listMode ? "" : gwFptsHtml(p, from, assignedRole)}
      </button>`;
  }

  function emptySlotHtml(slot, index, highlight, picking) {
    return `
      <div class="lu-slot${highlight ? " is-drop" : ""}${picking ? " is-picking" : ""}" data-slot-index="${index}"
        style="left:${slot.x}%; top:${100 - slot.y}%">
        <span class="lu-slot-label">${esc(slot.label)}</span>
      </div>`;
  }

  function filledSlotHtml(slot, index, p, highlight, picking) {
    const role = roleForIndex(index) || defaultRoleForSlot(p, slot.roles);
    return `
      <div class="lu-slot is-filled${highlight ? " is-drop" : ""}${picking ? " is-picking" : ""}" data-slot-index="${index}"
        style="left:${slot.x}%; top:${100 - slot.y}%">
        <span class="lu-slot-label">${esc(role || slot.label)}</span>
        ${chipHtml(p, { from: "slot", index, assignedRole: role })}
        ${
          state.data?.can_edit
            ? `<button type="button" class="lu-slot-clear" data-clear-slot="${index}" title="${tr("lineup.toPool")}" aria-label="${tr("lineup.removeAria")}">×</button>`
            : ""
        }
      </div>`;
  }

  function benchSlotHtml(index, highlight, pickInfo) {
    const pid = state.bench[index];
    const p = pid ? rosterById().get(pid) : null;
    const label = benchSlotLabel(index);
    const pickEligible = pickInfo?.eligible;
    const idealRole = pickInfo?.idealRole || null;
    if (!p) {
      return `
        <div class="lu-bench-slot${highlight ? " is-drop" : ""}${index === 0 ? " is-gk" : ""}"
          data-bench-index="${index}">
          <span class="lu-slot-label">${esc(label)}</span>
        </div>`;
    }
    const role = benchRoleForIndex(index) || defaultRoleForBench(p, index);
    // When picking a pitch slot, show eligibility on bench chips (ideal cue via class).
    const chipOpts = {
      from: "bench",
      index,
      assignedRole: role,
    };
    if (pickEligible === true) {
      chipOpts.pickEligible = true;
      chipOpts.idealRole = idealRole;
    } else if (pickEligible === false) {
      chipOpts.pickEligible = false;
    }
    return `
      <div class="lu-bench-slot is-filled${highlight ? " is-drop" : ""}${
        pickEligible === true ? " is-pick-eligible" : pickEligible === false ? " is-pick-ineligible" : ""
      }${index === 0 ? " is-gk" : ""}"
        data-bench-index="${index}">
        <span class="lu-slot-label">${esc(role || label)}</span>
        ${chipHtml(p, chipOpts)}
        ${
          state.data?.can_edit
            ? `<button type="button" class="lu-slot-clear" data-clear-bench="${index}" title="${tr("lineup.toPool")}" aria-label="${tr("lineup.removeAria")}">×</button>`
            : ""
        }
      </div>`;
  }

  function pickerHtml(rosterOverride) {
    // Prefer pre-sorted rosterOverride (poolFiltered / pickerRoster); else sort by displayed xPts.
    const roster = rosterOverride
      ? [...rosterOverride]
      : [...(state.data?.roster || [])].sort(
          (a, b) =>
            Number(effectiveXPts(b, null) || 0) - Number(effectiveXPts(a, null) || 0),
        );
    const status = selectionStatus();
    const suggest = state.data?.can_edit ? suggestFromChecked() : null;

    const rows = roster
      .map((p) => {
        const checked = state.checkedIds.has(p.id);
        const disabled = !state.data?.can_edit || cannotNewlySelect(p);
        return `
          <label class="lu-check-row${checked ? " is-checked" : ""}${cannotNewlySelect(p) ? " is-locked" : ""}">
            <input type="checkbox" class="lu-check" data-check-id="${esc(p.id)}"
              ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
            <span class="lu-check-body">
              <span class="lu-chip-id" role="button" tabindex="0" aria-expanded="false" aria-haspopup="dialog"
                data-player-id="${esc(p.id)}" aria-label="${esc(tr("lineup.playerCardAria", { name: p.name }))}">
                <span class="lu-check-name-row">
                  <span class="lu-check-name">${esc(surname(p.name))}</span>
                  ${gwFptsHtml(p, "pool", null)}
                </span>
                <span class="lu-check-sub">${esc(p.position_display || "")} · ${esc(oppLabel(p, "full") || "—")}</span>
              </span>
            </span>
            <span class="lu-check-xpts">${esc(xPtsLabel(p, null))}${hasFormField(p) ? ` · ${esc(tr("lineup.form"))} ${esc(formValueLabel(p))}` : ""}</span>
          </label>`;
      })
      .join("");

    let suggestBlock = "";
    if (suggest?.kind === "ok") {
      const btns = suggest.fitting
        .map(
          (f) =>
            `<button type="button" class="auth-btn lu-form-btn" data-apply-form="${esc(f.formation.id)}">
              ${esc(f.formation.label)} · ${Number(f.assignment.score).toFixed(2)}
            </button>`,
        )
        .join("");
      suggestBlock = `
        <div class="lu-suggest is-ok">
          <p class="lu-suggest-title">Подходит:</p>
          <div class="lu-form-btns">${btns}</div>
        </div>`;
    } else if (suggest?.kind === "gaps" || suggest?.kind === "need") {
      suggestBlock = `
        <div class="lu-suggest is-need">
          <p>${esc(suggest.text)}</p>
        </div>`;
    }

    return `
      <div class="lu-picker">
        <h2 class="subhead">Выбор для схемы</h2>
        <p class="lu-picker-hint muted">${tr("lineup.pickerHint")}</p>
        <div class="lu-pick-status">
          GK ${status.gks.length}/1 · полевые ${status.outfield.length}/10+
        </div>
        <div class="lu-check-list">${rows || `<p class="muted">${tr("lineup.noneFound")}</p>`}</div>
        ${suggestBlock}
      </div>`;
  }

  function listFiltersHtml() {
    const lines = ["", "GK", "DEF", "MID", "ATT"];
    const labels = { "": tr("common.all"), GK: "GK", DEF: "DEF", MID: "MID", ATT: "ATT" };
    const btns = lines
      .map(
        (line) =>
          `<button type="button" class="lu-filter-btn${state.listLine === line ? " is-active" : ""}" data-list-line="${esc(line)}">${labels[line]}</button>`,
      )
      .join("");
    return `
      <div class="lu-list-filters">
        <div class="lu-line-filters" role="group" aria-label="${tr("lineup.lineFilterAria")}">${btns}</div>
        <label class="lu-name-filter">
          <input type="search" id="lu-list-q" placeholder="${tr("lineup.searchName")}" autocomplete="off"
            aria-label="${tr("lineup.searchName")}" value="${esc(state.listQuery)}" />
        </label>
      </div>`;
  }

  function listXiRowHtml(slot, index, p, highlight, picking) {
    const role = p
      ? roleForIndex(index) || defaultRoleForSlot(p, slot.roles) || slot.label
      : slot.label;
    const cls = [
      "lu-list-slot",
      p ? "is-filled" : "",
      highlight ? "is-drop" : "",
      picking ? "is-picking" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!p) {
      return `
        <div class="${cls}" data-slot-index="${index}" role="button" tabindex="0">
          <span class="lu-list-slot-pos">${esc(slot.label)}</span>
          <span class="lu-list-slot-empty muted">пусто</span>
        </div>`;
    }
    const assignedRole = roleForIndex(index) || defaultRoleForSlot(p, slot.roles);
    return `
      <div class="${cls}" data-slot-index="${index}">
        <span class="lu-list-slot-pos">${esc(role)}</span>
        <div class="lu-list-slot-body">
          ${chipHtml(p, { from: "slot", index, assignedRole })}
        </div>
        ${
          state.data?.can_edit
            ? `<button type="button" class="lu-slot-clear" data-clear-slot="${index}" title="${tr("lineup.toPool")}" aria-label="${tr("lineup.removeAria")}">×</button>`
            : ""
        }
      </div>`;
  }

  function listBenchRowHtml(index, highlight, pickInfo) {
    const pid = state.bench[index];
    const p = pid ? rosterById().get(pid) : null;
    const label = benchSlotLabel(index);
    const pickEligible = pickInfo?.eligible;
    const idealRole = pickInfo?.idealRole || null;
    const cls = [
      "lu-list-slot",
      "is-bench",
      index === 0 ? "is-gk" : "",
      p ? "is-filled" : "",
      highlight ? "is-drop" : "",
      pickEligible === true ? "is-pick-eligible" : "",
      pickEligible === false ? "is-pick-ineligible" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!p) {
      return `
        <div class="${cls}" data-bench-index="${index}" role="button" tabindex="0">
          <span class="lu-list-slot-pos">${esc(label)}</span>
          <span class="lu-list-slot-empty muted">пусто</span>
        </div>`;
    }
    const role = benchRoleForIndex(index) || defaultRoleForBench(p, index);
    const chipOpts = { from: "bench", index, assignedRole: role };
    if (pickEligible === true) {
      chipOpts.pickEligible = true;
      chipOpts.idealRole = idealRole;
    } else if (pickEligible === false) {
      chipOpts.pickEligible = false;
    }
    return `
      <div class="${cls}" data-bench-index="${index}">
        <span class="lu-list-slot-pos">${esc(role || label)}</span>
        <div class="lu-list-slot-body">
          ${chipHtml(p, chipOpts)}
        </div>
        ${
          state.data?.can_edit
            ? `<button type="button" class="lu-slot-clear" data-clear-bench="${index}" title="${tr("lineup.toPool")}" aria-label="${tr("lineup.removeAria")}">×</button>`
            : ""
        }
      </div>`;
  }

  function listSlotsPanelHtml(form, byId, highlightRoles, highlightBench, pickSlotRoles, pickLabel, benchCount) {
    const xiRows = (form?.slots || [])
      .map((slot, i) => {
        const pid = state.slots[i];
        const p = pid ? byId.get(pid) : null;
        return listXiRowHtml(slot, i, p, highlightRoles ? highlightRoles[i] : false, state.pickSlotIndex === i);
      })
      .join("");
    const benchRows = Array.from({ length: BENCH_SIZE }, (_, i) => {
      const hi = highlightBench ? highlightBench[i] : false;
      let pickInfo = null;
      if (pickSlotRoles) {
        const pid = state.bench[i];
        const p = pid ? byId.get(pid) : null;
        if (p) {
          const eligible = playerMatchesSlot(p, pickSlotRoles);
          pickInfo = {
            eligible,
            idealRole: eligible ? idealRoleForSlot(p, pickSlotRoles) : null,
          };
        }
      }
      return listBenchRowHtml(i, hi, pickInfo);
    }).join("");

    return `
      <section class="lu-slots-panel" aria-label="${tr("lineup.slotsAria")}">
        <div class="lu-slots-block">
          <div class="lu-bench-head">
            <h2 class="lu-bench-title">Основа</h2>
            <span class="lu-bench-meta muted">${state.slots.filter(Boolean).length}/11</span>
          </div>
          <div class="lu-slot-rows" id="lu-xi-list">${xiRows}</div>
        </div>
        <div class="lu-slots-block">
          <div class="lu-bench-head">
            <h2 class="lu-bench-title">${tr("lineup.bench")}</h2>
            <span class="lu-bench-meta muted">${tr("lineup.benchMeta", { n: benchCount })}</span>
          </div>
          <div class="lu-slot-rows${pickSlotRoles ? " is-picking" : ""}" id="lu-bench-list">${benchRows}</div>
        </div>
        <p class="lu-hint muted">${
          pickLabel
            ? tr("lineup.pickHint", { slot: esc(pickLabel) })
            : tr("lineup.hintList")
        }</p>
        ${
          state.feedback
            ? `<p class="lu-feedback" role="status">${esc(state.feedback)}</p>`
            : ""
        }
      </section>`;
  }

  /** Scroll containers wiped by innerHTML — capture before render, restore after. */
  function captureSideScroll() {
    const ids = {};
    const active = document.activeElement;
    if (active?.classList?.contains("lu-check")) {
      ids.checkId = active.getAttribute("data-check-id") || null;
    }
    const scrolls = {};
    for (const sel of [".lu-pool", ".lu-pool-list", ".lu-check-list"]) {
      const el = document.querySelector(sel);
      if (el) scrolls[sel] = el.scrollTop;
    }
    return { scrolls, ids };
  }

  function restoreSideScroll(saved) {
    if (!saved) return;
    for (const [sel, top] of Object.entries(saved.scrolls || {})) {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = top;
    }
    const checkId = saved.ids?.checkId;
    if (checkId) {
      const again = document.querySelector(`.lu-check[data-check-id="${CSS.escape(checkId)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  let idPopEl = null;
  let idPopTrigger = null;

  function idPopOpen() {
    return !!(idPopEl && !idPopEl.hidden && idPopTrigger);
  }

  function idPopCardHtml(p) {
    const club = p.club_name || "";
    const opp = oppLabel(p, "full");
    const pos = positionsLabel(p);
    const oppOk = opp && opp !== "—";
    const slotIdx = state.slots.indexOf(p.id);
    const from = slotIdx >= 0 ? "slot" : state.bench.includes(p.id) ? "bench" : "pool";
    const assignedRole =
      slotIdx >= 0
        ? roleForIndex(slotIdx) ||
          defaultRoleForSlot(p, baseFormation()?.slots[slotIdx]?.roles || [])
        : null;
    const fpts = gwFptsHtml(p, from, assignedRole);
    return `
      <div class="lu-id-pop-head">
        <p class="lu-id-pop-name" id="lu-id-pop-name">${esc(p.name || "")}${fpts}</p>
        <button type="button" class="auth-link lu-id-pop-close" aria-label="${esc(tr("common.close"))}">×</button>
      </div>
      ${club ? `<p class="lu-id-pop-club muted">${esc(club)}</p>` : ""}
      ${oppOk ? `<p class="lu-id-pop-opp">${esc(opp)}</p>` : ""}
      ${pos ? `<p class="lu-id-pop-pos">${esc(pos)}</p>` : ""}`;
  }

  function ensureIdPop() {
    if (idPopEl) return idPopEl;
    idPopEl = document.createElement("div");
    idPopEl.id = "lu-id-pop";
    idPopEl.className = "lu-id-pop";
    idPopEl.hidden = true;
    idPopEl.setAttribute("role", "dialog");
    idPopEl.setAttribute("aria-labelledby", "lu-id-pop-name");
    idPopEl.addEventListener("click", (e) => {
      if (e.target.closest?.(".lu-id-pop-close")) closeIdPop({ restoreFocus: true });
    });
    document.body.appendChild(idPopEl);
    return idPopEl;
  }

  function positionIdPop(trigger) {
    const pop = idPopEl;
    if (!pop || !trigger) return;
    const vv = window.visualViewport;
    const vw = vv?.width ?? window.innerWidth;
    const vh = vv?.height ?? window.innerHeight;
    const ox = vv?.offsetLeft ?? 0;
    const oy = vv?.offsetTop ?? 0;
    const gap = 6;
    const edge = 8;
    const r = trigger.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = r.left;
    let top = r.bottom + gap;
    if (top + h > oy + vh - edge) top = r.top - h - gap;
    left = Math.min(Math.max(left, ox + edge), ox + vw - w - edge);
    top = Math.min(Math.max(top, oy + edge), oy + vh - h - edge);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function closeIdPop(opts = {}) {
    const restore = opts.restoreFocus !== false;
    const trigger = idPopTrigger;
    if (idPopEl) {
      idPopEl.hidden = true;
      idPopEl.innerHTML = "";
    }
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-controls");
      if (restore) trigger.focus({ preventScroll: true });
    }
    idPopTrigger = null;
  }

  function openIdPop(trigger, p) {
    const pop = ensureIdPop();
    if (idPopTrigger && idPopTrigger !== trigger) {
      idPopTrigger.setAttribute("aria-expanded", "false");
      idPopTrigger.removeAttribute("aria-controls");
    }
    idPopTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", "lu-id-pop");
    pop.innerHTML = idPopCardHtml(p);
    pop.style.visibility = "hidden";
    pop.hidden = false;
    positionIdPop(trigger);
    pop.style.visibility = "";
    pop.querySelector(".lu-id-pop-close")?.focus({ preventScroll: true });
  }

  function toggleIdPop(trigger, p) {
    if (idPopTrigger === trigger && idPopOpen()) {
      closeIdPop({ restoreFocus: true });
      return;
    }
    openIdPop(trigger, p);
  }

  function bindChipIdTriggers() {
    document.querySelectorAll(".lu-chip-id").forEach((el) => {
      const pid = el.getAttribute("data-player-id");
      const run = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const p = pid ? rosterById().get(pid) : null;
        if (!p) return;
        toggleIdPop(el, p);
      };
      el.addEventListener("click", run);
      el.addEventListener(
        "pointerdown",
        (e) => {
          e.stopPropagation();
          const chip = el.closest(".lu-chip");
          if (chip?.getAttribute("draggable") === "true") {
            chip.setAttribute("draggable", "false");
            const restore = () => {
              chip.setAttribute("draggable", "true");
              window.removeEventListener("pointerup", restore, true);
              window.removeEventListener("pointercancel", restore, true);
            };
            window.addEventListener("pointerup", restore, true);
            window.addEventListener("pointercancel", restore, true);
          }
        },
        true,
      );
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") run(e);
      });
    });
  }

  function bindIdPopDismiss() {
    document.addEventListener("pointerdown", (e) => {
      if (!idPopOpen()) return;
      if (e.target.closest?.("#lu-id-pop, .lu-chip-id")) return;
      closeIdPop({ restoreFocus: false });
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !idPopOpen()) return;
        e.preventDefault();
        e.stopPropagation();
        closeIdPop({ restoreFocus: true });
      },
      true,
    );
    window.addEventListener("resize", () => {
      if (idPopOpen()) positionIdPop(idPopTrigger);
    });
    window.addEventListener(
      "scroll",
      () => {
        if (!idPopOpen()) return;
        const r = idPopTrigger.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) {
          closeIdPop({ restoreFocus: false });
          return;
        }
        positionIdPop(idPopTrigger);
      },
      true,
    );
  }

  function render() {
    closeIdPop({ restoreFocus: false });
    const app = $("app");
    if (!app || !state.data) return;
    const savedScroll = captureSideScroll();
    const data = state.data;
    const form = currentFormation();
    const byId = rosterById();
    const used = usedIds();
    const pool = (data.roster || []).filter((p) => !used.has(p.id));

    const gwOpts = (data.gameweeks || [])
      .map(
        (g) =>
          `<option value="${g.gameweek}"${g.gameweek === state.gw ? " selected" : ""}>${esc(g.label)}</option>`,
      )
      .join("");

    const formOpts = (data.formations || [])
      .map(
        (f) =>
          `<option value="${esc(f.id)}"${f.id === state.formationId ? " selected" : ""}>${esc(f.label)}</option>`,
      )
      .join("");

    const xiCount = state.slots.filter(Boolean).length;
    const benchCount = state.bench.filter(Boolean).length;
    const xiPts = state.slots.reduce((sum, id, i) => {
      const p = id ? byId.get(id) : null;
      if (!p) return sum;
      const role = roleForIndex(i) || defaultRoleForSlot(p, form?.slots[i]?.roles || []);
      return sum + Number(effectiveXPts(p, role) || 0);
    }, 0);
    const highlightRoles = (() => {
      if (!state.selectedId || !form) return null;
      const p = byId.get(state.selectedId);
      if (!p) return null;
      return form.slots.map((s) => playerMatchesSlot(p, s.roles));
    })();
    const highlightBench = (() => {
      if (!state.selectedId) return null;
      const p = byId.get(state.selectedId);
      if (!p) return null;
      return Array.from({ length: BENCH_SIZE }, (_, i) => playerMatchesBench(p, i));
    })();

    const pickSlotRoles =
      state.pickSlotIndex != null && form
        ? form.slots[state.pickSlotIndex]?.roles || []
        : null;

    const pitchSlots = (form?.slots || [])
      .map((slot, i) => {
        const pid = state.slots[i];
        const p = pid ? byId.get(pid) : null;
        const hi = highlightRoles ? highlightRoles[i] : false;
        const picking = state.pickSlotIndex === i;
        if (p) return filledSlotHtml(slot, i, p, hi, picking);
        return emptySlotHtml(slot, i, hi, picking);
      })
      .join("");

    const benchSlots = Array.from({ length: BENCH_SIZE }, (_, i) => {
      const hi = highlightBench ? highlightBench[i] : false;
      let pickInfo = null;
      if (pickSlotRoles) {
        const pid = state.bench[i];
        const p = pid ? byId.get(pid) : null;
        if (p) {
          const eligible = playerMatchesSlot(p, pickSlotRoles);
          pickInfo = {
            eligible,
            idealRole: eligible ? idealRoleForSlot(p, pickSlotRoles) : null,
          };
        }
      }
      return benchSlotHtml(i, hi, pickInfo);
    }).join("");

    // When a pitch slot is selected, hide ineligible players entirely (both pool + checkbox picker).
    // Sort by displayed xPts (effective with null role = base after competition multipliers).
    const byXPtsDesc = (a, b) =>
      Number(effectiveXPts(b, null) || 0) - Number(effectiveXPts(a, null) || 0);
    const poolFiltered = (() => {
      let list = state.viewMode === "list" ? pool.filter(matchesListFilter) : [...pool];
      if (pickSlotRoles) list = list.filter((p) => playerMatchesSlot(p, pickSlotRoles));
      list = list.filter((p) => !cannotNewlySelect(p));
      return list.sort(byXPtsDesc);
    })();
    const pickerRoster = (() => {
      let list =
        state.viewMode === "list"
          ? (data.roster || []).filter(matchesListFilter)
          : [...(data.roster || [])];
      if (pickSlotRoles) list = list.filter((p) => playerMatchesSlot(p, pickSlotRoles));
      list = list.filter((p) => !cannotNewlySelect(p));
      return list.sort(byXPtsDesc);
    })();

    const poolHtml = poolFiltered.length
      ? poolFiltered
          .map((p) => {
            if (!pickSlotRoles) return chipHtml(p, { from: "pool" });
            return chipHtml(p, {
              from: "pool",
              pickEligible: true,
              idealRole: idealRoleForSlot(p, pickSlotRoles),
            });
          })
          .join("")
      : `<p class="muted">${
          pool.length && (state.viewMode === "list" || pickSlotRoles)
            ? pickSlotRoles
              ? tr("lineup.noneFound")
              : tr("lineup.noFilter")
            : tr("lineup.allInLineup")
        }</p>`;

    const pickLabel =
      state.pickSlotIndex != null && form
        ? form.slots[state.pickSlotIndex]?.label || String(state.pickSlotIndex + 1)
        : null;

    const refreshedWhen =
      data.league === "top4" && data.refreshed_at
        ? formatRefreshAt(data.refreshed_at)
        : "";

    const isList = state.viewMode === "list";
    const viewToggle = `
      <div class="lu-view-toggle" role="group" aria-label="${tr("lineup.viewAria")}">
        <button type="button" class="lu-view-btn${isList ? " is-active" : ""}" data-view-mode="list"
          aria-pressed="${isList ? "true" : "false"}">${tr("lineup.viewList")}</button>
        <button type="button" class="lu-view-btn${!isList ? " is-active" : ""}" data-view-mode="pitch"
          aria-pressed="${!isList ? "true" : "false"}">${tr("lineup.viewPitch")}</button>
      </div>`;

    const mainPanel = isList
      ? listSlotsPanelHtml(form, byId, highlightRoles, highlightBench, pickSlotRoles, pickLabel, benchCount)
      : `
        <section class="lu-pitch-wrap" aria-label="${tr("lineup.pitchAria")}">
          <div class="lu-pitch" id="lu-pitch">${pitchSlots}</div>
          <p class="lu-hint muted">${
            pickLabel
              ? tr("lineup.pickHintPitch", { slot: esc(pickLabel) })
              : tr("lineup.hintPitch")
          }</p>
          <div class="lu-bench" aria-label="${tr("lineup.benchAria")}">
            <div class="lu-bench-head">
              <h2 class="lu-bench-title">${tr("lineup.bench")}</h2>
              <span class="lu-bench-meta muted">${tr("lineup.benchMeta", { n: benchCount })}</span>
            </div>
            <div class="lu-bench-row${pickSlotRoles ? " is-picking" : ""}" id="lu-bench">${benchSlots}</div>
          </div>
          ${
            state.feedback
              ? `<p class="lu-feedback" role="status">${esc(state.feedback)}</p>`
              : ""
          }
        </section>`;

    app.innerHTML = `
      <section class="lu-toolbar">
        <div class="lu-team-name">${
          data.team.logo_url
            ? `<img class="top4-team-logo top4-team-logo--lg" src="${esc(data.team.logo_url)}" alt="" width="40" height="40" />`
            : ""
        }<span>${esc(data.team.name)}</span></div>
        <label class="gw-select${
          data.nextGw != null && Number(state.gw) === Number(data.nextGw)
            ? " is-next-gw"
            : ""
        }">${tr("lineup.gw")}
          <select id="lu-gw">${gwOpts || "<option>—</option>"}</select>
        </label>
        ${
          data.deadline_at
            ? `<span class="lu-deadline${data.deadline_passed ? " is-passed" : ""}" id="lu-deadline" title="${esc(tr("lineup.deadlineHint"))}"></span>`
            : ""
        }
        <label class="gw-select">${tr("lineup.formation")}
          <select id="lu-formation"${data.can_edit ? "" : " disabled"}>${formOpts}</select>
        </label>
        ${
          supportsBack5(baseFormation())
            ? `<button type="button" class="auth-btn lu-btn-secondary" id="lu-back5"${
                data.can_edit ? "" : " disabled"
              } title="${tr("lineup.back5Title")}">${
                state.back5 ? tr("lineup.back3") : tr("lineup.back5")
              }</button>`
            : ""
        }
        ${viewToggle}
        <div class="lu-actions">
          <span class="lu-count">${tr("lineup.count", { xi: xiCount, bench: benchCount })}${xiCount ? ` · ${xiPts.toFixed(2)} xPts` : ""}</span>
          ${
            data.league === "top4"
              ? `<span class="lu-refresh-wrap"><button type="button" class="auth-btn lu-btn-secondary" id="lineup-refresh">${tr("lineup.refresh")}</button>${
                  refreshedWhen
                    ? `<span class="lu-refreshed" title="${esc(refreshedWhen)}">${esc(tr("lineup.refreshedAt", { when: refreshedWhen }))}</span>`
                    : ""
                }</span>`
              : ""
          }
          ${
            data.can_edit
              ? `<button type="button" class="auth-btn lu-btn-secondary" id="lineup-clear" title="${tr("lineup.clearTitle")}">${tr("lineup.clear")}</button>
                 <button type="button" class="auth-btn" id="lineup-save"${state.dirty ? "" : " disabled"}>${tr("common.save")}</button>`
              : `<span class="muted">${tr("common.viewOnly")}</span>`
          }
        </div>
      </section>

      <div class="lu-layout${isList ? " is-list" : ""}">
        ${mainPanel}
        <aside class="lu-side${isList ? " is-list" : ""}" aria-label="${tr("lineup.sideAria")}">
          ${isList ? listFiltersHtml() : ""}
          <div class="lu-side-panels">
            <div class="lu-pool">
              <h2 class="subhead">${pickLabel ? tr("lineup.poolFor", { slot: esc(pickLabel) }) : tr("lineup.pool")}</h2>
              <div class="lu-pool-list${pickSlotRoles ? " is-picking" : ""}" id="lu-pool">${poolHtml}</div>
            </div>
            ${pickerHtml(pickerRoster)}
          </div>
        </aside>
      </div>
    `;

    bindEvents();
    restoreSideScroll(savedScroll);
    startDeadlineTick();
  }

  function bindEvents() {
    const gwSel = $("lu-gw");
    if (gwSel) {
      gwSel.addEventListener("change", () => {
        load(null, Number(gwSel.value));
      });
    }
    const formSel = $("lu-formation");
    if (formSel) {
      formSel.addEventListener("change", () => applyFormation(formSel.value));
    }
    const back5Btn = $("lu-back5");
    if (back5Btn) {
      back5Btn.addEventListener("click", () => setBack5(!state.back5));
    }
    const saveBtn = $("lineup-save");
    if (saveBtn) saveBtn.addEventListener("click", save);
    const clearBtn = $("lineup-clear");
    if (clearBtn) clearBtn.addEventListener("click", clearAll);
    const refreshBtn = $("lineup-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshInfo);

    document.querySelectorAll("[data-view-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-view-mode");
        if (mode !== "list" && mode !== "pitch") return;
        if (state.viewMode === mode) return;
        state.viewMode = mode;
        saveViewMode(mode);
        render();
      });
    });

    document.querySelectorAll("[data-list-line]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.listLine = btn.getAttribute("data-list-line") || "";
        render();
      });
    });

    const nameQ = $("lu-list-q");
    if (nameQ) {
      nameQ.addEventListener("input", () => {
        state.listQuery = nameQ.value;
        const caret = nameQ.selectionStart;
        render();
        const again = $("lu-list-q");
        if (again) {
          again.focus();
          try {
            again.setSelectionRange(caret, caret);
          } catch {
            /* ignore */
          }
        }
      });
    }

    document.querySelectorAll(".lu-slot-clear").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const slot = btn.getAttribute("data-clear-slot");
        const bench = btn.getAttribute("data-clear-bench");
        if (slot != null) clearSlot(Number(slot));
        else if (bench != null) clearBenchSlot(Number(bench));
      });
    });

    document.querySelectorAll("[data-cycle-slot]").forEach((btn) => {
      const run = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const idx = Number(btn.getAttribute("data-cycle-slot"));
        if (Number.isInteger(idx)) cycleSlotVariant(idx);
      };
      // Capture so chip/slot selection never sees badge clicks.
      btn.addEventListener("click", run, true);
      btn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
      btn.addEventListener("mousedown", (e) => e.stopPropagation(), true);
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") run(e);
      });
    });

    document.querySelectorAll("[data-cycle-bench]").forEach((btn) => {
      const run = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const idx = Number(btn.getAttribute("data-cycle-bench"));
        if (Number.isInteger(idx)) cycleBenchVariant(idx);
      };
      btn.addEventListener("click", run, true);
      btn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
      btn.addEventListener("mousedown", (e) => e.stopPropagation(), true);
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") run(e);
      });
    });

    document.querySelectorAll(".lu-check").forEach((el) => {
      el.addEventListener("change", () => {
        if (!state.data?.can_edit) return;
        const id = el.getAttribute("data-check-id");
        if (!id) return;
        if (el.checked) state.checkedIds.add(id);
        else state.checkedIds.delete(id);
        render();
      });
    });

    document.querySelectorAll("[data-apply-form]").forEach((btn) => {
      btn.addEventListener("click", () => {
        applySuggestedFormation(btn.getAttribute("data-apply-form"));
      });
    });

    document.querySelectorAll(".lu-chip").forEach((el) => {
      const pid = el.getAttribute("data-player-id");
      const from = el.getAttribute("data-from");
      const slotIndex = el.getAttribute("data-slot-index");

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.data?.can_edit) return;
        // Role badge / identity card own their clicks; never treat as player select.
        if (e.target.closest?.("[data-cycle-slot], [data-cycle-bench], .lu-role-badge, .lu-chip-id"))
          return;
        if (el.classList.contains("is-ineligible")) return;
        const chipPlayer = pid ? rosterById().get(pid) : null;
        if (cannotNewlySelect(chipPlayer)) return;

        // Slot-pick mode: place eligible player onto the target slot.
        if (state.pickSlotIndex != null) {
          // Second click on the same occupied slot's chip → cancel pick mode.
          if (
            from === "slot" &&
            slotIndex !== "" &&
            slotIndex != null &&
            Number(slotIndex) === state.pickSlotIndex
          ) {
            clearPickMode();
            setFeedback(null);
            render();
            return;
          }
          const form = currentFormation();
          const roles = form?.slots[state.pickSlotIndex]?.roles || [];
          const p = rosterById().get(pid);
          if (p && playerMatchesSlot(p, roles)) {
            placePlayer(pid, state.pickSlotIndex);
          }
          return;
        }

        // Pitch chip with no player selected → enter pick mode for that slot.
        if (from === "slot" && slotIndex !== "" && slotIndex != null && !state.selectedId) {
          const idx = Number(slotIndex);
          state.pickSlotIndex = idx;
          setFeedback(null);
          render();
          return;
        }

        if (state.selectedId === pid) {
          state.selectedId = null;
          render();
          return;
        }
        state.selectedId = pid;
        clearPickMode();
        render();
      });

      el.addEventListener("dragstart", (e) => {
        if (!state.data?.can_edit) return;
        if (el.classList.contains("is-ineligible")) {
          e.preventDefault();
          return;
        }
        state.dragFrom = {
          type: from,
          id: pid,
          index: slotIndex === "" || slotIndex == null ? null : Number(slotIndex),
        };
        e.dataTransfer.setData("text/plain", pid);
        e.dataTransfer.effectAllowed = "move";
        el.classList.add("is-dragging");
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("is-dragging");
        state.dragFrom = null;
      });
    });

    function bindXiSlotEl(slotEl) {
      const index = Number(slotEl.getAttribute("data-slot-index"));

      slotEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.data?.can_edit) return;
        if (e.target.closest?.(".lu-slot-clear, [data-cycle-slot], .lu-role-badge, .lu-chip-id")) return;

        // Player already selected → place onto this slot.
        if (state.selectedId) {
          placePlayer(state.selectedId, index);
          return;
        }

        // Toggle pick-for-slot mode (empty or occupied).
        if (state.pickSlotIndex === index) {
          clearPickMode();
          setFeedback(null);
          render();
          return;
        }
        state.pickSlotIndex = index;
        state.selectedId = null;
        setFeedback(null);
        render();
      });

      slotEl.addEventListener("dragover", (e) => {
        if (!state.data?.can_edit) return;
        e.preventDefault();
        const pid = state.dragFrom?.id || state.selectedId;
        if (!pid) return;
        const form = currentFormation();
        const p = rosterById().get(pid);
        if (p && playerMatchesSlot(p, form?.slots[index]?.roles)) {
          slotEl.classList.add("is-drop");
          e.dataTransfer.dropEffect = "move";
        }
      });
      slotEl.addEventListener("dragleave", () => slotEl.classList.remove("is-drop"));
      slotEl.addEventListener("drop", (e) => {
        e.preventDefault();
        slotEl.classList.remove("is-drop");
        const pid = e.dataTransfer.getData("text/plain") || state.dragFrom?.id;
        if (pid) placePlayer(pid, index);
      });
    }

    document.querySelectorAll(".lu-slot").forEach(bindXiSlotEl);
    document.querySelectorAll(".lu-list-slot[data-slot-index]").forEach(bindXiSlotEl);

    function bindBenchSlotEl(slotEl) {
      const index = Number(slotEl.getAttribute("data-bench-index"));

      slotEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.data?.can_edit) return;
        if (e.target.closest?.(".lu-slot-clear, [data-cycle-bench], .lu-role-badge, .lu-chip-id")) return;

        // In pitch slot-pick mode, placing onto bench clears pick via placeOnBench.
        if (state.pickSlotIndex != null) {
          // Only place if the click was on an eligible bench chip (handled by chip).
          // Empty bench / ineligible: ignore for pick mode.
          return;
        }

        if (state.selectedId) {
          placeOnBench(state.selectedId, index);
        }
      });

      slotEl.addEventListener("dragover", (e) => {
        if (!state.data?.can_edit) return;
        e.preventDefault();
        const pid = state.dragFrom?.id || state.selectedId;
        if (!pid) return;
        const p = rosterById().get(pid);
        if (p && playerMatchesBench(p, index)) {
          slotEl.classList.add("is-drop");
          e.dataTransfer.dropEffect = "move";
        }
      });
      slotEl.addEventListener("dragleave", () => slotEl.classList.remove("is-drop"));
      slotEl.addEventListener("drop", (e) => {
        e.preventDefault();
        slotEl.classList.remove("is-drop");
        const pid = e.dataTransfer.getData("text/plain") || state.dragFrom?.id;
        if (pid) placeOnBench(pid, index);
      });
    }

    document.querySelectorAll(".lu-bench-slot").forEach(bindBenchSlotEl);
    document.querySelectorAll(".lu-list-slot[data-bench-index]").forEach(bindBenchSlotEl);

    const pool = $("lu-pool");
    if (pool) {
      pool.addEventListener("dragover", (e) => {
        if (!state.data?.can_edit) return;
        e.preventDefault();
      });
      pool.addEventListener("drop", (e) => {
        e.preventDefault();
        const pid = e.dataTransfer.getData("text/plain") || state.dragFrom?.id;
        if (
          pid &&
          (state.dragFrom?.type === "slot" || state.dragFrom?.type === "bench")
        ) {
          returnToPool(pid);
        }
      });
      pool.addEventListener("click", (e) => {
        if (e.target === pool && state.selectedId) {
          if (usedIds().has(state.selectedId)) {
            returnToPool(state.selectedId);
          }
        }
      });
    }

    bindChipIdTriggers();
  }

  function bindGlobalDismiss() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.pickSlotIndex == null && !state.selectedId) return;
      clearSelectionModes();
      setFeedback(null);
      render();
    });
    document.addEventListener("click", (e) => {
      if (state.pickSlotIndex == null) return;
      if (
        e.target.closest?.(
          ".lu-slot, .lu-list-slot, .lu-chip, .lu-bench-slot, .lu-slot-clear, .lu-role-badge, .lu-chip-id, #lu-id-pop, .lu-toolbar, .lu-picker, .lu-check-row, .lu-list-filters, .auth-btn, select, a, input",
        )
      ) {
        return;
      }
      clearPickMode();
      setFeedback(null);
      render();
    });
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    const gw = params.get("gw") ? Number(params.get("gw")) : null;
    bindGlobalDismiss();
    bindIdPopDismiss();
    await load(null, gw);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  document.addEventListener("din8sty:lang", () => {
    if (typeof globalThis.applyI18n === "function") globalThis.applyI18n(document);
    if (state.data) render();
  });
})();
