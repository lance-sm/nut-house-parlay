#!/usr/bin/env node
// Walk-forward backtest of the Nut House Line (js/model.js) against closing lines.
//
//   node scripts/backtest_model.mjs [--year 2026] [--from 4] [--grid] [--json]
//
// For every week W from --from on: fit the model on games before W only, project each FBS-vs-FBS game
// in week W, and grade the side the model likes against that game's CLOSING line (the hardest number
// to beat). --grid sweeps the main knobs; --json prints the summary the Lab tab shows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fitModel, project, coverProb, overProb, DEFAULTS } from "../js/model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const year = Number(opt("--year", 2026));
const from = Number(opt("--from", 4));
const season = JSON.parse(readFileSync(join(root, "data", `season-${year}.json`), "utf8"));

export function backtest(season, params, { from = 4 } = {}) {
  const weeks = [...new Set(season.games.map((g) => g.wk))].sort((a, b) => a - b).filter((w) => w >= from);
  const rows = [];
  for (const w of weeks) {
    const model = fitModel(season, { beforeWeek: w, params });
    for (const g of season.games) {
      if (g.wk !== w || g.sp == null || g.hs == null) continue;
      if (!season.teams[g.h]?.conf || !season.teams[g.a]?.conf) continue;
      const pr = project(model, g.h, g.a, { neutral: g.neutral });
      const margin = g.hs - g.as;
      rows.push({
        wk: w, id: g.id, sp: g.sp, tot: g.tot, margin, total: g.hs + g.as,
        proj: pr.margin, res: pr.resMargin, mkt: pr.mktMargin, ptot: pr.total,
        edge: pr.margin + g.sp,               // >0 likes home
        tedge: g.tot == null ? null : pr.total - g.tot,
      });
    }
  }
  return rows;
}

function ats(rows, minEdge, maxEdge = Infinity, key = "edge") {
  let w = 0, l = 0, p = 0;
  for (const r of rows) {
    const e = r[key];
    if (e == null || Math.abs(e) < minEdge || Math.abs(e) >= maxEdge) continue;
    const res = key === "edge" ? (r.margin + r.sp) * Math.sign(e) : (r.total - r.tot) * Math.sign(e);
    if (res > 0) w++; else if (res < 0) l++; else p++;
  }
  return { w, l, p, pct: w + l ? w / (w + l) : null };
}

const mae = (rows, f) => rows.reduce((s, r) => s + Math.abs(f(r)), 0) / rows.length;
const fmt = (c) => `${c.w}-${c.l}${c.p ? `-${c.p}` : ""} (${c.pct == null ? "n/a" : (c.pct * 100).toFixed(1) + "%"})`;

function logloss(rows, p) {
  let s = 0, k = 0;
  for (const r of rows) {
    const out = r.margin + r.sp;
    if (out === 0) continue;
    const ph = coverProb(r.proj, r.sp, p, true);
    s += -Math.log(out > 0 ? ph : 1 - ph); k++;
  }
  return s / k;
}

function summary(params) {
  const rows = backtest(season, params, { from });
  return {
    n: rows.length,
    maeLine: mae(rows, (r) => r.margin + r.sp), maeProj: mae(rows, (r) => r.margin - r.proj),
    maeRes: mae(rows, (r) => r.margin - r.res), maeMkt: mae(rows, (r) => r.margin - r.mkt),
    all: ats(rows, 0.0001), e2: ats(rows, 2), e3: ats(rows, 3), e5: ats(rows, 5),
    t2: ats(rows, 2, Infinity, "tedge"), t4: ats(rows, 4, Infinity, "tedge"),
    ll: logloss(rows, { ...DEFAULTS, ...params }),
    rows,
  };
}

if (args.includes("--grid")) {
  const out = [];
  for (const blend of [0, 0.2, 0.35, 0.5, 0.75, 1])
    for (const cap of [17, 24, 35, 200])
      for (const decay of [0.85, 0.93, 1])
        for (const lambda of [1, 2.5, 6]) {
          const s = summary({ blend, cap, decay, lambda, totBlend: blend });
          out.push({ blend, cap, decay, lambda, ...s, rows: undefined });
        }
  out.sort((a, b) => (b.e3.pct ?? 0) - (a.e3.pct ?? 0));
  for (const o of out.slice(0, 25)) console.log(`blend ${o.blend} cap ${o.cap} decay ${o.decay} lam ${o.lambda} | maeProj ${o.maeProj.toFixed(2)} | all ${fmt(o.all)} | e3 ${fmt(o.e3)} | e5 ${fmt(o.e5)} | tot2 ${fmt(o.t2)}`);
  console.log("--- by blend (cap 24, decay .93, lam 2.5)");
  for (const o of out.filter((x) => x.cap === 24 && x.decay === 0.93 && x.lambda === 2.5).sort((a, b) => a.blend - b.blend))
    console.log(`blend ${o.blend} | maeProj ${o.maeProj.toFixed(2)} line ${o.maeLine.toFixed(2)} | all ${fmt(o.all)} | e2 ${fmt(o.e2)} e3 ${fmt(o.e3)} e5 ${fmt(o.e5)} | tot2 ${fmt(o.t2)} tot4 ${fmt(o.t4)} | ll ${o.ll.toFixed(4)}`);
} else if (!args.includes("--board")) {
  const s = summary({});
  if (args.includes("--json")) {
    console.log(JSON.stringify({ n: s.n, all: s.all, e3: s.e3, e5: s.e5, t2: s.t2, maeLine: s.maeLine, maeProj: s.maeProj }));
  } else {
    console.log(`games ${s.n} (weeks ${from}+), MAE vs final margin: closing line ${s.maeLine.toFixed(2)}, NH line ${s.maeProj.toFixed(2)}, results-only ${s.maeRes.toFixed(2)}, market-only ${s.maeMkt.toFixed(2)}`);
    console.log(`ATS every game ${fmt(s.all)} | edge 2+ ${fmt(s.e2)} | 3+ ${fmt(s.e3)} | 5+ ${fmt(s.e5)}`);
    console.log(`Totals edge 2+ ${fmt(s.t2)} | 4+ ${fmt(s.t4)} | logloss ${s.ll.toFixed(4)}`);
  }
}

// ---------- the Lab's boards, walk-forward ----------
// --board: the same walk-forward check the Lab tab shows (js/lab-core.js labBacktest).
import { labBacktest } from "../js/lab-core.js";

if (args.includes("--board")) {
  const history = JSON.parse(readFileSync(join(root, "data", "history.json"), "utf8"));
  const r = labBacktest(season, history, { from });
  const f = (c) => fmt({ ...c, pct: c.w + c.l ? c.w / (c.w + c.l) : null });
  console.log(`sharp board (top 5/wk) ${f(r.sharp)} | top 3 ${f(r.top3)} | strong ${f(r.strong)} | safest 3/wk ${f(r.safe)}`);
  console.log(Object.entries(r.kinds).map(([k, v]) => `${k} ${v.w}-${v.l}-${v.p}`).join(" | "), "|", r.weeks.map((x) => `w${x.wk} ${x.sharp.w}-${x.sharp.l}`).join(" "));
}
