// The Nut House Line: our own power ratings and projections, built in the browser from the season file
// (data/season-YYYY.json: every finished FBS game with its final score and closing DraftKings line).
// Pure functions, no DOM, no network, so the same code runs the Lab tab and scripts/backtest_model.mjs.
//
// How a projection is made (all numbers are points, HOME perspective unless a name says otherwise):
//   1. Results rating  R: opponent-adjusted scoring margin. Weighted ridge least squares over every
//      finished game: margin ~ R_home - R_away + HFA. Margins are squashed past ~3 scores (garbage time
//      says little), recent weeks count more, FCS opponents share one pooled rating.
//   2. Market rating   M: the same fit on the closing spreads instead of the scores. It is what the books
//      thought of each team all season, and it is the steadiest single number there is.
//   3. Nut House Line  = M-projection + BLEND x (R-projection - M-projection) + spot adjustments.
//      In words: start from where the market has rated a team all year, then lean toward what the team
//      has actually done on the field (where the two disagree is the whole idea), then adjust for the
//      spot (rest, letdown, bowl math). BLEND and the spot values are set by the walk-forward backtest
//      in scripts/backtest_model.mjs, not by feel.
//   4. Totals the same way: offense/defense points ratings from the scores, a pace rating from the
//      closing totals, blended.
//   5. Cover / win probabilities come from a normal curve around the projection; the spread of that curve
//      and the cover-probability shrink are calibrated by the same backtest.
//
// Sign conventions match insights.js: odds.spread / season sp are the HOME line, negative = home favored.
// A side "covers" when its margin + its line > 0. Projected home cover vs the line = proj + homeLine.

export const P4 = new Set(["SEC", "Big Ten", "Big 12", "ACC"]);
const P4_INDEPENDENTS = new Set(["87"]); // Notre Dame
export const FCS = "FCS";

// Tuned by scripts/backtest_model.mjs on 2026 weeks 3-11 (walk-forward, closing lines). See PARAMS_NOTE.
export const DEFAULTS = {
  cap: 24,          // margin squash: y = cap * tanh(m / cap)
  decay: 0.93,      // weight per week back
  lambda: 1,        // ridge pull toward 0 for the results fits (in games' worth of weight)
  lambdaMkt: 0.2,   // closing lines are low-noise, so the market fit barely needs any
  blend: 0.35,      // how far the Nut House Line leans from market rating toward results rating
  totBlend: 0.35,   // same for totals
  sdMargin: 15.5,   // spread of real margins around a projection (points)
  sdTotal: 15,      // spread of real totals around a projection
  coverShrink: 0.5, // backtest-calibrated: how much of the raw cover-probability edge survives
  iters: 60,
};

export function tierOf(conf, teamId) {
  if (!conf) return FCS;
  if (P4.has(conf) || P4_INDEPENDENTS.has(String(teamId))) return "P4";
  return "G6";
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const n = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
export const round = (v, d = 1) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : null);

// Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf), plenty for betting probabilities.
export function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// ---------- fitting ----------

function keyOf(id, teams) {
  const t = teams?.[id];
  return t && t.conf ? String(id) : FCS;
}

// Weighted ridge regression for y ~ X_home - X_away + h * (not neutral), solved by coordinate descent.
// rows: [{ h, a, y, w, neutral }]. Returns { rating: Map, hfa }.
function fitPaired(rows, { lambda, iters, hfaPrior = 2.5 }) {
  const r = new Map();
  const touch = new Map(); // team -> [{ i, s }]
  rows.forEach((row, i) => {
    for (const [k, s] of [[row.h, 1], [row.a, -1]]) {
      if (!r.has(k)) { r.set(k, 0); touch.set(k, []); }
      touch.get(k).push({ i, s });
    }
  });
  let hfa = hfaPrior;
  const keys = [...r.keys()];
  for (let it = 0; it < iters; it++) {
    for (const k of keys) {
      let num = 0, den = lambda;
      for (const { i, s } of touch.get(k)) {
        const row = rows[i];
        const other = s === 1 ? r.get(row.a) : r.get(row.h);
        const hf = row.neutral ? 0 : hfa;
        // y = s*(R_k) - s*other... rewrite: y = R_h - R_a + hf ; for k = home: R_k = y + R_a - hf ; away: R_k = R_h + hf - y
        const target = s === 1 ? row.y + other - hf : other + hf - row.y;
        num += row.w * target;
        den += row.w;
      }
      r.set(k, num / den);
    }
    // home field: weighted mean residual of non-neutral games, lightly pulled to the prior
    let num = hfaPrior * 4, den = 4;
    for (const row of rows) {
      if (row.neutral) continue;
      num += row.w * (row.y - (r.get(row.h) - r.get(row.a)));
      den += row.w;
    }
    hfa = num / den;
    // re-center so the average FBS rating is 0 (FCS pool excluded)
    let sum = 0, cnt = 0;
    for (const [k, v] of r) if (k !== FCS) { sum += v; cnt++; }
    const mean = cnt ? sum / cnt : 0;
    for (const [k, v] of r) r.set(k, v - mean);
  }
  return { rating: r, hfa };
}

// Offense/defense fit for totals: pts_home ~ mu + O_h - D_a + hfa/2, pts_away ~ mu + O_a - D_h - hfa/2.
function fitOffDef(rows, { lambda, iters }) {
  const O = new Map(), D = new Map(), touch = new Map();
  const obs = []; // { off, def, pts, w, sign }
  for (const row of rows) {
    obs.push({ off: row.h, def: row.a, pts: row.hs, w: row.w, home: row.neutral ? 0 : 1 });
    obs.push({ off: row.a, def: row.h, pts: row.as, w: row.w, home: row.neutral ? 0 : -1 });
  }
  obs.forEach((o, i) => {
    for (const k of [o.off, o.def]) if (!touch.has(k)) { touch.set(k, { off: [], def: [] }); O.set(k, 0); D.set(k, 0); }
    touch.get(o.off).off.push(i);
    touch.get(o.def).def.push(i);
  });
  let mu = obs.reduce((s, o) => s + o.pts, 0) / Math.max(1, obs.length);
  let h2 = 1.25;
  for (let it = 0; it < iters; it++) {
    for (const [k, t] of touch) {
      let num = 0, den = lambda;
      for (const i of t.off) { const o = obs[i]; num += o.w * (o.pts - mu + D.get(o.def) - h2 * o.home); den += o.w; }
      O.set(k, num / den);
      num = 0; den = lambda;
      for (const i of t.def) { const o = obs[i]; num += o.w * (mu + O.get(o.off) + h2 * o.home - o.pts); den += o.w; }
      D.set(k, num / den);
    }
    let sw = 0, sm = 0, sh = 0, swh = 0;
    for (const o of obs) {
      const base = O.get(o.off) - D.get(o.def);
      sm += o.w * (o.pts - base - h2 * o.home); sw += o.w;
      if (o.home) { sh += o.w * (o.pts - mu - base) * o.home; swh += o.w; }
    }
    mu = sm / sw;
    h2 = swh ? sh / swh : h2;
  }
  return { off: O, def: D, mu, h2 };
}

// Pace fit from closing totals: tot ~ mu + P_h + P_a.
function fitPace(rows, { lambda, iters }) {
  const P = new Map(), touch = new Map();
  rows.forEach((row, i) => {
    for (const k of [row.h, row.a]) { if (!P.has(k)) { P.set(k, 0); touch.set(k, []); } touch.get(k).push(i); }
  });
  let mu = rows.reduce((s, r) => s + r.tot, 0) / Math.max(1, rows.length);
  for (let it = 0; it < iters; it++) {
    for (const [k, list] of touch) {
      let num = 0, den = lambda;
      for (const i of list) { const r = rows[i]; const other = r.h === k ? r.a : r.h; num += r.w * (r.tot - mu - P.get(other)); den += r.w; }
      P.set(k, num / den);
    }
    let s = 0, w = 0;
    for (const r of rows) { s += r.w * (r.tot - P.get(r.h) - P.get(r.a)); w += r.w; }
    mu = s / w;
  }
  return { pace: P, mu };
}

// Fit every rating from finished games before `beforeWeek` (all finished games when omitted).
export function fitModel(season, { beforeWeek = Infinity, params = DEFAULTS } = {}) {
  const p = { ...DEFAULTS, ...params };
  const teams = season?.teams || {};
  const games = (season?.games || []).filter((g) => g.wk < beforeWeek && isNum(g.hs) && isNum(g.as));
  const lastWk = games.reduce((m, g) => Math.max(m, g.wk), 0);
  const base = games.map((g) => ({
    g,
    h: keyOf(g.h, teams), a: keyOf(g.a, teams),
    neutral: !!g.neutral,
    w: p.decay ** (lastWk - g.wk),
  })).filter((r) => r.h !== r.a);

  const res = fitPaired(base.map((r) => {
    const m = r.g.hs - r.g.as;
    return { ...r, y: p.cap * Math.tanh(m / p.cap) };
  }), p);
  const mktRows = base.filter((r) => isNum(r.g.sp)).map((r) => ({ ...r, y: -r.g.sp }));
  const mkt = fitPaired(mktRows, { ...p, lambda: p.lambdaMkt });
  const od = fitOffDef(base.map((r) => ({ ...r, hs: r.g.hs, as: r.g.as })), p);
  const pace = fitPace(base.filter((r) => isNum(r.g.tot)).map((r) => ({ ...r, tot: r.g.tot })), { ...p, lambda: p.lambdaMkt });

  return { params: p, teams, res, mkt, od, pace, throughWeek: lastWk, nGames: base.length };
}

const get = (m, k) => (m.has(k) ? m.get(k) : (m.has(FCS) ? m.get(FCS) : 0));

// Raw model numbers for one matchup (HOME perspective). homeId/awayId are ESPN team ids.
export function project(model, homeId, awayId, { neutral = false, adj = 0, totAdj = 0 } = {}) {
  const { teams, res, mkt, od, pace, params: p } = model;
  const h = keyOf(homeId, teams), a = keyOf(awayId, teams);
  const resM = get(res.rating, h) - get(res.rating, a) + (neutral ? 0 : res.hfa);
  const mktM = get(mkt.rating, h) - get(mkt.rating, a) + (neutral ? 0 : mkt.hfa);
  const margin = mktM + p.blend * (resM - mktM) + adj;

  const hPts = od.mu + get(od.off, h) - get(od.def, a) + (neutral ? 0 : od.h2);
  const aPts = od.mu + get(od.off, a) - get(od.def, h) - (neutral ? 0 : od.h2);
  const resT = hPts + aPts;
  const mktT = pace.mu + get(pace.pace, h) + get(pace.pace, a);
  const total = mktT + p.totBlend * (resT - mktT) + totAdj;

  return { margin, resMargin: resM, mktMargin: mktM, total, resTotal: resT, mktTotal: mktT, adj, totAdj };
}

// Probability the HOME side covers `homeLine` (or wins when homeLine = 0, ignoring ties), raw normal.
export function homeCoverRaw(margin, homeLine, sd) {
  return phi((margin + homeLine) / sd);
}

// Calibrated cover probability for a side: half-ish of the raw edge survives (the market is good).
export function coverProb(margin, homeLine, p = DEFAULTS, home = true) {
  const raw = homeCoverRaw(margin, homeLine, p.sdMargin);
  const ph = 0.5 + (raw - 0.5) * p.coverShrink;
  return home ? ph : 1 - ph;
}

export function overProb(total, line, p = DEFAULTS) {
  const raw = phi((total - line) / p.sdTotal);
  return 0.5 + (raw - 0.5) * p.coverShrink;
}

export function winProb(margin, p = DEFAULTS) {
  return phi(margin / p.sdMargin);
}

// Points of edge -> a team-rank list for the ratings table.
export function ratingsTable(model) {
  const out = [];
  for (const [id, t] of Object.entries(model.teams)) {
    if (!t.conf) continue;
    const resR = model.res.rating.get(id), mktR = model.mkt.rating.get(id);
    if (!isNum(resR) || !isNum(mktR)) continue;
    const nh = mktR + model.params.blend * (resR - mktR);
    out.push({
      id, abbr: t.abbr, short: t.short, conf: t.conf, tier: tierOf(t.conf, id),
      nh, res: resR, mkt: mktR, gap: resR - mktR,
      off: model.od.off.get(id) ?? 0, def: model.od.def.get(id) ?? 0,
    });
  }
  out.sort((a, b) => b.nh - a.nh);
  out.forEach((r, i) => { r.rank = i + 1; });
  return out;
}
