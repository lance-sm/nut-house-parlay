// Lab tab: every Power 4 and Group of 6 game for a week, searchable, each one read by the Nut House's own
// model (js/model.js ratings + js/lab-core.js spot angles and house history), with ranked boards on top.
//
// Contract (called by the main app):
//   mountLab(root, { onOpenGame }) -> { destroy() }
//   root: an empty <section> inside main.wrap. Styles live in css/lab.css, scoped under .lab.
//
// Data, all public and keyless: ESPN's week scoreboard (games + current odds), data/season-YYYY.json
// (finished games with closing lines, the model's fuel) and data/history.json (the house's own picks).

import { fetchWeekSlate, logoHTML, escapeHTML as esc, kickoffText } from "./espn.js?v=20261113e";
import { loadSeasonData, getCrew } from "./store.js?v=20261113e";
import { loadHistory } from "./history.js?v=20261113e";
import { ratingsTable, FCS } from "./model.js?v=20261113e";
import {
  buildContext, analyzeGame, boards, isFbsGame, labBacktest, settle, recText,
  BUCKET_TEXT, KNOBS,
} from "./lab-core.js?v=20261113e";

const WEEK_MIN = 1;
const WEEK_MAX = 16;
const MINUS = "−";
const DOT = " · ";
const BOARD_SIZE = 5;
const RATINGS_PREVIEW = 25;

const GRADE = { strong: "Strong", solid: "Solid", lean: "Lean", pass: "Pass" };
const RISK = { low: "Low bozo risk", med: "Some bozo risk", high: "Bozo alert" };
const SORTS = [
  ["best", "Best bet"],
  ["kick", "Kickoff"],
  ["gap", "Our line vs theirs"],
  ["close", "Closest spread"],
  ["safe", "Safest favorite"],
];

const slateCache = new Map();   // "year:week" -> slate
const seasonCache = new Map();  // year -> Promise<season|null>
let historyPromise = null;
let mounts = 0;

const pct = (p) => (p === null || p === undefined ? "—" : `${Math.round(p * 100)}%`);
const signed = (v, d = 1) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const r = Math.round(v * 10 ** d) / 10 ** d;
  if (r === 0) return "PK";
  return `${r > 0 ? "+" : MINUS}${Math.abs(r)}`;
};
const pts = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${Math.round(v * 10) / 10}`);
const odds = (o) => (o === null || o === undefined ? "" : o > 0 ? `+${o}` : `${MINUS}${Math.abs(o)}`);
const lineTxt = (l) => (l === 0 ? "PK" : `${l > 0 ? "+" : MINUS}${Math.abs(l)}`);

function etDay(iso) {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
}

export function mountLab(root, { onOpenGame } = {}) {
  const uid = `lab${++mounts}`;
  const st = {
    week: null, year: null, slate: null, season: undefined, history: undefined,
    ctx: null, analyses: [], error: null, loading: false,
    f: { q: "", tier: "all", conf: "", day: "", sort: "best", lines: false },
    open: new Set(), board: "sharp", showAllRatings: false,
    backtest: undefined,
  };
  let seq = 0;
  let destroyed = false;

  root.classList.add("lab");
  root.setAttribute("aria-label", "Pick Lab");
  root.innerHTML = `
    <div class="card lb-head">
      <div class="lb-weekbar">
        <button type="button" class="lb-wk-btn" data-act="week" data-d="-1" aria-label="Previous week">‹</button>
        <div class="lb-wk-label" aria-live="polite">
          <h2 class="lb-wk-name">Pick Lab</h2>
          <span class="lb-wk-sub" data-sub>The Nut House Line</span>
        </div>
        <button type="button" class="lb-wk-btn" data-act="week" data-d="1" aria-label="Next week">›</button>
      </div>
      <div class="lb-stats" data-stats></div>
      <p class="lb-disclaim">Our own model, built from this season's results, closing lines and the Bozo Picks sheet. Estimates, not guarantees.</p>
    </div>
    <div class="lb-body" data-body></div>`;
  const body = root.querySelector("[data-body]");
  const wkName = root.querySelector(".lb-wk-name");
  const wkSub = root.querySelector("[data-sub]");
  const statsEl = root.querySelector("[data-stats]");
  const prevBtn = root.querySelector('[data-d="-1"]');
  const nextBtn = root.querySelector('[data-d="1"]');

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);

  load({});

  // ---------- data ----------

  function seasonFor(year) {
    if (!seasonCache.has(year)) seasonCache.set(year, loadSeasonData(year));
    return seasonCache.get(year);
  }
  function historyDoc() {
    if (!historyPromise) historyPromise = loadHistory();
    return historyPromise;
  }

  async function load({ week, year }) {
    const mine = ++seq;
    st.loading = true;
    st.error = null;
    paint();
    try {
      const key = week && year ? `${year}:${week}` : null;
      let slate = key ? slateCache.get(key) : null;
      if (!slate) {
        slate = await fetchWeekSlate({ week: week || undefined, seasonType: 2, year: year || undefined });
        slateCache.set(`${slate.year}:${slate.week}`, slate);
      }
      if (mine !== seq || destroyed) return;
      st.slate = slate;
      st.week = slate.week;
      st.year = slate.year;
      const [season, history] = await Promise.all([seasonFor(st.year), historyDoc()]);
      if (mine !== seq || destroyed) return;
      st.season = season;
      st.history = history;
      if (!season) throw new Error("This season's game file isn't available yet");
      st.ctx = buildContext(season, { week: st.week, history, crew: getCrew() });
      st.analyses = deriveGames(slate, season).filter((g) => isFbsGame(st.ctx, g)).map((g) => analyzeGame(st.ctx, g));
    } catch (err) {
      if (mine !== seq || destroyed) return;
      st.error = (err && err.message) || "Couldn’t reach ESPN";
      st.analyses = [];
    }
    st.loading = false;
    paint();
    if (st.season && st.backtest === undefined) scheduleBacktest();
  }

  // Finished (and some live) games lose their lines on ESPN's scoreboard; the season file has the close.
  function deriveGames(slate, season) {
    const byId = new Map((season?.games || []).map((g) => [g.id, g]));
    return (slate.games || []).map((g) => {
      const s = byId.get(g.id);
      const has = g.odds && (g.odds.spread !== null || g.odds.overUnder !== null || g.odds.homeML !== null);
      if (has || !s) return g;
      return { ...g, odds: { provider: season.provider || null, spread: s.sp ?? null, spreadOpen: s.spo ?? null, overUnder: s.tot ?? null, totalOpen: s.toto ?? null, homeML: s.hml ?? null, awayML: s.aml ?? null, homeId: g.home.id, awayId: g.away.id } };
    });
  }

  function scheduleBacktest() {
    st.backtest = null; // running
    const run = () => {
      if (destroyed) return;
      try {
        st.backtest = labBacktest(st.season, st.history, { from: 4, size: BOARD_SIZE });
      } catch {
        st.backtest = false;
      }
      paintHow();
      paintStats();
    };
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 2500 });
    else setTimeout(run, 400);
  }

  // ---------- events ----------

  function onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act;
    if (act === "week") {
      const w = Math.min(WEEK_MAX, Math.max(WEEK_MIN, (st.week || 1) + Number(el.dataset.d)));
      if (w !== st.week) { st.open.clear(); load({ week: w, year: st.year }); }
    } else if (act === "board") {
      st.board = el.dataset.v;
      paintBoards();
    } else if (act === "tier") {
      st.f.tier = el.dataset.v;
      paintList();
    } else if (act === "toggle") {
      const id = el.dataset.id;
      if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
      const card = root.querySelector(`[data-game="${CSS.escape(id)}"]`);
      if (card) card.outerHTML = gameCardHTML(st.analyses.find((a) => a.id === id));
      root.querySelector(`[data-game="${CSS.escape(id)}"] [data-act="toggle"]`)?.focus();
    } else if (act === "jump") {
      const id = el.dataset.id;
      // make sure the game is visible in the list, then open it there
      st.f = { ...st.f, q: "", tier: "all", conf: "", day: "", lines: false };
      st.open.add(id);
      paintList(true);
      const card = root.querySelector(`[data-game="${CSS.escape(id)}"]`);
      if (card) { card.scrollIntoView({ behavior: "smooth", block: "start" }); card.querySelector("[data-act='toggle']")?.focus({ preventScroll: true }); }
    } else if (act === "game") {
      if (onOpenGame) onOpenGame(el.dataset.id);
    } else if (act === "clear") {
      st.f = { q: "", tier: "all", conf: "", day: "", sort: st.f.sort, lines: false };
      paintList(true);
    } else if (act === "ratings") {
      st.showAllRatings = !st.showAllRatings;
      paintRatings();
    } else if (act === "retry") {
      load({ week: st.week, year: st.year });
    }
  }

  function onInput(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.f) return;
    const k = el.dataset.f;
    st.f[k] = el.type === "checkbox" ? el.checked : el.value;
    paintList();
  }

  // ---------- paint ----------

  function paint() {
    if (destroyed) return;
    wkName.textContent = st.week ? `Week ${st.week}` : "Pick Lab";
    wkSub.textContent = st.ctx ? `Nut House Line${DOT}rated through week ${st.ctx.model.throughWeek}` : "The Nut House Line";
    prevBtn.disabled = !st.week || st.week <= WEEK_MIN || st.loading;
    nextBtn.disabled = !st.week || st.week >= WEEK_MAX || st.loading;
    paintStats();
    if (st.loading && !st.analyses.length) {
      body.innerHTML = `<div class="card lb-empty"><p class="lb-busy">Crunching the slate${"…"}</p></div>`;
      return;
    }
    if (st.error) {
      body.innerHTML = `<p class="banner error lb-err"><span>${esc(st.error)}</span><button type="button" class="btn" data-act="retry">Try again</button></p>`;
      return;
    }
    body.innerHTML = `
      <section class="lb-sec" data-boards></section>
      <section class="lb-sec" aria-labelledby="${uid}-games">
        <div class="lb-sec-h"><h2 class="lb-h2" id="${uid}-games">Every game</h2><span class="lb-aux" data-count></span></div>
        <div class="card lb-filters" data-filters></div>
        <ol class="lb-games" data-list></ol>
      </section>
      <section class="lb-sec" data-ratings></section>
      <section class="lb-sec" data-how></section>`;
    paintBoards();
    paintFilters();
    paintList();
    paintRatings();
    paintHow();
  }

  function paintStats() {
    if (destroyed) return;
    const a = st.analyses;
    const withLine = a.filter((x) => x.hasLine).length;
    const open = a.filter((x) => x.game.state === "pre").length;
    const bt = st.backtest;
    const btTxt = bt ? recText(bt.sharp) : bt === null ? "…" : "—";
    statsEl.innerHTML = `
      <div class="lb-stat"><span class="lb-stat-v">${st.loading && !a.length ? "…" : a.length}</span><span class="lb-stat-l">Games</span></div>
      <div class="lb-stat"><span class="lb-stat-v">${st.loading && !a.length ? "…" : `${withLine}`}</span><span class="lb-stat-l">With odds${open !== a.length && a.length ? `${DOT}${open} to play` : ""}</span></div>
      <div class="lb-stat"><span class="lb-stat-v">${btTxt}</span><span class="lb-stat-l">Board, weeks ${bt ? `${bt.from}–${bt.through}` : "so far"}</span></div>`;
  }

  // ----- boards -----

  function paintBoards() {
    const el = root.querySelector("[data-boards]");
    if (!el) return;
    const past = st.analyses.length && st.analyses.every((a) => a.game.state !== "pre");
    const b = boards(st.analyses, { size: BOARD_SIZE, includeStarted: past });
    const list = st.board === "safe" ? b.safe : b.sharp;
    const sub = st.board === "safe"
      ? "Highest chance to hit. Moneylines no shorter than " + odds(KNOBS.maxFav) + "; the payout's thin, the record isn't."
      : "Spreads and totals where the spots this season say the number's off. One per game.";
    el.innerHTML = `
      <div class="lb-sec-h"><h2 class="lb-h2">Top picks</h2><span class="lb-aux">${past ? "Graded at the final" : "Games not started yet"}</span></div>
      <div class="lb-seg" role="tablist" aria-label="Board">
        <button type="button" role="tab" class="lb-seg-b" data-act="board" data-v="sharp" aria-selected="${st.board === "sharp"}">Best bets</button>
        <button type="button" role="tab" class="lb-seg-b" data-act="board" data-v="safe" aria-selected="${st.board === "safe"}">Safest legs</button>
      </div>
      <p class="lb-note">${esc(sub)}</p>
      ${list.length ? `<ol class="card lb-board">${list.map((p, i) => boardRowHTML(p, i)).join("")}</ol>`
        : `<div class="card lb-empty"><p>${st.analyses.length ? (st.board === "safe" ? "No favorite clears the bar this week." : "Nothing clears the bar. When no spot is firing, the honest pick is a pass.") : "No games yet."}</p></div>`}`;
  }

  function boardRowHTML(p, i) {
    const g = p.game;
    const fin = g.state === "post" ? settle(p, g.home.score ?? 0, g.away.score ?? 0) : null;
    const res = fin === null ? "" : `<span class="chip ${fin > 0 ? "won" : fin < 0 ? "lost" : ""}">${fin > 0 ? "Hit" : fin < 0 ? "Miss" : "Push"}</span>`;
    const logo = p.team ? logoHTML(p.team, "sm") : `<span class="lb-ou" aria-hidden="true">${p.side === "o" ? "O" : "U"}</span>`;
    return `<li><button type="button" class="lb-row" data-act="jump" data-id="${esc(g.id)}" data-grade="${p.grade}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-row-logo">${logo}</span>
      <span class="lb-row-main">
        <span class="lb-row-label">${esc(p.label)} <span class="lb-odds">${esc(odds(p.odds))}</span></span>
        <span class="lb-row-meta">${esc(matchup(g))}${DOT}${esc(g.state === "pre" ? kickoffText(g.date) : g.state === "in" ? "Live" : "Final")} ${res}</span>
        <span class="lb-row-why">${esc(reasonLine(p))}</span>
        ${houseChipHTML(p)}
      </span>
      <span class="lb-row-hit"><span class="lb-hit-v">${pct(p.hit)}</span><span class="lb-hit-u">${st.board === "safe" ? "to hit" : GRADE[p.grade]}</span></span>
    </button></li>`;
  }

  // One line, the reason that matters most for this pick.
  function reasonLine(p) {
    if (p.kind === "ml") {
      const why = [`Market ${pct(p.fair)}`, `our ratings ${pct(p.model)}`];
      const good = (p.angles || []).filter((a) => a.shift > 0.004)[0];
      if (good) why.push(good.label.toLowerCase());
      return why.join(DOT);
    }
    const mine = (p.angles || []).filter((a) => a.shift > 0.004).sort((a, b) => b.shift - a.shift);
    const theirs = (p.oppAngles || []).filter((a) => a.shift < -0.004).sort((a, b) => a.shift - b.shift);
    if (p.kind === "total") {
      const lean = (p.angles || []).filter((a) => a.shift > 0.004).sort((a, b) => b.shift - a.shift)[0];
      return lean ? `${lean.label}: overs ${recText(lean.rec)} this season` : `Our total ${pts(p.game && st.analyses.find((x) => x.id === p.game.id)?.nhTotal)}`;
    }
    const opp = p.team && p.game ? (p.game.home.id === p.team.id ? p.game.away : p.game.home) : null;
    if (mine[0]) return `${mine[0].label} (${recText(mine[0].rec)} ATS this season)`;
    if (theirs[0] && opp) return `Fade ${opp.short}: ${theirs[0].label.toLowerCase()} (${recText(theirs[0].rec)} ATS)`;
    return p.edgePts > 0 ? `Our line likes it by ${pts(p.edgePts)}` : "Coin flip";
  }

  function houseChipHTML(p) {
    const h = p.house;
    if (!h || !h.rec) return "";
    const bits = [`House ${recText(h.rec)} ${BUCKET_TEXT[h.bucket]}`];
    if (h.team && h.team.w + h.team.l >= 2) bits.push(`${recText(h.team)} on ${p.team?.short || "them"}`);
    if (h.lane) bits.push(`${h.lane.name}'s lane (${recText(h.lane.r)})`);
    else if (h.cold) bits.push(`keep ${h.cold.name} away (${recText(h.cold.r)})`);
    return `<span class="lb-house" data-risk="${h.risk}"><b>${esc(RISK[h.risk])}</b> ${esc(bits.join(DOT))}</span>`;
  }

  // ----- filters + list -----

  function paintFilters() {
    const el = root.querySelector("[data-filters]");
    if (!el) return;
    const confs = new Set(), days = new Map();
    for (const a of st.analyses) {
      for (const t of [a.game.home, a.game.away]) { const c = st.ctx?.teams[t.id]?.conf; if (c) confs.add(c); }
      const d = etDay(a.game.date);
      if (!days.has(d)) days.set(d, Date.parse(a.game.date));
    }
    const dayList = [...days.entries()].sort((a, b) => a[1] - b[1]).map(([d]) => d);
    const tiers = [["all", "All"], ["P4", "Power 4"], ["G6", "Group of 6"], ["ranked", "Ranked"]];
    el.innerHTML = `
      <label class="lb-search"><span class="sr-only">Search teams</span>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input type="search" data-f="q" placeholder="Search a team or conference" value="${esc(st.f.q)}" autocomplete="off" enterkeyhint="search">
      </label>
      <div class="lb-chips" role="group" aria-label="Level">
        ${tiers.map(([v, t]) => `<button type="button" class="lb-chip" data-act="tier" data-v="${v}" aria-pressed="${st.f.tier === v}">${t}</button>`).join("")}
      </div>
      <div class="lb-selects">
        <label><span class="sr-only">Conference</span><select data-f="conf"><option value="">All conferences</option>${[...confs].sort().map((c) => `<option ${st.f.conf === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
        <label><span class="sr-only">Day</span><select data-f="day"><option value="">Every day</option>${dayList.map((d) => `<option ${st.f.day === d ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></label>
        <label><span class="sr-only">Sort</span><select data-f="sort">${SORTS.map(([v, t]) => `<option value="${v}" ${st.f.sort === v ? "selected" : ""}>Sort: ${t}</option>`).join("")}</select></label>
      </div>
      <label class="lb-check"><input type="checkbox" data-f="lines" ${st.f.lines ? "checked" : ""}> Only games with odds</label>`;
  }

  function matches(a) {
    const f = st.f;
    const g = a.game;
    const confH = st.ctx?.teams[g.home.id]?.conf || "", confA = st.ctx?.teams[g.away.id]?.conf || "";
    if (f.tier === "P4" && a.th !== "P4" && a.ta !== "P4") return false;
    if (f.tier === "G6" && a.th !== "G6" && a.ta !== "G6") return false;
    if (f.tier === "ranked" && !g.home.rank && !g.away.rank) return false;
    if (f.conf && confH !== f.conf && confA !== f.conf) return false;
    if (f.day && etDay(g.date) !== f.day) return false;
    if (f.lines && !a.hasLine) return false;
    const q = f.q.trim().toLowerCase();
    if (q) {
      const hay = [g.home, g.away].flatMap((t) => [t.name, t.short, t.abbr, t.location, t.mascot]).concat([confH, confA]).join(" ").toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function sorted(list) {
    const by = st.f.sort;
    const val = (a) => a.best ? a.best.value : -1;
    const kick = (a) => Date.parse(a.game.date);
    const gap = (a) => (a.game.odds?.spread === null || a.game.odds?.spread === undefined) ? -1 : Math.abs(a.proj.margin + a.game.odds.spread);
    const close = (a) => (a.game.odds?.spread === null || a.game.odds?.spread === undefined) ? 99 : Math.abs(a.game.odds.spread);
    const safe = (a) => Math.max(0, ...a.bets.filter((b) => b.kind === "ml" && b.odds >= KNOBS.maxFav).map((b) => b.hit));
    const f = {
      best: (x, y) => val(y) - val(x) || kick(x) - kick(y),
      kick: (x, y) => kick(x) - kick(y),
      gap: (x, y) => gap(y) - gap(x) || kick(x) - kick(y),
      close: (x, y) => close(x) - close(y) || kick(x) - kick(y),
      safe: (x, y) => safe(y) - safe(x) || kick(x) - kick(y),
    }[by] || ((x, y) => kick(x) - kick(y));
    return list.slice().sort(f);
  }

  function paintList(refilter = false) {
    if (refilter) paintFilters();
    const el = root.querySelector("[data-list]");
    const count = root.querySelector("[data-count]");
    if (!el) return;
    const list = sorted(st.analyses.filter(matches));
    if (count) count.textContent = `${list.length} of ${st.analyses.length}`;
    root.querySelectorAll("[data-act='tier']").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === st.f.tier)));
    el.innerHTML = list.length ? list.map(gameCardHTML).join("")
      : `<li class="card lb-empty"><p>No games match.</p><button type="button" class="btn" data-act="clear">Clear filters</button></li>`;
    paintRatings();
  }

  function matchup(g) {
    return `${g.away.short} ${g.neutral ? "vs" : "at"} ${g.home.short}`;
  }

  function teamLine(t, tier) {
    const rank = t.rank ? `<span class="lb-rk">${t.rank}</span>` : "";
    const fcs = tier === FCS ? `<span class="lb-tag">FCS</span>` : "";
    return `<span class="lb-team">${logoHTML(t, "sm")}${rank}<span class="lb-tn">${esc(t.short)}</span>${fcs}${t.record ? `<span class="lb-rec">${esc(t.record)}</span>` : ""}</span>`;
  }

  function marketLine(a) {
    const o = a.game.odds || {};
    const g = a.game;
    const parts = [];
    if (o.spread !== null && o.spread !== undefined) {
      const fav = o.spread <= 0 ? g.home : g.away;
      parts.push(o.spread === 0 ? "PK" : `${fav.abbr || fav.short} ${MINUS}${Math.abs(o.spread)}`);
    }
    if (o.overUnder !== null && o.overUnder !== undefined) parts.push(`O/U ${o.overUnder}`);
    return parts.length ? parts.join(DOT) : "No line yet";
  }

  function ourLine(a) {
    const g = a.game;
    const m = a.proj.margin;
    const fav = m >= 0 ? g.home : g.away;
    const r = Math.round(Math.abs(m) * 2) / 2;
    return `${r === 0 ? "PK" : `${fav.abbr || fav.short} ${MINUS}${r}`}${DOT}${Math.round(a.nhTotal * 2) / 2}`;
  }

  function scoreTxt(g) {
    if (g.state === "pre") return esc(kickoffText(g.date));
    const s = `${g.away.abbr || g.away.short} ${g.away.score ?? 0}, ${g.home.abbr || g.home.short} ${g.home.score ?? 0}`;
    return g.state === "in" ? `<span class="chip live">Live</span> ${esc(s)}` : `Final${DOT}${esc(s)}`;
  }

  function gameCardHTML(a) {
    if (!a) return "";
    const g = a.game;
    const open = st.open.has(a.id);
    const b = a.best;
    const bestTxt = !b ? (a.hasLine ? "No edge on this one" : "Waiting on a line")
      : b.value > 0.004 ? `${b.label} ${odds(b.odds)}${DOT}${pct(b.hit)}${DOT}${GRADE[b.grade]}` : `Pass${DOT}nothing beats the vig`;
    return `<li class="card lb-game" data-game="${esc(a.id)}" data-open="${open}" data-grade="${b && b.value > 0.004 ? b.grade : "pass"}">
      <button type="button" class="lb-game-top" data-act="toggle" data-id="${esc(a.id)}" aria-expanded="${open}">
        <span class="lb-teams">${teamLine(g.away, a.ta)}${teamLine(g.home, a.th)}</span>
        <span class="lb-when">${scoreTxt(g)}${g.broadcast ? `<span class="lb-tv">${esc(g.broadcast)}</span>` : ""}</span>
        <span class="lb-lines">
          <span><b>Line</b> ${esc(marketLine(a))}</span>
          <span><b>Ours</b> ${esc(ourLine(a))}</span>
        </span>
        <span class="lb-best"><span class="lb-best-k">Lab</span> ${esc(bestTxt)}</span>
      </button>
      ${open ? detailHTML(a) : ""}
    </li>`;
  }

  function detailHTML(a) {
    const g = a.game;
    const pr = a.proj;
    const o = g.odds || {};
    const sp = o.spread ?? null;
    const homeAbbr = g.home.abbr || g.home.short;
    const spreadRow = (label, m) => `<tr><th scope="row">${label}</th><td>${esc(homeAbbr)} ${esc(signed(-m))}</td></tr>`;
    const numbers = `
      <table class="lb-nums">
        <caption class="sr-only">The numbers</caption>
        <tbody>
          <tr><th scope="row">Market spread</th><td>${sp === null ? "—" : `${esc(homeAbbr)} ${esc(lineTxt(sp))}`}${o.spreadOpen !== null && o.spreadOpen !== undefined && o.spreadOpen !== sp ? ` <span class="lb-dim">(opened ${esc(lineTxt(o.spreadOpen))})</span>` : ""}</td></tr>
          ${spreadRow("Nut House Line", pr.margin)}
          ${spreadRow("Results only", pr.resMargin)}
          ${spreadRow("Books\u2019 season ratings", pr.mktMargin)}
          <tr><th scope="row">Total</th><td>${o.overUnder ?? "—"} <span class="lb-dim">ours ${pts(a.nhTotal)}${DOT}scoring model ${pts(pr.resTotal)}</span></td></tr>
          <tr><th scope="row">Win chance</th><td>${esc(g.away.short)} ${pct(1 - a.homeWin)}${DOT}${esc(g.home.short)} ${pct(a.homeWin)}</td></tr>
        </tbody>
      </table>`;

    const betRows = a.bets.slice().sort((x, y) => y.value - x.value).map((b) => `
      <tr data-grade="${b.value > 0.004 ? b.grade : "pass"}">
        <th scope="row">${esc(b.label)}</th>
        <td>${esc(odds(b.odds))}</td>
        <td>${pct(b.hit)}</td>
        <td>${b.value > 0.004 ? GRADE[b.grade] : b.kind === "ml" && b.hit >= 0.6 ? "Safe-ish" : "Pass"}</td>
      </tr>`).join("");
    const bets = a.bets.length ? `
      <table class="lb-bets">
        <caption class="sr-only">Every bet on this game</caption>
        <thead><tr><th scope="col">Bet</th><th scope="col">Price</th><th scope="col">Hit</th><th scope="col">Read</th></tr></thead>
        <tbody>${betRows}</tbody>
      </table>` : `<p class="lb-dim">No odds posted yet. Our line is above; check back once books hang a number.</p>`;

    const angleList = (team, list) => list.length
      ? `<ul class="lb-angles">${list.map((x) => `<li data-tone="${x.tone}"><b>${esc(x.label)}</b> <span>${recText(x.rec)} ATS this season${x.shift ? ` ${x.shift > 0 ? "for" : "against"} the side` : ", too few to count"}</span></li>`).join("")}</ul>`
      : `<p class="lb-dim">No spots.</p>`;
    const form = (t, s) => {
      const bits = [`${s.w}-${s.l}`, `ATS ${recText(s.ats)}`, `O/U ${recText(s.ou)}`];
      if (s.rest !== null) bits.push(`${Math.round(s.rest)} days rest`);
      if (s.last) bits.push(`last: ${s.last.won ? "W" : "L"} by ${Math.abs(s.last.margin)}${s.last.cover !== null ? `, ${s.last.cover > 0 ? "covered" : s.last.cover < 0 ? "missed" : "pushed"} by ${Math.abs(s.last.cover)}` : ""}`);
      return bits.join(DOT);
    };
    const spots = `
      <div class="lb-spot"><h4>${esc(g.away.short)}</h4><p class="lb-form">${esc(form(g.away, a.sa))}</p>${angleList(g.away, a.angA)}</div>
      <div class="lb-spot"><h4>${esc(g.home.short)}</h4><p class="lb-form">${esc(form(g.home, a.sh))}</p>${angleList(g.home, a.angH)}</div>
      ${a.angT.length ? `<div class="lb-spot"><h4>Total</h4><ul class="lb-angles">${a.angT.map((x) => `<li data-tone="${x.shift > 0.004 ? "good" : x.shift < -0.004 ? "bad" : "neutral"}"><b>${esc(x.label)}</b> <span>overs ${recText(x.rec)} this season</span></li>`).join("")}</ul></div>` : ""}`;

    const b = a.best;
    const house = b && b.house && b.value > 0.004 ? `
      <div class="lb-spot lb-housebox" data-risk="${b.house.risk}">
        <h4>Nut House on ${esc(b.label)}</h4>
        <ul class="lb-angles">
          <li><b>House ${esc(BUCKET_TEXT[b.house.bucket])}</b> <span>${b.house.rec ? `${recText(b.house.rec)} all-time` : "never tried"}</span></li>
          ${b.house.team ? `<li><b>House on ${esc(b.team?.short || "them")}</b> <span>${recText(b.house.team)}</span></li>` : ""}
          ${b.house.lane ? `<li data-tone="good"><b>${esc(b.house.lane.name)}'s lane</b> <span>${recText(b.house.lane.r)} ${esc(BUCKET_TEXT[b.house.bucket])}</span></li>` : ""}
          ${b.house.cold ? `<li data-tone="bad"><b>Keep ${esc(b.house.cold.name)} off it</b> <span>${recText(b.house.cold.r)} ${esc(BUCKET_TEXT[b.house.bucket])}</span></li>` : ""}
        </ul>
        <p class="lb-risk">${esc(RISK[b.house.risk])}</p>
      </div>` : "";

    return `<div class="lb-detail">
      <div class="lb-dsec"><h3 class="lb-h3">The numbers</h3>${numbers}</div>
      <div class="lb-dsec"><h3 class="lb-h3">Every bet</h3>${bets}</div>
      <div class="lb-dsec"><h3 class="lb-h3">Spots and form</h3><div class="lb-spots">${spots}</div></div>
      ${house ? `<div class="lb-dsec"><h3 class="lb-h3">Bozo check</h3>${house}</div>` : ""}
      <button type="button" class="btn lb-full" data-act="game" data-id="${esc(g.id)}">Full game</button>
    </div>`;
  }

  // ----- ratings -----

  function paintRatings() {
    const el = root.querySelector("[data-ratings]");
    if (!el || !st.ctx) return;
    const all = ratingsTable(st.ctx.model);
    const q = st.f.q.trim().toLowerCase();
    let rows = all;
    if (st.f.tier === "P4" || st.f.tier === "G6") rows = rows.filter((r) => r.tier === st.f.tier);
    if (st.f.conf) rows = rows.filter((r) => r.conf === st.f.conf);
    if (q) rows = rows.filter((r) => `${r.short} ${r.abbr} ${r.conf}`.toLowerCase().includes(q));
    const shown = st.showAllRatings ? rows : rows.slice(0, RATINGS_PREVIEW);
    el.innerHTML = `
      <div class="lb-sec-h"><h2 class="lb-h2">Nut House power ratings</h2><span class="lb-aux">Points better than an average FBS team, neutral field</span></div>
      <div class="card lb-rtg-wrap">
        <table class="lb-rtg">
          <thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col">Rating</th><th scope="col" title="Results rating minus the market's season rating">Vs market</th></tr></thead>
          <tbody>${shown.map((r) => `<tr>
            <td class="lb-dim">${r.rank}</td>
            <th scope="row"><span class="lb-rtg-t">${esc(r.short)}</span> <span class="lb-dim">${esc(r.conf)}</span></th>
            <td>${signed(r.nh)}</td>
            <td data-tone="${r.gap > 2 ? "good" : r.gap < -2 ? "bad" : ""}">${signed(r.gap)}</td>
          </tr>`).join("")}</tbody>
        </table>
        ${rows.length > RATINGS_PREVIEW ? `<button type="button" class="btn ghost lb-more" data-act="ratings">${st.showAllRatings ? "Show top 25" : `Show all ${rows.length}`}</button>` : ""}
      </div>
      <p class="lb-note">"Vs market" is how much better (or worse) a team has played than the books have rated it all year. Big positives are teams the market may still be slow on.</p>`;
  }

  // ----- how it works -----

  function paintHow() {
    const el = root.querySelector("[data-how]");
    if (!el) return;
    const bt = st.backtest;
    const rec = (r) => `${recText(r)}${r.w + r.l ? ` (${Math.round((r.w / (r.w + r.l)) * 100)}%)` : ""}`;
    const btHTML = bt ? `
      <ul class="lb-bt">
        <li><b>Best bets board</b> ${rec(bt.sharp)} <span>top ${BOARD_SIZE} a week, weeks ${bt.from}–${bt.through}</span></li>
        <li><b>Its top 3</b> ${rec(bt.top3)}</li>
        <li><b>Every "Strong" spread or total</b> ${rec(bt.strong)}</li>
        <li><b>Safest 3 legs a week</b> ${rec(bt.safe)}</li>
      </ul>
      <p class="lb-note">Each week was rebuilt using only games played before it, then graded at the closing number. The spots themselves were picked by us after looking at this season, so treat these as the hopeful end of the range.</p>`
      : bt === null ? `<p class="lb-note lb-busy">Re-running the season week by week…</p>` : `<p class="lb-note">Backtest unavailable.</p>`;
    el.innerHTML = `
      <details class="card lb-how">
        <summary><span class="lb-h2">How the Lab picks</span></summary>
        <div class="lb-how-b">
          <p><b>Our line.</b> Two power ratings fit to every FBS game this season: one from the final scores (blowouts squashed, recent weeks weighted up, opponents adjusted), one from the closing spreads. The Nut House Line starts at the season ratings and leans 35% toward what teams have actually done on the field.</p>
          <p><b>The honest part.</b> Run week by week, those ratings alone hit about 48% against closing spreads. The books already know who's good. So our line breaks ties and sets the moneyline read, but it doesn't push a spread pick by itself.</p>
          <p><b>What moves a pick.</b> Spots: upset hangovers, teams that just blew out the number, three straight misses, home dogs of 7+, road chalk of 10+, rest, bowl math, and total spots. Each one is graded live against every FBS game this season before the week on screen, shrunk toward .500 until it has a real sample, and capped.</p>
          <p><b>The Bozo check.</b> Every pick the house has made since 2024, from the Bozo Picks sheet: how we do on that kind of bet and on that team, whose lane it is, and who should stay away. The house is ${houseLine()}.</p>
          ${btHTML}
        </div>
      </details>`;
  }

  function houseLine() {
    const bk = st.ctx?.book;
    if (!bk) return "still loading";
    const ml = bk.buckets.get("ml")?.all;
    const sp = ["take", "lay-small", "lay-mid", "lay-big", "pk"].map((k) => bk.buckets.get(k)?.all).filter(Boolean)
      .reduce((r, x) => ({ w: r.w + x.w, l: r.l + x.l, p: r.p + x.p }), { w: 0, l: 0, p: 0 });
    return `${ml ? recText(ml) : "0-0"} on moneylines and ${recText(sp)} on spreads all-time, which is the whole case for the Safest legs board`;
  }

  return {
    destroy() {
      destroyed = true;
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("change", onInput);
    },
  };
}
