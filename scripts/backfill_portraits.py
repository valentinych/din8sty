#!/usr/bin/env python3
"""
Fill players.portrait_url from tm_squad_players (or a JSON map) where it is
NULL / empty / a TM crest (`/wappen/`). Never writes a wappen URL.

Usage:
  python3 scripts/backfill_portraits.py
  python3 scripts/backfill_portraits.py --dry-run
  python3 scripts/backfill_portraits.py --dump-json /tmp/portraits.json
  python3 scripts/backfill_portraits.py --db /opt/din8sty/data/din8sty.db --from-json /tmp/portraits.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "din8sty.db"
TM_DB_PATH = ROOT.parent / "transfermarkt" / "data" / "app.db"

TOP4 = ("GB1", "ES1", "IT1", "L1")


def is_real_portrait_url(url: str | None) -> bool:
    if not url:
        return False
    s = str(url).strip()
    if not s:
        return False
    if "/wappen/" in s.lower():
        return False
    return "/portrait/" in s.lower()


def load_from_tm(tm_path: Path) -> dict[str, str]:
    tm = sqlite3.connect(f"file:{tm_path}?mode=ro", uri=True)
    rows = tm.execute(
        """
        SELECT player_id, portrait_url
        FROM tm_squad_players
        WHERE portrait_url IS NOT NULL
          AND trim(portrait_url) != ''
          AND portrait_url NOT LIKE '%/wappen/%'
          AND portrait_url LIKE '%/portrait/%'
        ORDER BY
          CASE WHEN portrait_url LIKE '%/portrait/big/%' THEN 0 ELSE 1 END,
          length(portrait_url) DESC
        """
    ).fetchall()
    tm.close()
    out: dict[str, str] = {}
    for pid, url in rows:
        pid_s = str(pid)
        if pid_s not in out and is_real_portrait_url(url):
            out[pid_s] = str(url).strip()
    return out


def load_from_json(path: Path) -> dict[str, str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit("JSON map must be {player_id: portrait_url}")
    return {
        str(k): str(v).strip()
        for k, v in raw.items()
        if is_real_portrait_url(v)
    }


def needs_portrait_sql() -> str:
    return (
        "portrait_url IS NULL OR trim(portrait_url) = '' "
        "OR portrait_url LIKE '%/wappen/%'"
    )


def counts(conn: sqlite3.Connection) -> dict[str, int]:
    q = needs_portrait_sql()
    top4_ph = ",".join("?" * len(TOP4))
    has_picks = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='top4_draft_picks'"
    ).fetchone()
    drafted_null = 0
    drafted = 0
    if has_picks:
        drafted = conn.execute(
            "SELECT COUNT(*) FROM top4_draft_picks WHERE COALESCE(replaced,0)=0"
        ).fetchone()[0]
        drafted_null = conn.execute(
            f"""
            SELECT COUNT(*) FROM top4_draft_picks dp
            JOIN players p ON p.id = dp.player_id
            WHERE COALESCE(dp.replaced,0)=0 AND ({q})
            """
        ).fetchone()[0]
    return {
        "all_null": conn.execute(f"SELECT COUNT(*) FROM players WHERE {q}").fetchone()[0],
        "top4_null": conn.execute(
            f"SELECT COUNT(*) FROM players WHERE league_id IN ({top4_ph}) AND ({q})",
            TOP4,
        ).fetchone()[0],
        "drafted": drafted,
        "drafted_null": drafted_null,
    }


def spot(conn: sqlite3.Connection) -> list[tuple[str, str, str | None]]:
    return conn.execute(
        """
        SELECT id, name, portrait_url FROM players
        WHERE id IN ('520624', '193082', '241641')
        ORDER BY name
        """
    ).fetchall()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=DB_PATH)
    ap.add_argument("--tm", type=Path, default=TM_DB_PATH)
    ap.add_argument("--from-json", type=Path, default=None)
    ap.add_argument("--dump-json", type=Path, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.from_json:
        mapping = load_from_json(args.from_json)
    else:
        if not args.tm.exists():
            print(f"Missing TM DB {args.tm}", file=sys.stderr)
            return 1
        mapping = load_from_tm(args.tm)

    if args.dump_json:
        args.dump_json.write_text(
            json.dumps(mapping, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Wrote {len(mapping)} portraits → {args.dump_json}")
        if not args.db.exists():
            return 0

    if not args.db.exists():
        print(f"Missing {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    before = counts(conn)
    print("before", before)
    print("spot", [(r[1], r[2]) for r in spot(conn)])

    would = 0
    applied = 0
    samples: list[tuple[str, str, str]] = []
    q = needs_portrait_sql()
    with conn:
        for pid, url in mapping.items():
            row = conn.execute(
                f"SELECT name FROM players WHERE id = ? AND ({q})",
                (pid,),
            ).fetchone()
            if not row:
                continue
            would += 1
            if len(samples) < 8:
                samples.append((pid, row["name"], url))
            if not args.dry_run:
                conn.execute(
                    f"""
                    UPDATE players SET portrait_url = ?
                    WHERE id = ? AND ({q})
                    """,
                    (url, pid),
                )
                applied += 1
    if not args.dry_run:
        try:
            conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except sqlite3.OperationalError:
            pass

    after = counts(conn)
    print("would_fill" if args.dry_run else "updated", would if args.dry_run else applied)
    print("after", after)
    print("samples:")
    for pid, name, url in samples:
        print(f"  {name} ({pid}): {url}")
    print("spot", [(r[1], r[2]) for r in spot(conn)])
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
