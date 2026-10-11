#!/usr/bin/env python3
"""
Merge players (+ Top-4 wishlist cleanup) from a donor din8sty.db into a target DB.
Does NOT touch registrations, draft state, lineups, fixtures, or user maps.

Usage (on prod, after scp'ing donor):
  python3 scripts/merge_players_from_donor.py /tmp/din8sty-donor.db /opt/din8sty/data/din8sty.db
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone

PLAYER_COLS = [
    "id",
    "club_id",
    "league_id",
    "name",
    "age",
    "date_of_birth",
    "height",
    "preferred_foot",
    "position",
    "detail_role",
    "detail_label",
    "side_role",
    "shirt_number",
    "nationality",
    "market_value_eur",
    "contract_until",
    "portrait_url",
    "tm_url",
    "fm_rating",
    "fm_potential",
    "fm_wage_pw",
    "fm_wage_display",
    "fm_url",
    "fm_matched_name",
    "fm_synced_at",
    "capology_wage_pw",
    "capology_wage_display",
    "capology_currency_orig",
    "capology_synced_at",
]


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: merge_players_from_donor.py DONOR.db TARGET.db", file=sys.stderr)
        return 2
    donor, target = sys.argv[1], sys.argv[2]
    conn = sqlite3.connect(target)
    conn.row_factory = sqlite3.Row
    conn.execute(f"ATTACH DATABASE ? AS donor", (donor,))

    # Column intersection (schema drift safe)
    tgt_cols = {
        r["name"]
        for r in conn.execute("PRAGMA table_info(players)")
    }
    don_cols = {
        r["name"]
        for r in conn.execute("PRAGMA donor.table_info(players)")
    }
    cols = [c for c in PLAYER_COLS if c in tgt_cols and c in don_cols]
    if "id" not in cols:
        print("players.id missing", file=sys.stderr)
        return 1

    col_list = ", ".join(cols)
    placeholders = ", ".join("?" for _ in cols)
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "id")

    upsert_sql = f"""
      INSERT INTO players ({col_list})
      VALUES ({placeholders})
      ON CONFLICT(id) DO UPDATE SET {updates}
    """

    donor_rows = conn.execute(f"SELECT {col_list} FROM donor.players").fetchall()
    donor_ids = {r["id"] for r in donor_rows}
    top4 = ("GB1", "ES1", "IT1", "L1")

    # Top-4 players on target that donor no longer has → remove from pool
    stale = conn.execute(
        f"""SELECT id FROM players
            WHERE league_id IN ({",".join("?" * len(top4))})
              AND id NOT IN (SELECT id FROM donor.players)""",
        top4,
    ).fetchall()

    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    club_moves = 0
    mv_changes = 0
    inserted = 0
    updated = 0
    with conn:
        upsert = conn.prepare if False else None  # noqa
        stmt = conn.execute  # placeholder
        for r in donor_rows:
            prev = conn.execute(
                "SELECT club_id, market_value_eur FROM players WHERE id=?",
                (r["id"],),
            ).fetchone()
            vals = [r[c] for c in cols]
            conn.execute(upsert_sql, vals)
            if prev is None:
                inserted += 1
            else:
                updated += 1
                if prev["club_id"] != r["club_id"]:
                    club_moves += 1
                if prev["market_value_eur"] != r["market_value_eur"]:
                    mv_changes += 1

        removed = 0
        for row in stale:
            pid = row["id"]
            if "top4_wishlist" in tables:
                conn.execute("DELETE FROM top4_wishlist WHERE player_id=?", (pid,))
            if "top8_wishlist" in tables:
                conn.execute("DELETE FROM top8_wishlist WHERE player_id=?", (pid,))
            conn.execute("DELETE FROM players WHERE id=?", (pid,))
            removed += 1

        # Copy relevant meta keys
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for key in (
            "tm_html_top4_synced_at",
            "tm_html_top4_players",
            "capology_synced_at",
            "capology_fx_date",
            "capology_fx_gbp_eur",
            "capology_players_matched",
        ):
            row = conn.execute(
                "SELECT value FROM donor.meta WHERE key=?", (key,)
            ).fetchone()
            if not row:
                continue
            conn.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, row["value"]),
            )
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('players_merged_from_donor_at',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (now,),
        )

    # Preserve registration counts for sanity
    regs = conn.execute("SELECT COUNT(*) n FROM top4_registrations").fetchone()["n"] if "top4_registrations" in tables else -1
    print(
        f"Merged donor→target: updated={updated} inserted={inserted} "
        f"club_moves={club_moves} mv_changes={mv_changes} removed_stale_top4={removed} "
        f"top4_regs={regs} donor_players={len(donor_ids)}"
    )
    samples = ("418560", "937958", "342229", "315858")
    for pid in samples:
        r = conn.execute(
            "SELECT name, club_id, market_value_eur, capology_wage_pw FROM players WHERE id=?",
            (pid,),
        ).fetchone()
        if r:
            print(
                f"  {r['name']}: club={r['club_id']} MV={r['market_value_eur']} "
                f"cap={r['capology_wage_pw']}"
            )
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
