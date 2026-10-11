#!/usr/bin/env python3
"""Force-scrape a fixed list of clubs by known FMInside URL."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# Import helpers from main scraper without running main
import importlib.util

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("scrape_fminside", ROOT / "scripts" / "scrape_fminside.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

TARGETS = [
    ("281", "Manchester City", "/clubs/7-fm-26/679-manchester-city"),
    ("46", "Inter Milan", "/clubs/7-fm-26/1135-internazionale"),
    ("27", "Bayern Munich", "/clubs/7-fm-26/915-fc-bayern"),
    ("273", "Stade Rennais FC", "/clubs/7-fm-26/884-rennes"),
    ("631", "Chelsea FC", "/clubs/7-fm-26/630-chelsea"),
    ("31", "Liverpool FC", "/clubs/7-fm-26/676-liverpool"),
    ("720", "FC Porto", "/clubs/7-fm-26/1478-fc-porto"),
    ("294", "SL Benfica", "/clubs/7-fm-26/1487-benfica"),
]


def main() -> None:
    raw_path = ROOT / "data" / "fminside_raw.json"
    raw = json.loads(raw_path.read_text())
    con = sqlite3.connect(ROOT / "data" / "din8sty.db")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            channel="chrome",
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = browser.new_context(user_agent=mod.UA, locale="en-US").new_page()
        for cid, name, url in TARGETS:
            existing = len((raw.get("clubs", {}).get(cid) or {}).get("players") or [])
            if existing >= 40:
                print(f"skip {name} ({existing})", flush=True)
                continue
            print(f"→ {name}", flush=True)
            players = mod.scrape_club(page, url, name)
            print(f"  {url} → {len(players)}", flush=True)
            if len(players) < 20:
                continue
            lg = con.execute("SELECT league_id FROM clubs WHERE id=?", (cid,)).fetchone()[0]
            raw.setdefault("clubs", {})[cid] = {
                "tm_name": name,
                "league_id": lg,
                "fm_url": url,
                "players": players,
                "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2))
            time.sleep(0.5)
        browser.close()
    print("done")


if __name__ == "__main__":
    main()
