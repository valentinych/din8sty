#!/usr/bin/env python3
"""Scrape FMInside squads for previous + 2025/26 season clubs of unmatched movers.

Movers often sit under an old club on FM while TM already shows the new club.

Previous / season clubs are resolved from (in order):
  1. TM /transfer/{transferId} (ribbon.transferId) — immediate previous club
  2. clubAssignments (most recent non-current senior club)
  3. data/fm_season_clubs.json — clubs played for in season 2025/26
     (built by npm run transfers:sync from TM ceapi transfer history)

Short TM club names (e.g. "LASK") often fail FMInside search; use KNOWN_FM_URLS
and scrape_fminside aliases ("LASK Linz").

Writes:
  - data/fminside_raw.json  (extra clubs keyed by TM club id)
  - data/fm_previous_clubs.json  ({ tm_player_id: previous_tm_club_id })
  - data/fm_season_clubs.json is read (and may already exist from transfers:sync)

Usage:
  python3 scripts/scrape_previous_clubs.py
  python3 scripts/scrape_previous_clubs.py --min-value 0 --limit 80
  python3 scripts/scrape_previous_clubs.py --player 1282860
  python3 scripts/scrape_previous_clubs.py --season-clubs
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

import importlib.util

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "din8sty.db"
OUT_PATH = ROOT / "data" / "fminside_raw.json"
PREV_MAP_PATH = ROOT / "data" / "fm_previous_clubs.json"
SEASON_CLUBS_PATH = ROOT / "data" / "fm_season_clubs.json"
TM_DB_PATH = Path(
    __import__("os").environ.get(
        "TM_DB_PATH", str(ROOT.parent / "transfermarkt" / "data" / "app.db")
    )
)
TM_API = "https://tmapi-alpha.transfermarkt.technology"

spec = importlib.util.spec_from_file_location(
    "scrape_fminside", ROOT / "scripts" / "scrape_fminside.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Known FMInside club URLs when name search is unreliable.
# Non-top-8 leagues (Brazil, Ligue 2, …) often missing from FMInside club search
# even though squad pages exist — pin URLs discovered from player pages.
KNOWN_FM_URLS: dict[str, str] = {
    "683": "/clubs/7-fm-26/981-olympiacos",  # Olympiacos Piraeus
    "413": "/clubs/7-fm-26/154-lask-linz",  # LASK (TM name "LASK" ≠ FM "LASK Linz")
    "199": "/clubs/7-fm-26/319-corinthians",  # Sport Club Corinthians Paulista
    "1421": "/clubs/7-fm-26/2047-reims",  # Stade Reims
    "537": "/clubs/7-fm-26/316-botafogo",  # Botafogo
    "1023": "/clubs/7-fm-26/329-palmeiras",  # Palmeiras
    "1701": "/clubs/7-fm-26/2384-felgueiras",  # FC Felgueiras 1932
    "2407": "/clubs/7-fm-26/1257-monterrey",  # Monterrey (Liga MX; Canales etc.)
    "1304": "/clubs/7-fm-26/1037-heracles",  # Heracles Almelo (Eerste Divisie; Ambrek etc.)
    # TM prefix/short names fail FMInside search (FM uses bare "Mallorca", "Shakhtar", …)
    "237": "/clubs/7-fm-26/1726-mallorca",  # RCD Mallorca (Leo Román etc.)
    "472": "/clubs/7-fm-26/1772-las-palmas",  # UD Las Palmas
    "660": "/clubs/7-fm-26/1895-shakhtar",  # Shakhtar Donetsk
    "428": "/clubs/7-fm-26/1452-gornik",  # Górnik Zabrze
    "7097": "/clubs/7-fm-26/102467-union-sante-fe",  # Unión Santa Fe (FM typo "Sante")
    "48": "/clubs/7-fm-26/931-karlsruhe-sc",  # Karlsruher SC
    "9010": "/clubs/7-fm-26/199-dender-eh",  # FCV Dender EH
    "159": "/clubs/7-fm-26/1955-crvena-zvezda",  # Red Star Belgrade
    "255": "/clubs/7-fm-26/1456-legia",  # Legia Warszawa
    "1290": "/clubs/7-fm-26/852-grenoble",  # Grenoble
    "369": "/clubs/7-fm-26/533-lyngby",  # Lyngby BK
    "2921": "/clubs/7-fm-26/1158-pescara",  # Pescara
    "3522": "/clubs/7-fm-26/1173-spezia",  # Spezia Calcio
    "26": "/clubs/7-fm-26/1849-fc-basel",  # FC Basel 1893 (male; search can hit wrong page)
    # Liga Portugal 2 — bare "Oliveirense" search fails name_match; pin from player page.
    "8827": "/clubs/7-fm-26/2416-oliveirense",  # UD Oliveirense (Tyler Keating etc.)
    # Lower-league / non-top-8 former clubs for remaining unmatched movers.
    "11273": "/clubs/7-fm-26/2048-rodez",  # Rodez AF
    "642": "/clubs/7-fm-26/1000-de-graafschap",  # De Graafschap
    "116": "/clubs/7-fm-26/1848-aarau",  # FC Aarau
    "142": "/clubs/7-fm-26/1749-zaragoza",  # Real Zaragoza
    "2843": "/clubs/7-fm-26/1791-gif-sundsvall",  # GIF Sundsvall
    "93": "/clubs/7-fm-26/121196-sc-verl",  # SC Verl
    "2715": "/clubs/7-fm-26/216-seraing-fc",  # RFC Seraing
    "235": "/clubs/7-fm-26/1032-rkc",  # RKC Waalwijk
    "330": "/clubs/7-fm-26/314-atletico-mineiro",  # Atlético Mineiro
    "173": "/clubs/7-fm-26/545-odense-bk",  # Odense Boldklub
    "865": "/clubs/7-fm-26/526-fc-midtjylland",  # FC Midtjylland
    "6912": "/clubs/7-fm-26/2403-vizela",  # FC Vizela
    "1302": "/clubs/7-fm-26/689-northampton",  # Northampton Town
    "759": "/clubs/7-fm-26/1300885-lsk",  # Śląsk Wrocław (FM slug "lsk")
    "3527": "/clubs/7-fm-26/714221-motor",  # Motor Lublin
    "54189": "/clubs/7-fm-26/257-rwd-molenbeek",  # RWDM Brussels (FM: RWD Molenbeek)
    "384": "/clubs/7-fm-26/1022-mvv-maastricht",  # MVV Maastricht
    "527": "/clubs/7-fm-26/1856-fc-lausanne",  # FC Lausanne-Sport (FM: FC Lausanne)
    "5817": "/clubs/7-fm-26/926867-snderjyske",  # Sønderjyske Fodbold (slug drops ø)
    "238": "/clubs/7-fm-26/1455-lech",  # Lech Poznań (FM bare "Lech"; "Lech Poznań" is women's)
    # Argentine Primera — TM "Argentinos Juniors" search often misses FM "Argentinos".
    "1030": "/clubs/7-fm-26/78-argentinos",  # Argentinos Juniors (Cristian Ferreira etc.)
}

# clubAssignments types that are not a previous senior club.
SKIP_ASSIGN_TYPES = {
    "current",
    "nationalTeam",
    "national",
    "youth",
    "youthNationalTeam",
}

# Skip youth / reserve / special clubs for FM scrape (no useful FM squad).
# Token-aware: naive substring "b "/" b" false-positives on "Club 84" and
# "Red Star Belgrade". Match whole tokens only for short markers.
# Prefer promote_to_senior_club() (TM mainClubId) over skipping — FM lists
# graduates on the senior squad (e.g. Denner: Corinthians U20 → Corinthians).
YOUTH_SUBSTRINGS = (
    "yth",
    "youth",
    "u23",
    "u21",
    "u20",
    "u19",
    "u18",
    "u17",
    "u16",
    "u15",
    "res.",
    "reserve",
    "amateure",
)
# Whole-token only (after lowercasing / splitting on non-alnum).
YOUTH_TOKENS = frozenset(
    {"ii", "b", "u23", "u21", "u20", "u19", "u18", "u17", "u16", "u15"}
)


def looks_youth_or_reserve(name: str) -> bool:
    n = (name or "").lower().strip()
    if not n:
        return False
    # Fallback "Club {id}" is unknown, not youth — do not skip.
    if n.startswith("club ") and n[5:].isdigit():
        return False
    if any(m in n for m in YOUTH_SUBSTRINGS):
        return True
    tokens = re.split(r"[^a-z0-9]+", n)
    return any(t in YOUTH_TOKENS for t in tokens if t)


# Offline youth→senior when TM /club/{id} fails (502) or is unavailable.
# mainClubId from TM baseDetails; keep in sync when new U-side movers appear.
YOUTH_TO_SENIOR: dict[str, str] = {
    "14876": "199",  # SC Corinthians U20 → Sport Club Corinthians Paulista
    "12124": "405",  # Aston Villa U21 → Aston Villa
    "15038": "679",  # Athletico Paranaense U20
    "16653": "537",  # Botafogo FR U20
    "2517": "79",  # VfB Stuttgart U19
}


def promote_to_senior_club(club_id: str) -> tuple[str, str | None]:
    """Map TM youth/reserve club → senior club for FM scrape/match.

    TM transferSource often points at U20/U21 sides (e.g. 14876 Corinthians U20)
    while FMInside only has the senior squad (mainClubId 199). Uses mainClubId
    when it differs from self. Does not follow superiorClubId alone (often a
    holding/regional org, not the FM club). Offline YOUTH_TO_SENIOR covers API
    failures. Returns (club_id, name_or_none).
    """
    cid = str(club_id)
    if cid in YOUTH_TO_SENIOR:
        senior = YOUTH_TO_SENIOR[cid]
        sdata = tm_get(f"/club/{senior}")
        sraw = (sdata or {}).get("data") or {}
        sname = sraw.get("name") if isinstance(sraw.get("name"), str) else None
        print(f"  promote {cid} → senior {senior} {sname!r} (offline map)", flush=True)
        return senior, sname

    data = tm_get(f"/club/{cid}")
    raw = (data or {}).get("data") or {}
    name = raw.get("name") if isinstance(raw.get("name"), str) else None
    bd = raw.get("baseDetails") if isinstance(raw.get("baseDetails"), dict) else {}
    main = bd.get("mainClubId")
    main_s = str(main) if main not in (None, "", 0, "0") else ""
    # Senior sides set mainClubId to self; youth/reserve point at the senior id.
    if main_s and main_s != cid:
        sdata = tm_get(f"/club/{main_s}")
        sraw = (sdata or {}).get("data") or {}
        sname = sraw.get("name") if isinstance(sraw.get("name"), str) else None
        if not sname and name:
            sname = re.sub(
                r"\s*U(?:23|21|20|19|18|17|16|15)\b|\s*Youth\b|\s*Res(?:erve|\.)?\b",
                "",
                name,
                flags=re.I,
            ).strip() or name
        print(f"  promote {cid} {name!r} → senior {main_s} {sname!r}", flush=True)
        return main_s, sname
    # Name-based youth with no mainClubId — strip suffix for search name only.
    if looks_youth_or_reserve(name or ""):
        print(f"  ! youth club {cid} {name!r} has no mainClubId — skip promote", flush=True)
    return cid, name


def tm_get(path: str) -> dict | None:
    req = urllib.request.Request(
        f"{TM_API}{path}",
        headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.transfermarkt.com/",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)
    except Exception as e:
        print(f"  ! TM {path}: {e}", flush=True)
        return None


def transfer_source_club(transfer_id: str) -> str | None:
    data = tm_get(f"/transfer/{transfer_id}")
    src = ((data or {}).get("data") or {}).get("transferSource") or {}
    cid = src.get("clubId")
    return str(cid) if cid else None


def prev_from_assignments(raw: dict, current_club_id: str) -> str | None:
    """Most recent non-current senior-club assignment, if any."""
    assigns = raw.get("clubAssignments") or []
    if not isinstance(assigns, list):
        return None
    cands: list[tuple[str, str]] = []
    for a in assigns:
        if not isinstance(a, dict):
            continue
        atype = str(a.get("type") or "")
        if atype in SKIP_ASSIGN_TYPES:
            continue
        cid = a.get("clubId")
        if cid is None:
            continue
        cid_s = str(cid)
        if not cid_s or cid_s == current_club_id:
            continue
        start = str(a.get("start") or a.get("end") or a.get("debut") or "")
        cands.append((start, cid_s))
    if not cands:
        return None
    cands.sort(key=lambda x: x[0], reverse=True)
    return cands[0][1]


def club_name(tm: sqlite3.Connection, club_id: str) -> str | None:
    row = tm.execute("SELECT name FROM tm_clubs WHERE id = ?", (club_id,)).fetchone()
    if row and row[0]:
        return row[0]
    data = tm_get(f"/club/{club_id}")
    name = ((data or {}).get("data") or {}).get("name")
    return name if isinstance(name, str) and name.strip() else None


def club_search_names(tm: sqlite3.Connection, club_id: str, primary: str) -> list[str]:
    """Ordered search strings for FMInside (expanded forms first for acronyms)."""
    names: list[str] = []
    data = tm_get(f"/club/{club_id}")
    raw = (data or {}).get("data") or {}
    for key in ("officialName", "name"):
        v = raw.get(key) if key != "name" else (raw.get("name") or primary)
        if isinstance(v, str) and v.strip() and v.strip() not in names:
            names.append(v.strip())
    short = ((raw.get("baseDetails") or {}) or {}).get("shortName")
    if isinstance(short, str) and short.strip() and short.strip() not in names:
        names.append(short.strip())
    if primary and primary not in names:
        names.append(primary)
    # Prefer longer / expanded names first (LASK Linz before LASK).
    names.sort(key=lambda n: (-len(n), n))
    return names or [primary]


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def unmatched_movers(
    din: sqlite3.Connection,
    tm: sqlite3.Connection,
    *,
    min_value: int,
    player_id: str | None,
) -> list[dict]:
    """All unmatched TM players who have a previous-club signal.

    Uses ribbon.transferId (any ribbon type — not only NEW_SIGNING) and/or
    clubAssignments. Previous clubs outside the top-8 leagues are the common
    miss: FM still lists the player there, but main scrape never visited that club.
    """
    if player_id:
        rows = din.execute(
            "SELECT id, name, club_id, age, market_value_eur FROM players WHERE id = ?",
            (player_id,),
        ).fetchall()
    else:
        rows = din.execute(
            """
            SELECT id, name, club_id, age, market_value_eur
            FROM players
            WHERE fm_rating IS NULL
              AND COALESCE(market_value_eur, 0) >= ?
            ORDER BY COALESCE(market_value_eur, 0) DESC
            """,
            (min_value,),
        ).fetchall()

    out: list[dict] = []
    for pid, name, club_id, age, mv in rows:
        raw_row = tm.execute(
            "SELECT raw_json FROM tm_squad_players WHERE player_id = ? LIMIT 1",
            (pid,),
        ).fetchone()
        if not raw_row or not raw_row[0]:
            continue
        try:
            raw = json.loads(raw_row[0])
        except json.JSONDecodeError:
            continue
        ribbon = raw.get("ribbon") or {}
        tid = ribbon.get("transferId")
        assign_prev = prev_from_assignments(raw, str(club_id))
        if not tid and not assign_prev:
            continue
        out.append(
            {
                "id": str(pid),
                "name": name,
                "club_id": str(club_id),
                "age": age,
                "market_value_eur": mv or 0,
                "transfer_id": str(tid) if tid else None,
                "assign_prev": assign_prev,
                "ribbon_type": ribbon.get("ribbonType"),
            }
        )
    return out


def resolve_previous_club(p: dict) -> str | None:
    """Prefer transfer API (accurate for recent moves); fall back to assignments."""
    if p.get("transfer_id"):
        src = transfer_source_club(p["transfer_id"])
        time.sleep(0.15)
        if src and src != p["club_id"]:
            return src
    assign_prev = p.get("assign_prev")
    if assign_prev and assign_prev != p["club_id"]:
        return assign_prev
    return None


def scrape_club_pack(
    page,
    raw: dict,
    cid: str,
    name: str,
    tm: sqlite3.Connection,
    *,
    force: bool,
) -> bool:
    """Scrape one club into raw. Returns True if written."""
    existing = len((raw.get("clubs", {}).get(cid) or {}).get("players") or [])
    if existing >= 15 and not force:
        print(f"skip {name} ({cid}) already {existing} players", flush=True)
        return False
    if looks_youth_or_reserve(name):
        print(f"skip {name} ({cid}) youth/reserve", flush=True)
        return False

    print(f"→ {name} ({cid})", flush=True)
    url = KNOWN_FM_URLS.get(cid)
    if not url:
        for q in club_search_names(tm, cid, name):
            url = mod.resolve_club_url(page, q, None)
            if url:
                print(f"  resolved via {q!r}", flush=True)
                break
            time.sleep(0.3)
    if not url:
        print("  ! no FM URL", flush=True)
        return False
    squad = mod.scrape_club(page, url, name)
    print(f"  {url} → {len(squad)} players", flush=True)
    if len(squad) < 10:
        return False
    raw.setdefault("clubs", {})[cid] = {
        "tm_name": name,
        "league_id": None,
        "fm_url": url,
        "players": squad,
        "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "previous_club_supplement": True,
    }
    OUT_PATH.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
    # Persist known mapping for next runs
    club_map = load_json(mod.CLUB_MAP_PATH, {})
    club_map[cid] = url
    mod.CLUB_MAP_PATH.write_text(json.dumps(club_map, ensure_ascii=False, indent=2) + "\n")
    time.sleep(0.5)
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    # Default 0: any unmatched mover with transferId/assignments is eligible.
    # Old default (€5M) skipped mid-value signings whose prior club is only on FM.
    ap.add_argument("--min-value", type=int, default=0)
    ap.add_argument(
        "--limit",
        type=int,
        default=80,
        help="Max clubs to scrape (not already in fminside_raw)",
    )
    ap.add_argument("--player", default="", help="Only this TM player id")
    ap.add_argument("--force", action="store_true", help="Re-scrape previous clubs")
    ap.add_argument(
        "--season-clubs",
        action="store_true",
        default=True,
        help="Also scrape 2025/26 season clubs from fm_season_clubs.json (default on)",
    )
    ap.add_argument(
        "--no-season-clubs",
        action="store_true",
        help="Skip 2025/26 season club scrape",
    )
    args = ap.parse_args()
    use_season = args.season_clubs and not args.no_season_clubs

    if not DB_PATH.exists():
        raise SystemExit(f"Missing {DB_PATH}")
    if not TM_DB_PATH.exists():
        raise SystemExit(f"Missing TM DB {TM_DB_PATH}")

    din = sqlite3.connect(DB_PATH)
    tm = sqlite3.connect(TM_DB_PATH)
    players = unmatched_movers(
        din, tm, min_value=args.min_value, player_id=args.player or None
    )
    print(
        f"Candidates: {len(players)} unmatched movers "
        f"(min_value={args.min_value}, any transferId/assignments)"
    )

    prev_map: dict[str, str] = load_json(PREV_MAP_PATH, {})
    season_map: dict[str, list] = load_json(SEASON_CLUBS_PATH, {})
    raw = load_json(OUT_PATH, {"clubs": {}})

    # Resolve previous clubs (network to TM for transferId). Always write map,
    # even when the club is already in fminside_raw — match phase 2 needs it.
    club_weight: dict[str, int] = {}  # club_id -> sum market value of movers
    club_names: dict[str, str] = {}

    def add_club(cid: str, weight: int) -> str | None:
        """Promote youth→senior, register for scrape. Returns senior club id."""
        if not cid:
            return None
        senior_id, senior_name = promote_to_senior_club(cid)
        time.sleep(0.1)
        club_weight[senior_id] = club_weight.get(senior_id, 0) + int(weight or 0)
        if senior_id not in club_names:
            club_names[senior_id] = (
                senior_name or club_name(tm, senior_id) or f"Club {senior_id}"
            )
        return senior_id

    for p in players:
        src = resolve_previous_club(p)
        if not src:
            print(f"  skip {p['id']} {p['name']}: no previous club", flush=True)
        else:
            senior = add_club(src, p["market_value_eur"]) or src
            prev_map[p["id"]] = senior
            print(
                f"  {p['id']} {p['name']}: {p['club_id']} ← {senior} ({club_names[senior]})"
                f" [{p.get('ribbon_type') or 'no-ribbon'}]",
                flush=True,
            )
        # 2025/26 season clubs (from transfers:sync)
        if use_season:
            for cid in season_map.get(p["id"], []) or []:
                cid_s = str(cid)
                if cid_s and cid_s != p["club_id"]:
                    add_club(cid_s, p["market_value_eur"])

    # Also include season clubs for any unmatched player in season map (even
    # without transferId) when --player is set or --season-clubs.
    if use_season:
        if args.player:
            season_ids = [args.player]
        else:
            season_ids = [
                str(r[0])
                for r in din.execute(
                    "SELECT id FROM players WHERE fm_rating IS NULL"
                ).fetchall()
            ]
        for pid in season_ids:
            row = din.execute(
                "SELECT club_id, market_value_eur, name FROM players WHERE id = ?",
                (pid,),
            ).fetchone()
            if not row:
                continue
            cur, mv, pname = str(row[0]), row[1] or 0, row[2]
            promoted_season: list[str] = []
            for cid in season_map.get(pid, []) or []:
                cid_s = str(cid)
                if not cid_s or cid_s == cur:
                    continue
                senior = add_club(cid_s, mv)
                if senior and senior != cur and senior not in promoted_season:
                    promoted_season.append(senior)
                    print(
                        f"  season {pid} {pname}: 25/26 club {senior}",
                        flush=True,
                    )
            if promoted_season:
                season_map[pid] = promoted_season

    PREV_MAP_PATH.write_text(json.dumps(prev_map, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {PREV_MAP_PATH} ({len(prev_map)} players)")
    if use_season:
        SEASON_CLUBS_PATH.write_text(
            json.dumps(season_map, ensure_ascii=False, indent=2) + "\n"
        )
        print(f"Wrote {SEASON_CLUBS_PATH} ({len(season_map)} players)")

    # Scrape missing clubs, highest total mover value first.
    to_scrape: list[tuple[str, str]] = []
    for cid, _w in sorted(club_weight.items(), key=lambda kv: -kv[1]):
        name = club_names[cid]
        existing = len((raw.get("clubs", {}).get(cid) or {}).get("players") or [])
        if existing >= 15 and not args.force:
            print(f"skip {name} ({cid}) already {existing} players", flush=True)
            continue
        if looks_youth_or_reserve(name):
            print(f"skip {name} ({cid}) youth/reserve", flush=True)
            continue
        to_scrape.append((cid, name))
        if args.limit and len(to_scrape) >= args.limit:
            break

    if not to_scrape:
        print("Nothing to scrape")
        din.close()
        tm.close()
        return

    print(f"Scraping {len(to_scrape)} clubs (prev + 25/26)…")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            channel="chrome",
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = browser.new_context(user_agent=mod.UA, locale="en-US").new_page()
        for cid, name in to_scrape:
            scrape_club_pack(page, raw, cid, name, tm, force=args.force)
        browser.close()

    din.close()
    tm.close()
    print("done")


if __name__ == "__main__":
    main()
