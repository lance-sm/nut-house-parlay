// Scouting tab: a weekly scouting report next to the ticket.
// Week header, awards for the house ticket, the ticket vs ESPN FPI and the market, the model's best
// picks board, pitfalls, and trends (the house's own picks + market-wide ATS this season).
//
// Contract (called by the main app):
//   mountScout(root, { parlays, currentParlay, onOpenGame }) -> { update({ parlays, currentParlay }), destroy() }
//   root: an empty <section> inside main.wrap (not a sheet). Styles live in css/scout.css, all scoped
//   under .scout (added to root here). Every tappable pick or leg calls onOpenGame(eventId).
//
// Data: fetchWeekSlate for the week on screen (its own ‹ Week › switcher), fetchPredictor for every
// game on the slate (6 at a time, cached per event in sessionStorage), loadSeasonData(year) for
// closing lines on finished games and the season trends. The math lives in insights.js.

import { fetchWeekSlate, fetchPredictor, logoHTML, escapeHTML as esc, kickoffText } from "./espn.js";
import { gradeLeg, legLabel, fmtLine, fmtOdds, teamById } from "./grade.js";
import { loadSeasonData } from "./store.js";
import { slatePicks, legInsights, pitfalls, marketTrends, houseTrends, bestWorst, boardRecord } from "./insights.js";

const WEEK_MIN = 1;
const WEEK_MAX = 16;
const BOARD_SIZE = 8;
const TRAP_SIZE = 4;
const SLATE_PREVIEW = 6;            // slate-level pitfalls shown before "Show more"
const SLATE_FRESH_MS = 60_000;      // a cached slate younger than this is shown without refetching
const REFRESH_MS = 60_000;          // scoreboard refresh while games are live or about to kick
const FPI_TTL_MS = 20 * 60_000;     // pre-game / live projections
const FPI_NULL_TTL_MS = 5 * 60_000; // "no projection" (or a swallowed network error): try again soon
const FPI_TIMEOUT_MS = 9_000;
const FPI_CONCURRENCY = 6;
const FPI_KEY = "nh.fpi.v1:";
const ODDS_KEY = "nh.odds.v1:";

const MINUS = "\u2212";
const DASH = "\u2013";
const DOT = " \u00b7 ";
const ARROW = "\u2192";
const ELLIPSIS = "\u2026";

const ICON = {
  trophy: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4.5v1.2A3 3 0 0 0 7.4 10.2M17 6h2.5v1.2a3 3 0 0 1-2.9 3M12 14v3.5M8.5 20.5h7M9.5 17.5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dunce: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M12 4.5L18.5 20h-13L12 4.5zM7.3 15.5h9.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="12" cy="3" r="1.6" fill="currentColor"/></svg>',
  hook: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="15" cy="3.6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 5.5V15a4.5 4.5 0 0 1-9 0v-3.5l2.6 2.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const AWARDS = {
  best: { title: "Best pick", icon: ICON.trophy, none: "Nobody's cashing yet." },
  worst: { title: "Bozo of the week", icon: ICON.dunce, none: "No bozo yet. Every leg is still breathing." },
  closest: { title: "Closest call", icon: ICON.hook, none: "Nothing's settled yet." },
};

const VERDICT = {
  agree: { cls: "won", text: "FPI agrees" },
  disagree: { cls: "lost", text: "FPI fades it" },
  neutral: { cls: "even", text: "Toss-up" },
  unknown: { cls: "", text: "No read" },
};

const REASON_TONE = { good: "good", warn: "warn", bad: "bad" };
const SHARE_TRENDS = new Set(["key-37"]);  // shares of games, not W-L records
const BAR_HALF = 0.15;                      // trend bar: half its width = 15 points away from .500
// Reasons the ticket row's numbers already show (FPI line, projected cover, line move, no totals model).
const TRIO_RE = /^(FPI: |FPI doesn|Projected |Line moved |Total moved )/;
const SEV_TEXT = { high: "High", med: "Watch", low: "Minor" };

// ---------- caches shared by every mount (the tab can be torn down and remounted) ----------

const slateCache = new Map();   // "year:type:week" -> { slate, at }
const seasonCache = new Map();  // year -> Promise<season|null>
const seasonIdx = new WeakMap(); // season object -> { byId, games }
const preds = new Map();        // event id -> {homeMargin, homeWin, awayWin} | null (resolved this session)
const fpiMem = new Map();       // event id -> { v, at, fin } mirror of sessionStorage
const inflight = new Map();     // event id -> Promise
const oddsMemo = new Map();     // event id -> last odds seen with a line (live games lose theirs)
const allGames = new Map();     // event id -> latest game (odds filled) from any slate seen this session

let mounts = 0;

export function mountScout(root, { parlays = [], currentParlay = null, onOpenGame } = {}) {
  const uid = `sc${++mounts}`;
  let allParlays = Array.isArray(parlays) ? parlays.filter(Boolean) : [];
  let cur = currentParlay || null;

  const st = {
    week: null, seasonType: 2, year: null,
    raw: null,          // slate as ESPN returned it
    games: null,        // slate games with odds filled (null until loaded)
    loading: false,
    error: null,
    updatedAt: null,
    season: undefined,  // undefined = loading, null = not available, object
    seasonYear: null,
    ui: { moreSlate: false, market: "season" },
  };
  const painted = new WeakMap();
  let seq = 0;
  let timer = null;
  let paintTimer = null;
  let destroyed = false;

  root.classList.add("scout");
  root.setAttribute("aria-label", "Scouting report");
  root.innerHTML = `
    <div class="card sc-head">
      <div class="sc-weekbar">
        <button type="button" class="sc-wk-btn" data-act="week" data-d="-1" data-fk="wk-prev" aria-label="Previous week">\u2039</button>
        <div class="sc-wk-label" aria-live="polite">
          <h2 class="sc-wk-name" id="${uid}-wk">This week</h2>
          <span class="sc-wk-sub" data-wk-sub>Scouting report</span>
        </div>
        <button type="button" class="sc-wk-btn" data-act="week" data-d="1" data-fk="wk-next" aria-label="Next week">\u203a</button>
      </div>
      <div class="sc-head-stats" data-head></div>
    </div>
    <div class="sc-body"></div>`;
  const wkName = root.querySelector(".sc-wk-name");
  const wkSub = root.querySelector("[data-wk-sub]");
  const prevBtn = root.querySelector('[data-d="-1"]');
  const nextBtn = root.querySelector('[data-d="1"]');
  const headEl = root.querySelector("[data-head]");
  const body = root.querySelector(".sc-body");

  root.addEventListener("click", onClick);
  document.addEventListener("visibilitychange", onVisibility);

  const start = weekOfParlay(cur);
  loadWeek(start ? { week: start.week, seasonType: 2, year: start.year } : {});

  // ---------- data ----------

  function dead(mine) { return destroyed || mine !== seq; }

  async function loadWeek(req, { force = false } = {}) {
    if (destroyed) return;
    const mine = ++seq;
    clearTimeout(timer);
    timer = null;
    if (req.week) { st.week = req.week; st.seasonType = req.seasonType ?? 2; }
    if (req.year) st.year = req.year;

    // A week seen before paints straight from cache (a refresh is the same week, so nothing blanks out).
    const key = req.week && (req.year || st.year) ? slateKey(req.year || st.year, req.seasonType ?? 2, req.week) : null;
    const hit = key ? slateCache.get(key) : null;
    if (hit) setSlate(hit.slate, hit.at);
    else { st.raw = null; st.games = null; st.updatedAt = null; }
    st.error = null;
    st.loading = true;
    paint();

    if (hit && !force && Date.now() - hit.at < SLATE_FRESH_MS) {
      st.loading = false;
      afterSlate(mine);
      return;
    }

    try {
      const slate = await fetchWeekSlate({
        week: req.week || undefined,
        seasonType: req.seasonType ?? 2,
        year: req.year || st.year || undefined,
      });
      if (dead(mine)) return;
      const at = Date.now();
      slateCache.set(slateKey(slate.year, slate.seasonType, slate.week), { slate, at });
      setSlate(slate, at);
    } catch (err) {
      if (dead(mine)) return;
      st.error = (err && err.message) || "Couldn\u2019t reach ESPN";
    }
    st.loading = false;
    paint();
    afterSlate(mine);
  }

  function setSlate(slate, at) {
    st.raw = slate;
    st.week = slate.week ?? st.week;
    st.seasonType = slate.seasonType ?? st.seasonType;
    st.year = slate.year ?? st.year;
    st.updatedAt = new Date(at);
    deriveGames();
  }

  // Scoreboard games with odds patched in: finished games lose their lines on ESPN's scoreboard,
  // so closing lines come from the season file (or from what this session saw before kickoff).
  function deriveGames() {
    if (!st.raw) { st.games = null; return; }
    const idx = st.season ? indexSeason(st.season) : null;
    st.games = (st.raw.games || []).map((g) => {
      const out = fillOdds(g, idx ? idx.byId.get(g.id) : null, st.season?.provider);
      allGames.set(out.id, out);
      return out;
    });
  }

  function afterSlate(mine) {
    if (dead(mine)) return;
    ensureSeason(st.year);
    if (st.games) loadPreds(mine);
    schedule();
  }

  function ensureSeason(year) {
    if (!year) { st.season = null; st.seasonYear = null; return; }
    if (st.seasonYear === year && (st.season !== undefined || seasonCache.has(year))) return;
    if (!seasonCache.has(year)) seasonCache.set(year, loadSeasonData(year).catch(() => null));
    const p = seasonCache.get(year);
    st.season = undefined;
    st.seasonYear = year;
    p.then((data) => {
      if (destroyed || year !== st.seasonYear) return;
      st.season = data && Array.isArray(data.games) ? data : null;
      deriveGames();
      paintSoon();
    });
  }

  // FPI for every game on the slate. The house's legs go first so the ticket section fills in early.
  function loadPreds(mine) {
    const games = st.games || [];
    const legIds = new Set((weekParlay()?.legs || []).map((l) => String(l.e)));
    const order = [...games].sort((a, b) => rank(a) - rank(b));
    function rank(g) { return legIds.has(g.id) ? 0 : g.state === "pre" ? 1 : 2; }

    const todo = [];
    for (const g of order) {
      const cached = readFpi(g.id);
      if (cached !== undefined) preds.set(g.id, cached);
      else if (!inflight.has(g.id)) todo.push(g);
    }
    if (!todo.length) { paintSoon(); return; }

    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const g = todo[next++];
        if (destroyed) return;
        await fetchOne(g);
        if (!destroyed && mine === seq) paintSoon();
      }
    };
    for (let i = 0; i < Math.min(FPI_CONCURRENCY, todo.length); i++) worker();
  }

  function fetchOne(g) {
    if (inflight.has(g.id)) return inflight.get(g.id);
    const p = withTimeout(fetchPredictor(g.id), FPI_TIMEOUT_MS).then((v) => {
      inflight.delete(g.id);
      if (v === TIMED_OUT) { if (!preds.has(g.id)) preds.set(g.id, null); return; }
      preds.set(g.id, v || null);
      writeFpi(g.id, v || null, g.state === "post");
    }, () => { inflight.delete(g.id); if (!preds.has(g.id)) preds.set(g.id, null); });
    inflight.set(g.id, p);
    return p;
  }

  function retryFpi() {
    for (const g of st.games || []) {
      if (preds.get(g.id) === null) { preds.delete(g.id); fpiMem.delete(g.id); try { sessionStorage.removeItem(FPI_KEY + g.id); } catch { /* fine */ } }
    }
    paint();
    loadPreds(seq);
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (destroyed || document.hidden || !st.week) return;
    const games = st.games || [];
    const soon = Date.now() + 15 * 60_000;
    const active = games.some((g) => g.state === "in" || (g.state === "pre" && Date.parse(g.date) < soon));
    if (st.error || active) timer = setTimeout(() => loadWeek(here(), { force: true }), REFRESH_MS);
  }

  function onVisibility() {
    if (destroyed) return;
    if (document.hidden) { clearTimeout(timer); timer = null; return; }
    const stale = !st.updatedAt || Date.now() - st.updatedAt.getTime() > REFRESH_MS;
    const live = (st.games || []).some((g) => g.state === "in");
    if (st.error || (stale && live)) loadWeek(here(), { force: true });
    else schedule();
  }

  function here() {
    return { week: st.week, seasonType: st.seasonType, year: st.year };
  }

  function go(d) {
    let { week, seasonType } = st;
    if (week == null) return;
    if (seasonType === 3) { if (d > 0) return; week = WEEK_MAX; seasonType = 2; }
    else if (seasonType === 1) { if (d < 0) return; week = WEEK_MIN; seasonType = 2; }
    else { week += d; if (week < WEEK_MIN || week > WEEK_MAX) return; }
    st.ui.moreSlate = false;
    loadWeek({ week, seasonType, year: st.year });
  }

  // The week's parlay: the one whose legs are on this slate, current one first.
  function weekParlay() {
    if (!st.games) return null;
    const ids = new Set(st.games.map((g) => g.id));
    const list = cur ? [cur, ...allParlays.filter((p) => p !== cur && p.id !== cur.id)] : allParlays;
    return list.find((p) => Array.isArray(p?.legs) && p.legs.some((l) => ids.has(String(l.e)))) || null;
  }

  function resolveGame(id) {
    const key = String(id);
    const g = allGames.get(key);
    if (g) return g;
    const idx = st.season ? indexSeason(st.season) : null;
    return idx ? idx.games(key) : null;
  }

  // ---------- events ----------

  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || !root.contains(el)) return;
    const act = el.getAttribute("data-act");
    if (act === "open") {
      const id = el.getAttribute("data-e");
      if (id && typeof onOpenGame === "function") onOpenGame(id);
    } else if (act === "week") {
      go(Number(el.getAttribute("data-d")) || 0);
    } else if (act === "retry" || act === "refresh") {
      if (act === "refresh" && st.loading) return; // already on it
      loadWeek(here(), { force: true });
    } else if (act === "retry-fpi") {
      retryFpi();
    } else if (act === "retry-season") {
      seasonCache.delete(st.year);
      st.season = undefined;
      paint();
      ensureSeason(st.year);
    } else if (act === "more-slate") {
      st.ui.moreSlate = !st.ui.moreSlate;
      paint();
    } else if (act === "market") {
      const v = el.getAttribute("data-v") === "recent" ? "recent" : "season";
      if (v !== st.ui.market) { st.ui.market = v; paint(); }
    }
  }

  // ---------- paint ----------

  function paintSoon() {
    if (paintTimer || destroyed) return;
    paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 120);
  }

  function paint() {
    if (destroyed) return;
    clearTimeout(paintTimer);
    paintTimer = null;
    const active = document.activeElement;
    const fk = active && root.contains(active) ? active.getAttribute("data-fk") : null;
    const lefts = [];
    root.querySelectorAll("[data-sk]").forEach((el) => { if (el.scrollLeft) lefts.push([el.getAttribute("data-sk"), el.scrollLeft]); });

    const m = buildModel();
    paintWeekbar(m);
    const head = safe("head", () => headHTML(m));
    if (painted.get(headEl) !== head) { headEl.innerHTML = head; painted.set(headEl, head); }
    reconcile(body, buildSections(m), painted);

    for (const [k, x] of lefts) {
      const el = root.querySelector(`[data-sk="${cssEscape(k)}"]`);
      if (el) el.scrollLeft = x;
    }
    if (fk && (!active.isConnected || document.activeElement !== active)) {
      const el = root.querySelector(`[data-fk="${cssEscape(fk)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  function paintWeekbar(m) {
    wkName.textContent = weekName(st);
    wkSub.textContent = m.games?.length ? `${dateRange(m.games)}${DOT}Scouting report` : st.loading ? `Loading${ELLIPSIS}` : "Scouting report";
    const canPrev = st.week != null && (st.seasonType === 3 || (st.seasonType === 2 && st.week > WEEK_MIN));
    const canNext = st.week != null && (st.seasonType === 1 || (st.seasonType === 2 && st.week < WEEK_MAX));
    prevBtn.disabled = !canPrev;
    nextBtn.disabled = !canNext;
  }

  // Everything the sections need, computed once per paint.
  function buildModel() {
    const games = st.games;
    const m = {
      games, st, uid,
      byId: new Map((games || []).map((g) => [g.id, g])),
      parlay: null, legs: [], started: false, retro: false,
      predReady: false, legPredReady: false, predMap: new Map(), predCount: 0,
      lined: 0, provider: null,
    };
    if (!games) return m;
    m.parlay = weekParlay();
    m.legs = m.parlay ? m.parlay.legs.filter(Boolean) : [];
    m.started = m.legs.some((l) => { const g = m.byId.get(String(l.e)); return g && g.state !== "pre"; });
    m.retro = games.length > 0 && !games.some((g) => g.state === "pre");
    for (const g of games) {
      if (preds.has(g.id)) { m.predMap.set(g.id, preds.get(g.id)); if (preds.get(g.id)) m.predCount++; }
      if (g.odds && isNum(g.odds.spread)) m.lined++;
      if (!m.provider && g.odds?.provider) m.provider = g.odds.provider;
    }
    m.predReady = games.every((g) => m.predMap.has(g.id));
    m.legPredReady = m.legs.every((l) => !m.byId.has(String(l.e)) || m.predMap.has(String(l.e)));
    return m;
  }

  function buildSections(m) {
    const out = [];
    const add = (key, fn) => {
      const html = safe(key, fn);
      if (html) out.push([key, html]);
    };
    if (st.error) add("error", () => errorHTML(!!st.games));
    if (!st.games) {
      if (!st.error) {
        add("ticket", () => skeletonSection("Your ticket vs the numbers", 3));
        add("board", () => skeletonSection("The board", 4));
        add("trends", () => skeletonSection("Trends", 4));
      }
      return out;
    }
    if (!st.games.length) {
      add("empty", () => `<div class="card sc-empty-card"><p class="sc-empty-h">No games on the board</p><p>ESPN has no FBS games listed for ${esc(weekName(st))}. Try another week.</p></div>`);
      add("trends", () => trendsHTML(m));
      return out;
    }
    if (m.parlay && m.started) add("awards", () => awardsHTML(m));
    add("ticket", () => ticketHTML(m));
    add("board", () => boardHTML(m));
    add("pitfalls", () => pitfallsHTML(m));
    add("trends", () => trendsHTML(m));
    return out;
  }

  // ---------- header strip ----------

  function headHTML(m) {
    const games = m.games;
    if (!games) {
      return `<div class="sc-stats" aria-hidden="true">${statTile("\u2013", "Games")}${statTile("\u2013", "Lined")}${statTile("\u2013", "FPI")}</div>
        <p class="sc-fresh">${st.error ? "" : `Loading the slate from ESPN${ELLIPSIS}`}</p>`;
    }
    const n = games.length;
    const fpiText = m.predReady ? `${m.predCount}/${n}` : `${m.predMap.size}/${n}`;
    const fpiSub = m.predReady ? "FPI" : `FPI${ELLIPSIS}`;
    const bits = [];
    if (m.provider) bits.push(`Lines: ${esc(m.provider)}`);
    if (st.loading) bits.push(`Refreshing${ELLIPSIS}`);
    else if (st.updatedAt) bits.push(`Updated ${esc(clockTime(st.updatedAt))}`);
    return `<div class="sc-stats">
        ${statTile(String(n), n === 1 ? "Game" : "Games")}
        ${statTile(String(m.lined), "Lined")}
        ${statTile(fpiText, fpiSub, !m.predReady)}
      </div>
      <div class="sc-fresh">
        <span>${bits.join(DOT)}</span>
        <button type="button" class="btn ghost sc-refresh" data-act="refresh" data-fk="refresh"${st.loading ? ' aria-busy="true"' : ""}>${ICON.refresh}<span>Refresh</span></button>
      </div>`;
  }

  function statTile(value, label, busy = false) {
    return `<div class="sc-stat${busy ? " busy" : ""}"><span class="sc-stat-v num">${esc(value)}</span><span class="sc-stat-l">${esc(label)}</span></div>`;
  }

  function errorHTML(hasData) {
    const msg = hasData ? "Couldn\u2019t refresh from ESPN. Showing the last update." : `Couldn\u2019t load ${esc(weekName(st))} from ESPN.`;
    return `<div class="banner error sc-err" role="alert"><span>${msg}</span><button type="button" class="btn" data-act="retry" data-fk="retry">Retry</button></div>`;
  }

  // ---------- 2. awards ----------

  function awardsHTML(m) {
    const bw = bestWorst(m.legs, m.byId) || {};
    const final = !!bw.final;
    const tiles = [
      awardTile("best", bw.best, final),
      awardTile("worst", bw.worst, final),
      bw.closest || final ? awardTile("closest", bw.closest, final) : "",
    ].join("");
    return `<div class="card sc-awards">
      <div class="sc-awards-h">
        <h2 class="sc-awards-title" id="${uid}-awards">${esc(weekName(st))} awards</h2>
        <span class="sc-awards-tag${final ? "" : " live"}">${final ? "Final" : "So far"}</span>
      </div>
      <div class="sc-award-grid">${tiles}</div>
    </div>`;
  }

  function awardTile(kind, item, final) {
    const meta = AWARDS[kind];
    const title = final ? meta.title : `${meta.title} (so far)`;
    if (!item || !item.leg) {
      return `<div class="sc-award" data-kind="${kind}" data-empty>
        <span class="sc-award-icon">${meta.icon}</span>
        <span class="sc-award-body"><span class="sc-award-k">${esc(title)}</span><span class="sc-award-none">${esc(final && kind === "worst" ? "Clean sheet. No bozo this week." : meta.none)}</span></span>
      </div>`;
    }
    const { leg, game } = item;
    const grade = item.grade || gradeLeg(leg, game);
    const label = legLabel(leg, game);
    const team = leg.t !== "total" && game ? teamById(game, leg.s) : null;
    const badge = team ? logoHTML(team) : ouBadge(leg);
    const sub = [game ? scoreLine(game) : "", quip(kind, item, grade, final)].filter(Boolean).join(DOT);
    return `<button type="button" class="sc-award" data-kind="${kind}" data-act="open" data-e="${esc(leg.e)}" data-fk="award-${kind}">
      <span class="sc-award-icon">${meta.icon}</span>
      <span class="sc-award-body">
        <span class="sc-award-k">${esc(title)}</span>
        <span class="sc-award-pick">${badge}<span class="sc-award-label">${esc(label)}</span></span>
        <span class="sc-award-m num">${esc(grade.text || "")}</span>
        ${sub ? `<span class="sc-award-sub">${esc(sub)}</span>` : ""}
      </span>
    </button>`;
  }

  // ---------- 3. your ticket vs the numbers ----------

  function ticketHTML(m) {
    const title = "Your ticket vs the numbers";
    if (!m.parlay) {
      const canBet = (m.games || []).some((g) => g.state === "pre");
      return sectionHTML("ticket", title, "", `<div class="card sc-empty-card">
          <p class="sc-empty-h">No ticket for this week yet</p>
          <p>Build one and it shows up here, leg by leg against ESPN FPI and the line.</p>
          ${canBet ? '<button type="button" class="btn primary" data-action="new" data-fk="build">Build this week\u2019s parlay</button>' : ""}
        </div>`);
    }
    if (!m.legPredReady) return sectionHTML("ticket", title, `<span class="sc-busy">Reading the numbers${ELLIPSIS}</span>`, skeletonRows(Math.max(1, m.legs.length)));

    const legPreds = new Map();
    for (const l of m.legs) if (m.predMap.has(String(l.e))) legPreds.set(String(l.e), m.predMap.get(String(l.e)));
    const insights = legInsights(m.legs, m.byId, legPreds) || [];
    const pits = pitfalls({ legs: m.legs, gamesById: m.byId, predictors: legPreds, slate: [] }) || [];
    const pitsByLeg = new Map();
    for (const p of pits) {
      if (p == null || p.legIndex == null) continue;
      if (!pitsByLeg.has(p.legIndex)) pitsByLeg.set(p.legIndex, []);
      pitsByLeg.get(p.legIndex).push(p);
    }

    const rows = m.legs.map((leg, i) => ({ leg, i, ins: insights[i] || null }))
      .sort((a, b) => kickMs(a.leg, m.byId) - kickMs(b.leg, m.byId) || a.i - b.i);
    const counts = { agree: 0, disagree: 0 };
    for (const r of rows) if (r.ins && counts[r.ins.verdict] !== undefined) counts[r.ins.verdict]++;
    const read = rows.filter((r) => r.ins && (r.ins.verdict === "agree" || r.ins.verdict === "disagree" || r.ins.verdict === "neutral")).length;
    const aux = read
      ? `FPI agrees with <b>${counts.agree}</b> of ${m.legs.length}${counts.disagree ? `${DOT}fades <b class="bad">${counts.disagree}</b>` : ""}`
      : "";
    return sectionHTML("ticket", title, aux, `<ol class="card sc-legs">${rows.map((r) => legRowHTML(r, m, pitsByLeg.get(r.i) || [])).join("")}</ol>`);
  }

  function legRowHTML({ leg, i, ins }, m, pits) {
    const game = m.byId.get(String(leg.e)) || ins?.game || null;
    const label = legLabel(leg, game);
    const team = leg.t !== "total" && game ? teamById(game, leg.s) : null;
    const badge = team ? logoHTML(team, "sm") : leg.t === "total" ? ouBadge(leg) : "";
    const verdict = VERDICT[ins?.verdict] || VERDICT.unknown;
    // Trap side, same rule as the board's 'trap' tier: FPI edge of 1.5+ pts but the money moved 1+ against it.
    const mvAgainst = ins?.move && ins.move.withPick === false && isNum(ins.move.delta) ? Math.abs(ins.move.delta) : 0;
    const edgePts = isNum(ins?.edge) ? (leg.t === "ml" ? (ins.edge * 100) / 2.8 : ins.edge) : 0;
    const trap = ins?.verdict === "agree" && edgePts >= 1.5 && mvAgainst >= 1;
    const grade = game && game.state !== "pre" ? gradeLeg(leg, game) : null;
    const when = game ? whenText(game) : (leg.k ? kickoffText(leg.k) : "");
    const sub = [game ? matchup(game) : leg.g || "", when].filter(Boolean).join(DOT);

    let numbers = "";
    if (leg.t === "total") {
      numbers = `<span class="sc-legnote">ESPN FPI doesn\u2019t project totals, so no model read here.${moveText(ins?.move, false) ? ` Line: ${esc(moveText(ins.move, false))}.` : ""}</span>`;
    } else if (!game) {
      numbers = `<span class="sc-legnote">This game isn\u2019t on the FBS board for this week.</span>`;
    } else {
      const edgeCell = leg.t === "ml"
        ? cell(isNum(ins?.edge) ? fmtPctPts(ins.edge) : "\u2014", "Win prob edge", toneOf(ins?.edge))
        : cell(isNum(ins?.edge) ? fmtSigned(ins.edge) : "\u2014", "Proj cover", toneOf(ins?.edge, 0.5));
      const fpi = isNum(ins?.fpiMargin) ? fpiText(ins.fpiMargin, game, leg.s) : "\u2014";
      const mv = ins?.move;
      const mvTone = mv && mv.delta ? (mv.withPick === true ? "good" : mv.withPick === false ? "bad" : "") : "";
      numbers = `<span class="sc-trio">${edgeCell}${cell(fpi, "FPI line", "")}${cell(moveText(mv, true) || "\u2014", "Line move", mvTone)}</span>`;
    }

    const pitText = pits.map((p) => String(p.title || "").toLowerCase());
    const reasons = game
      ? (ins?.reasons || [])
        .filter((r) => r && r.text && !TRIO_RE.test(r.text) && !pitText.some((t) => t.includes(String(r.text).toLowerCase())))
        .slice(0, 3).map(reasonChip).join("")
      : "";
    const pitList = pits.length
      ? `<span class="sc-legpits">${pits.map((p) => `<span class="sc-legpit" data-sev="${esc(p.severity)}"><i aria-hidden="true"></i><span><span class="sc-sr">${esc(SEV_TEXT[p.severity] || "")}: </span>${esc(p.title)}</span></span>`).join("")}</span>`
      : "";
    return `<li><button type="button" class="sc-leg" data-act="open" data-e="${esc(leg.e)}" data-fk="leg-${i}" data-verdict="${esc(ins?.verdict || "unknown")}">
      <span class="sc-leg-top">
        <span class="sc-pick">${badge}<span class="sc-pick-label">${esc(label)}</span>${isNum(leg.o) ? `<span class="sc-odds num">${esc(fmtOdds(leg.o))}</span>` : ""}</span>
        <span class="sc-leg-chips">${trap ? `<span class="chip lost sc-trapchip" title="${esc(`FPI likes it, but the money moved ${fmtLine(mvAgainst, false)} the other way`)}">Trap</span>` : ""}<span class="chip ${verdict.cls}">${esc(verdict.text)}</span></span>
      </span>
      <span class="sc-leg-sub"><span>${esc(sub)}</span>${grade ? `<span class="chip ${esc(grade.tone)}">${esc(grade.text)}</span>` : ""}</span>
      ${numbers}
      ${reasons ? `<span class="sc-whys">${reasons}</span>` : ""}
      ${pitList}
    </button></li>`;
  }

  // ---------- 4. best picks board ----------

  function boardHTML(m) {
    const title = "The board";
    const trends = seasonTrends(1);
    const honest = boardHonesty(trends);
    if (!m.predReady) {
      return sectionHTML("board", title, `<span class="sc-busy">FPI ${m.predMap.size} of ${m.games.length}${ELLIPSIS}</span>`,
        `${honest}${skeletonRows(4, true)}`);
    }
    if (m.games.length && m.predCount === 0) {
      return sectionHTML("board", title, "", `${honest}<div class="card sc-empty-card"><p class="sc-empty-h">No FPI projections came back</p><p>ESPN’s model didn’t answer for this slate. It sometimes takes a minute.</p><button type="button" class="btn" data-act="retry-fpi" data-fk="retry-fpi">Retry</button></div>`);
    }
    const all = (slatePicks(m.games, m.predMap, { includeStarted: m.retro }) || []).filter(Boolean);
    // Best (model + money agree) first, then lean; slatePicks' score order holds inside each tier.
    const picks = [...all.filter((p) => p.tier === "best"), ...all.filter((p) => p.tier === "lean")].slice(0, BOARD_SIZE);
    const traps = all.filter((p) => p.tier === "trap").slice(0, TRAP_SIZE);

    let aux = "";
    if (m.retro && picks.length + traps.length) {
      const rec = boardRecord([...picks, ...traps]) || {};
      const sum = (...rs) => rs.reduce((a, r) => ({ w: a.w + (r?.w || 0), l: a.l + (r?.l || 0), p: a.p + (r?.p || 0) }), { w: 0, l: 0, p: 0 });
      const board = sum(rec.best, rec.lean);
      const trap = sum(rec.trap);
      const bits = [];
      if (board.w + board.l + board.p) bits.push(`Board went <b class="${board.w > board.l ? "good" : board.w < board.l ? "bad" : ""}">${wlp(board)}</b>`);
      // A trap "going 1-3" is the model's side losing, which is the point of flagging it.
      if (trap.w + trap.l + trap.p) bits.push(`traps went <b>${wlp(trap)}</b>`);
      aux = bits.join(DOT);
    } else if (picks.length) {
      const best = picks.filter((p) => p.tier === "best").length;
      aux = [best ? `${best} best` : "", picks.length - best ? `${picks.length - best} lean` : ""].filter(Boolean).join(DOT);
    }

    const kicked = m.retro ? 0 : m.games.filter((g) => g.state !== "pre").length;
    const notes = [];
    if (kicked) notes.push(`${kicked} game${kicked === 1 ? " has" : "s have"} kicked off and dropped off the board.`);
    const upcoming = m.games.filter((g) => g.state === "pre").length;
    const linedUpcoming = m.games.filter((g) => g.state === "pre" && isNum(g.odds?.spread)).length;
    if (!m.retro && linedUpcoming && linedUpcoming < upcoming * 0.6) {
      notes.push(`Only ${linedUpcoming} of ${upcoming} games have a line so far; the board fills in as books post them.`);
    }
    if (m.retro) notes.push("Every game is in, so this is the board graded after the fact.");
    const extra = notes.length ? `<p class="sc-note">${esc(notes.join(" "))}</p>` : "";

    let list;
    if (!picks.length) {
      const msg = m.lined === 0
        ? (m.retro
          ? "No closing lines for these games yet. They fill in once the season file is rebuilt."
          : "No lines posted for this week yet. Books usually hang them Sunday night.")
        : traps.length
          ? "Nothing clean this week: everything the model likes has the money going the other way. See the traps below."
          : "Nothing clears the bar this week. The model doesn’t love anything, which is its own kind of advice.";
      list = `<div class="card sc-empty-card"><p>${esc(msg)}</p></div>`;
    } else {
      list = `<ol class="card sc-board">${picks.map((p, i) => pickRowHTML(p, i, m.retro)).join("")}</ol>`;
    }
    const trapBlock = m.lined ? trapsHTML(traps, trends, m.retro) : "";
    return sectionHTML("board", title, aux, `${honest}${extra}${list}${trapBlock}`);
  }

  function pickRowHTML(p, i, retro) {
    const game = p.game;
    const team = game ? teamById(game, p.teamId ?? p.s) : null;
    const label = legLabel({ t: p.t, s: p.s, l: p.l, n: team?.short }, game);
    const isMl = p.t === "ml";
    const edgeVal = isMl ? fmtPctPts(p.edge) : fmtSigned(p.edge);
    const edgeUnit = isMl ? "win prob vs odds" : "pts vs line";
    const grade = retro && game ? gradeLeg({ t: p.t, s: p.s, l: p.l }, game) : null;
    const meta = [game ? matchup(game) : "", game ? whenText(game) : ""].filter(Boolean).join(DOT);
    const reasons = (p.reasons || []).slice(0, 4).map(reasonChip).join("");
    return `<li><button type="button" class="sc-pickrow" data-act="open" data-e="${esc(p.e)}" data-fk="pick-${esc(p.id || i)}" data-tier="${esc(p.tier)}">
      <span class="sc-rank num">${i + 1}</span>
      <span class="sc-pick-logo">${team ? logoHTML(team) : ""}</span>
      <span class="sc-pick-main">
        <span class="sc-pick-label">${esc(label)}${isNum(p.o) ? ` <span class="sc-odds num">${esc(fmtOdds(p.o))}</span>` : ""}</span>
        <span class="sc-pick-meta"><span class="sc-tier">${p.tier === "best" ? "Best" : "Lean"}</span>${esc(meta)}</span>
      </span>
      <span class="sc-edge"><span class="sc-edge-v num">${esc(edgeVal)}</span><span class="sc-edge-u">${edgeUnit}</span></span>
      ${grade || reasons ? `<span class="sc-whys">${grade ? `<span class="chip ${esc(grade.tone)}">${esc(grade.text)}</span>` : ""}${reasons}</span>` : ""}
    </button></li>`;
  }

  // Traps: the model likes the side, the money went the other way. Shown so nobody walks into one.
  function trapsHTML(traps, trends, retro) {
    const tr = trendById(trends, "board-trap");
    const fade = trendById(trends, "board-fade");
    let intro = "ESPN’s model likes these, but the money went the other way.";
    if (tr && tr.w + tr.l) {
      intro += ` Sides like this are ${wlp(tr)} this season`;
      intro += fade && fade.w + fade.l ? `; fading them is ${wlp(fade)}.` : ".";
    }
    const body = traps.length
      ? `<ol class="card sc-board sc-traps">${traps.map((p, i) => trapRowHTML(p, i, retro)).join("")}</ol>`
      : `<p class="sc-empty-inline sc-trap-none">No traps this week: nothing the model likes has the money running the other way.</p>`;
    return `<div class="sc-trap-wrap">
      <div class="sc-sub-h sc-trap-h"><h3 class="sc-h3">Traps</h3>${traps.length ? `<span class="sc-aux">${traps.length} flagged</span>` : ""}</div>
      ${traps.length ? `<p class="sc-note">${esc(intro)}</p>` : ""}
      ${body}
    </div>`;
  }

  function trapRowHTML(p, i, retro) {
    const game = p.game;
    const team = game ? teamById(game, p.teamId ?? p.s) : null;
    const label = legLabel({ t: p.t, s: p.s, l: p.l, n: team?.short }, game);
    const isMl = p.t === "ml";
    const meta = [game ? matchup(game) : "", game ? whenText(game) : ""].filter(Boolean).join(DOT);
    const grade = retro && game ? gradeLeg({ t: p.t, s: p.s, l: p.l }, game) : null;
    const mv = p.move || {};
    const amt = isNum(mv.delta) ? Math.abs(mv.delta) : null;
    const path = isNum(mv.open) && isNum(mv.now) ? ` (${fmtLine(mv.open, true)} ${ARROW} ${fmtLine(mv.now, true)})` : "";
    const moved = amt ? `Money moved ${fmtLine(amt, false)} the other way${path}` : "Money moved the other way";
    const others = (p.reasons || []).filter((r) => r && r.text && !/^(Line|Total|Money) moved /.test(r.text)).slice(0, 2).map(reasonChip).join("");
    return `<li><button type="button" class="sc-pickrow sc-traprow" data-act="open" data-e="${esc(p.e)}" data-fk="trap-${esc(p.id || i)}" data-tier="trap">
      <span class="sc-rank" aria-hidden="true">!</span>
      <span class="sc-pick-logo">${team ? logoHTML(team) : ""}</span>
      <span class="sc-pick-main">
        <span class="sc-pick-label"><span class="sc-sr">FPI side: </span>${esc(label)}${isNum(p.o) ? ` <span class="sc-odds num">${esc(fmtOdds(p.o))}</span>` : ""}</span>
        <span class="sc-pick-meta"><span class="sc-tier">Trap</span>${esc(meta)}</span>
      </span>
      <span class="sc-edge"><span class="sc-edge-v num">${esc(isMl ? fmtPctPts(p.edge) : fmtSigned(p.edge))}</span><span class="sc-edge-u">FPI edge</span></span>
      <span class="sc-whys">${grade ? `<span class="chip ${esc(grade.tone)}">${esc(grade.text)}</span>` : ""}<span class="sc-why" data-tone="bad">${esc(moved)}</span>${others}</span>
    </button></li>`;
  }

  // One honest line under the board heading: how "model + money agree" picks have done this season.
  function boardHonesty(trends) {
    if (st.season === undefined) return `<p class="sc-note sc-honest"><span class="sc-skel-line" style="--w:70%"></span></p>`;
    const t = trendById(trends, "board-best");
    if (!t || !(t.w + t.l)) {
      return `<p class="sc-note sc-honest">Best = ESPN FPI likes the side and the line moved its way. Signals, not locks.</p>`;
    }
    const pct = isNum(t.pct) ? t.pct : t.w / (t.w + t.l);
    return `<p class="sc-note sc-honest">${esc(t.label || "Model + money agree")}: ${esc(wlp(t))} this season (${Math.round(pct * 100)}%). Signals, not locks.</p>`;
  }

  // ---------- 5. pitfalls ----------

  function pitfallsHTML(m) {
    const title = "Pitfalls";
    if (!m.predReady) return sectionHTML("pitfalls", title, `<span class="sc-busy">Checking${ELLIPSIS}</span>`, skeletonRows(2));
    const list = (pitfalls({ legs: m.legs, gamesById: m.byId, predictors: m.predMap, slate: m.games }) || []).filter(Boolean);
    const mine = list.filter((p) => p.legIndex != null);
    const slate = list.filter((p) => p.legIndex == null);
    const high = list.filter((p) => p.severity === "high").length;
    const aux = list.length ? `${list.length} flagged${high ? `${DOT}<b class="bad">${high} high</b>` : ""}` : "";
    if (!list.length) {
      return sectionHTML("pitfalls", title, "", `<div class="card sc-empty-card"><p>Nothing scary on the board${m.parlay ? " or your ticket" : ""}. Suspicious, honestly.</p></div>`);
    }
    const shownSlate = st.ui.moreSlate ? slate : slate.slice(0, SLATE_PREVIEW);
    const more = slate.length > SLATE_PREVIEW
      ? `<button type="button" class="btn ghost sc-more" data-act="more-slate" data-fk="more-slate" aria-expanded="${st.ui.moreSlate}">${st.ui.moreSlate ? "Show fewer" : `Show ${slate.length - SLATE_PREVIEW} more`}</button>`
      : "";
    const group = (head, items) => items.length
      ? `<div class="sc-pitgroup"><h3 class="eyebrow sc-pitgroup-h">${esc(head)}</h3><ul class="sc-pits">${items.map((p, i) => pitRowHTML(p, m, i)).join("")}</ul></div>`
      : "";
    return sectionHTML("pitfalls", title, aux, `<div class="card sc-pitcard">
      ${m.parlay ? group("On your ticket", mine) || `<p class="sc-pit-clear">Your ticket is clean. No flags on any leg.</p>` : ""}
      ${group("Around the slate", shownSlate)}${more}
    </div>`);
  }

  function pitRowHTML(p, m, i) {
    const leg = p.legIndex != null ? m.legs[p.legIndex] : null;
    const where = leg ? `Leg: ${legLabel(leg, m.byId.get(String(leg.e)))}` : "";
    const g = p.e ? m.byId.get(String(p.e)) : null;
    const tag = [where, g && !leg ? matchup(g) : ""].filter(Boolean).join("");
    const inner = `<span class="sc-pit-top"><span class="sc-sev">${esc(SEV_TEXT[p.severity] || p.severity || "")}</span><span class="sc-pit-t">${esc(p.title)}</span></span>
      ${p.detail ? `<span class="sc-pit-d">${esc(p.detail)}</span>` : ""}
      ${tag ? `<span class="sc-pit-where">${esc(tag)}</span>` : ""}`;
    const sev = esc(p.severity || "low");
    return p.e
      ? `<li><button type="button" class="sc-pit" data-sev="${sev}" data-act="open" data-e="${esc(p.e)}" data-fk="pit-${esc(p.kind)}-${esc(p.e)}-${p.legIndex ?? "s"}-${i}">${inner}</button></li>`
      : `<li><div class="sc-pit" data-sev="${sev}">${inner}</div></li>`;
  }

  // ---------- 6. trends ----------

  function seasonTrends(sinceWeek) {
    if (!st.season) return [];
    return safeCall(() => marketTrends(st.season, { sinceWeek }), []);
  }

  function trendsHTML(m) {
    return sectionHTML("trends", "Trends", "", `${houseHTML()}${marketHTML()}`);
  }

  function houseHTML() {
    const year = st.year;
    const list = allParlays.filter((p) => {
      const y = /^(\d{4})/.exec(String(p?.id || ""));
      return !y || !year || Number(y[1]) === year;
    });
    let body;
    if (!list.length) {
      body = `<p class="sc-empty-inline">No tickets logged yet. Trends start once the house has a few weeks in.</p>`;
    } else if (st.season === undefined && !list.every((p) => (p.legs || []).every((l) => allGames.has(String(l.e))))) {
      body = skeletonLines(4);
    } else {
      const h = houseTrends(list, resolveGame) || {};
      const t = h.tickets || {};
      const lg = h.legs || {};
      const hit = (lg.w || 0) + (lg.l || 0) ? lg.w / (lg.w + lg.l) : null;
      const pend = [t.pending ? `${t.pending} ticket${t.pending === 1 ? "" : "s"}` : "", lg.pending ? `${lg.pending} leg${lg.pending === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
      body = `<div class="sc-stats sc-house-stats">
          ${statTile(`${t.cashed || 0}${DASH}${t.busted || 0}${t.push ? `${DASH}${t.push}` : ""}`, "Tickets")}
          ${statTile(`${lg.w || 0}${DASH}${lg.l || 0}${lg.p ? `${DASH}${lg.p}` : ""}`, "Legs")}
          ${statTile(hit === null ? "\u2013" : `${Math.round(hit * 100)}%`, "Leg hit rate")}
        </div>
        ${pend ? `<p class="sc-note">Still to settle: ${esc(pend)}.</p>` : ""}
        ${(h.notes || []).length ? `<ul class="sc-notes">${h.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        ${trendRows(h.splits || [], "house")}`;
    }
    return `<div class="card sc-trendcard">
      <div class="sc-sub-h"><h3 class="sc-h3">The house</h3><span class="sc-aux">${list.length ? `${list.length} ticket${list.length === 1 ? "" : "s"}${year ? ` in ${year}` : ""}` : ""}</span></div>
      ${body}
    </div>`;
  }

  function marketHTML() {
    const s = st.season;
    let body;
    let aux = "";
    if (s === undefined) {
      body = skeletonLines(5);
    } else if (!s) {
      body = `<p class="sc-empty-inline">Season-to-date numbers aren\u2019t published yet. Once they are, this shows how favorites, dogs, home teams, totals and ESPN FPI have done against the closing line.</p>
        <button type="button" class="btn sc-small" data-act="retry-season" data-fk="retry-season">Check again</button>`;
    } else {
      const through = Number(s.throughWeek) || null;
      const recent = st.ui.market === "recent" && through;
      const since = recent ? Math.max(1, through - 3) : 1;
      const rows = seasonTrends(since);
      aux = through ? `Through week ${through}` : "";
      const seg = through && through > 4
        ? `<div class="sc-seg" role="group" aria-label="Range">
            <button type="button" class="sc-seg-b" data-act="market" data-v="season" data-fk="mk-season" aria-pressed="${!recent}">Season</button>
            <button type="button" class="sc-seg-b" data-act="market" data-v="recent" data-fk="mk-recent" aria-pressed="${!!recent}">Last 4 wks</button>
          </div>`
        : "";
      body = `${seg}${rows.length ? trendRows(rows, "market") : `<p class="sc-empty-inline">No finished games with closing lines yet.</p>`}
        <p class="sc-note sc-foot">Against the spread at the closing line${s.provider ? ` (${esc(s.provider)})` : ""}. 52.4% is break-even at \u2212110.</p>`;
    }
    return `<div class="card sc-trendcard">
      <div class="sc-sub-h"><h3 class="sc-h3">The market this season</h3><span class="sc-aux">${esc(aux)}</span></div>
      ${body}
    </div>`;
  }

  function trendRows(rows, key) {
    const items = rows.filter(Boolean).map((t) => {
      const w = t.w || 0, l = t.l || 0, p = t.p || 0;
      const n = isNum(t.n) ? t.n : w + l + p;
      const tone = REASON_TONE[t.tone] || "neutral";
      const label = `<span class="sc-tl">${esc(t.label)}${t.note ? `<small>${esc(t.note)}</small>` : ""}</span>`;
      // A tally with no win/loss split (e.g. hook losses): just the count.
      if (!isNum(t.pct) && !w) {
        return `<li class="sc-trow" data-tone="${tone}">${label}<span class="sc-trec num">${n}</span><span class="sc-tpct num">\u2013</span><span class="sc-tbar none" aria-hidden="true"></span></li>`;
      }
      const pct = isNum(t.pct) ? t.pct : w + l ? w / (w + l) : null;
      // A share of games rather than a W-L record: .500 means nothing here, so no centered bar.
      if (SHARE_TRENDS.has(t.id)) {
        return `<li class="sc-trow" data-tone="${tone}">${label}<span class="sc-trec num">${w} of ${n}</span><span class="sc-tpct num">${pct === null ? "\u2013" : `${Math.round(pct * 100)}%`}</span><span class="sc-tbar share" aria-hidden="true"><i style="--d:${(pct || 0).toFixed(3)}"></i></span></li>`;
      }
      const d = pct === null ? 0 : Math.max(-1, Math.min(1, (pct - 0.5) / BAR_HALF));
      const dir = d > 0.001 ? "up" : d < -0.001 ? "dn" : "";
      return `<li class="sc-trow" data-tone="${tone}">${label}
        <span class="sc-trec num">${w}${DASH}${l}${p ? `${DASH}${p}` : ""}</span>
        <span class="sc-tpct num">${pct === null ? "\u2013" : `${Math.round(pct * 100)}%`}</span>
        <span class="sc-tbar ${dir}" aria-hidden="true"><i style="--d:${Math.abs(d).toFixed(3)}"></i></span>
      </li>`;
    }).join("");
    if (!items) return "";
    return `<div class="sc-x" data-sk="tr-${key}"><ul class="sc-trows" aria-label="${key === "house" ? "House splits" : "Market trends"}">
      <li class="sc-trow sc-trow-h" aria-hidden="true"><span></span><span>W${DASH}L${DASH}P</span><span>Pct</span><span class="sc-tbar-h">.500</span></li>
      ${items}
    </ul></div>`;
  }

  // ---------- shared bits ----------

  function sectionHTML(key, title, aux, inner) {
    const id = `${uid}-${key}`;
    return `<div class="sc-sec-h"><h2 class="sc-h2" id="${id}">${esc(title)}</h2>${aux ? `<span class="sc-aux">${aux}</span>` : ""}</div>${inner}`;
  }

  function skeletonSection(title, rows) {
    return `<div class="sc-sec-h"><h2 class="sc-h2">${esc(title)}</h2></div>${skeletonRows(rows)}`;
  }

  function safe(key, fn) {
    try {
      return fn() || "";
    } catch (err) {
      console.error(`[scout] ${key} failed`, err);
      return `<div class="card sc-empty-card"><p>Couldn\u2019t crunch this part of the report.</p></div>`;
    }
  }

  return {
    update(next = {}) {
      if (destroyed) return;
      if ("parlays" in next) allParlays = Array.isArray(next.parlays) ? next.parlays.filter(Boolean) : [];
      if ("currentParlay" in next) {
        const prevId = cur?.id ?? null;
        cur = next.currentParlay || null;
        // The header's week picker moved to another ticket: follow it. Otherwise keep this tab's week.
        if (cur && cur.id !== prevId) {
          const w = weekOfParlay(cur);
          if (w && (w.week !== st.week || st.seasonType !== 2 || (w.year && w.year !== st.year))) {
            st.ui.moreSlate = false;
            loadWeek({ week: w.week, seasonType: 2, year: w.year || st.year });
            return;
          }
        }
      }
      if (st.games) loadPreds(seq); // a new ticket may ride games we haven't projected yet
      paintSoon();
    },
    destroy() {
      destroyed = true;
      seq++;
      clearTimeout(timer);
      clearTimeout(paintTimer);
      timer = null;
      paintTimer = null;
      root.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVisibility);
      root.innerHTML = "";
      root.classList.remove("scout");
      root.removeAttribute("aria-label");
    },
  };
}

// ---------- pure helpers ----------

// Keyed section diff (same approach as detail.js): reuse each section element and only rewrite
// the ones whose HTML changed, so a refresh or a predictor landing doesn't flash the whole tab.
function reconcile(parent, sections, painted) {
  const old = new Map();
  for (const el of parent.children) old.set(el.getAttribute("data-sec"), el);
  let prev = null;
  for (const [key, html] of sections) {
    let el = old.get(key);
    if (el) {
      old.delete(key);
    } else {
      el = document.createElement("section");
      el.className = `sc-sec sc-sec-${key}`;
      el.setAttribute("data-sec", key);
    }
    if (painted.get(el) !== html) {
      el.innerHTML = html;
      painted.set(el, html);
      const h = el.querySelector(".sc-h2[id], .sc-awards-title");
      if (h && h.id) el.setAttribute("aria-labelledby", h.id);
      else el.removeAttribute("aria-labelledby");
    }
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (el !== want) parent.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}

function weekOfParlay(p) {
  if (!p || !p.id) return null;
  const id = String(p.id);
  const m = /-w(\d+)/i.exec(id);
  if (!m) return null;
  const week = Number(m[1]);
  if (!(week >= WEEK_MIN && week <= WEEK_MAX)) return null;
  const y = /^(\d{4})-/.exec(id);
  return { week, year: y ? Number(y[1]) : null };
}

function slateKey(year, type, week) {
  return `${year}:${type ?? 2}:${week}`;
}

function weekName(st) {
  if (st.seasonType === 3) return "Bowl season";
  if (st.seasonType === 1) return "Preseason";
  return st.week ? `Week ${st.week}` : "This week";
}

function dateRange(games) {
  const ms = games.map((g) => Date.parse(g.date)).filter(Number.isFinite);
  if (!ms.length) return "";
  const a = new Date(Math.min(...ms));
  const b = new Date(Math.max(...ms));
  const mon = (d) => d.toLocaleDateString([], { month: "short" });
  if (a.toDateString() === b.toDateString()) return `${mon(a)} ${a.getDate()}`;
  if (a.getMonth() === b.getMonth()) return `${mon(a)} ${a.getDate()}${DASH}${b.getDate()}`;
  return `${mon(a)} ${a.getDate()} ${DASH} ${mon(b)} ${b.getDate()}`;
}

function clockTime(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function matchup(g) {
  const a = g.away.abbr || g.away.short;
  const h = g.home.abbr || g.home.short;
  return `${a} ${g.neutral ? "vs" : "@"} ${h}`;
}

function whenText(g) {
  if (g.state === "pre") return g.date ? kickoffText(g.date) : "TBD";
  if (g.state === "in") return g.detail || "Live";
  return g.completed ? "Final" : g.detail || "Final";
}

function scoreLine(g) {
  if (g.state === "pre") return g.date ? kickoffText(g.date) : "";
  const a = `${g.away.abbr || g.away.short} ${g.away.score ?? 0}`;
  const h = `${g.home.abbr || g.home.short} ${g.home.score ?? 0}`;
  return `${a}, ${h}${g.state === "in" ? ` (${g.detail || "live"})` : ""}`;
}

function kickMs(leg, byId) {
  const g = byId.get(String(leg.e));
  const ms = Date.parse(g?.date || leg.k || "");
  return Number.isFinite(ms) ? ms : Infinity;
}

function quip(kind, item, grade, final) {
  if (!final) return "";
  const m = isNum(item.margin) ? item.margin : grade.margin;
  if (!isNum(m)) return "";
  if (kind === "best") return m >= 14 ? "Never in doubt." : m >= 7 ? "Comfortable." : "Got there.";
  if (kind === "worst") return m <= -14 ? "Not close. Not even a little." : m <= -7 ? "Never really had a chance." : "So close, still a bozo.";
  if (grade.tone === "push") return "Money back, dignity intact.";
  if (Math.abs(m) <= 1) return m > 0 ? "Survived by a hook." : "Lost by a hook. Brutal.";
  return m > 0 ? "Sweated that one out." : "Coulda been.";
}

function ouBadge(leg) {
  return `<span class="sc-ou" aria-hidden="true">${leg.s === "o" ? "O" : "U"}</span>`;
}

function cell(value, label, tone) {
  return `<span class="sc-cell"${tone ? ` data-tone="${tone}"` : ""}><span class="sc-cell-v num">${esc(value)}</span><span class="sc-cell-l">${esc(label)}</span></span>`;
}

function reasonChip(r) {
  if (!r || !r.text) return "";
  const tone = REASON_TONE[r.tone] || "neutral";
  return `<span class="sc-why" data-tone="${tone}">${esc(r.text)}</span>`;
}

function toneOf(v, dead = 0) {
  if (!isNum(v)) return "";
  return v > dead ? "good" : v < -dead ? "bad" : "";
}

// FPI's projected margin for the picked team, read as a line: "BAY by 4.9" / "KU by 2.1".
function fpiText(margin, game, teamId) {
  const mine = teamById(game, teamId);
  const opp = mine && mine === game.home ? game.away : game.home;
  const v = Math.round(Math.abs(margin) * 10) / 10;
  if (v === 0) return "Dead even";
  const who = margin > 0 ? mine : opp;
  return `${who?.abbr || who?.short || ""} by ${v.toFixed(1)}`;
}

function moveText(mv, signed) {
  if (!mv) return "";
  const { open, now, delta } = mv;
  if (isNum(open) && isNum(now)) {
    if (!delta && open === now) return `${fmtLine(now, signed) || "PK"}, no move`;
    return `${fmtLine(open, signed)} ${ARROW} ${fmtLine(now, signed)}`;
  }
  if (isNum(now)) return `${fmtLine(now, signed)} now`;
  return "";
}

function fmtSigned(v) {
  if (!isNum(v)) return "\u2014";
  const r = Math.round(v * 10) / 10;
  if (r === 0) return "0.0";
  return `${r > 0 ? "+" : MINUS}${Math.abs(r).toFixed(1)}`;
}

function fmtPctPts(v) {
  if (!isNum(v)) return "\u2014";
  const r = Math.round(v * 100);
  if (r === 0) return "0%";
  return `${r > 0 ? "+" : MINUS}${Math.abs(r)}%`;
}

function wlp(r) {
  return `${r.w || 0}${DASH}${r.l || 0}${r.p ? `${DASH}${r.p}` : ""}`;
}

function trendById(trends, id) {
  const t = (trends || []).find((x) => x && x.id === id);
  return t ? { ...t, w: t.w || 0, l: t.l || 0, p: t.p || 0 } : null;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function safeCall(fn, fallback) {
  try { return fn() ?? fallback; } catch (err) { console.error("[scout]", err); return fallback; }
}

function skeletonRows(n, board = false) {
  const row = `<li class="sc-skel-row${board ? " board" : ""}"><span class="sc-skel-dot"></span><span class="sc-skel-lines"><span class="sc-skel-line" style="--w:55%"></span><span class="sc-skel-line sm" style="--w:80%"></span></span></li>`;
  return `<ul class="card sc-skel" aria-busy="true" aria-label="Loading">${row.repeat(n)}</ul>`;
}

function skeletonLines(n) {
  const widths = [72, 58, 84, 64, 76, 52];
  return `<div class="sc-skel-block" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => `<span class="sc-skel-line" style="--w:${widths[i % widths.length]}%"></span>`).join("")}</div>`;
}

function cssEscape(s) {
  const str = String(s ?? "");
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(str) : str.replace(/["\\]/g, "\\$&");
}

// ---------- odds + season helpers ----------

const ODDS_FIELDS = [
  ["spread", "sp"], ["spreadOpen", "spo"], ["overUnder", "tot"], ["totalOpen", "toto"], ["homeML", "hml"], ["awayML", "aml"],
];
const ODDS_EXTRA = ["homeSpreadOdds", "awaySpreadOdds", "overOdds", "underOdds"];

function hasLine(o) {
  return !!o && (isNum(o.spread) || isNum(o.overUnder) || isNum(o.homeML));
}

function fillOdds(g, sg, seasonProvider) {
  const base = g.odds || null;
  if (hasLine(base)) rememberOdds(g.id, base);
  const memo = base && hasLine(base) ? null : recallOdds(g.id);
  const needs = !base || ODDS_FIELDS.some(([k]) => !isNum(base[k]));
  if (!needs || (!sg && !memo)) return g;
  const odds = {
    provider: base?.provider || memo?.provider || (sg ? seasonProvider || null : null),
    details: base?.details || memo?.details || null,
    homeId: g.home.id,
    awayId: g.away.id,
  };
  const fromSeason = sg ? seasonOdds(sg) : null;
  for (const [k] of ODDS_FIELDS) odds[k] = firstNum(base?.[k], fromSeason?.[k], memo?.[k]);
  for (const k of ODDS_EXTRA) odds[k] = firstNum(base?.[k], memo?.[k]);
  return hasLine(odds) || isNum(odds.spreadOpen) || isNum(odds.totalOpen) ? { ...g, odds } : g;
}

// Season-file line fields -> odds fields. A moneyline at -5000 or worse isn't a real market: drop both sides.
function seasonOdds(sg) {
  const o = {};
  for (const [k, sk] of ODDS_FIELDS) o[k] = isNum(sg[sk]) ? sg[sk] : null;
  if ((isNum(o.homeML) && o.homeML <= -5000) || (isNum(o.awayML) && o.awayML <= -5000)) { o.homeML = null; o.awayML = null; }
  return o;
}

function firstNum(...vals) {
  for (const v of vals) if (isNum(v)) return v;
  return null;
}

function rememberOdds(id, odds) {
  const prev = oddsMemo.get(id);
  if (prev && prev.spread === odds.spread && prev.overUnder === odds.overUnder && prev.homeML === odds.homeML) return;
  oddsMemo.set(id, odds);
  try { sessionStorage.setItem(ODDS_KEY + id, JSON.stringify(odds)); } catch { /* storage off: memory only */ }
}

function recallOdds(id) {
  if (oddsMemo.has(id)) return oddsMemo.get(id);
  try {
    const raw = sessionStorage.getItem(ODDS_KEY + id);
    if (raw) { const o = JSON.parse(raw); oddsMemo.set(id, o); return o; }
  } catch { /* fine */ }
  return null;
}

// Season file -> lookups. games(id) returns a game in the normalized shape for houseTrends.
function indexSeason(season) {
  let idx = seasonIdx.get(season);
  if (idx) return idx;
  const byId = new Map();
  for (const sg of season.games || []) if (sg && sg.id != null) byId.set(String(sg.id), sg);
  const teams = season.teams || {};
  const made = new Map();
  const team = (id, score) => {
    const t = teams[id] || {};
    const abbr = t.abbr || "";
    const logo = `https://a.espncdn.com/i/teamlogos/ncaa/500/${id}.png`;
    return {
      id: String(id), abbr, short: t.short || abbr, name: t.short || abbr, location: t.short || "", mascot: "",
      logo, logoDark: logo.replace("/500/", "/500-dark/"), color: null, altColor: null,
      score: isNum(score) ? score : null, rank: null, record: null, linescores: [], winner: false,
    };
  };
  idx = {
    byId,
    games(id) {
      if (made.has(id)) return made.get(id);
      const sg = byId.get(id);
      if (!sg) return null;
      const home = team(sg.h, sg.hs);
      const away = team(sg.a, sg.as);
      if (isNum(home.score) && isNum(away.score)) { home.winner = home.score > away.score; away.winner = away.score > home.score; }
      const odds = { provider: season.provider || null, details: null, homeId: home.id, awayId: away.id, ...seasonOdds(sg) };
      const g = {
        id: String(sg.id), date: sg.date, name: "", shortName: `${away.abbr} @ ${home.abbr}`,
        state: "post", completed: true, statusName: "STATUS_FINAL", detail: "Final", longDetail: "Final",
        period: 4, clock: null, clockSeconds: null,
        home, away, neutral: !!sg.neutral, odds, broadcast: null, venue: null, situation: null, weather: null,
        week: sg.wk ?? null,
      };
      made.set(id, g);
      return g;
    },
  };
  seasonIdx.set(season, idx);
  return idx;
}

// ---------- FPI cache ----------

const TIMED_OUT = Symbol("timeout");

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]);
}

// undefined = not cached (or expired); null = ESPN has no projection; object = projection.
function readFpi(id) {
  let rec = fpiMem.get(id);
  if (!rec) {
    try {
      const raw = sessionStorage.getItem(FPI_KEY + id);
      if (raw) { rec = JSON.parse(raw); fpiMem.set(id, rec); }
    } catch { /* storage off */ }
  }
  if (!rec || typeof rec !== "object") return undefined;
  if (rec.fin && rec.v) return rec.v;
  const ttl = rec.v ? FPI_TTL_MS : FPI_NULL_TTL_MS;
  return Date.now() - (rec.at || 0) < ttl ? rec.v ?? null : undefined;
}

function writeFpi(id, v, final) {
  const rec = { v: v || null, at: Date.now(), fin: !!(final && v) };
  fpiMem.set(id, rec);
  try { sessionStorage.setItem(FPI_KEY + id, JSON.stringify(rec)); } catch { /* storage off: memory only */ }
}
