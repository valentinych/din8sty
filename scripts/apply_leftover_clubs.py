#!/usr/bin/env python3
"""Apply leftover club_id updates (from TM transfers) onto a din8sty DB."""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: apply_leftover_clubs.py PAYLOAD.json DB", file=sys.stderr)
        return 2
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    conn = sqlite3.connect(sys.argv[2])
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT OR IGNORE INTO leagues (id, name, country, sort_order) VALUES (?, ?, ?, ?)",
        ("OTH", "Outside", "—", 99),
    )
    club_sql = """
      INSERT INTO clubs (id, league_id, name, short_name, club_code, crest_url)
      VALUES (:id, :league_id, :name, :short_name, :club_code, :crest_url)
      ON CONFLICT(id) DO UPDATE SET
        league_id=CASE
          WHEN clubs.league_id IN ('GB1','ES1','IT1','L1','FR1','PO1','BE1','NL1')
            THEN clubs.league_id
          ELSE excluded.league_id
        END,
        name=excluded.name,
        short_name=COALESCE(excluded.short_name, clubs.short_name),
        club_code=COALESCE(excluded.club_code, clubs.club_code),
        crest_url=COALESCE(excluded.crest_url, clubs.crest_url)
    """
    moved = 0
    missing_player = 0
    with conn:
        for c in payload["clubs"]:
            conn.execute(club_sql, c)
        for p in payload["players"]:
            prev = conn.execute(
                "SELECT club_id, league_id FROM players WHERE id=?", (p["id"],)
            ).fetchone()
            if prev is None:
                missing_player += 1
                continue
            if str(prev["club_id"]) != str(p["club_id"]) or str(prev["league_id"]) != str(
                p["league_id"]
            ):
                conn.execute(
                    "UPDATE players SET club_id=?, league_id=? WHERE id=?",
                    (p["club_id"], p["league_id"], p["id"]),
                )
                moved += 1
    print(
        f"clubs upserted={len(payload['clubs'])} player_club_moves={moved} "
        f"missing_on_target={missing_player} payload_players={len(payload['players'])}"
    )
    for pid in ("324358", "460939", "648195", "111873", "493003", "455661"):
        r = conn.execute(
            """SELECT p.name, p.club_id, p.league_id, c.name AS club
               FROM players p LEFT JOIN clubs c ON c.id=p.club_id WHERE p.id=?""",
            (pid,),
        ).fetchone()
        print(dict(r) if r else {"id": pid, "missing": True})
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
