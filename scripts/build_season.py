#!/usr/bin/env python3
"""Build data/season-<year>.json: every completed regular-season game on ESPN's FBS
board (scoreboard groups=80) with closing/opening lines and the FPI projection.

    python3 scripts/build_season.py [--year 2026] [--full]

Standard library only, Python 3.9+. Incremental by default: games already in the
existing file are reused and only newly completed games are fetched. --full refetches
everything.

Sign conventions (see the Scouting spec):
  sp / spo   HOME team's closing / opening spread. Negative = home favored.
             BYU (away) -7 at UCF -> sp = +7.
  tot / toto closing / opening total.
  hml / aml  closing moneylines, American odds.
  fpi        ESPN FPI projected HOME margin (teamPredPtDiff), 1 decimal.
  fpiw       FPI HOME win probability 0..1 (gameProjection / 100).
Any line or FPI field may be null.

Top-level "recheck" (only present when non-empty) lists event ids whose odds or FPI
request failed outright (network/5xx after retries). They are refetched on the next run;
every other game already in the file counts as checked and is reused as-is.
"""

import argparse
import concurrent.futures
import datetime
import http.client
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"
UA = "nut-house-parlay/season-builder (+https://github.com)"
TIMEOUT = 20
RETRIES = 3
WORKERS = 8
PROVIDER_ID = "100"  # DraftKings
FBS_GROUP = 80
# Conferences that never appear as a conference game on the FBS board.
CONF_FALLBACK = {"18": "FBS Indep."}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")


class NotFound(Exception):
    """ESPN answered 404: the resource definitively does not exist."""


def get_json(url):
    """GET a JSON document with timeout and 3 retries (exponential backoff).
    Raises NotFound on 404/410, the last error otherwise."""
    last = None
    for attempt in range(RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                raise NotFound(url)
            if 400 <= e.code < 500 and e.code not in (408, 429):
                raise
            last = e
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                http.client.HTTPException, ValueError) as e:
            last = e
        if attempt < RETRIES:
            time.sleep(1.5 * (2 ** attempt))
    raise last


# ---------------------------------------------------------------- number helpers

def clean(x, places=3):
    """float -> int when integral, else rounded float. None passes through."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    f = round(f, places)
    return int(f) if f.is_integer() else f


def line_num(v):
    """'-7.5' / '+9.5' / 'PK' / 'EVEN' / 'o43.5' -> number."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return clean(v)
    s = str(v).strip()
    if s[:1] in ("o", "O", "u", "U"):
        s = s[1:]
    if s.upper() in ("PK", "PICK", "EVEN", "EV"):
        return 0
    return clean(s)


def ml_num(v):
    """'+235' / '-290' / 'EVEN' -> int American odds."""
    if v is None:
        return None
    if isinstance(v, str) and v.strip().upper() in ("EVEN", "EV"):
        return 100
    n = clean(v, 0)
    return int(n) if n is not None else None


def dig(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


def ref_id(ref, kind="teams"):
    """'.../teams/2116?lang=en' -> '2116'."""
    if not isinstance(ref, str) or ("/%s/" % kind) not in ref:
        return None
    return ref.split("/%s/" % kind, 1)[1].split("?", 1)[0].split("/", 1)[0]


def neg(x):
    return None if x is None else clean(-x)


# ---------------------------------------------------------------- scoreboard

def scoreboard_url(week, year):
    # The site API ignores `year=`; `dates=<YYYY>` is what selects the season.
    return ("%s/scoreboard?groups=%d&limit=400&week=%d&seasontype=2&dates=%d"
            % (SITE, FBS_GROUP, week, year))


def get_board(week, year):
    sb = get_json(scoreboard_url(week, year))
    got = dig(sb, "season", "year")
    if got is not None and int(got) != int(year):
        raise ValueError("ESPN returned season %s for week %d of %d" % (got, week, year))
    return sb


def regular_season_weeks(sb):
    for league in sb.get("leagues") or []:
        for cal in league.get("calendar") or []:
            if str(cal.get("value")) == "2":
                weeks = []
                for e in cal.get("entries") or []:
                    try:
                        weeks.append(int(e.get("value")))
                    except (TypeError, ValueError):
                        pass
                if weeks:
                    return max(weeks)
    return None


def parse_week(sb, week, teams, conf_names):
    """-> list of base game records for completed games; fills teams and conf_names."""
    games = []
    for ev in sb.get("events") or []:
        comps = ev.get("competitions") or []
        if not comps:
            continue
        c = comps[0]
        grp = c.get("groups") or {}
        if grp.get("isConference") and grp.get("id"):
            conf_names[str(grp["id"])] = grp.get("shortName") or grp.get("name")
        sides = {t.get("homeAway"): t for t in c.get("competitors") or []}
        home, away = sides.get("home"), sides.get("away")
        if not home or not away:
            continue
        for t in (home, away):
            team = t.get("team") or {}
            tid = str(team.get("id") or t.get("id"))
            teams[tid] = {
                "abbr": team.get("abbreviation"),
                "short": team.get("shortDisplayName") or team.get("displayName"),
                "_conf": str(team["conferenceId"]) if team.get("conferenceId") else None,
            }
        status = dig(c, "status", "type") or dig(ev, "status", "type") or {}
        if not status.get("completed"):
            continue
        games.append({
            "id": str(ev.get("id")),
            "wk": week,
            "date": ev.get("date") or c.get("date"),
            "h": str(dig(home, "team", "id") or home.get("id")),
            "a": str(dig(away, "team", "id") or away.get("id")),
            "neutral": bool(c.get("neutralSite")),
            "hs": clean(home.get("score"), 0),
            "as": clean(away.get("score"), 0),
            "_habbr": dig(home, "team", "abbreviation"),
            "_aabbr": dig(away, "team", "abbreviation"),
        })
    return games


# ---------------------------------------------------------------- odds + FPI

ODDS_FIELDS = ("sp", "spo", "tot", "toto", "hml", "aml")
FPI_FIELDS = ("fpi", "fpiw")


def fetch_odds(g):
    """-> (fields dict, provider name, details text). Raises on transport failure."""
    eid = g["id"]
    try:
        d = get_json("%s/events/%s/competitions/%s/odds?lang=en&region=us" % (CORE, eid, eid))
    except NotFound:
        return {}, None, None
    items = d.get("items") or []
    if not items:
        return {}, None, None
    it = next((x for x in items if str(dig(x, "provider", "id")) == PROVIDER_ID), items[0])
    if "provider" not in it and isinstance(it.get("$ref"), str):
        it = get_json(it["$ref"].replace("http://", "https://", 1))

    ho, ao = it.get("homeTeamOdds") or {}, it.get("awayTeamOdds") or {}
    flip = 1
    hid = ref_id(dig(ho, "team", "$ref"))
    if hid and hid == g["a"] and ref_id(dig(ao, "team", "$ref")) == g["h"]:
        ho, ao, flip = ao, ho, -1  # core API home/away disagree with the scoreboard

    def side_line(side, block):
        return line_num(dig(side, block, "pointSpread", "american"))

    sp = side_line(ho, "close")
    if sp is None:
        sp = neg(side_line(ao, "close"))
    if sp is None and it.get("spread") is not None:
        sp = clean(float(it["spread"]) * flip)
    if sp is None:
        sp = side_line(ho, "current")
    spo = side_line(ho, "open")
    if spo is None:
        spo = neg(side_line(ao, "open"))

    tot = line_num(dig(it, "close", "total", "american"))
    if tot is None:
        tot = clean(it.get("overUnder"))
    if tot is None:
        tot = line_num(dig(it, "current", "total", "american"))
    toto = line_num(dig(it, "open", "total", "american"))

    def side_ml(side):
        v = ml_num(dig(side, "close", "moneyLine", "american"))
        if v is None:
            v = ml_num(side.get("moneyLine"))
        if v is None:
            v = ml_num(dig(side, "current", "moneyLine", "american"))
        return v

    fields = {"sp": sp, "spo": spo, "tot": tot, "toto": toto, "hml": side_ml(ho), "aml": side_ml(ao)}
    return fields, dig(it, "provider", "name"), it.get("details")


def fetch_fpi(g):
    eid = g["id"]
    try:
        d = get_json("%s/events/%s/competitions/%s/predictor?lang=en&region=us" % (CORE, eid, eid))
    except NotFound:
        return {}
    side = d.get("homeTeam") or {}
    if ref_id(dig(side, "team", "$ref")) == g["a"] and ref_id(dig(d, "awayTeam", "team", "$ref")) == g["h"]:
        side = d.get("awayTeam") or {}

    def stat(name):
        for s in side.get("statistics") or []:
            if s.get("name") == name:
                return s.get("value")
        return None

    margin, proj = stat("teamPredPtDiff"), stat("gameProjection")
    return {
        "fpi": clean(margin, 1),
        "fpiw": clean(float(proj) / 100.0, 3) if proj is not None else None,
    }


def details_sign_ok(g, details):
    """Cross-check sp against ESPN's text ('FIU -10.5'). None when it can't tell."""
    if not details or g.get("sp") is None:
        return None
    parts = details.strip().rsplit(" ", 1)
    if len(parts) != 2:
        return None
    abbr, val = parts
    v = line_num(val)
    if v is None:
        return None
    if abbr == g.get("_habbr"):
        expected = v
    elif abbr == g.get("_aabbr"):
        expected = -v
    else:
        return None
    return abs(expected - g["sp"]) < 1e-9


# ---------------------------------------------------------------- main

GAME_KEYS = ("id", "wk", "date", "h", "a", "neutral", "hs", "as") + ODDS_FIELDS + FPI_FIELDS


def load_existing(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def pct(n, d):
    return "%.0f%%" % (100.0 * n / d) if d else "n/a"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--year", type=int, help="season year (default: ESPN's current season)")
    ap.add_argument("--full", action="store_true", help="refetch every game, ignoring the existing file")
    args = ap.parse_args()
    started = time.time()

    try:
        default_sb = get_json("%s/scoreboard" % SITE)
    except Exception as e:
        print("error: cannot reach ESPN scoreboard: %s" % e, file=sys.stderr)
        return 1
    cur_year = dig(default_sb, "season", "year")
    cur_type = dig(default_sb, "season", "type")
    cur_week = dig(default_sb, "week", "number")
    year = args.year or cur_year
    if not year:
        print("error: ESPN did not report a current season; pass --year", file=sys.stderr)
        return 1

    path = os.path.join(DATA_DIR, "season-%d.json" % year)
    existing = load_existing(path)
    if existing is not None and existing.get("season") != year:
        existing = None
    old = None if (args.full or existing is None) else existing
    old_games = {g["id"]: g for g in (old or {}).get("games", [])}
    old_recheck = set((old or {}).get("recheck", []))

    # Which regular-season weeks can hold completed games.
    try:
        wk1 = get_board(1, year)
    except Exception as e:
        print("error: week 1 scoreboard failed: %s" % e, file=sys.stderr)
        return 1
    max_week = regular_season_weeks(wk1) or 16
    if year == cur_year and cur_type == 1:
        last_week = 0
    elif year == cur_year and cur_type == 2 and cur_week:
        last_week = min(int(cur_week), max_week)
    elif cur_year and year > cur_year:
        last_week = 0
    else:
        last_week = max_week
    weeks = list(range(1, last_week + 1))

    # Scoreboards (concurrent). A failed week carries its games over from the old file.
    boards, failed_weeks = {1: wk1} if weeks else {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(get_board, w, year): w for w in weeks if w != 1}
        for fut in concurrent.futures.as_completed(futs):
            w = futs[fut]
            try:
                boards[w] = fut.result()
            except Exception as e:
                failed_weeks.append(w)
                print("warn: week %d scoreboard failed (%s); keeping previous data" % (w, e), file=sys.stderr)

    teams, conf_names, games = {}, {}, {}
    for w in sorted(boards):
        for g in parse_week(boards[w], w, teams, conf_names):
            games[g["id"]] = g
    carried = 0
    for w in sorted(failed_weeks):
        for g in (existing or {}).get("games", []):
            if g.get("wk") == w and g["id"] not in games:
                games[g["id"]] = dict(g)
                carried += 1
                for tid in (g["h"], g["a"]):
                    if tid not in teams and tid in (existing.get("teams") or {}):
                        t = existing["teams"][tid]
                        teams[tid] = {"abbr": t.get("abbr"), "short": t.get("short"), "_conf": None, "_old_conf": t.get("conf")}

    # Reuse checked games; queue the rest.
    to_fetch, reused = [], 0
    for gid, g in games.items():
        prev = old_games.get(gid)
        if prev is not None:
            for k in ODDS_FIELDS + FPI_FIELDS:
                g.setdefault(k, prev.get(k))
        if prev is not None and gid not in old_recheck:
            reused += 1
        else:
            to_fetch.append(g)

    recheck, providers, sign_checks, sign_bad = set(), {}, 0, []

    def work(g):
        out = {"odds": None, "fpi": None, "provider": None, "details": None, "errors": []}
        try:
            out["odds"], out["provider"], out["details"] = fetch_odds(g)
        except Exception as e:
            out["errors"].append("odds: %s" % e)
        try:
            out["fpi"] = fetch_fpi(g)
        except Exception as e:
            out["errors"].append("fpi: %s" % e)
        return g, out

    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for g, out in ex.map(work, to_fetch):
            prev = old_games.get(g["id"]) or {}
            for part, keys in (("odds", ODDS_FIELDS), ("fpi", FPI_FIELDS)):
                if out[part] is not None:
                    for k in keys:
                        g[k] = out[part].get(k)
                else:  # transport failure: keep whatever we had, retry next run
                    for k in keys:
                        g[k] = prev.get(k)
                    recheck.add(g["id"])
            for err in out["errors"]:
                print("warn: %s %s" % (g["id"], err), file=sys.stderr)
            if out["provider"]:
                providers[out["provider"]] = providers.get(out["provider"], 0) + 1
            ok = details_sign_ok(g, out["details"])
            if ok is not None:
                sign_checks += 1
                if not ok:
                    sign_bad.append("%s (%s, sp=%s)" % (g["id"], out["details"], g["sp"]))
    # Carried-over games that were pending stay pending.
    for gid in old_recheck:
        if gid in games and games[gid]["wk"] in failed_weeks:
            recheck.add(gid)

    # Assemble deterministic output.
    game_list = []
    for g in sorted(games.values(), key=lambda x: (x.get("date") or "", int(x["id"]) if x["id"].isdigit() else 0, x["id"])):
        game_list.append({k: g.get(k) for k in GAME_KEYS})
    used = sorted({g["h"] for g in game_list} | {g["a"] for g in game_list},
                  key=lambda t: (int(t) if t.isdigit() else 0, t))
    old_teams = (existing or {}).get("teams") or {}
    team_map = {}
    for tid in used:
        t = teams.get(tid) or {}
        conf = conf_names.get(t.get("_conf") or "") or CONF_FALLBACK.get(t.get("_conf") or "")
        if conf is None:
            conf = t.get("_old_conf") or (old_teams.get(tid) or {}).get("conf")
        team_map[tid] = {"abbr": t.get("abbr"), "short": t.get("short"), "conf": conf}

    provider = "DraftKings"
    if providers:
        provider = sorted(providers.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    elif existing and existing.get("provider"):
        provider = existing["provider"]

    payload = {
        "season": year,
        "generated": None,
        "throughWeek": max([g["wk"] for g in game_list] or [0]),
        "provider": provider,
        "teams": team_map,
        "games": game_list,
    }
    if recheck:
        payload["recheck"] = sorted(recheck)

    n = len(game_list)
    with_sp = sum(1 for g in game_list if g["sp"] is not None)
    with_spo = sum(1 for g in game_list if g["spo"] is not None)
    with_fpi = sum(1 for g in game_list if g["fpi"] is not None)
    with_tot = sum(1 for g in game_list if g["tot"] is not None)

    if n == 0 and existing is None:
        print("No completed regular-season games for %d yet; nothing written." % year)
        return 0

    def body(p):
        q = dict(p)
        q.pop("generated", None)
        return json.dumps(q, separators=(",", ":"), ensure_ascii=False, sort_keys=False)

    if existing is not None and body(existing) == body(payload) and existing.get("generated"):
        payload["generated"] = existing["generated"]
    else:
        payload["generated"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"

    current = None
    try:
        with open(path, "r", encoding="utf-8") as f:
            current = f.read()
    except OSError:
        pass
    if current == text:
        status = "unchanged"
    else:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
        status = "written"

    print("season-%d.json %s (%s bytes) in %.1fs" % (year, status, format(len(text.encode("utf-8")), ","), time.time() - started))
    print("  games %d through week %d | fetched %d, reused %d%s" % (
        n, payload["throughWeek"], len(to_fetch), reused,
        (", carried %d from failed weeks %s" % (carried, sorted(failed_weeks))) if failed_weeks else ""))
    print("  closing spread %s | open spread %s | total %s | fpi %s" % (
        pct(with_sp, n), pct(with_spo, n), pct(with_tot, n), pct(with_fpi, n)))
    if providers:
        print("  providers this run: %s" % ", ".join("%s %d" % kv for kv in sorted(providers.items())))
    if sign_checks:
        print("  spread sign vs ESPN details text: %d/%d agree" % (sign_checks - len(sign_bad), sign_checks))
    for s in sign_bad[:10]:
        print("  warn: sign mismatch %s" % s, file=sys.stderr)
    if recheck:
        print("  %d game(s) queued for recheck next run" % len(recheck))
    return 0


if __name__ == "__main__":
    sys.exit(main())
