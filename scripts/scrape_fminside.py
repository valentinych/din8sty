#!/usr/bin/env python3
"""Scrape FMInside Rating (CA) + wagep/w for Din8sty top-8 clubs.

Uses Playwright + Chrome to pass Cloudflare. Progress is saved after each club
so the run can be resumed.

Usage:
  python3 scripts/scrape_fminside.py
  python3 scripts/scrape_fminside.py --limit 5
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
import unicodedata
from pathlib import Path

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "din8sty.db"
OUT_PATH = ROOT / "data" / "fminside_raw.json"
CLUB_MAP_PATH = ROOT / "data" / "fminside_club_map.json"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


# English TM place names → canonical (German/local, post-NFKD) forms used on FMInside.
# "1.FC Nuremberg" must match "FC Nürnberg" (nurnberg after accent fold).
PLACE_CANON: dict[str, str] = {
    "nuremberg": "nurnberg",
    "nuernberg": "nurnberg",
    "cologne": "koln",
    "koeln": "koln",
    "munich": "munchen",
    "muenchen": "munchen",
    "dusseldorf": "dusseldorf",
    "duesseldorf": "dusseldorf",
}

# Canonical place token → FMInside search queries that actually filter (bare EN
# names often fall through to the default richest list).
PLACE_SEARCH: dict[str, list[str]] = {
    "nurnberg": ["FC Nürnberg", "1. FC Nürnberg", "Nürnberg"],
    "koln": ["1. FC Köln", "FC Köln", "Köln"],
    "munchen": ["Bayern München", "FC Bayern München", "München"],
    "dusseldorf": ["Fortuna Düsseldorf", "Düsseldorf"],
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    for token in (
        " football club",
        " fc",
        " cf",
        " afc",
        " sc",
        " ac",
        " as",
        " ss",
        " ud",
        " rc",
        " rsc",
        " kv",
        " sv",
        " bv",
        " vfl",
        " vfb",
        " tsg",
        " 1.",
        " club",
    ):
        s = s.replace(token, " ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    # Fold EN/DE place-name spelling so TM "Nuremberg" ≡ FM "Nürnberg".
    parts = [PLACE_CANON.get(t, t) for t in s.split()]
    return " ".join(parts)


def parse_wage(wage_li) -> tuple[str | None, int | None]:
    if not wage_li:
        return None, None
    text = wage_li.get_text(" ", strip=True)
    if not text or text == "-":
        return None, None
    m = re.search(r"€\s*([\d.,]+)\s*([KM])?", text)
    if not m:
        return text.replace(" ", ""), None
    n = float(m.group(1).replace(",", ""))
    suf = m.group(2)
    if suf == "K":
        n *= 1_000
    elif suf == "M":
        n *= 1_000_000
    return text.replace(" ", ""), int(n)


def parse_full_squad(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    block = None
    for h in soup.find_all(["h2", "h3"]):
        if h.get_text(strip=True) == "Full Squad":
            block = h.find_next(class_="players")
            break
    if block is None:
        # fallback: last .players with wage rows
        for cand in soup.select(".players"):
            rows = cand.select("ul.player")
            if rows and rows[0].select_one("li.wage"):
                block = cand
    if block is None:
        return []

    out = []
    for r in block.select("ul.player"):
        a = r.select_one("li.player a[href*='/players/']")
        if not a:
            continue
        ratings = [
            int(x.get_text(strip=True))
            for x in r.select("li.rating span.card")
            if x.get_text(strip=True).isdigit()
        ]
        wage_display, wage_pw = parse_wage(r.select_one("li.wage"))
        age_el = r.select_one("li.age")
        out.append(
            {
                "name": a.get("title") or a.get_text(strip=True),
                "url": a.get("href"),
                "ca": ratings[0] if ratings else None,
                "pa": ratings[1] if len(ratings) > 1 else None,
                "age": int(age_el.get_text(strip=True))
                if age_el and age_el.get_text(strip=True).isdigit()
                else None,
                "wage_display": wage_display,
                "wage_pw": wage_pw,
            }
        )
    return out


def wait_ready(page, timeout_s: float = 60) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        title = page.title()
        if "just a moment" in title.lower() or "security verification" in title.lower():
            page.wait_for_timeout(1500)
            continue
        if page.locator("body").count():
            return True
        page.wait_for_timeout(500)
    return False


STOPWORDS = {
    "de",
    "da",
    "do",
    "del",
    "la",
    "le",
    "el",
    "the",
    "and",
    "of",
    "club",
}


def significant_tokens(s: str) -> set[str]:
    return {t for t in norm(s).split() if len(t) > 2 and t not in STOPWORDS}


def name_match_ok(tm_name: str, fm_name: str) -> bool:
    """Accept if distinctive tokens clearly refer to the same club."""
    na, nb = norm(tm_name), norm(fm_name)
    if not na or not nb:
        return False
    if na == nb or na in nb or nb in na:
        return True
    # Stem overlap: Rennes ↔ Rennais, etc.
    for ta in na.split():
        for tb in nb.split():
            if len(ta) >= 5 and len(tb) >= 5 and (ta.startswith(tb[:5]) or tb.startswith(ta[:5])):
                return True
    # Well-known short FM names
    short = {
        "psg": ("paris", "germain"),
        "ol": ("lyon",),
        "om": ("marseille",),
        "inter": ("inter", "milan"),
        "internazionale": ("inter",),
        "barca": ("barcelona",),
        "atletico": ("atletico", "madrid"),
        "rennes": ("rennes",),
        "brest": ("brest",),
        "lille": ("lille",),
        "lyon": ("lyon",),
        "marseille": ("marseille",),
        "toulouse": ("toulouse",),
        "angers": ("angers",),
        "troyes": ("troyes",),
        "getafe": ("getafe",),
        "villarreal": ("villarreal",),
        "porto": ("porto",),
        "benfica": ("benfica",),
        "bayern": ("bayern",),
        "chelsea": ("chelsea",),
        "liverpool": ("liverpool",),
        "everton": ("everton",),
        "heerenveen": ("heerenveen",),
        "alkmaar": ("az", "alkmaar"),
        "cagliari": ("cagliari",),
        "parma": ("parma",),
    }
    if nb in short:
        req = short[nb]
        if req == ("inter",) or all(tok in na for tok in req):
            return True
    # also: TM short form vs FM long form
    if "inter" in na.split() and "inter" in nb:
        return True
    if "rennes" in na and nb == "rennes":
        return True
    if nb in short and all(tok in na for tok in short[nb]):
        return True
    # Translated / bilingual club names (TM EN ↔ FM local).
    bilingual = (
        (("red", "star"), ("crvena", "zvezda")),
        (("crvena", "zvezda"), ("red", "star")),
    )
    na_toks, nb_toks = set(na.split()), set(nb.split())
    for left, right in bilingual:
        if set(left) <= na_toks and set(right) <= nb_toks:
            return True
    a = significant_tokens(tm_name)
    b = significant_tokens(fm_name)
    if not a or not b:
        return False
    inter = a & b
    if not inter:
        return False
    # Shared long token (Westerlo, Bilbao, Madrid, …) is enough.
    if any(len(t) >= 5 for t in inter):
        return True
    return len(inter) / len(a) >= 0.5 and len(inter) / len(b) >= 0.4


def looks_like_default_richest(names: list[str], query: str = "") -> bool:
    """Unfiltered clubs page starts with mega-clubs; treat as failed filter.

    Exception: when searching for one of those mega-clubs, the default list
    is a valid result set.
    """
    qn = norm(query)
    mega = (
        "manchester city",
        "real madrid",
        "fc barcelona",
        "liverpool",
        "bayern",
        "psg",
        "chelsea",
        "arsenal",
        "manchester united",
    )
    if any(m in qn or qn in m for m in mega):
        return False
    joined = " | ".join(norm(n) for n in names[:8])
    hits = sum(1 for key in mega[:5] if key in joined)
    return hits >= 3


def resolve_club_url(page, club_name: str, short_name: str | None) -> str | None:
    queries = []
    for q in (club_name, short_name or ""):
        q = (q or "").strip()
        if q and q not in queries:
            queries.append(q)
    compact = re.sub(
        r"\s+(FC|CF|AFC|SC|AC|FK|SK|NK|UD|CD|KV|RSC|VV)$",
        "",
        club_name,
        flags=re.I,
    ).strip()
    if compact and compact not in queries:
        queries.append(compact)
    # common FMInside aliases (keys must be norm()'d)
    aliases = {
        "kaa gent": ["Gent", "AA Gent"],
        "oud heverlee leuven": ["OH Leuven", "Leuven"],
        "standard liege": ["Standard Liege", "Standard", "Standard Luik"],
        "athletic bilbao": ["Athletic Bilbao", "Bilbao"],
        "atletico de madrid": ["Atletico Madrid", "Atlético Madrid"],
        "deportivo a coruna": ["Deportivo", "Depor"],
        "aston villa": ["Aston Villa"],
        "brighton hove albion": ["Brighton"],
        "wolverhampton wanderers": ["Wolves", "Wolverhampton"],
        "tottenham hotspur": ["Tottenham"],
        "west ham united": ["West Ham"],
        "nottingham forest": ["Nottingham Forest"],
        "paris saint germain": ["PSG", "Paris Saint-Germain"],
        "olympique lyon": ["Lyon", "Olympique Lyonnais"],
        "olympique marseille": ["Marseille", "OM"],
        "stade rennais": ["Rennes", "Stade Rennais"],
        "stade reims": ["Reims", "Stade Reims"],
        "sport club corinthians paulista": ["Corinthians", "SC Corinthians"],
        "sc corinthians": ["Corinthians"],
        "stade brestois 29": ["Brest", "Stade Brestois"],
        "rc strasbourg alsace": ["Strasbourg"],
        "toulouse": ["Toulouse"],
        "losc lille": ["Lille", "LOSC"],
        "angers sco": ["Angers"],
        "estac troyes": ["Troyes"],
        "le mans": ["Le Mans"],
        "paris": ["Paris FC"],
        "getafe": ["Getafe"],
        "rayo vallecano": ["Rayo Vallecano", "Rayo"],
        "villarreal": ["Villarreal"],
        "real sociedad": ["Real Sociedad"],
        "borussia monchengladbach": ["Borussia Monchengladbach", "Gladbach"],
        "heidenheim 1846": ["Heidenheim"],
        "fsv mainz 05": ["Mainz"],
        "bayer 04 leverkusen": ["Bayer Leverkusen", "Leverkusen"],
        "1899 hoffenheim": ["Hoffenheim"],
        "inter milan": ["Internazionale", "Inter"],
        "milan": ["Milan"],
        # Short TM acronyms fail bare search on FMInside — need expanded form.
        "lask": ["LASK Linz", "Linz"],
        "rbs": ["Red Bull Salzburg", "FC Salzburg", "Salzburg"],
        "tsk": ["TSK"],
        "debreceni vsc": ["Debrecen", "Debreceni VSC", "DVSC"],
        "debrecen": ["Debrecen", "Debreceni VSC"],
        # Prefixed / abbreviated TM names ≠ bare FM club names.
        "rcd mallorca": ["Mallorca"],
        "ud las palmas": ["Las Palmas"],
        "shakhtar d": ["Shakhtar", "Shakhtar Donetsk"],
        "shakhtar donetsk": ["Shakhtar"],
        "gornik zabrze": ["Górnik", "Gornik"],
        "karlsruher sc": ["Karlsruhe SC", "Karlsruhe"],
        "fcv dender eh": ["Dender EH", "Dender"],
        "legia warszawa": ["Legia"],
        "red star": ["Crvena zvezda", "Crvena Zvezda"],
        "union santa fe": ["Unión Sante FE", "Union Santa Fe", "Unión Santa Fe"],
        "lyngby bk": ["Lyngby"],
        "spezia calcio": ["Spezia"],
        "real oviedo": ["Oviedo", "Real Oviedo"],
        # Liga Portugal 2 — filter match is flaky on bare / UD forms.
        "ud oliveirense": ["Oliveirense", "UD Oliveirense"],
        "oliveirense": ["Oliveirense", "UD Oliveirense"],
        "rwdm brussels": ["RWD Molenbeek", "RWDM", "Molenbeek"],
        "de graafschap doetinchem": ["De Graafschap", "Graafschap"],
        "rodez af": ["Rodez"],
        "rkc waalwijk": ["RKC", "Waalwijk"],
        "clube atletico mineiro": ["Atlético Mineiro", "Atletico Mineiro"],
        "odense boldklub": ["Odense", "OB"],
        "slask wroclaw": ["Śląsk", "Slask", "Śląsk Wrocław"],
        "fc lausanne sport": ["FC Lausanne", "Lausanne", "Lausanne-Sport"],
        "sonderjyske fodbold": ["Sønderjyske", "Sonderjyske"],
        "lech poznan": ["Lech"],
    }
    for a in aliases.get(norm(club_name), []):
        if a not in queries:
            queries.append(a)
    # EN place names (Nuremberg) need DE search strings (FC Nürnberg) or the
    # clubs filter returns the default richest list / no match.
    for tok in significant_tokens(club_name):
        for a in PLACE_SEARCH.get(tok, []):
            if a not in queries:
                queries.append(a)

    for q in queries:
        page.goto("https://fminside.net/clubs", wait_until="domcontentloaded", timeout=90000)
        if not wait_ready(page, 45):
            continue
        if page.locator("form.filter").count() == 0:
            page.wait_for_timeout(4000)
            if page.locator("form.filter").count() == 0:
                continue

        page.fill('input[name="name"]', "")
        page.evaluate("$('form.filter').trigger('change')")
        page.wait_for_timeout(1200)
        page.fill('input[name="name"]', q)
        male = page.locator('input[name="gender"][value="1"]')
        if male.count():
            male.check()
        page.evaluate("$('form.filter').trigger('change')")
        page.wait_for_timeout(2500)
        for _ in range(60):
            if not page.locator("form.filter.loading").count():
                break
            page.wait_for_timeout(200)

        if not page.locator("#club_table").count():
            continue
        html = page.locator("#club_table").inner_html()
        soup = BeautifulSoup(html, "html.parser")
        rows = []
        for a in soup.select("a[href*='/clubs/7-']"):
            href = a.get("href") or ""
            if "richest" in href:
                continue
            name = (a.get("title") or a.get_text(strip=True) or "").strip()
            if len(name) < 2:
                continue
            rows.append((name, href))

        # unique by href
        seen = set()
        uniq = []
        for name, href in rows:
            if href in seen:
                continue
            seen.add(href)
            uniq.append((name, href))

        if looks_like_default_richest([n for n, _ in uniq], q):
            # filter did not apply
            continue

        ranked = []
        for name, href in uniq:
            nn = norm(name)
            if re.search(r"\b(b|ii|u21|u23|women|femin|col)\b", nn) or re.search(
                r"-(b|ii|u\d+|youth|women)(/|$)", href
            ):
                continue
            if not name_match_ok(club_name, name) and not name_match_ok(q, name):
                continue
            score = 0
            if nn == norm(club_name) or nn == norm(q):
                score += 100
            else:
                ta, tb = significant_tokens(club_name), significant_tokens(name)
                score += int(80 * len(ta & tb) / max(len(ta | tb), 1))
            if re.search(r"/clubs/7-fm-26/2000", href):
                score -= 10
            ranked.append((score, name, href))

        ranked.sort(reverse=True)
        if ranked and ranked[0][0] >= 50:
            return ranked[0][2]
    return None


def club_page_name(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    if h1:
        return h1.get_text(strip=True)
    title = soup.title.get_text(strip=True) if soup.title else ""
    m = re.match(r"(.+?)\s*\(", title)
    return (m.group(1).strip() if m else title) or None


def scrape_club(page, club_url: str, expected_name: str) -> list[dict]:
    if club_url.startswith("/"):
        club_url = "https://fminside.net" + club_url
    for attempt in range(3):
        page.goto(club_url, wait_until="domcontentloaded", timeout=90000)
        if not wait_ready(page, 60):
            page.wait_for_timeout(2000)
            continue
        page.wait_for_timeout(1500 + attempt * 1000)
        html = page.content()
        if "just a moment" in page.title().lower():
            page.wait_for_timeout(3000)
            continue
        page_name = club_page_name(html)
        if page_name and not name_match_ok(expected_name, page_name):
            print(f"  ! reject page '{page_name}' for '{expected_name}'", flush=True)
            return []
        players = parse_full_squad(html)
        if players:
            return players
        page.wait_for_timeout(2000)
    return []


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Max clubs to scrape this run")
    ap.add_argument("--league", default="", help="Only one TM league id, e.g. GB1")
    ap.add_argument("--force", action="store_true", help="Re-scrape clubs already done")
    args = ap.parse_args()

    if not DB_PATH.exists():
        raise SystemExit(f"Missing {DB_PATH}. Run: npm run db:build")

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    sql = "SELECT id, league_id, name, short_name, ranking FROM clubs"
    params: list = []
    if args.league:
        sql += " WHERE league_id = ?"
        params.append(args.league)
    sql += " ORDER BY league_id, COALESCE(ranking, 999), name"
    clubs = [dict(r) for r in con.execute(sql, params)]
    con.close()

    club_map = load_json(CLUB_MAP_PATH, {})
    raw = load_json(OUT_PATH, {"clubs": {}})

    done = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            channel="chrome",
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(user_agent=UA, locale="en-US")
        page = context.new_page()

        for club in clubs:
            cid = club["id"]
            if (
                not args.force
                and cid in raw.get("clubs", {})
                and len(raw["clubs"][cid].get("players") or []) >= 20
            ):
                continue
            print(f"→ {club['league_id']} {club['name']} …", flush=True)
            url = club_map.get(cid)
            if not url:
                url = resolve_club_url(page, club["name"], club.get("short_name"))
                if url:
                    club_map[cid] = url
                    CLUB_MAP_PATH.write_text(json.dumps(club_map, ensure_ascii=False, indent=2))
            if not url:
                print(f"  ! no FMInside club URL for {club['name']}", flush=True)
                raw.setdefault("clubs", {})[cid] = {
                    "tm_name": club["name"],
                    "league_id": club["league_id"],
                    "fm_url": None,
                    "players": [],
                    "error": "unresolved",
                }
                OUT_PATH.write_text(json.dumps(raw, ensure_ascii=False, indent=2))
                continue

            players = scrape_club(page, url, club["name"])
            if not players:
                # drop bad cached map entry so next run can re-resolve
                if cid in club_map:
                    del club_map[cid]
                    CLUB_MAP_PATH.write_text(json.dumps(club_map, ensure_ascii=False, indent=2))
                print(f"  ! empty/rejected {url}", flush=True)
                raw.setdefault("clubs", {})[cid] = {
                    "tm_name": club["name"],
                    "league_id": club["league_id"],
                    "fm_url": url,
                    "players": [],
                    "error": "empty_or_mismatch",
                }
                OUT_PATH.write_text(json.dumps(raw, ensure_ascii=False, indent=2))
                continue

            print(f"  {url} → {len(players)} players", flush=True)
            raw.setdefault("clubs", {})[cid] = {
                "tm_name": club["name"],
                "league_id": club["league_id"],
                "fm_url": url,
                "players": players,
                "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            OUT_PATH.write_text(json.dumps(raw, ensure_ascii=False, indent=2))
            done += 1
            if args.limit and done >= args.limit:
                break
            time.sleep(0.8)

        browser.close()

    print(f"Done. Scraped {done} clubs. Raw → {OUT_PATH}")


if __name__ == "__main__":
    main()
