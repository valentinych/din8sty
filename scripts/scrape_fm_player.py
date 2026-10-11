#!/usr/bin/env python3
"""Scrape one FMInside player page → JSON on stdout.

Accepts a full FMInside URL or numeric unique ID. With only an ID, uses
optional --name (TM/Din8sty name) to find the matching search result,
or resolves from data/fminside_raw.json when present.

Usage:
  python3 scripts/scrape_fm_player.py 14185873 --name "Cristian Ferreira"
  python3 scripts/scrape_fm_player.py "https://fminside.net/players/7-fm-26/14185873-cristian-ferreira"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

import importlib.util

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "scrape_fminside", ROOT / "scripts" / "scrape_fminside.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ID_RE = re.compile(r"^\d+$")
URL_ID_RE = re.compile(r"/players/\d+-[^/]+/(\d+)(?:-|/|$)", re.I)


def normalize_input(raw: str) -> tuple[str | None, str | None]:
    """Return (url, id). Either may be None."""
    s = (raw or "").strip()
    if not s:
        return None, None
    if ID_RE.match(s):
        return None, s
    if s.startswith("/players/"):
        s = "https://fminside.net" + s
    elif "fminside.net" not in s and re.search(r"\d+-[a-z0-9-]+", s, re.I):
        s = "https://fminside.net/players/" + s.lstrip("/")
    if "fminside.net" in s and not s.startswith("http"):
        s = "https://" + s.lstrip("/")
    if "fminside.net" in s or s.startswith("http"):
        m = URL_ID_RE.search(urlparse(s).path)
        return s, m.group(1) if m else None
    return None, None


def parse_player_html(html: str, page_url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text() if soup.title else ""
    if "404" in title.lower():
        raise RuntimeError("fm_player_not_found")

    h1 = soup.find("h1")
    name = h1.get_text(strip=True) if h1 else None

    def kv(key: str) -> str | None:
        for li in soup.select("li"):
            k = li.select_one("span.key")
            v = li.select_one("span.value")
            if k and v and k.get_text(strip=True).lower() == key.lower():
                return v.get_text(" ", strip=True)
        return None

    if not name:
        name = kv("Name")

    age_raw = kv("Age")
    age = int(age_raw) if age_raw and age_raw.isdigit() else None

    wage_text = kv("Wages")
    wage_display, wage_pw = None, None
    if wage_text:
        wage_display, wage_pw = mod.parse_wage(
            BeautifulSoup(f"<li class='wage'>{wage_text}</li>", "html.parser").li
        )

    # CA/PA sit immediately before .player_value (DOM: CA then PA).
    # find_all_previous returns nearest-first → [PA, CA].
    ca = pa = None
    value = soup.select_one(".player_value")
    if value:
        prev_cards: list[int] = []
        for sib in value.find_all_previous("span", class_="card"):
            if sib.find_parent(class_="player_versions"):
                continue
            t = sib.get_text(strip=True)
            if t.isdigit():
                prev_cards.append(int(t))
            if len(prev_cards) >= 2:
                break
        if len(prev_cards) >= 2:
            pa, ca = prev_cards[0], prev_cards[1]

    if ca is None:
        cards: list[int] = []
        for span in soup.select("span.card"):
            if span.find_parent(class_="player_versions"):
                continue
            t = span.get_text(strip=True)
            if t.isdigit():
                cards.append(int(t))
        if len(cards) >= 2:
            ca, pa = cards[0], cards[1]

    path = urlparse(page_url).path
    m = URL_ID_RE.search(path)
    fm_id = m.group(1) if m else None
    rel = path if path.startswith("/") else None

    if not name:
        raise RuntimeError("fm_parse_failed_name")
    if ca is None:
        raise RuntimeError("fm_parse_failed_rating")

    return {
        "name": name,
        "url": rel,
        "fm_id": fm_id,
        "ca": ca,
        "pa": pa,
        "age": age,
        "wage_display": wage_display,
        "wage_pw": wage_pw,
        "page_url": page_url,
    }


def resolve_url_from_id(page, fm_id: str, name_hint: str | None) -> str:
    """Find player URL containing /{fm_id}- via raw JSON or name search."""
    raw_path = ROOT / "data" / "fminside_raw.json"
    if raw_path.exists():
        try:
            raw = json.loads(raw_path.read_text())
            for pack in (raw.get("clubs") or {}).values():
                for pl in pack.get("players") or []:
                    u = pl.get("url") or ""
                    if f"/{fm_id}-" in u or u.endswith(f"/{fm_id}"):
                        return u if u.startswith("http") else "https://fminside.net" + u
        except Exception:
            pass

    if not name_hint or len(name_hint.strip()) < 2:
        raise RuntimeError("fm_id_needs_name_or_url")

    page.goto(
        "https://fminside.net/players", wait_until="domcontentloaded", timeout=90000
    )
    if not mod.wait_ready(page, 45):
        raise RuntimeError("fm_cloudflare")
    page.wait_for_timeout(1000)
    if page.locator("form.filter").count() == 0:
        page.wait_for_timeout(3000)
    if page.locator("form.filter").count() == 0:
        raise RuntimeError("fm_search_unavailable")

    page.fill('input[name="name"]', "")
    page.evaluate("$('form.filter').trigger('change')")
    page.wait_for_timeout(800)
    page.fill('input[name="name"]', name_hint.strip())
    male = page.locator('input[name="gender"][value="1"]')
    if male.count():
        male.first.check()
    page.evaluate("$('form.filter').trigger('change')")
    page.wait_for_timeout(2500)
    for _ in range(40):
        if not page.locator("form.filter.loading").count():
            break
        page.wait_for_timeout(200)

    soup = BeautifulSoup(page.content(), "html.parser")
    needle = f"/{fm_id}-"
    for a in soup.select("a[href*='/players/']"):
        href = a.get("href") or ""
        if needle in href:
            return href if href.startswith("http") else "https://fminside.net" + href

    raise RuntimeError("fm_id_not_found_in_search")


def scrape_player(url_or_id: str, name_hint: str | None = None) -> dict:
    url, fm_id = normalize_input(url_or_id)
    pw = sync_playwright().start()
    try:
        browser = None
        last_err: Exception | None = None
        for kwargs in (
            {"channel": "chrome"},
            {"executable_path": "/usr/bin/chromium"},
            {"executable_path": "/usr/bin/chromium-browser"},
            {},
        ):
            try:
                browser = pw.chromium.launch(
                    headless=True,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                    ],
                    **kwargs,
                )
                break
            except Exception as e:
                last_err = e
        if browser is None:
            raise RuntimeError(f"browser_launch_failed: {last_err}")

        try:
            page = browser.new_context(user_agent=mod.UA, locale="en-US").new_page()
            if not url:
                if not fm_id:
                    raise RuntimeError("invalid_fm_input")
                url = resolve_url_from_id(page, fm_id, name_hint)

            page.goto(url, wait_until="domcontentloaded", timeout=90000)
            if not mod.wait_ready(page, 60):
                raise RuntimeError("fm_cloudflare")
            page.wait_for_timeout(1500)
            if "just a moment" in page.title().lower():
                page.wait_for_timeout(4000)
            return parse_player_html(page.content(), page.url)
        finally:
            browser.close()
    finally:
        pw.stop()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("url_or_id", help="FMInside player URL or numeric unique ID")
    ap.add_argument(
        "--name",
        default="",
        help="TM/Din8sty name hint (needed when only ID is given and not in raw)",
    )
    args = ap.parse_args()
    try:
        data = scrape_player(args.url_or_id, args.name or None)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        sys.exit(1)
    print(json.dumps({"ok": True, "player": data}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
