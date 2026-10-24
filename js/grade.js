// Grades a parlay leg against a normalized game (see espn.js normalizeGame).
//
// Leg shape:
//   { e: "401856834",            ESPN event id
//     t: "ml" | "spread" | "total",
//     s: "239" | "o" | "u",      team id for ml/spread, o/u for totals
//     l: -7 | 2.5 | 54.5 | null, line (spread from the picked team's side; total points)
//     o: -110 | null,            American odds, optional
//     n: "Baylor",               cached team short name (ml/spread) so the slip reads before scores load
//     g: "BAY @ KU",             cached matchup
//     k: "2026-10-24T17:00Z" }   kickoff ISO; tells the app which scoreboard day to poll
//
// Grade shape:
//   { tone: "pending"|"winning"|"losing"|"even"|"won"|"lost"|"push"|"void",
//     settled: boolean, margin: number|null, text: "Covering by 3.5", sub: "Pace 61" }

export function legLabel(leg, game) {
  if (leg.t === "total") {
    const side = leg.s === "o" ? "Over" : "Under";
    return `${side} ${fmtLine(leg.l, false)}`;
  }
  const team = game ? teamById(game, leg.s) : null;
  const name = team?.short || leg.n || "Team";
  if (leg.t === "ml") return `${name} ML`;
  return `${name} ${fmtLine(leg.l, true)}`;
}

// "BYU @ UCF" style context line for a leg, used under the pick.
export function legMatchup(game) {
  return game ? `${game.away.short} at ${game.home.short}` : "";
}

export function fmtLine(v, signed) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  if (!signed) return trimNum(v);
  if (v === 0) return "PK";
  return (v > 0 ? "+" : "−") + trimNum(Math.abs(v));
}

export function fmtOdds(o) {
  if (o === null || o === undefined) return "";
  return o > 0 ? `+${o}` : `−${Math.abs(o)}`;
}

function trimNum(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

export function teamById(game, id) {
  if (!game) return null;
  if (game.home.id === String(id)) return game.home;
  if (game.away.id === String(id)) return game.away;
  return null;
}

function opponentOf(game, id) {
  return game.home.id === String(id) ? game.away : game.home;
}

// Fraction of regulation played, for total-points pace.
function elapsedFraction(game) {
  if (game.state !== "in" || !game.period) return 0;
  if (game.period > 4) return 1;
  const left = game.clockSeconds ?? 900;
  return Math.min(1, ((game.period - 1) * 900 + (900 - left)) / 3600);
}

export function gradeLeg(leg, game) {
  if (!game) return { tone: "pending", settled: false, margin: null, text: "Loading…", sub: "" };

  const isVoid = game.state === "post" && !game.completed;
  if (isVoid || /POSTPONED|CANCELED|CANCELLED|SUSPENDED/.test(game.statusName)) {
    return { tone: "void", settled: game.state === "post", margin: null, text: game.detail || "Postponed", sub: "Leg likely voided" };
  }
  if (game.state === "pre") {
    return { tone: "pending", settled: false, margin: null, text: "Not started", sub: "" };
  }

  const final = game.state === "post";
  const hs = game.home.score ?? 0;
  const as = game.away.score ?? 0;

  if (leg.t === "total") {
    const total = hs + as;
    const line = Number(leg.l);
    const over = leg.s === "o";
    const m = over ? total - line : line - total;
    const frac = elapsedFraction(game);
    const pace = frac > 0.12 && !final ? Math.round(total / frac) : null;
    const sub = pace !== null ? `${total} pts · pace ${pace}` : `${total} pts`;
    // Scores only go up: an over that clears the line, or an under that busts it, is locked.
    if (over && total > line) return { tone: "won", settled: true, margin: m, text: final ? `Hit by ${trimNum(m)}` : `Already over by ${trimNum(m)}`, sub };
    if (!over && total > line) return { tone: "lost", settled: true, margin: m, text: final ? `Missed by ${trimNum(-m)}` : `Busted by ${trimNum(-m)}`, sub };
    if (final) {
      if (m === 0) return { tone: "push", settled: true, margin: 0, text: "Push", sub };
      return m > 0 ? { tone: "won", settled: true, margin: m, text: `Hit by ${trimNum(m)}`, sub }
                   : { tone: "lost", settled: true, margin: m, text: `Missed by ${trimNum(-m)}`, sub };
    }
    // Not decided yet: judge by scoring pace rather than the raw total.
    if (over) {
      const tone = pace === null ? "even" : pace > line ? "winning" : "losing";
      return { tone, settled: false, margin: m, text: `Needs ${Math.floor(line - total) + 1} more`, sub };
    }
    const tone = pace === null ? "winning" : pace < line ? "winning" : "losing";
    return { tone, settled: false, margin: m, text: `${trimNum(m)} pts of room`, sub };
  }

  const mine = teamById(game, leg.s);
  if (!mine) return { tone: "pending", settled: false, margin: null, text: "Team not in game", sub: "" };
  const opp = opponentOf(game, leg.s);
  const diff = (mine.score ?? 0) - (opp.score ?? 0);
  const lead = diff > 0 ? `Up ${diff}` : diff < 0 ? `Down ${-diff}` : "Tied";

  if (leg.t === "ml") {
    if (final) return diff > 0 ? { tone: "won", settled: true, margin: diff, text: `Won by ${diff}`, sub: "" }
                               : { tone: "lost", settled: true, margin: diff, text: diff === 0 ? "Tied" : `Lost by ${-diff}`, sub: "" };
    return { tone: diff > 0 ? "winning" : diff < 0 ? "losing" : "even", settled: false, margin: diff, text: lead, sub: "" };
  }

  // Spread
  const m = diff + Number(leg.l);
  if (final) {
    if (m === 0) return { tone: "push", settled: true, margin: 0, text: "Push", sub: lead.replace("Up", "Won by").replace("Down", "Lost by") };
    return m > 0 ? { tone: "won", settled: true, margin: m, text: `Covered by ${trimNum(m)}`, sub: lead.replace("Up", "Won by").replace("Down", "Lost by") }
                 : { tone: "lost", settled: true, margin: m, text: `Missed by ${trimNum(-m)}`, sub: lead.replace("Up", "Won by").replace("Down", "Lost by") };
  }
  if (m === 0) return { tone: "even", settled: false, margin: 0, text: "On the number", sub: lead };
  return m > 0 ? { tone: "winning", settled: false, margin: m, text: `Covering by ${trimNum(m)}`, sub: lead }
               : { tone: "losing", settled: false, margin: m, text: `Short by ${trimNum(-m)}`, sub: lead };
}

// Whole-ticket status.
//   status: "pending" (nothing kicked), "alive", "cashed", "busted"
export function gradeParlay(legs, gamesById) {
  const grades = legs.map((leg) => gradeLeg(leg, gamesById.get(String(leg.e))));
  const count = (t) => grades.filter((g) => g.tone === t).length;
  const won = count("won"), lost = count("lost"), push = count("push") + count("void");
  const winning = count("winning"), losing = count("losing"), even = count("even"), pending = count("pending");
  const settled = grades.filter((g) => g.settled).length;
  let status = "alive";
  if (lost > 0) status = "busted";
  else if (settled === legs.length && legs.length > 0) status = won > 0 ? "cashed" : "push";
  else if (pending === legs.length) status = "pending";
  return { grades, status, won, lost, push, winning, losing, even, pending, settled, total: legs.length };
}

// American odds math. Pushed/voided legs drop out of the price.
export function americanToDecimal(o) {
  if (o === null || o === undefined || o === 0) return null;
  return o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
}

export function parlayPrice(legs, grades) {
  let dec = 1;
  for (let i = 0; i < legs.length; i++) {
    const tone = grades?.[i]?.tone;
    if (tone === "push" || tone === "void") continue;
    const d = americanToDecimal(legs[i].o);
    if (d === null) return null;
    dec *= d;
  }
  return dec;
}

export function decimalToAmerican(dec) {
  if (!dec || dec <= 1) return null;
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}
