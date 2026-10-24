// Scouting-tab analytics: the model board, ticket checks, pitfalls, trends and weekly awards.
// Pure functions over normalized games (espn.js normalizeGame) and the season file (data/season-YYYY.json).
//
// Sign conventions — a flipped sign makes the board recommend the wrong side:
//   odds.spread / spreadOpen, season sp / spo   the HOME team's line, negative = home favored
//   leg / pick l                                line from the PICKED side; away line = -(home line)
//   FPI homeMargin, season fpi                  projected HOME final margin
//   projected cover = picked team's FPI margin + l;  actual cover = team score - opp score + l
//   move.delta = now - open from the pick's side: > 0 means the pick gets more points now than at open,
//   i.e. the money went the other way (against). Totals: open/now are the raw total, withPick per side.

import { gradeLeg, gradeParlay, legLabel, fmtLine, fmtOdds, americanToDecimal } from "./grade.js";

const KEYS = [3, 7, 10, 14];      // most common CFB final margins worth a hook (3 and 7 by far)
const ML_PTS = 2.8;               // ~2.8% of win probability per point of spread near pick'em
const SMALL_FAV_ML = -150;        // moneyline candidates: dogs and favorites no shorter than this
const VOID_RE = /POSTPONED|CANCELED|CANCELLED|SUSPENDED/;
const SEV = { high: 0, med: 1, low: 2 };

// ---------- small helpers ----------

function n(v) {
  if (v === undefined || v === null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const flip = (v) => (isNum(v) ? 0 - v : null);              // 0 - v keeps PK as 0, never -0
const fromSide = (homeVal, home) => (home ? n(homeVal) : flip(n(homeVal)));
const pts = (v) => fmtLine(Math.abs(v), false);
const pct = (p) => `${Math.round(p * 100)}%`;
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const lookup = (m, k) => (m ? (typeof m.get === "function" ? m.get(String(k)) : m[k]) ?? null : null);
const record = (c) => `${c.w}-${c.l}${c.p ? `-${c.p}` : ""}`;

function tally(c, margin) {
  if (margin > 0) c.w++;
  else if (margin < 0) c.l++;
  else c.p++;
}

function sideOf(game, teamId) {
  if (!game?.home || !game?.away) return null;
  const home = game.home.id === String(teamId);
  if (!home && game.away.id !== String(teamId)) return null;
  return { home, team: home ? game.home : game.away, opp: home ? game.away : game.home };
}

// ---------- market and model ----------

function implied(o) {
  o = n(o);
  if (o === null || o === 0) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}

// Both moneylines, or null when there's no real market: books hang placeholders like -100000/+5000 on
// 28+ point spreads, so anything at -5000 or shorter voids both sides.
function mlPair(odds) {
  const h = n(odds?.homeML), a = n(odds?.awayML);
  if (h === null || a === null || h === 0 || a === 0 || h <= -5000 || a <= -5000) return null;
  return { h, a };
}

// De-vigged market win probability for one side.
function fairProb(odds, home) {
  const ml = mlPair(odds);
  if (!ml) return null;
  const ih = implied(ml.h), ia = implied(ml.a);
  const fh = ih / (ih + ia);
  return home ? fh : 1 - fh;
}

function fpiWin(pred, home) {
  if (!pred) return null;
  const hw = n(pred.homeWin);
  if (home) return hw;
  const aw = n(pred.awayWin);
  return aw !== null ? aw : hw === null ? null : 1 - hw;
}

function makeMove(open, now, upIsWith = false) {
  if (open === null || now === null) return { open, now, delta: null, withPick: null };
  const delta = round(now - open, 2);
  return { open, now, delta, withPick: delta === 0 ? null : upIsWith ? delta > 0 : delta < 0 };
}

// Team-side spread move. Moneyline picks use it too: ESPN only carries an opening number for spreads.
const teamMove = (game, home) => makeMove(fromSide(game?.odds?.spreadOpen, home), fromSide(game?.odds?.spread, home));
// A rising total is money on the over.
const totalMove = (game, over) => makeMove(n(game?.odds?.totalOpen), n(game?.odds?.overUnder), over);
const againstBy = (mv) => (mv.withPick === false ? Math.abs(mv.delta) : 0);

// Model + money: FPI alone is a coin flip against the close, but FPI edges the line has moved TOWARD
// (toward = -delta, in points) beat it, and edges the money moved away from lose. Backtested on the 2026 file.
function boardTier(edgePts, toward) {
  if (!(edgePts >= 1.5)) return "pass";
  if (toward === null) return "lean";     // no opening line: can't confirm the money
  return toward >= 1 ? "best" : toward <= -1 ? "trap" : "lean";
}

function moveReason(mv, total = false) {
  if (mv.delta === null || Math.abs(mv.delta) < 1) return null;
  const fmt = (v) => fmtLine(v, !total);
  const tone = mv.withPick ? "good" : againstBy(mv) >= 2 ? "bad" : "warn";
  return { tone, text: `${total ? "Total" : "Line"} moved ${pts(mv.delta)} ${mv.withPick ? "with" : "against"} (${fmt(mv.open)} → ${fmt(mv.now)})` };
}

// "FPI: BYU by 7.6" — names the team FPI projects to win. margin is from the picked side.
function fpiText(game, home, margin) {
  const r = round(margin, 1);
  if (r === 0) return "FPI: dead even";
  const winner = r > 0 === home ? game.home : game.away;
  return `FPI: ${winner.short} by ${pts(r)}`;
}

// A dog half a point short of a key number loses on it; a favorite on it pushes, past it loses.
function keyNumberFor(l) {
  if (!isNum(l) || l === 0) return { onKey: false, hookRisk: false, note: null, key: null };
  const a = Math.abs(l);
  if (l > 0 && KEYS.includes(a + 0.5)) return { onKey: false, hookRisk: true, note: `Dies on a ${a + 0.5}-point loss`, key: a + 0.5 };
  if (l < 0 && (a === 3.5 || a === 7.5)) return { onKey: false, hookRisk: true, note: `Loses on a ${a - 0.5}-point win`, key: a - 0.5 };
  if (a === 3 || a === 7) return { onKey: true, hookRisk: false, note: `Pushes on a ${a}-point ${l > 0 ? "loss" : "win"}`, key: a };
  return { onKey: false, hookRisk: false, note: null, key: null };
}

// The hook on your side of 3 or 7.
function hookEdge(l) {
  if (!isNum(l)) return null;
  const a = Math.abs(l);
  if (l > 0 && (a === 3.5 || a === 7.5)) return `Survives a ${a - 0.5}-point loss`;
  if (l < 0 && (a === 2.5 || a === 6.5)) return `Covers with a ${a + 0.5}-point win`;
  return null;
}

function keySeverity(l) {
  const a = Math.abs(l);
  if (l > 0 && (a === 2.5 || a === 6.5)) return "med";
  if (l < 0 && (a === 3.5 || a === 7.5)) return "med";
  return "low";
}

// ---------- kickoff in US Eastern ----------

let etFormat = null;
function etMinutes(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  etFormat ||= new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const parts = etFormat.formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return (get("hour") % 24) * 60 + get("minute");
}

function kickoffMinutes(game, leg) {
  if (game && game.state === "pre" && /TBD/i.test(`${game.detail || ""} ${game.longDetail || ""}`)) return null;
  return etMinutes(game?.date || leg?.k);
}

// 10 PM ET or later, including the after-midnight Hawaii/Mountain West kicks.
const isLate = (m) => m !== null && (m >= 22 * 60 || m < 5 * 60);
const etClock = (m) => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, "0")} ${m < 12 * 60 ? "AM" : "PM"}`;

function koWindow(m) {
  if (m === null) return null;
  if (isLate(m)) return "ko-late";
  if (m >= 19 * 60) return "ko-prime";
  if (m >= 15 * 60) return "ko-afternoon";
  return "ko-early";
}

// ---------- model board ----------

export function slatePicks(games, predictors, { includeStarted = false } = {}) {
  const picks = [];
  for (const game of games || []) {
    if (!game?.home || !game?.away || VOID_RE.test(game.statusName || "")) continue;
    if (game.state !== "pre" && !includeStarted) continue;
    const pred = lookup(predictors, game.id);
    const odds = game.odds || {};

    // Spread: the side FPI likes against the number (projected home cover = homeMargin + home line).
    // Dead on the number goes to the dog, so the pick doesn't depend on which side ESPN calls home.
    const sp = n(odds.spread), hm = n(pred?.homeMargin);
    if (sp !== null && hm !== null) {
      const cover = round(hm + sp, 3);
      picks.push(buildPick(game, pred, cover > 0 || (cover === 0 && sp > 0), "spread"));
    }

    // Moneyline: only dogs and short favorites where FPI beats the de-vigged price by 4%+.
    const pair = mlPair(odds);
    const ml = !pair ? null : [true, false]
      .map((home) => ({ home, wp: fpiWin(pred, home), fp: fairProb(odds, home), o: home ? pair.h : pair.a }))
      .filter((c) => c.wp !== null && c.fp !== null)
      .sort((a, b) => (b.wp - b.fp) - (a.wp - a.fp))[0];
    if (ml && ml.wp - ml.fp >= 0.04 && ml.o >= SMALL_FAV_ML) picks.push(buildPick(game, pred, ml.home, "ml"));
  }
  return picks.sort((a, b) => b.score - a.score || b.edgePts - a.edgePts || a.id.localeCompare(b.id));
}

function buildPick(game, pred, home, t) {
  const team = home ? game.home : game.away;
  const opp = home ? game.away : game.home;
  const odds = game.odds || {};
  const l = t === "spread" ? fromSide(odds.spread, home) : null;
  const rawMargin = fromSide(pred?.homeMargin, home);
  const winProb = fpiWin(pred, home);
  const fair = fairProb(odds, home);
  const edge = t === "spread" ? round(rawMargin + l, 2) : round(winProb - fair, 4);
  const edgePts = t === "spread" ? edge : round((edge * 100) / ML_PTS, 2);
  const move = teamMove(game, home);
  const keyNumber = keyNumberFor(l);
  // Huge model-vs-market gaps usually mean injury/QB news the model hasn't priced.
  const huge = Math.abs(edgePts) > 10;
  const toward = move.delta === null ? null : 0 - move.delta;
  const score = round(Math.min(edgePts, 7) + clamp(toward ?? 0, -3, 3) - (huge ? 1 : 0), 2);
  const tier = boardTier(edgePts, toward);

  const reasons = [];
  if (rawMargin !== null) reasons.push({ tone: t === "ml" && rawMargin < 0 ? "warn" : "good", text: fpiText(game, home, rawMargin) });
  if (t === "ml") reasons.push({ tone: "good", text: `FPI ${pct(winProb)} to win vs ${pct(fair)} priced in` });
  else if (rawMargin > 0 && l > 0) reasons.push({ tone: "good", text: `FPI has ${team.short} winning outright` });
  const mr = moveReason(move);
  if (mr) reasons.push(mr);
  if (keyNumber.note) reasons.push({ tone: "warn", text: keyNumber.note });
  const he = t === "spread" ? hookEdge(l) : null;
  if (he) reasons.push({ tone: "good", text: he });
  if (huge) reasons.push({ tone: "warn", text: "Check injury news" });
  if (tier === "trap") reasons.push({ tone: "bad", text: `Money moved ${pts(toward)} the other way` });

  return {
    id: `${game.id}:${t}:${team.id}`, e: game.id, t, s: team.id, l,
    o: n(t === "spread" ? (home ? odds.homeSpreadOdds : odds.awaySpreadOdds) : (home ? odds.homeML : odds.awayML)),
    n: team.short, g: game.shortName, k: game.date,          // leg-shaped, so a pick can drop onto a ticket
    teamId: team.id, oppId: opp.id, home, game,
    fpiMargin: round(rawMargin, 2), edge, edgePts,
    winProb: round(winProb, 4), fairProb: round(fair, 4),
    move, keyNumber, score, tier, reasons,
  };
}

export function boardRecord(picks) {
  const rec = { best: { w: 0, l: 0, p: 0 }, lean: { w: 0, l: 0, p: 0 }, trap: { w: 0, l: 0, p: 0 } };
  for (const pick of picks || []) {
    const r = rec[pick.tier];
    if (!r || !pick.game || pick.game.state !== "post") continue;
    const tone = gradeLeg(pick, pick.game).tone;
    if (tone === "won") r.w++;
    else if (tone === "lost") r.l++;
    else if (tone === "push") r.p++;
  }
  return rec;
}

// ---------- your ticket vs the numbers ----------

export function legInsights(legs, gamesById, predictors) {
  return (legs || []).map((leg) => legInsight(leg, lookup(gamesById, leg.e), lookup(predictors, leg.e)));
}

function legInsight(leg, game, pred) {
  const out = { leg, game: game || null, fpiMargin: null, edge: null, move: makeMove(null, null), verdict: "unknown", reasons: [], winProb: null, fairProb: null };
  const say = (tone, text) => text && out.reasons.push({ tone, text });
  if (!game?.home) {
    say("warn", "Game not loaded");
    return out;
  }

  if (leg.t === "total") {
    const over = leg.s === "o";
    out.move = totalMove(game, over);
    const mr = moveReason(out.move, true);
    if (mr) out.reasons.push(mr);
    const now = out.move.now, line = n(leg.l);
    if (now !== null && line !== null && now !== line) {
      const better = over ? line < now : line > now;
      say(better ? "good" : "warn", `Total now ${fmtLine(now, false)}; you have ${fmtLine(line, false)}`);
    }
    say("warn", "FPI doesn't project totals");
    return out;
  }

  const side = sideOf(game, leg.s);
  if (!side) {
    say("warn", "Team not in this game");
    return out;
  }
  const { home, team } = side;
  out.move = teamMove(game, home);
  const rawMargin = fromSide(pred?.homeMargin, home);
  out.fpiMargin = round(rawMargin, 2);
  out.winProb = round(fpiWin(pred, home), 4);
  out.fairProb = round(fairProb(game.odds, home), 4);
  const toneOf = (v) => (v === "agree" ? "good" : v === "disagree" ? "bad" : "warn");

  if (leg.t === "ml") {
    const wp = fpiWin(pred, home), fp = fairProb(game.odds, home);
    if (wp === null) say("warn", "No FPI projection yet");
    else if (fp === null) {
      // ESPN drops moneylines once a game kicks: fall back to FPI's straight-up call.
      out.verdict = wp >= 0.55 ? "agree" : wp <= 0.45 ? "disagree" : "neutral";
      say(toneOf(out.verdict), `${game.state === "pre" ? "No moneyline posted" : "No live moneyline"} · FPI gives ${team.short} ${pct(wp)} to win`);
    } else {
      out.edge = round(wp - fp, 4);
      out.verdict = wp > fp + 0.01 ? "agree" : wp < fp - 0.01 ? "disagree" : "neutral";
      say(toneOf(out.verdict), `FPI ${pct(wp)} to win vs ${pct(fp)} priced in`);
      if (rawMargin !== null) say(toneOf(out.verdict), fpiText(game, home, rawMargin));
    }
    const mr = moveReason(out.move);
    if (mr) out.reasons.push(mr);
    return out;
  }

  // Spread: judged at the number on the ticket, not today's number.
  const line = n(leg.l) ?? out.move.now;
  if (rawMargin === null) say("warn", "No FPI projection yet");
  else if (line === null) say("warn", "No spread posted");
  else {
    out.edge = round(rawMargin + line, 2);
    out.verdict = out.edge > 0.5 ? "agree" : out.edge < -0.5 ? "disagree" : "neutral";
    const tone = toneOf(out.verdict);
    say(tone, fpiText(game, home, rawMargin));
    say(tone, out.edge > 0 ? `Projected to cover by ${pts(out.edge)}` : out.edge < 0 ? `Projected ${pts(out.edge)} short` : "Projected right on the number");
  }
  const mr = moveReason(out.move);
  if (mr) out.reasons.push(mr);
  const now = out.move.now;
  if (line !== null && now !== null && now !== line) {
    say(line > now ? "good" : "warn", `Market now ${fmtLine(now, true)}; you have ${fmtLine(line, true)}`);
  }
  const key = keyNumberFor(line);
  say("warn", key.note);
  say("good", hookEdge(line));
  return out;
}

// ---------- pitfalls ----------

export function pitfalls({ legs = [], gamesById, predictors, slate = [] } = {}) {
  const out = [];
  const byGame = new Map();

  legInsights(legs, gamesById, predictors).forEach((x, i) => {
    const { leg, game } = x;
    if (!game?.home) return;
    const e = String(game.id);
    if (!byGame.has(e)) byGame.set(e, []);
    byGame.get(e).push(i);
    const label = legLabel(leg, game);
    const add = (kind, severity, title, detail) => out.push({ kind, severity, title, detail, e, legIndex: i });
    const side = leg.t === "total" ? null : sideOf(game, leg.s);
    const odds = game.odds || {};

    // Line moved against the leg.
    const mv = x.move, against = againstBy(mv);
    if (against >= 1.5) {
      if (leg.t === "total") {
        const toward = leg.s === "o" ? "under" : "over";
        add("fade-move", against >= 3 ? "high" : "med", `Total moved ${pts(against)} against ${label}`,
          `Opened ${fmtLine(mv.open, false)}, now ${fmtLine(mv.now, false)}: the money has been on the ${toward}.`);
      } else if (side) {
        const flipped = mv.open < 0 && mv.now > 0;
        add("fade-move", against >= 3 || flipped ? "high" : "med",
          flipped ? `${side.team.short} flipped from favorite to underdog` : `Line moved ${pts(against)} against ${side.team.short}`,
          `${side.team.short} opened ${fmtLine(mv.open, true)} and is now ${fmtLine(mv.now, true)}: the money has been on ${side.opp.short}.`);
      }
    }

    // FPI disagrees with the leg.
    if (x.verdict === "disagree" && side) {
      if (leg.t === "spread" && x.edge < -1.5) {
        add("model-disagrees", x.edge < -4 ? "high" : "med", `FPI says ${label} falls short`,
          `${fpiText(game, side.home, x.fpiMargin)}, ${pts(x.edge)} short of ${fmtLine(n(leg.l) ?? mv.now, true)}.`);
      } else if (leg.t === "ml" && x.edge !== null) {   // needs a price; the live straight-up fallback has none
        const gap = (x.edge * 100) / ML_PTS;
        if (gap < -1.5) {
          add("model-disagrees", gap < -4 ? "high" : "med", `FPI doesn't like ${label}`,
            `FPI gives ${side.team.short} ${pct(x.winProb)} to win; the price implies ${pct(x.fairProb)}.`);
        }
      }
    }

    // Key numbers and big favorites.
    const line = leg.t === "spread" ? n(leg.l) ?? mv.now : null;
    if (line !== null) {
      const key = keyNumberFor(line);
      if (key.note) {
        add("key-number", keySeverity(line), `${label} ${lowerFirst(key.note)}`,
          `Games land on exactly ${key.key} more often than almost any other margin in college football.`);
      }
      if (line <= -14) {
        add("big-favorite", "med", `${label} is a backdoor candidate`,
          `Laying ${pts(line)} means one garbage-time score by ${side?.opp.short || "the other side"} can sink the leg.`);
      }
    }
    if (leg.t === "ml" && side) {
      const o = n(leg.o) ?? n(side.home ? odds.homeML : odds.awayML);
      if (o !== null && o <= -400) {
        const loses = 1 - (fairProb(odds, side.home) ?? implied(o));
        add("big-favorite", "low", `${label} at ${fmtOdds(o)} barely pays`,
          `It multiplies the ticket by only ${americanToDecimal(o).toFixed(2)}x and still loses about ${pct(loses)} of the time.`);
      }
    }

    // Late kickoff.
    const ko = kickoffMinutes(game, leg);
    if (isLate(ko)) {
      add("late-night", "low", `${label} kicks at ${etClock(ko)} ET`,
        "The ticket won't settle until well after midnight Eastern, and late games are where parlays go to die.");
    }

    // No market on a game that hasn't kicked (odds vanish from the scoreboard once a game starts).
    const missing = leg.t === "total" ? n(odds.overUnder) === null
      : leg.t === "ml" ? !mlPair(odds)
      : n(odds.spread) === null;
    if (game.state === "pre" && missing) {
      add("no-line", "med", `No line on ${game.shortName}`,
        "Books don't have a number up, which often means injury, QB or weather news. Check before locking it in.");
    }
  });

  // Two or more legs on one game ride together.
  for (const idx of byGame.values()) {
    if (idx.length < 2) continue;
    for (const i of idx) {
      const game = lookup(gamesById, legs[i].e);
      const others = idx.filter((j) => j !== i).map((j) => legLabel(legs[j], game)).join(" and ");
      out.push({ kind: "same-game", severity: "med", title: `${legLabel(legs[i], game)} shares a game with ${others}`,
        detail: "Legs on the same game are correlated: one bad game script can take out both.", e: String(game.id), legIndex: i });
    }
  }

  // Slate-level, upcoming games only; skip what the ticket rows already say.
  const flagged = (kind) => new Set(out.filter((p) => p.kind === kind).map((p) => p.e));
  const fade = flagged("fade-move"), disagree = flagged("model-disagrees");
  const upcoming = (slate || []).filter((g) => g?.home && g.state === "pre" && !VOID_RE.test(g.statusName || ""));

  upcoming
    .map((g) => ({ g, d: n(g.odds?.spread) !== null && n(g.odds?.spreadOpen) !== null ? n(g.odds.spread) - n(g.odds.spreadOpen) : null }))
    .filter(({ g, d }) => d !== null && Math.abs(d) >= 3 && !fade.has(String(g.id)))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 5)
    .forEach(({ g, d }) => {
      const towardHome = d < 0;          // home line dropping = money on home
      const t = towardHome ? g.home : g.away;
      out.push({ kind: "steam", severity: Math.abs(d) >= 5 ? "med" : "low",
        title: `Steam on ${t.short}: ${fmtLine(fromSide(g.odds.spreadOpen, towardHome), true)} → ${fmtLine(fromSide(g.odds.spread, towardHome), true)}`,
        detail: `The line has moved ${pts(d)} points toward ${t.short} since open (${g.away.short} at ${g.home.short}); moves that big usually mean sharp money or news.`,
        e: String(g.id), legIndex: null });
    });

  upcoming
    .map((g) => {
      const hm = n(lookup(predictors, g.id)?.homeMargin), sp = n(g.odds?.spread);
      return { g, hm, sp, gap: hm !== null && sp !== null ? hm + sp : null };
    })
    .filter(({ g, gap }) => gap !== null && Math.abs(gap) > 10 && !disagree.has(String(g.id)))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 5)
    .forEach(({ g, hm, sp, gap }) => {
      const fav = sp < 0 ? g.home : g.away;
      const market = sp === 0 ? "the line is a pick'em" : `the line has ${fav.short} ${fmtLine(-Math.abs(sp), true)}`;
      out.push({ kind: "check-news", severity: "med", title: `FPI and the line are ${pts(gap)} apart on ${g.shortName}`,
        detail: `${fpiText(g, true, hm)} but ${market}; gaps that big usually mean injury or QB news the model hasn't priced.`,
        e: String(g.id), legIndex: null });
    });

  return out.sort((a, b) => SEV[a.severity] - SEV[b.severity]
    || (a.legIndex === null) - (b.legIndex === null)
    || (a.legIndex ?? 0) - (b.legIndex ?? 0));
}

// ---------- trends ----------

function trend(id, label, c, note, minN = 20) {
  const n = c.w + c.l + c.p;
  const pct = c.w + c.l ? c.w / (c.w + c.l) : null;
  const tone = pct === null || n < minN ? "neutral" : pct >= 0.55 ? "good" : pct <= 0.45 ? "bad" : "neutral";
  return { id, label, w: c.w, l: c.l, p: c.p, n, pct, note, tone };
}

const MARKET = [
  ["fav", "Favorites ATS", "Closing line"],
  ["dog", "Underdogs ATS", "Closing line"],
  ["home", "Home teams ATS", "Neutral sites left out"],
  ["home-dog", "Home underdogs ATS", "Neutral sites left out"],
  ["road-fav", "Road favorites ATS", "Neutral sites left out"],
  ["fav-14", "Favorites of 14+ ATS", "Big numbers, backdoor country"],
  ["fav-3", "Favorites of 3 or less ATS", "Basically coin flips with a hook"],
  ["over", "Overs", "Closing total"],
  ["under", "Unders", "Closing total"],
  ["fpi-3", "FPI side, 3+ pt edge", "ESPN FPI alone vs the closing line, no market check"],
  ["fpi-5", "FPI side, 5+ pt edge", "ESPN FPI alone vs the closing line, no market check"],
  ["board-best", "Model + money agree", "FPI side with a 1.5+ edge, line moved 1+ toward it from open"],
  ["board-lean", "Model alone, line steady", "FPI side with a 1.5+ edge, line within a point of open"],
  ["board-trap", "Model vs the money", "FPI side with a 1.5+ edge, line moved 1+ away from it"],
  ["board-fade", "Fading the traps", "The other side of those same games"],
  ["movers", "Side the line moved toward", "Moves of 1.5+ from open, graded at the close"],
  ["fav-su", "Favorites straight up", "Moneyline favorite won the game"],
  ["key-37", "Decided by exactly 3 or 7", "Share of finals on the two key numbers: why the hook matters"],
];

// FCS teams carry conf: null in season.teams (independents are "FBS Indep."). With no teams table, nothing is FCS.
const isFCS = (teams, id) => !!teams && (teams[id] ? teams[id].conf == null : true);

export function marketTrends(season, { sinceWeek = 1, includeFCS = false } = {}) {
  const c = Object.fromEntries(MARKET.map(([id]) => [id, { w: 0, l: 0, p: 0 }]));
  let fcsSkipped = 0;
  for (const g of season?.games || []) {
    const hs = n(g.hs), as = n(g.as);
    if (hs === null || as === null || (n(g.wk) ?? 0) < sinceWeek) continue;
    // FCS cupcakes skew the big-number and favorite rows.
    if (!includeFCS && (isFCS(season.teams, g.h) || isFCS(season.teams, g.a))) {
      fcsSkipped++;
      continue;
    }
    const diff = hs - as;                         // home final margin
    const sp = n(g.sp), spo = n(g.spo), tot = n(g.tot), fpi = n(g.fpi);

    if (sp !== null) {
      const homeCover = diff + sp;
      if (!g.neutral) tally(c.home, homeCover);
      if (sp !== 0) {
        const favCover = sp < 0 ? homeCover : -homeCover;
        tally(c.fav, favCover);
        tally(c.dog, -favCover);
        if (Math.abs(sp) >= 14) tally(c["fav-14"], favCover);
        if (Math.abs(sp) <= 3) tally(c["fav-3"], favCover);
        if (sp > 0 && !g.neutral) {
          tally(c["home-dog"], homeCover);
          tally(c["road-fav"], -homeCover);
        }
      }
      if (fpi !== null) {
        const gap = round(fpi + sp, 3);           // FPI's projected home cover
        const fpiCover = gap > 0 ? homeCover : -homeCover;
        if (Math.abs(gap) >= 3) tally(c["fpi-3"], fpiCover);
        if (Math.abs(gap) >= 5) tally(c["fpi-5"], fpiCover);
        // The board's tiers, graded at the close. Points the line moved toward the FPI side:
        // home line dropping (sp < spo) is money on home.
        const toward = spo === null ? null : round(gap > 0 ? spo - sp : sp - spo, 3);
        const tier = boardTier(Math.abs(gap), toward);
        if (tier !== "pass") tally(c[`board-${tier}`], fpiCover);
        if (tier === "trap") tally(c["board-fade"], -fpiCover);
      }
      // Home line dropping (sp < spo) means the money came in on the home side.
      if (spo !== null && Math.abs(sp - spo) >= 1.5) tally(c.movers, sp < spo ? homeCover : -homeCover);
    }

    if (tot !== null) {
      tally(c.over, hs + as - tot);
      tally(c.under, tot - (hs + as));
    }

    // Favorite = sign of the closing spread (a pick'em has none); moneylines only when there's no spread.
    const ml = mlPair({ homeML: g.hml, awayML: g.aml });
    if (sp !== null) {
      if (sp !== 0) tally(c["fav-su"], sp < 0 ? diff : -diff);
    } else if (ml && ml.h !== ml.a) tally(c["fav-su"], ml.h < ml.a ? diff : -diff);

    if ([3, 7].includes(Math.abs(diff))) c["key-37"].w++;
    else c["key-37"].l++;
  }
  const out = MARKET.map(([id, label, note]) => {
    const t = trend(id, label, c[id], note);
    return id === "key-37" ? { ...t, tone: "neutral" } : t;
  });
  if (fcsSkipped) out[0].note = `${out[0].note}; FBS vs FBS only (${fcsSkipped} FCS games left out)`;
  out.fcsExcluded = fcsSkipped;
  return out;
}

const HOUSE = [
  ["type-ml", "Moneyline"], ["type-spread", "Spread"], ["type-total", "Totals"],
  ["fav", "Favorites"], ["dog", "Underdogs"],
  ["home", "Home teams"], ["road", "Road teams"],
  ["ko-early", "Before 3 PM ET"], ["ko-afternoon", "3–7 PM ET"], ["ko-prime", "7–10 PM ET"], ["ko-late", "10 PM+ ET"],
  ["move-with", "With the line move"], ["move-against", "Against the line move"],
];

// Favorite or dog for a team leg, by the sign of the spread (the leg's own line, else the game's); a pick'em
// is neither. Moneyline legs fall back to the game's prices, then the leg's odds, only when there's no spread.
function favDog(leg, game, side) {
  const gameLine = fromSide(game.odds?.spread, side.home);
  const line = leg.t === "spread" ? n(leg.l) ?? gameLine : gameLine;
  if (line !== null || leg.t === "spread") return line === null || line === 0 ? null : line < 0 ? "fav" : "dog";
  const ml = mlPair(game.odds);
  if (ml && ml.h !== ml.a) return (side.home ? ml.h < ml.a : ml.a < ml.h) ? "fav" : "dog";
  const o = n(leg.o);
  return o === null || o === 0 ? null : o < 0 ? "fav" : "dog";
}

export function houseTrends(parlays, resolveGame) {
  const tickets = { cashed: 0, busted: 0, push: 0, pending: 0 };
  const legs = { w: 0, l: 0, p: 0, pending: 0 };
  const c = Object.fromEntries(HOUSE.map(([id]) => [id, { w: 0, l: 0, p: 0 }]));
  let hookLosses = 0;

  for (const parlay of parlays || []) {
    const list = parlay?.legs || [];
    if (!list.length) continue;
    const games = new Map();
    for (const leg of list) {
      const e = String(leg.e);
      if (!games.has(e)) {
        const g = resolveGame ? resolveGame(e) : null;
        if (g) games.set(e, g);
      }
    }
    const { grades, status } = gradeParlay(list, games);
    if (status === "cashed") tickets.cashed++;
    else if (status === "busted") tickets.busted++;
    else if (status === "push") tickets.push++;
    else tickets.pending++;

    list.forEach((leg, i) => {
      const grade = grades[i];
      const result = grade.tone === "won" ? 1 : grade.tone === "lost" ? -1 : grade.tone === "push" || grade.tone === "void" ? 0 : null;
      if (result === null) {
        legs.pending++;
        return;
      }
      if (result > 0) legs.w++;
      else if (result < 0) legs.l++;
      else legs.p++;
      if (result < 0 && isNum(grade.margin) && grade.margin >= -1) hookLosses++;

      const game = games.get(String(leg.e));
      const hit = (id) => id && tally(c[id], result);
      hit(leg.t === "ml" ? "type-ml" : leg.t === "total" ? "type-total" : "type-spread");
      hit(koWindow(kickoffMinutes(game, leg)));
      if (!game) return;
      if (leg.t === "total") {
        const mv = totalMove(game, leg.s === "o");
        if (mv.withPick !== null) hit(mv.withPick ? "move-with" : "move-against");
        return;
      }
      const side = sideOf(game, leg.s);
      if (!side) return;
      hit(favDog(leg, game, side));
      if (!game.neutral) hit(side.home ? "home" : "road");
      const mv = teamMove(game, side.home);
      if (mv.withPick !== null) hit(mv.withPick ? "move-with" : "move-against");
    });
  }

  const splits = HOUSE.map(([id, label]) => trend(id, label, c[id], null, 10)).filter((t) => t.n > 0);
  if (hookLosses) {
    splits.push({ id: "hook", label: "Lost by the hook (1 pt or less)", w: 0, l: hookLosses, p: 0, n: hookLosses, pct: null,
      note: "Legs that missed by a point or less", tone: "bad" });
  }

  const settled = legs.w + legs.l + legs.p;
  const notes = [];
  if (settled < 20) {
    notes.push(settled === 0 ? "No settled legs yet — trends start meaning something around 20"
      : `Only ${settled} leg${settled === 1 ? "" : "s"} logged — trends start meaning something around 20`);
  } else {
    const overall = legs.w + legs.l ? legs.w / (legs.w + legs.l) : 0;
    notes.push(`The house is ${record(legs)} on legs (${pct(overall)})`);
    const ranked = splits.filter((t) => t.pct !== null && t.w + t.l >= 8).sort((a, b) => b.pct - a.pct);
    const best = ranked[0], worst = ranked[ranked.length - 1];
    if (best && best.pct >= overall + 0.08) notes.push(`${best.label}: ${record(best)}, the house's best lane`);
    if (worst && worst !== best && worst.pct <= overall - 0.08) notes.push(`${worst.label}: ${record(worst)}, maybe lay off`);
    if (hookLosses >= 2) notes.push(`${hookLosses} legs lost by a point or less: the hook is real`);
    if (notes.length < 4) {
      const done = tickets.cashed + tickets.busted + tickets.push;
      notes.push(`${tickets.cashed} of ${done} settled ticket${done === 1 ? "" : "s"} cashed`);
    }
  }

  return { tickets, legs, splits, notes, hookLosses };
}

// ---------- awards ----------

export function bestWorst(legs, gamesById) {
  const rows = (legs || []).map((leg, index) => {
    const game = lookup(gamesById, leg.e);
    const grade = gradeLeg(leg, game || undefined);
    return { leg, index, game, grade, margin: grade.margin };
  });
  const pick = (list, better) => list.reduce((a, b) => (a === null || better(b, a) ? b : a), null);
  const has = (r, tones) => tones.includes(r.grade.tone) && isNum(r.margin);
  return {
    best: pick(rows.filter((r) => has(r, ["won", "winning"])), (b, a) => b.margin > a.margin),
    worst: pick(rows.filter((r) => has(r, ["lost", "losing"])), (b, a) => b.margin < a.margin),
    closest: pick(rows.filter((r) => r.grade.settled && isNum(r.margin)), (b, a) => Math.abs(b.margin) < Math.abs(a.margin)),
    final: rows.length > 0 && rows.every((r) => r.grade.settled),
  };
}
