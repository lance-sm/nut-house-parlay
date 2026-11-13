// Pick Lab engine: turns a week's slate into graded bets with a hit chance, a value read, spot angles
// and the Nut House's own history on that kind of pick. Pure functions (no DOM, no network), shared by the
// Lab tab (js/lab.js) and the backtest (scripts/backtest_model.mjs).
//
// Inputs
//   season   data/season-YYYY.json   finished FBS games with scores + closing lines (the model's fuel)
//   history  data/history.json       every pick the house has made, graded by the Bozo Picks sheet
//   games    normalized games (espn.js normalizeGame) for the week on screen, odds included
//
// Every probability here is for the side named. Spread lines are from the picked side (+ = getting points).
// Home line conventions follow model.js / insights.js (odds.spread is the HOME line, negative = home favored).

import { fitModel, project, phi, tierOf, DEFAULTS, FCS } from "./model.js?v=20261113e";

// How much of each signal reaches the hit chance. Walk-forward, our ratings alone went ~48% against
// closing spreads this season (scripts/backtest_model.mjs), so they set "our line" and break ties but don't
// move a spread's cover chance. Spot angles that have actually paid this season carry that weight.
export const KNOBS = {
  spreadShrink: 0,      // share of the ratings' raw cover-probability edge we believe (backtest says none)
  totalShrink: 0,       // same for totals: our total is shown, the angles move the over/under chance
  mlModelWeight: 0.1,   // moneyline hit chance = 90% de-vigged market + 10% Nut House rating
  angleK: 120,          // an angle's record is shrunk toward .500 by n / (n + angleK)
  angleMinN: 25,        // ignore angles with fewer graded games than this
  angleCap: 0.035,      // one angle moves a cover chance by at most 3.5 points
  sideCap: 0.06,        // all angles together, at most 6 points
  maxFav: -600,         // "safest legs" won't suggest a moneyline shorter than this by default
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pctTxt = (p) => `${Math.round(p * 100)}%`;
export const recText = (r) => `${r.w}-${r.l}${r.p ? `-${r.p}` : ""}`;
const blank = () => ({ w: 0, l: 0, p: 0 });
const tally = (r, x) => { if (x > 0) r.w++; else if (x < 0) r.l++; else r.p++; };
const pctOf = (r) => (r.w + r.l ? r.w / (r.w + r.l) : null);

export function implied(o) {
  o = num(o);
  if (o === null || o === 0) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}
function mlPair(odds) {
  const h = num(odds?.homeML), a = num(odds?.awayML);
  if (h === null || a === null || h === 0 || a === 0 || h <= -5000 || a <= -5000) return null;
  return { h, a };
}

// ---------- team timelines from the season file ----------

function buildTimelines(season) {
  const T = new Map();
  const games = (season?.games || []).filter((g) => isNum(g.hs) && isNum(g.as))
    .slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const g of games) {
    for (const home of [true, false]) {
      const id = home ? g.h : g.a;
      const line = isNum(g.sp) ? (home ? g.sp : -g.sp) : null;
      const margin = home ? g.hs - g.as : g.as - g.hs;
      if (!T.has(id)) T.set(id, []);
      T.get(id).push({
        t: Date.parse(g.date), wk: g.wk, id: g.id, home, neutral: !!g.neutral, opp: home ? g.a : g.h,
        margin, won: margin > 0, line, cover: line === null ? null : margin + line,
        tot: isNum(g.tot) ? g.tot : null, pts: g.hs + g.as,
      });
    }
  }
  return T;
}

// A team's situation going into a game that kicks at `t` (ms).
function stateAt(T, id, t) {
  const all = T.get(String(id)) || [];
  let i = all.length;
  while (i > 0 && all[i - 1].t >= t) i--;
  const before = all.slice(0, i);
  const last = before[before.length - 1] || null;
  const w = before.filter((x) => x.won).length;
  const covers = before.filter((x) => x.cover !== null);
  const last3 = covers.slice(-3);
  return {
    n: before.length, w, l: before.length - w, last,
    rest: last ? (t - last.t) / 864e5 : null,
    last3: last3.length === 3 ? last3.filter((x) => x.cover > 0).length : null,
    ats: covers.reduce((r, x) => { tally(r, x.cover); return r; }, blank()),
    ou: before.filter((x) => x.tot !== null).reduce((r, x) => { tally(r, x.pts - x.tot); return r; }, blank()),
  };
}

// ---------- spot angles ----------
// Each side angle is graded live against every FBS-vs-FBS game this season before the week on screen,
// so its record (and how much it moves a pick) updates itself every week. `why` is the football reason.

export const SIDE_ANGLES = [
  { id: "upset-hangover", label: "Coming off an upset win", why: "Teams that just pulled an upset get overpriced the next week",
    test: (s) => !!s.last && s.last.won && s.last.line !== null && s.last.line > 0 },
  { id: "hype-tax", label: "Blew out the number last week", why: "A 14+ point cover or a 28+ point win inflates the next line",
    test: (s) => !!s.last && ((s.last.cover !== null && s.last.cover >= 14) || s.last.margin >= 28) },
  { id: "buy-low", label: "Failed to cover 3 straight", why: "The market sours on a team after three misses",
    test: (s) => s.last3 === 0 },
  { id: "hot-ats", label: "Covered 3 straight", why: "Riding the team that keeps beating the number",
    test: (s) => s.last3 === 3 },
  { id: "off-bye", label: "Coming off a bye", why: "Extra week to heal and prepare",
    test: (s) => s.rest !== null && s.rest >= 13 },
  { id: "short-week", label: "Short week", why: "Six days or less since the last game",
    test: (s) => s.rest !== null && s.rest <= 6.5 },
  { id: "home-dog", label: "Home dog of 7+", why: "Big home underdogs keep it closer than the number",
    test: (s, c) => c.home && !c.neutral && c.line !== null && c.line >= 7 },
  { id: "road-chalk", label: "Road favorite of 10+", why: "Laying double digits on the road is a tax",
    test: (s, c) => !c.home && !c.neutral && c.line !== null && c.line <= -10 },
  { id: "bowl-push", label: "One win from bowl eligible", why: "Five wins in November: the sixth is worth a lot",
    test: (s, c) => c.wk >= 9 && s.w === 5 },
  { id: "dead-season", label: "Season's over", why: "Can't reach six wins anymore; nothing left to play for",
    test: (s, c) => c.wk >= 9 && s.w + Math.max(0, 12 - s.n) < 6 },
];

export const TOTAL_ANGLES = [
  { id: "low-total", label: "Total 45 or lower", test: (c) => c.tot <= 45 },
  { id: "high-total", label: "Total 60 or higher", test: (c) => c.tot >= 60 },
  { id: "p4-g6", label: "Power 4 vs Group of 6", test: (c) => (c.th === "P4") !== (c.ta === "P4") && c.th !== FCS && c.ta !== FCS },
  { id: "g6-g6", label: "Group of 6 vs Group of 6", test: (c) => c.th === "G6" && c.ta === "G6" },
  { id: "weekday", label: "Weeknight game", test: (c) => c.weekday },
  { id: "both-over", label: "Both teams' games keep going over", test: (c) => c.ouh >= 0.6 && c.oua >= 0.6 && c.ouhN >= 5 && c.ouaN >= 5 },
  { id: "both-under", label: "Both teams' games keep going under", test: (c) => c.ouh <= 0.4 && c.oua <= 0.4 && c.ouhN >= 5 && c.ouaN >= 5 },
];

function etWeekday(t) {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(t));
  return ["Tue", "Wed", "Thu", "Fri"].includes(d);
}

function totalCtx(game, teams, T, t) {
  const sh = stateAt(T, game.home.id, t), sa = stateAt(T, game.away.id, t);
  const p = (r) => (r.w + r.l ? r.w / (r.w + r.l) : 0.5);
  return {
    tot: num(game.odds?.overUnder),
    th: tierOf(teams[game.home.id]?.conf, game.home.id), ta: tierOf(teams[game.away.id]?.conf, game.away.id),
    weekday: etWeekday(t),
    ouh: p(sh.ou), oua: p(sa.ou), ouhN: sh.ou.w + sh.ou.l, ouaN: sa.ou.w + sa.ou.l,
  };
}

// Records for every angle from season games before `week` (FBS vs FBS with a closing line).
function angleRecords(season, T, week) {
  const teams = season.teams || {};
  const side = Object.fromEntries(SIDE_ANGLES.map((a) => [a.id, blank()]));
  const over = Object.fromEntries(TOTAL_ANGLES.map((a) => [a.id, blank()]));
  for (const g of season.games || []) {
    if (g.wk >= week || !isNum(g.hs) || !teams[g.h]?.conf || !teams[g.a]?.conf) continue;
    const t = Date.parse(g.date);
    if (isNum(g.sp)) {
      for (const home of [true, false]) {
        const s = stateAt(T, home ? g.h : g.a, t);
        const line = home ? g.sp : -g.sp;
        const cov = (home ? g.hs - g.as : g.as - g.hs) + line;
        const c = { home, neutral: !!g.neutral, line, wk: g.wk };
        for (const a of SIDE_ANGLES) if (a.test(s, c)) tally(side[a.id], cov);
      }
    }
    if (isNum(g.tot)) {
      const pseudo = { home: { id: g.h }, away: { id: g.a }, odds: { overUnder: g.tot } };
      const c = totalCtx(pseudo, teams, T, t);
      for (const a of TOTAL_ANGLES) if (a.test(c)) tally(over[a.id], g.hs + g.as - g.tot);
    }
  }
  return { side, over };
}

// Record -> probability shift for the side it describes.
function shiftOf(rec, k = KNOBS) {
  const n = rec.w + rec.l;
  if (n < k.angleMinN) return 0;
  return clamp((rec.w / n - 0.5) * (n / (n + k.angleK)), -k.angleCap, k.angleCap);
}

// ---------- the Nut House's own book ----------

export function bucketOf(kind, line, side) {
  if (kind === "ml") return "ml";
  if (kind === "total") return side === "u" ? "under" : "over";
  if (!isNum(line) || line === 0) return "pk";
  if (line > 0) return "take";
  return line >= -7 ? "lay-small" : line >= -14 ? "lay-mid" : "lay-big";
}

export const BUCKET_TEXT = {
  "ml": "moneylines", "over": "overs", "under": "unders", "pk": "pick'ems",
  "take": "getting points", "lay-small": "laying 7 or less", "lay-mid": "laying 7.5 to 14", "lay-big": "laying 14.5+",
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\bst\b/g, "state").trim();

export function houseBook(history) {
  const buckets = new Map(), teams = new Map();
  const bump = (map, key, who, r) => {
    if (!map.has(key)) map.set(key, { all: blank(), by: new Map() });
    const e = map.get(key);
    const add = (rec) => { if (r === "W") rec.w++; else if (r === "L") rec.l++; else if (r === "P") rec.p++; };
    add(e.all);
    if (!e.by.has(who)) e.by.set(who, blank());
    add(e.by.get(who));
  };
  for (const y of history?.years || []) {
    for (const w of y.weeks || []) {
      for (const [who, pk] of Object.entries(w.picks || {})) {
        if (!pk || !pk.r) continue;
        bump(buckets, bucketOf(pk.kind, pk.line, pk.side), who, pk.r);
        if (pk.kind !== "total" && pk.team) bump(teams, norm(pk.team), who, pk.r);
      }
    }
  }
  return { buckets, teams };
}

function houseFor(book, crewNames, kind, line, side, team) {
  if (!book) return null;
  const b = bucketOf(kind, line, side);
  const e = book.buckets.get(b);
  let teamE = null;
  if (team) for (const key of [team.location, team.short, team.name, team.mascot ? `${team.location}` : null]) {
    const hit = key && book.teams.get(norm(key));
    if (hit) { teamE = hit; break; }
  }
  const people = e ? [...e.by.entries()].map(([id, r]) => ({ id, name: crewNames.get(id) || id.charAt(0).toUpperCase() + id.slice(1), r, p: pctOf(r), n: r.w + r.l })) : [];
  const lane = people.filter((x) => x.n >= 4 && x.p >= 0.6).sort((a, b) => b.p - a.p || b.n - a.n)[0] || null;
  const cold = people.filter((x) => x.n >= 3 && x.p <= 0.34).sort((a, b) => a.p - b.p || b.n - a.n)[0] || null;
  const bp = e ? pctOf(e.all) : null, bn = e ? e.all.w + e.all.l : 0;
  const tp = teamE ? pctOf(teamE.all) : null, tn = teamE ? teamE.all.w + teamE.all.l : 0;
  let risk = "low";
  if ((bp !== null && bn >= 10 && bp < 0.48) || (tp !== null && tn >= 3 && tp <= 0.34)) risk = "high";
  else if ((bp !== null && bn >= 10 && bp < 0.53) || (tp !== null && tn >= 3 && tp < 0.5)) risk = "med";
  return { bucket: b, rec: e?.all || null, team: teamE?.all || null, lane, cold, risk };
}

// ---------- context for one week ----------

export function buildContext(season, { week, history = null, crew = [], params = DEFAULTS } = {}) {
  const model = fitModel(season, { beforeWeek: week, params });
  const T = buildTimelines(season);
  const angles = angleRecords(season, T, week);
  const book = houseBook(history);
  const crewNames = new Map((crew || []).map((c) => [String(c.id), c.name]));
  return { season, teams: season?.teams || {}, model, T, angles, book, crewNames, week };
}

function teamTier(ctx, team) {
  return tierOf(ctx.teams[team.id]?.conf, team.id);
}

// Full read on one game: the Nut House numbers plus every bet worth listing.
export function analyzeGame(ctx, game, k = KNOBS) {
  const p = ctx.model.params;
  const t = Date.parse(game.date);
  const home = game.home, away = game.away;
  const th = teamTier(ctx, home), ta = teamTier(ctx, away);
  const sh = stateAt(ctx.T, home.id, t), sa = stateAt(ctx.T, away.id, t);
  const odds = game.odds || {};
  const sp = num(odds.spread), tot = num(odds.overUnder);
  const pr = project(ctx.model, home.id, away.id, { neutral: !!game.neutral });

  // spot angles, both sides
  const sideAngles = (s, isHome) => {
    const line = sp === null ? null : (isHome ? sp : -sp);
    const c = { home: isHome, neutral: !!game.neutral, line, wk: ctx.week };
    return SIDE_ANGLES.filter((a) => a.test(s, c)).map((a) => {
      const rec = ctx.angles.side[a.id];
      const shift = shiftOf(rec, k);
      return { id: a.id, label: a.label, why: a.why, rec, shift, tone: shift > 0.004 ? "good" : shift < -0.004 ? "bad" : "neutral" };
    });
  };
  const angH = sideAngles(sh, true), angA = sideAngles(sa, false);
  const angSum = (list) => list.reduce((s, a) => s + a.shift, 0);
  const homeShift = clamp(angSum(angH) - angSum(angA), -k.sideCap, k.sideCap);

  const tc = tot === null ? null : totalCtx(game, ctx.teams, ctx.T, t);
  const angT = tc ? TOTAL_ANGLES.filter((a) => a.test(tc)).map((a) => {
    const rec = ctx.angles.over[a.id];
    const shift = shiftOf(rec, k);
    return { id: a.id, label: a.label, rec, shift, tone: shift > 0.004 ? "over" : shift < -0.004 ? "under" : "neutral" };
  }) : [];
  const overShift = clamp(angT.reduce((s, a) => s + a.shift, 0), -k.sideCap, k.sideCap);

  const bets = [];
  const mk = (b) => {
    const be = implied(b.odds ?? -110);
    const team = b.kind === "total" ? null : (b.side === home.id ? home : away);
    const house = houseFor(ctx.book, ctx.crewNames, b.kind, b.line, b.kind === "total" ? b.side : null, team);
    const value = b.hit - be;
    const out = { ...b, be, value, team, house, game };
    out.grade = value >= 0.03 ? "strong" : value >= 0.015 ? "solid" : value >= 0.004 ? "lean" : "pass";
    out.label = b.kind === "total" ? `${b.side === "o" ? "Over" : "Under"} ${b.line}` :
      b.kind === "ml" ? `${team.short} ML` : `${team.short} ${b.line === 0 ? "PK" : (b.line > 0 ? "+" : "") + b.line}`;
    // leg-shaped, so it reads like a ticket leg
    Object.assign(out, { e: game.id, t: b.kind, s: b.side, l: b.kind === "ml" ? null : b.line, o: b.odds ?? null, n: team?.short || null, g: game.shortName, k: game.date });
    bets.push(out);
  };

  let homeCover = null;
  if (sp !== null) {
    const raw = phi((pr.margin + sp) / p.sdMargin);
    homeCover = clamp(0.5 + k.spreadShrink * (raw - 0.5) + homeShift, 0.3, 0.7);
    mk({ kind: "spread", side: home.id, line: sp, odds: num(odds.homeSpreadOdds) ?? -110, hit: homeCover, edgePts: pr.margin + sp, angles: angH, oppAngles: angA });
    mk({ kind: "spread", side: away.id, line: sp === 0 ? 0 : -sp, odds: num(odds.awaySpreadOdds) ?? -110, hit: 1 - homeCover, edgePts: -(pr.margin + sp), angles: angA, oppAngles: angH });
  }
  const ml = mlPair(odds);
  let homeWin = phi(pr.margin / p.sdMargin);
  let fairHome = null;
  if (ml) {
    const ih = implied(ml.h), ia = implied(ml.a);
    fairHome = ih / (ih + ia);
    const hw = clamp((1 - k.mlModelWeight) * fairHome + k.mlModelWeight * homeWin + homeShift * 0.5, 0.01, 0.99);
    mk({ kind: "ml", side: home.id, line: null, odds: ml.h, hit: hw, fair: fairHome, model: homeWin, angles: angH, oppAngles: angA });
    mk({ kind: "ml", side: away.id, line: null, odds: ml.a, hit: 1 - hw, fair: 1 - fairHome, model: 1 - homeWin, angles: angA, oppAngles: angH });
  }
  let overP = null;
  if (tot !== null) {
    const raw = phi((pr.total - tot) / p.sdTotal);
    overP = clamp(0.5 + k.totalShrink * (raw - 0.5) + overShift, 0.3, 0.7);
    mk({ kind: "total", side: "o", line: tot, odds: num(odds.overOdds) ?? -110, hit: overP, edgePts: pr.total - tot, angles: angT });
    mk({ kind: "total", side: "u", line: tot, odds: num(odds.underOdds) ?? -110, hit: 1 - overP, edgePts: tot - pr.total, angles: angT.map((a) => ({ ...a, shift: -a.shift })) });
  }

  const best = bets.filter((b) => b.kind !== "ml").sort((a, b) => b.value - a.value || (b.edgePts ?? 0) - (a.edgePts ?? 0))[0] || null;
  return {
    game, id: game.id, th, ta, sh, sa,
    proj: pr, nhLine: -pr.margin, nhTotal: pr.total, homeWin, fairHome,
    homeCover, overP, angH, angA, angT, bets, best,
    hasLine: sp !== null || tot !== null || !!ml,
  };
}

export function isFbsGame(ctx, game) {
  return teamTier(ctx, game.home) !== FCS || teamTier(ctx, game.away) !== FCS;
}

// Ranked lists across a slate.
export function boards(analyses, { maxFav = KNOBS.maxFav, size = 5, includeStarted = false } = {}) {
  const open = analyses.filter((a) => includeStarted || a.game.state === "pre");
  const all = open.flatMap((a) => a.bets);
  const score = (b) => b.value - (b.house?.risk === "high" ? 0.01 : 0) - (b.house?.risk === "med" ? 0.003 : 0);
  // One pick per game on the sharp board: its best value bet, moneylines only when they're plus money or short.
  // Moneyline dogs can be +EV and still lose most weeks, and the book grades W-L, so they stay off it.
  const sharp = open.map((a) => a.bets
      .filter((b) => b.kind !== "ml" && b.value > 0)
      .sort((x, y) => score(y) - score(x))[0])
    .filter(Boolean)
    .sort((x, y) => score(y) - score(x) || (y.edgePts ?? 0) - (x.edgePts ?? 0))
    .slice(0, size);
  const safe = all
    .filter((b) => b.kind === "ml" && b.odds >= maxFav && b.hit >= 0.6 && b.value > -0.06)
    .sort((x, y) => y.hit - x.hit || y.value - x.value)
    .slice(0, size);
  return { sharp, safe };
}

// Grades a bet (leg-shaped) against a finished game's scores. +1 win, -1 loss, 0 push.
export function settle(bet, hs, as) {
  const home = bet.game.home.id === String(bet.side);
  if (bet.kind === "total") { const d = hs + as - bet.line; return Math.sign(bet.side === "o" ? d : -d); }
  const m = home ? hs - as : as - hs;
  if (bet.kind === "ml") return Math.sign(m);
  return Math.sign(m + bet.line);
}

export const fmtPct = pctTxt;

// Season file game -> the normalized shape analyzeGame expects (finished games keep their closing line).
export function seasonGameAsSlate(g, teams) {
  const t = (id) => ({ id: String(id), short: teams?.[id]?.short || String(id), abbr: teams?.[id]?.abbr || "" });
  return {
    id: g.id, date: g.date, state: "post", neutral: !!g.neutral, shortName: "",
    home: { ...t(g.h), score: g.hs }, away: { ...t(g.a), score: g.as },
    odds: { spread: g.sp ?? null, overUnder: g.tot ?? null, homeML: g.hml ?? null, awayML: g.aml ?? null, spreadOpen: g.spo ?? null, totalOpen: g.toto ?? null },
  };
}

// Walk-forward check of the boards: every week from `from` on, built only from earlier weeks, graded at
// the closing numbers. Returns records for the sharp board (top `size` a week) and the safest 3 legs.
export function labBacktest(season, history, { from = 4, size = 5 } = {}) {
  const teams = season?.teams || {};
  const weeks = [...new Set((season?.games || []).map((g) => g.wk))].sort((a, b) => a - b).filter((w) => w >= from);
  const out = { sharp: blank(), top3: blank(), safe: blank(), strong: blank(), kinds: {}, weeks: [], from, through: weeks[weeks.length - 1] ?? null };
  for (const w of weeks) {
    const ctx = buildContext(season, { week: w, history });
    const an = season.games
      .filter((g) => g.wk === w && isNum(g.hs) && (teams[g.h]?.conf || teams[g.a]?.conf))
      .map((g) => analyzeGame(ctx, seasonGameAsSlate(g, teams)));
    const b = boards(an, { size, includeStarted: true });
    const wk = { wk: w, sharp: blank() };
    const res = (x) => settle(x, x.game.home.score, x.game.away.score);
    b.sharp.forEach((x, i) => {
      const r = res(x);
      tally(out.sharp, r); tally(wk.sharp, r);
      if (i < 3) tally(out.top3, r);
      out.kinds[x.kind] ??= blank();
      tally(out.kinds[x.kind], r);
    });
    for (const a of an) for (const x of a.bets) if (x.grade === "strong" && x.kind !== "ml") tally(out.strong, res(x));
    b.safe.slice(0, 3).forEach((x) => tally(out.safe, res(x)));
    out.weeks.push(wk);
  }
  return out;
}
