#!/usr/bin/env python3
"""Build data/history.json from the "Bozo Picks" Google Sheet.

The sheet has one tab per season ("Year 1", "Year 2", "Year 3"). Row 1 names the
players; each player gets two columns: the pick ("W - Clemson -18.5") and the
result ("W", "L" or "P"). Rows are weeks ("Week 0".."Week 15"); blank cells mean
the player didn't pick that week. Summary blocks further down the tab are ignored
and recomputed by the site.

Usage: save each tab's values (Sheets API values.get response, or a bare list of
rows) as JSON, then

    python3 scripts/import_history.py year1.json year2.json year3.json > data/history.json

Bios are kept from the existing data/history.json, so re-importing only refreshes
the picks.
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

SEASONS = {1: 2024, 2: 2025, 3: 2026}  # Year 3 is the 2026 season on the site.

# Sheet shorthand -> one name per team, so "Bama" and "Alabama" count together.
ALIASES = {
    "bama": "Alabama", "alabama": "Alabama",
    "uga": "Georgia", "georgia": "Georgia",
    "gt": "Georgia Tech", "georgia tech": "Georgia Tech",
    "ou": "Oklahoma", "oklahoma": "Oklahoma",
    "uh": "Houston", "houston": "Houston",
    "unt": "North Texas",
    "mizzou": "Missouri", "missouri": "Missouri",
    "k state": "Kansas State",
    "iowa st": "Iowa State", "iowa state": "Iowa State",
    "az state": "Arizona State", "arizona st": "Arizona State", "asu": "Arizona State",
    "wsu": "Washington State", "wash state": "Washington State", "washington st": "Washington State",
    "vandy": "Vanderbilt",
    "tamu": "Texas A&M", "a&m": "Texas A&M", "texas a&m": "Texas A&M",
    "nd": "Notre Dame", "notre dame": "Notre Dame",
    "the u": "Miami", "miami": "Miami",
    "ohio st": "Ohio State", "ohio state": "Ohio State",
    "boise st": "Boise State", "boise state": "Boise State",
    "mississppi state": "Mississippi State",
    "ok state": "Oklahoma State",
    "uva": "Virginia",
    "ull": "Louisiana",
    "ttu": "Texas Tech", "texas tech": "Texas Tech",
    "ut": "Texas", "texas": "Texas",
    "uf": "Florida", "florida": "Florida",
    "ul": "Louisville",
    "cal": "California",
    "fsu": "Florida State",
    "usf": "South Florida",
    "n illinois": "Northern Illinois",
}

# Picks the sheet doesn't spell out, filled from the site's own ticket for that week.
OVERRIDES = {
    (3, "3", "noah"): {"text": "SMU/UL O58.5", "side": "o", "line": 58.5,
                       "note": "Sheet says only SMU/UL; side and line from the site's Week 3 ticket"},
}


def team(name):
    key = re.sub(r"\s+", " ", name.strip()).lower()
    return ALIASES.get(key, name.strip())


def parse_pick(text):
    """'W - Iowa/N Illinois U44.5' -> structured pick (result handled separately)."""
    body = re.sub(r"^[WLP]\s*-\s*", "", text.strip()).strip()
    body = re.sub(r"\s+", " ", body)
    if "/" in body:  # a total: "K State/Iowa State U 51.5", "SMU/UL"
        m = re.match(r"^(.*?)\s*(?:([OoUu])\s*(\d+(?:\.\d+)?))?$", body)
        teams_part, side, line = m.group(1), m.group(2), m.group(3)
        return {
            "kind": "total",
            "teams": [team(t) for t in teams_part.split("/")],
            "side": side.lower() if side else None,
            "line": float(line) if line else None,
        }
    m = re.match(r"^(.*?)\s+ML$", body, re.I)
    if m:
        return {"kind": "ml", "team": team(m.group(1))}
    m = re.match(r"^(.*?)\s*([+-])\s*(\d+(?:\.\d+)?)$", body)
    if m:
        line = float(m.group(3)) * (-1 if m.group(2) == "-" else 1)
        return {"kind": "spread", "team": team(m.group(1)), "line": line}
    raise ValueError(f"Can't read pick: {text!r}")


def clean_text(text):
    """Pick as the sheet wrote it, minus the result prefix and obvious typos/spacing."""
    body = re.sub(r"^[WLP]\s*-\s*", "", text.strip()).strip()
    body = re.sub(r"\s+", " ", body).replace("Mississppi", "Mississippi")
    return re.sub(r"\s([+-])\s(\d)", r" \1\2", body)  # "UCLA - 2.5" -> "UCLA -2.5"


def rows_of(path):
    data = json.loads(Path(path).read_text())
    return data["values"] if isinstance(data, dict) else data


def import_year(n, rows):
    header = rows[0]
    # Names sit every other column from B; the first gap ends the list (Year 1 has a
    # summary table to the right of the picks).
    players = []
    for i in range(1, len(header), 2):
        if not header[i].strip():
            break
        players.append((i, header[i]))
    weeks = []
    for row in rows[1:]:
        label = (row[0] if row else "").strip()
        m = re.match(r"^Week (\d+)$", label)
        if not m:
            if weeks and not label:
                break  # blank row after the weeks: summary blocks start
            continue
        wk = m.group(1)
        picks = {}
        for col, name in players:
            text = row[col].strip() if col < len(row) else ""
            res = row[col + 1].strip().upper() if col + 1 < len(row) else ""
            if not text:
                continue
            if res not in ("W", "L", "P"):
                raise ValueError(f"Year {n} Week {wk} {name}: result {res!r}")
            pid = name.strip().lower()
            pick = {"text": clean_text(text), "r": res, **parse_pick(text)}
            pick.update(OVERRIDES.get((n, wk, pid), {}))
            picks[pid] = pick
        if picks:
            weeks.append({"wk": wk, "picks": picks})
    return {"year": n, "season": SEASONS.get(n), "label": f"Year {n}", "weeks": weeks}


def main(paths):
    out_path = Path(__file__).resolve().parent.parent / "data" / "history.json"
    bios = {}
    if out_path.exists():
        bios = json.loads(out_path.read_text()).get("bios", {})
    years = [import_year(n, rows_of(p)) for n, p in enumerate(paths, start=1)]
    doc = {
        "source": "Bozo Picks sheet",
        "asOf": date.today().isoformat(),
        "years": years,
        "bios": bios,
    }
    json.dump(doc, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
