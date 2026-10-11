#!/usr/bin/env python3
"""
Refresh squad memberships + market values from public Transfermarkt kader
pages into data/din8sty.db.

Default: all Top-8 leagues (GB1/ES1/IT1/L1/FR1/PO1/BE1/NL1).
`--top4-only` keeps the old GB1/ES1/IT1/L1 scope.

TM private API (tmapi-alpha) is often 403; public HTML works.

Usage:
  python3 scripts/sync_tm_squads_html.py
  python3 scripts/sync_tm_squads_html.py --top4-only
  python3 scripts/sync_tm_squads_html.py --limit 3
  python3 scripts/sync_tm_squads_html.py --season 2026
  python3 scripts/sync_tm_squads_html.py --from-json data/tm_top8_squads_html.json --no-prune
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "din8sty.db"
TM_DB_PATH = ROOT.parent / "transfermarkt" / "data" / "app.db"

TOP8 = ("GB1", "ES1", "IT1", "L1", "FR1", "PO1", "BE1", "NL1")
TOP4 = ("GB1", "ES1", "IT1", "L1")
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
GAP_S = 1.2

POS_MAP = {
    "goalkeeper": "GK",
    "centre-back": "DEF",
    "left-back": "DEF",
    "right-back": "DEF",
    "sweeper": "DEF",
    "defensive midfield": "MID",
    "central midfield": "MID",
    "attacking midfield": "MID",
    "left midfield": "MID",
    "right midfield": "MID",
    "left winger": "ATT",
    "right winger": "ATT",
    "centre-forward": "ATT",
    "second striker": "ATT",
    "striker": "ATT",
}

DETAIL_MAP = {
    "goalkeeper": "GK",
    "centre-back": "CB",
    "left-back": "LB",
    "right-back": "RB",
    "defensive midfield": "DM",
    "central midfield": "CM",
    "attacking midfield": "AM",
    "left midfield": "LM",
    "right midfield": "RM",
    "left winger": "LW",
    "right winger": "RW",
    "centre-forward": "ST",
    "second striker": "SS",
}


def is_real_portrait_url(url: str | None) -> bool:
    """Club crests (`/wappen/`) are not player photos — they go stale after transfers."""
    if not url:
        return False
    s = str(url).strip()
    if not s:
        return False
    return "/wappen/" not in s.lower()


def parse_eur(s: str | None) -> int | None:
    if not s:
        return None
    t = s.replace("€", "").replace(",", "").strip().lower()
    if t in ("-", "?", ""):
        return None
    m = re.match(r"([\d.]+)\s*([mk])?", t)
    if not m:
        return None
    n = float(m.group(1))
    suf = m.group(2)
    if suf == "m":
        n *= 1_000_000
    elif suf == "k":
        n *= 1_000
    return int(round(n))


def normalize_pos(label: str | None) -> tuple[str | None, str | None, str | None]:
    if not label:
        return None, None, None
    key = label.strip().lower()
    group = POS_MAP.get(key)
    detail = DETAIL_MAP.get(key)
    return group, detail, label.strip()


def fetch(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
            "Referer": "https://www.transfermarkt.com/",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read().decode("utf-8", errors="replace")


def kader_path(relative_url: str, season: int) -> str:
    # /manchester-city/startseite/verein/281 → /manchester-city/kader/verein/281/saison_id/2026
    m = re.search(r"/verein/(\d+)", relative_url)
    if not m:
        raise ValueError(f"bad relative_url: {relative_url}")
    club_id = m.group(1)
    slug = relative_url.strip("/").split("/")[0]
    return f"/{slug}/kader/verein/{club_id}/saison_id/{season}"


def parse_kader(html: str, club_id: str, league_id: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.select_one("table.items")
    if not table:
        return []
    out: list[dict] = []
    for tr in table.select("tbody > tr"):
        a = tr.select_one('a[href*="/profil/spieler/"]')
        mv_a = tr.select_one('a[href*="/marktwertverlauf/spieler/"]')
        if not a or not mv_a:
            continue
        href = a.get("href") or ""
        m = re.search(r"/spieler/(\d+)", href)
        if not m:
            continue
        pid = m.group(1)
        name = a.get_text(" ", strip=True)
        if not name:
            continue
        pos_el = tr.select_one("table.inline-table tr:nth-of-type(2) td")
        pos_label = pos_el.get_text(strip=True) if pos_el else None
        position, detail_role, detail_label = normalize_pos(pos_label)

        ages = [td.get_text(strip=True) for td in tr.select("td.zentriert")]
        age = None
        shirt = None
        contract = None
        # Typical: [shirt, age, nat(empty often), contract]
        nums = []
        for t in ages:
            if re.fullmatch(r"\d{1,2}", t):
                nums.append(int(t))
            elif re.fullmatch(r"\d{2}/\d{2}/\d{4}", t):
                contract = t
                # TM shows DD/MM/YYYY → ISO-ish keep as-is for contract_until column
                d, mo, y = t.split("/")
                contract = f"{y}-{mo}-{d}"
        if nums:
            # shirt can be missing ('-'); first small int often shirt, second age
            if len(nums) >= 2:
                shirt, age = nums[0], nums[1]
            else:
                age = nums[0]

        portrait = None
        img = tr.select_one("img.bilderrahmen-fixed, img.player-portrait, td img")
        if img and img.get("data-src"):
            portrait = img["data-src"]
        elif img and img.get("src") and "transparent" not in (img.get("src") or ""):
            portrait = img.get("src")

        # TM shows the club crest when no player photo exists — never store that
        # as portrait_url (it goes stale after transfers).
        if not is_real_portrait_url(portrait):
            portrait = None

        out.append(
            {
                "id": pid,
                "club_id": club_id,
                "league_id": league_id,
                "name": name,
                "age": age,
                "shirt_number": shirt,
                "position": position,
                "detail_role": detail_role,
                "detail_label": detail_label,
                "market_value_eur": parse_eur(mv_a.get_text(strip=True)),
                "contract_until": contract,
                "portrait_url": portrait,
                "tm_url": f"https://www.transfermarkt.com{href}",
            }
        )
    return out


def load_clubs(
    conn: sqlite3.Connection, leagues: tuple[str, ...]
) -> list[tuple[str, str, str, str]]:
    """Return (id, name, league_id, relative_url). Prefer TM DB for relative_url."""
    din = conn.execute(
        f"""SELECT id, name, league_id FROM clubs
            WHERE league_id IN ({",".join("?" * len(leagues))})
            ORDER BY league_id, name""",
        leagues,
    ).fetchall()
    url_by_id: dict[str, str] = {}
    if TM_DB_PATH.exists():
        tm = sqlite3.connect(f"file:{TM_DB_PATH}?mode=ro", uri=True)
        for cid, rel in tm.execute(
            "SELECT id, relative_url FROM tm_clubs WHERE relative_url IS NOT NULL"
        ):
            url_by_id[str(cid)] = rel
        tm.close()
    out = []
    for cid, name, league_id in din:
        rel = url_by_id.get(str(cid))
        if not rel:
            rel = f"/club/startseite/verein/{cid}"
            print(f"  ! fallback url for {name} ({cid})", file=sys.stderr)
        out.append((str(cid), name, league_id, rel))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--top4-only",
        action="store_true",
        help="Only GB1/ES1/IT1/L1 (old default)",
    )
    ap.add_argument(
        "--from-json",
        type=str,
        default="",
        help="Apply an existing tm_*_squads_html.json instead of scraping TM",
    )
    ap.add_argument(
        "--no-prune",
        action="store_true",
        help="Never delete players absent from the scrape (keeps drafted leavers)",
    )
    args = ap.parse_args()
    leagues = TOP4 if args.top4_only else TOP8

    if not DB_PATH.exists():
        print(f"Missing {DB_PATH}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    before = {
        r["id"]: (r["club_id"], r["market_value_eur"])
        for r in conn.execute(
            f"SELECT id, club_id, market_value_eur FROM players WHERE league_id IN ({','.join('?'*len(leagues))})",
            leagues,
        )
    }

    scraped: dict[str, dict] = {}
    failed = 0
    failed_clubs: list[tuple[str, str, str, str]] = []

    if args.from_json:
        dump_path = Path(args.from_json)
        if not dump_path.is_absolute():
            dump_path = ROOT / dump_path
        payload = __import__("json").loads(dump_path.read_text(encoding="utf-8"))
        for p in payload.get("players") or []:
            if p.get("id"):
                scraped[str(p["id"])] = p
        print(f"Loaded {len(scraped)} players from {dump_path}")
    else:
        clubs = load_clubs(conn, leagues)
        if args.limit:
            clubs = clubs[: args.limit]
        label = "Top-4" if args.top4_only else "Top-8"
        print(f"Scraping {len(clubs)} {label} clubs (saison_id={args.season})…")

        def scrape_one(i: int, total: int, cid: str, name: str, league_id: str, rel: str) -> bool:
            path = kader_path(rel, args.season)
            url = f"https://www.transfermarkt.com{path}"
            time.sleep(GAP_S)
            try:
                html = fetch(url)
                rows = parse_kader(html, cid, league_id)
                if not rows:
                    raise RuntimeError("0 players parsed")
                for p in rows:
                    scraped[p["id"]] = p
                sample_mv = max((p["market_value_eur"] or 0) for p in rows)
                print(
                    f"  [{i}/{total}] {name}: {len(rows)} players · max MV €{sample_mv/1e6:.0f}M"
                )
                return True
            except Exception as e:
                print(f"  [{i}/{total}] {name}: FAIL {e}", file=sys.stderr)
                return False

        for i, (cid, name, league_id, rel) in enumerate(clubs, 1):
            if not scrape_one(i, len(clubs), cid, name, league_id, rel):
                failed += 1
                failed_clubs.append((cid, name, league_id, rel))

        # One retry pass for transient timeouts
        if failed_clubs:
            print(f"Retrying {len(failed_clubs)} failed clubs…")
            still: list[tuple[str, str, str, str]] = []
            for j, (cid, name, league_id, rel) in enumerate(failed_clubs, 1):
                if scrape_one(j, len(failed_clubs), cid, name, league_id, rel):
                    failed -= 1
                else:
                    still.append((cid, name, league_id, rel))
            failed_clubs = still

        print(f"Unique players scraped: {len(scraped)} (club failures: {failed})")
        dump_path = ROOT / "data" / (
            "tm_top4_squads_html.json" if args.top4_only else "tm_top8_squads_html.json"
        )
        dump_path.write_text(
            __import__("json").dumps(
                {
                    "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "season": args.season,
                    "players": list(scraped.values()),
                    "failed_clubs": [c[1] for c in failed_clubs],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"Wrote {dump_path} ({len(scraped)} players)")
    if args.dry_run:
        changed = 0
        for pid, p in scraped.items():
            old = before.get(pid)
            if not old or old[0] != p["club_id"] or old[1] != p["market_value_eur"]:
                changed += 1
        print(f"Dry-run: would upsert {len(scraped)}, ~{changed} club/MV changes vs prior Top-4 rows")
        return 0 if failed == 0 else 2

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    upsert = conn.execute  # noqa: F841 — clarity

    update_sql = """
      UPDATE players SET
        club_id = :club_id,
        league_id = :league_id,
        name = :name,
        age = COALESCE(:age, age),
        shirt_number = COALESCE(:shirt_number, shirt_number),
        position = COALESCE(:position, position),
        detail_role = COALESCE(:detail_role, detail_role),
        detail_label = COALESCE(:detail_label, detail_label),
        market_value_eur = :market_value_eur,
        contract_until = COALESCE(:contract_until, contract_until),
        portrait_url = CASE
          -- Never write a crest. Only fill when the stored portrait is missing
          -- or is itself a crest — never overwrite a real photo.
          WHEN :portrait_url IS NOT NULL
               AND :portrait_url NOT LIKE '%/wappen/%'
               AND (portrait_url IS NULL OR portrait_url LIKE '%/wappen/%')
            THEN :portrait_url
          WHEN portrait_url LIKE '%/wappen/%' THEN NULL
          ELSE portrait_url
        END,
        tm_url = COALESCE(:tm_url, tm_url)
      WHERE id = :id
    """
    insert_sql = """
      INSERT INTO players (
        id, club_id, league_id, name, age, shirt_number,
        position, detail_role, detail_label,
        market_value_eur, contract_until, portrait_url, tm_url
      ) VALUES (
        :id, :club_id, :league_id, :name, :age, :shirt_number,
        :position, :detail_role, :detail_label,
        :market_value_eur, :contract_until, :portrait_url, :tm_url
      )
    """

    updated = 0
    inserted = 0
    club_moves = 0
    mv_changes = 0
    with conn:
        for pid, p in scraped.items():
            exists = conn.execute("SELECT club_id, market_value_eur FROM players WHERE id=?", (pid,)).fetchone()
            if exists:
                if exists["club_id"] != p["club_id"]:
                    club_moves += 1
                if exists["market_value_eur"] != p["market_value_eur"]:
                    mv_changes += 1
                conn.execute(update_sql, p)
                updated += 1
            else:
                conn.execute(insert_sql, p)
                inserted += 1

        # Players still tagged Top-4 but absent from all Top-4 squads → left the pool.
        # Only prune when scrape coverage looks complete (avoid wiping on partial failures).
        # --no-prune / --from-json: never delete (drafted leavers like Ferran Torres).
        removed = 0
        scraped_clubs = {p["club_id"] for p in scraped.values()}
        if args.no_prune or args.from_json:
            print("Skip stale prune (--no-prune/--from-json)")
        else:
            min_ok = max(1, len(clubs) - max(2, failed))
            if failed <= 2 and len(scraped) >= 1800 and len(scraped_clubs) >= min_ok:
                stale = conn.execute(
                    f"""SELECT id, name, club_id, league_id FROM players
                        WHERE league_id IN ({",".join("?" * len(TOP4))})
                          AND id NOT IN ({",".join("?" * len(scraped))})""",
                    [*TOP4, *scraped.keys()],
                ).fetchall()
                tables = {
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                }
                for row in stale:
                    if "top4_wishlist" in tables:
                        conn.execute(
                            "DELETE FROM top4_wishlist WHERE player_id=?", (row["id"],)
                        )
                    if "top8_wishlist" in tables:
                        conn.execute(
                            "DELETE FROM top8_wishlist WHERE player_id=?", (row["id"],)
                        )
                    conn.execute("DELETE FROM players WHERE id=?", (row["id"],))
                    removed += 1
                if removed:
                    print(
                        f"Removed {removed} players no longer on Top-4 squads "
                        "(wishlist rows cleared)"
                    )
            else:
                print(
                    f"Skip stale prune (failed={failed}, players={len(scraped)}, "
                    f"clubs={len(scraped_clubs)}/{len(clubs)})"
                )

        conn.execute(
            "INSERT INTO meta(key,value) VALUES('tm_html_top4_synced_at',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (now,),
        )
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('tm_html_top4_players',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(len(scraped)),),
        )

    print("=== TM HTML squad sync ===")
    print(f"Updated: {updated}  Inserted: {inserted}  Club moves: {club_moves}  MV changes: {mv_changes}")
    # samples
    for pid in ("418560", "392757", "315858", "598577", "937958"):
        r = conn.execute(
            "SELECT name, club_id, market_value_eur FROM players WHERE id=?", (pid,)
        ).fetchone()
        if r:
            print(f"  {r['name']}: club={r['club_id']} MV={r['market_value_eur']}")
    conn.close()
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
