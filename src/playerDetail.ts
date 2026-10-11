import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { formatPositionDisplay } from "./positions.js";
import { sanitizePortraitUrl } from "./playerAvatar.js";
import { listPlayerCoaches } from "./playerCoaches.js";
import { ensurePlayerCoaches } from "./coachSync.js";
import { listPlayerTransfers } from "./playerTransfers.js";
import { ensurePlayerTransfers } from "./transferSync.js";
import { loadWagePeers, withTrustedWage } from "./trustedWage.js";

type Row = Record<string, unknown>;

function money(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJson(raw: unknown): Row {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw)) as Row;
  } catch {
    return {};
  }
}

function openTmDb(root: string): Database.Database | null {
  const tmPath =
    process.env.TM_DB_PATH ?? path.resolve(root, "..", "transfermarkt", "data", "app.db");
  if (!fs.existsSync(tmPath)) return null;
  try {
    return new Database(tmPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function refLookup(tm: Database.Database, category: string, id: unknown) {
  if (id == null || id === "" || id === 0 || id === "0") return null;
  const row = tm
    .prepare(`SELECT id, name, raw_json FROM tm_ref WHERE category = ? AND id = ?`)
    .get(category, String(id)) as { id: string; name: string | null; raw_json: string | null } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, raw: parseJson(row.raw_json) };
}

function enrichFromTm(tm: Database.Database, playerId: string) {
  const rows = tm
    .prepare(
      `SELECT sp.*, cl.name AS club_name, cl.crest_url AS club_crest, cl.city AS club_city
       FROM tm_squad_players sp
       LEFT JOIN tm_clubs cl ON cl.id = sp.club_id
       WHERE sp.player_id = ?
       ORDER BY sp.synced_at DESC`,
    )
    .all(playerId) as Row[];
  if (!rows.length) return null;

  const primary = rows[0]!;
  const raw = parseJson(primary.raw_json);
  const attrs = (raw.attributes ?? {}) as Row;
  const life = (raw.lifeDates ?? {}) as Row;
  const birth = (raw.birthPlaceDetails ?? {}) as Row;
  const natBlock = (raw.nationalityDetails ?? {}) as Row;
  const nat = (natBlock.nationalities ?? {}) as Row;
  const mv = (raw.marketValueDetails ?? {}) as Row;
  const mvCurrent = (mv.current ?? {}) as Row;
  const mvPrev = (mv.previous ?? {}) as Row;
  const mvHigh = (mv.highest ?? {}) as Row;
  const mvDelta = (mv.delta ?? {}) as Row;
  const agency = (attrs.consultantAgency ?? {}) as Row;
  const foot = (attrs.preferredFoot ?? {}) as Row;
  const pos = (attrs.position ?? {}) as Row;
  const side1 = (attrs.firstSidePosition ?? {}) as Row;
  const side2 = (attrs.secondSidePosition ?? {}) as Row;

  const nationalityId = nat.nationalityId != null ? Number(nat.nationalityId) : null;
  const secondNatId =
    nat.secondNationalityId && Number(nat.secondNationalityId) > 0
      ? Number(nat.secondNationalityId)
      : null;
  const birthCountryId = birth.countryOfBirthId != null ? Number(birth.countryOfBirthId) : null;
  const outfitterId = attrs.outfitterId != null ? Number(attrs.outfitterId) : null;

  const nationality = refLookup(tm, "countries", nationalityId);
  const secondNationality = refLookup(tm, "countries", secondNatId);
  const birthCountry = refLookup(tm, "countries", birthCountryId);
  const confederation = refLookup(
    tm,
    "confederations",
    nationality?.raw?.confederationId != null ? Number(nationality.raw.confederationId) : null,
  );
  const outfitter = refLookup(tm, "outfitters", outfitterId);
  const outfitterRaw = attrs.outfitter as Row | undefined;
  const sidePos1 = refLookup(tm, "positions", attrs.firstSidePositionId);
  const sidePos2 = refLookup(tm, "positions", attrs.secondSidePositionId);

  const lineupRows = tm
    .prepare(
      `SELECT l.game_id, l.club_id, l.is_starter, l.shirt_number, l.is_captain, l.position_label,
              g.date_utc, g.competition_id, g.home_club_id, g.away_club_id,
              g.home_score, g.away_score,
              h.name AS home_name, a.name AS away_name
       FROM tm_game_lineup l
       JOIN tm_games g ON g.id = l.game_id
       LEFT JOIN tm_clubs h ON h.id = g.home_club_id
       LEFT JOIN tm_clubs a ON a.id = g.away_club_id
       WHERE l.player_id = ?
       ORDER BY COALESCE(g.date_utc, '') DESC
       LIMIT 100`,
    )
    .all(playerId) as Row[];

  const eventRows = tm
    .prepare(
      `SELECT e.game_id, e.minute, e.event_type, e.action, e.reason,
              e.active_player_id, e.passive_player_id,
              g.date_utc, h.name AS home_name, a.name AS away_name
       FROM tm_game_events e
       JOIN tm_games g ON g.id = e.game_id
       LEFT JOIN tm_clubs h ON h.id = g.home_club_id
       LEFT JOIN tm_clubs a ON a.id = g.away_club_id
       WHERE e.active_player_id = ? OR e.passive_player_id = ?
       ORDER BY COALESCE(g.date_utc, '') DESC, COALESCE(e.minute, 0)
       LIMIT 100`,
    )
    .all(playerId, playerId) as Row[];

  return {
    short_name: (raw.shortName as string) ?? null,
    display_name: (raw.displayName as string) ?? null,
    passport_name: (natBlock.passportName as string) ?? null,
    place_of_birth: (birth.placeOfBirth as string) ?? (primary.place_of_birth as string) ?? null,
    gender: (birth.gender as string) ?? (primary.gender as string) ?? null,
    birth_country: birthCountry
      ? { id: birthCountryId, name: birthCountry.name, flag_url: birthCountry.raw?.flagUrl ?? null }
      : null,
    former_clubs_note: (attrs.formerClubsNote as string) || null,
    last_contract_renewal: (attrs.lastContractRenewal as string) ?? null,
    agency: {
      id: agency.id != null ? Number(agency.id) : null,
      name: (agency.name as string) ?? (primary.agency_name as string) ?? null,
      verified: (agency.verificationStatus as string) ?? null,
    },
    outfitter: outfitter
      ? { id: outfitter.id, name: outfitter.name }
      : outfitterRaw?.name
        ? { id: outfitterId, name: String(outfitterRaw.name) }
        : null,
    market_value_detail: {
      current: money(mvCurrent.value) ?? money(primary.market_value_eur),
      previous: money(mvPrev.value) ?? money(primary.market_value_previous),
      highest: money(mvHigh.value) ?? money(primary.market_value_highest),
      current_determined: (mvCurrent.determined as string) ?? null,
      previous_determined: (mvPrev.determined as string) ?? null,
      highest_determined: (mvHigh.determined as string) ?? null,
      delta_value: (mvDelta.value as string) ?? null,
      delta_type: (mvDelta.type as string) ?? null,
    },
    nationality_detail: {
      id: nationalityId,
      name: nationality?.name ?? null,
      fifa_code: (nationality?.raw?.fifaCode as string) ?? null,
      flag_url: (nationality?.raw?.flagUrl as string) ?? null,
      confederation: confederation ? { id: confederation.id, name: confederation.name } : null,
      second: secondNationality
        ? {
            id: secondNatId,
            name: secondNationality.name,
            fifa_code: (secondNationality.raw?.fifaCode as string) ?? null,
            flag_url: (secondNationality.raw?.flagUrl as string) ?? null,
          }
        : null,
    },
    positions_detail: {
      main: {
        label: (pos.shortName as string) ?? (primary.detail_label as string) ?? null,
        name: (pos.name as string) ?? null,
        group: (attrs.positionGroupName as string) ?? null,
        category: (pos.category as string) ?? null,
      },
      extras: [
        side1.shortName || side1.name || sidePos1
          ? {
              label: (side1.shortName as string) ?? (sidePos1?.raw?.shortName as string) ?? sidePos1?.name ?? null,
              name: (side1.name as string) ?? sidePos1?.name ?? null,
            }
          : null,
        side2.shortName || side2.name || sidePos2
          ? {
              label: (side2.shortName as string) ?? (sidePos2?.raw?.shortName as string) ?? sidePos2?.name ?? null,
              name: (side2.name as string) ?? sidePos2?.name ?? null,
            }
          : null,
      ].filter(Boolean),
    },
    preferred_foot_detail: (foot.name as string) ?? null,
    date_of_birth_tm: (life.dateOfBirth as string) ?? null,
    clubs_history: rows.map((r) => ({
      club_id: String(r.club_id),
      club_name: (r.club_name as string) ?? null,
      club_crest: (r.club_crest as string) ?? null,
      club_city: (r.club_city as string) ?? null,
      shirt_number: r.shirt_number == null ? null : Number(r.shirt_number),
      is_captain: Boolean(r.is_captain),
    })),
    assignments: Array.isArray(raw.clubAssignments) ? raw.clubAssignments : [],
    matches: lineupRows.map((r) => ({
      game_id: String(r.game_id),
      date_utc: (r.date_utc as string) ?? null,
      competition_id: (r.competition_id as string) ?? null,
      home_club_name: (r.home_name as string) ?? null,
      away_club_name: (r.away_name as string) ?? null,
      home_score: r.home_score == null ? null : Number(r.home_score),
      away_score: r.away_score == null ? null : Number(r.away_score),
      is_starter: Boolean(r.is_starter),
      shirt_number: r.shirt_number == null ? null : Number(r.shirt_number),
      position_label: (r.position_label as string) ?? null,
    })),
    events: eventRows.map((r) => {
      const active = String(r.active_player_id ?? "") === playerId;
      const eventType = String(r.event_type ?? "");
      let eventLabel = eventType;
      if (eventType === "goals") eventLabel = "Гол";
      else if (eventType === "cards") eventLabel = "Карточка";
      else if (eventType === "substitutes") eventLabel = "Замена";
      return {
        game_id: String(r.game_id),
        date_utc: (r.date_utc as string) ?? null,
        home_club_name: (r.home_name as string) ?? null,
        away_club_name: (r.away_name as string) ?? null,
        minute: r.minute == null ? null : Number(r.minute),
        event_type: eventType || null,
        event_label: eventLabel || null,
        action: (r.action as string) ?? null,
        reason: (r.reason as string) ?? null,
        role: active ? "active" : "passive",
      };
    }),
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function normName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(playerName: string, statName: string): boolean {
  const want = normName(playerName);
  const got = normName(statName);
  if (!want || !got) return false;
  if (want === got) return true;
  if (got.includes(want) || want.includes(got)) return true;
  const wantTok = want.split(" ").filter((t) => t.length > 0);
  const gotTok = got.split(" ").filter((t) => t.length > 0);
  const last = wantTok[wantTok.length - 1];
  if (!last || !gotTok.includes(last)) return false;
  const wFirst = wantTok.length >= 2 ? wantTok[0] : "";
  const gFirst = gotTok.length >= 2 ? gotTok[0] : "";
  if (!wFirst || !gFirst) return last.length >= 4;
  if (wFirst === gFirst) return true;
  return (
    wFirst[0] === gFirst[0] && (wFirst.length === 1 || gFirst.length === 1)
  );
}

function afEventLabel(type: string): string {
  const t = type.toLowerCase();
  if (t === "goal") return "Гол";
  if (t === "card") return "Карточка";
  if (t === "subst" || t === "substitution") return "Замена";
  if (t === "var") return "VAR";
  return type || "—";
}

type AfMatchRow = {
  game_id: string;
  date_utc: string | null;
  competition_id: string | null;
  home_club_name: string | null;
  away_club_name: string | null;
  home_score: number | null;
  away_score: number | null;
  is_starter: boolean;
  shirt_number: number | null;
  position_label: string | null;
};

type AfEventRow = {
  game_id: string;
  date_utc: string | null;
  home_club_name: string | null;
  away_club_name: string | null;
  minute: number | null;
  event_type: string | null;
  event_label: string | null;
  action: string | null;
  reason: string | null;
  role: "active" | "passive";
};

/** Current-season appearances + events from AF GW stats already in din8sty.db. */
function enrichFromAf(
  db: Database.Database,
  playerId: string,
  playerName: string,
  clubId: string,
): { matches: AfMatchRow[]; events: AfEventRow[] } {
  const empty = { matches: [] as AfMatchRow[], events: [] as AfEventRow[] };
  if (
    !tableExists(db, "af_gw_player_stats") ||
    !tableExists(db, "fixtures") ||
    !tableExists(db, "club_af_map")
  ) {
    return empty;
  }

  const teamIds = new Set<number>();
  for (const row of db
    .prepare(`SELECT af_team_id FROM club_af_map WHERE club_id = ?`)
    .all(clubId) as Array<{ af_team_id: number }>) {
    teamIds.add(Number(row.af_team_id));
  }
  if (tableExists(db, "player_transfers")) {
    const clubs = db
      .prepare(
        `SELECT to_club_id AS club_id FROM player_transfers WHERE player_id = ?
         UNION
         SELECT from_club_id FROM player_transfers WHERE player_id = ?`,
      )
      .all(playerId, playerId) as Array<{ club_id: string | null }>;
    for (const c of clubs) {
      if (!c.club_id) continue;
      for (const row of db
        .prepare(`SELECT af_team_id FROM club_af_map WHERE club_id = ?`)
        .all(String(c.club_id)) as Array<{ af_team_id: number }>) {
        teamIds.add(Number(row.af_team_id));
      }
    }
  }
  if (!teamIds.size) return empty;

  const placeholders = [...teamIds].map(() => "?").join(",");
  const stats = db
    .prepare(
      `SELECT s.af_fixture_id, s.af_team_id, s.af_player_id, s.player_name,
              s.minutes, s.position, s.substitute,
              f.date, f.home_name, f.away_name, f.home_goals, f.away_goals,
              f.league_id, l.name AS league_name
       FROM af_gw_player_stats s
       JOIN fixtures f ON f.id = s.af_fixture_id
       LEFT JOIN leagues l ON l.id = f.league_id
       WHERE s.af_team_id IN (${placeholders})
       ORDER BY COALESCE(f.date, '') DESC`,
    )
    .all(...teamIds) as Array<{
    af_fixture_id: number;
    af_team_id: number;
    af_player_id: number;
    player_name: string;
    minutes: number;
    position: string | null;
    substitute: number;
    date: string | null;
    home_name: string | null;
    away_name: string | null;
    home_goals: number | null;
    away_goals: number | null;
    league_id: string | null;
    league_name: string | null;
  }>;

  const matched = stats.filter((s) => namesMatch(playerName, s.player_name));
  const played = matched.filter((s) => Number(s.minutes) > 0);
  const afIds = [...new Set(matched.map((s) => Number(s.af_player_id)))];

  const matches: AfMatchRow[] = played.map((s) => {
    const mins = Number(s.minutes) || 0;
    const pos = (s.position || "").trim();
    return {
      game_id: String(s.af_fixture_id),
      date_utc: s.date ?? null,
      competition_id: s.league_name || s.league_id || null,
      home_club_name: s.home_name ?? null,
      away_club_name: s.away_name ?? null,
      home_score: s.home_goals == null ? null : Number(s.home_goals),
      away_score: s.away_goals == null ? null : Number(s.away_goals),
      is_starter: Number(s.substitute) !== 1,
      shirt_number: null,
      position_label: [pos || null, mins ? `${mins}'` : null].filter(Boolean).join(" · ") || null,
    };
  });

  if (!afIds.length || !tableExists(db, "af_gw_fixture_events")) {
    return { matches, events: [] };
  }

  const evPlace = afIds.map(() => "?").join(",");
  const eventRows = db
    .prepare(
      `SELECT e.af_fixture_id, e.elapsed, e.extra, e.type, e.detail,
              e.player_id, e.assist_id,
              f.date, f.home_name, f.away_name
       FROM af_gw_fixture_events e
       JOIN fixtures f ON f.id = e.af_fixture_id
       WHERE e.player_id IN (${evPlace}) OR e.assist_id IN (${evPlace})
       ORDER BY COALESCE(f.date, '') DESC, e.elapsed, COALESCE(e.extra, 0)`,
    )
    .all(...afIds, ...afIds) as Array<{
    af_fixture_id: number;
    elapsed: number | null;
    extra: number | null;
    type: string | null;
    detail: string | null;
    player_id: number | null;
    assist_id: number | null;
    date: string | null;
    home_name: string | null;
    away_name: string | null;
  }>;

  const idSet = new Set(afIds);
  const events: AfEventRow[] = eventRows.map((e) => {
    const extra = e.extra == null ? null : Number(e.extra);
    const elapsed = e.elapsed == null ? null : Number(e.elapsed);
    let action = (e.detail || "").trim() || null;
    if (extra && extra > 0 && elapsed != null) {
      action = action ? `${action} (${elapsed}+${extra})` : `${elapsed}+${extra}`;
    }
    const active = e.player_id != null && idSet.has(Number(e.player_id));
    return {
      game_id: String(e.af_fixture_id),
      date_utc: e.date ?? null,
      home_club_name: e.home_name ?? null,
      away_club_name: e.away_name ?? null,
      minute: elapsed,
      event_type: e.type ?? null,
      event_label: afEventLabel(String(e.type || "")),
      action,
      reason: null,
      role: active ? "active" : "passive",
    };
  });

  return { matches, events };
}

export async function getPlayerById(
  db: Database.Database,
  root: string,
  id: string,
  writeDb: Database.Database | null = null,
) {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS club_name, c.crest_url AS club_crest, c.short_name AS club_short_name,
              c.market_value AS club_market_value, c.ranking AS club_ranking,
              l.name AS league_name, l.country AS league_country
       FROM players p
       JOIN clubs c ON c.id = p.club_id
       JOIN leagues l ON l.id = p.league_id
       WHERE p.id = ?`,
    )
    .get(id) as Row | undefined;

  if (!row) return null;

  const player = withTrustedWage(
    {
      ...row,
      portrait_url: sanitizePortraitUrl(row.portrait_url as string | null),
      position_display: formatPositionDisplay(row),
    },
    loadWagePeers(db),
  );

  let tm: ReturnType<typeof enrichFromTm> = null;
  const tmDb = openTmDb(root);
  if (tmDb) {
    try {
      tm = enrichFromTm(tmDb, id);
    } finally {
      tmDb.close();
    }
  }

  // Prefer writeDb so lazy-sync can persist; fall back to readonly list.
  const cached = listPlayerTransfers(writeDb ?? db, id);
  const transfers = await ensurePlayerTransfers(writeDb, id, cached);
  const cachedCoaches = listPlayerCoaches(writeDb ?? db, id);
  const coaches = await ensurePlayerCoaches(writeDb, id, cachedCoaches);

  const af = enrichFromAf(
    writeDb ?? db,
    id,
    String(player.name || ""),
    String(player.club_id || ""),
  );
  const matches = tm?.matches?.length ? tm.matches : af.matches;
  const events = tm?.events?.length ? tm.events : af.events;
  const tmOut = tm ? { ...tm, matches, events } : { matches, events };

  return { ...player, tm: tmOut, transfers, coaches };
}
