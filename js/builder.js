// Parlay builder: a search-first slate picker plus a bet slip, mounted into the app's .sheet overlay.
//
//   mountBuilder(root, { initial, onSave, onCancel }) -> { destroy() }
//   searchGames(games, query) -> the matching games, best match first
//                                (empty query: every game, sorted by kickoff)
//
// Leg shape is documented at the top of grade.js. Styles live in css/builder.css.

import { fetchWeekSlate, logoHTML, escapeHTML as esc, kickoffText, etDateKey } from "./espn.js";
import { legLabel, fmtLine, fmtOdds, parlayPrice, americanToDecimal, decimalToAmerican } from "./grade.js";

/* ================================ search ================================ */

// Lowercase, no accents, no punctuation. "&" and apostrophes vanish so "Texas A&M" -> "texas am",
// "a & m" -> "am", "Hawai'i" -> "hawaii", "San José St" -> "san jose st", "Miami (OH)" -> "miami oh".
function norm(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*&\s*/g, "")
    .replace(/['‘’ʻ`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Nicknames people actually type. ids are ESPN team ids; names are normalized fields
// (short / location / displayName) that also count, in case an id ever changes.
const ALIAS_TABLE = [
  { keys: ["bama"], ids: ["333"], names: ["alabama"] },
  { keys: ["ole miss", "olemiss"], ids: ["145"], names: ["ole miss", "mississippi"] },
  { keys: ["unt"], ids: ["249"], names: ["north texas"] },
  { keys: ["unm"], ids: ["167"], names: ["new mexico"] },
  { keys: ["uh"], ids: ["248"], names: ["houston"] },
  { keys: ["osu"], ids: ["194", "197"], names: ["ohio state", "oklahoma state"] },
  { keys: ["tamu", "a&m", "texas a&m"], ids: ["245"], names: ["texas am"] },
  { keys: ["pitt"], ids: ["221"], names: ["pittsburgh", "pitt"] },
  { keys: ["ucf"], ids: ["2116"], names: ["ucf", "central florida"] },
  { keys: ["smu"], ids: ["2567"], names: ["smu", "southern methodist"] },
  { keys: ["tcu"], ids: ["2628"], names: ["tcu", "texas christian"] },
  { keys: ["lsu"], ids: ["99"], names: ["lsu", "louisiana state"] },
  { keys: ["usc"], ids: ["30"], names: ["usc", "southern california"] },
  { keys: ["uga"], ids: ["61"], names: ["georgia"] },
  { keys: ["fsu"], ids: ["52"], names: ["florida state"] },
  { keys: ["wazzu"], ids: ["265"], names: ["washington state"] },
  { keys: ["kstate", "k state"], ids: ["2306"], names: ["kansas state"] },
];
const ALIASES = new Map();
for (const a of ALIAS_TABLE) for (const k of a.keys) ALIASES.set(norm(k), a);

const TEAM_IX = new WeakMap();
function teamIndex(t) {
  const team = t || {};
  let ix = TEAM_IX.get(team);
  if (ix) return ix;
  const short = norm(team.short), loc = norm(team.location), name = norm(team.name), mascot = norm(team.mascot);
  const abbr = norm(team.abbr).replace(/ /g, "");
  const tokens = [...new Set(`${short} ${loc} ${name} ${mascot}`.split(" ").filter(Boolean))];
  ix = { id: String(team.id ?? ""), short, loc, name, mascot, abbr, tokens };
  TEAM_IX.set(team, ix);
  return ix;
}

// Optimal-string-alignment Damerau-Levenshtein, bailing out once the distance must exceed max.
function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

// Typo-tolerant "starts with": compare w against f's prefixes of length |w|-1 .. |w|+1.
function prefixDistance(w, f, max) {
  let best = max + 1;
  for (let len = w.length - 1; len <= w.length + 1; len++) {
    if (len < 1 || len >= f.length) continue;
    best = Math.min(best, editDistance(w, f.slice(0, len), max));
  }
  return best;
}

// Edits allowed for a typed word: none under 4 letters, 1 for 4-6, 2 for 7+.
const typoBudget = (w) => (w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0);

// One typed word against one team. tier 3 = exact/prefix on short name, abbreviation or school;
// tier 2 = a whole word or word-prefix anywhere in the name; tier 1 = typo match.
function matchWord(w, ix) {
  if (w === ix.short || w === ix.abbr || w === ix.loc) return { score: 100, tier: 3 };
  let best = 0;
  for (const f of [ix.short, ix.loc, ix.abbr]) {
    if (f && f.startsWith(w)) best = Math.max(best, 90 - Math.min(10, f.length - w.length));
  }
  if (best) return { score: best, tier: 3 };

  if (w === ix.mascot) return { score: 72, tier: 2 };
  for (const t of ix.tokens) {
    if (t === w) best = Math.max(best, 70);
    else if (t.startsWith(w)) best = Math.max(best, 60 - Math.min(10, t.length - w.length) / 2);
  }
  if (best) return { score: best, tier: 2 };

  // Typos: people rarely miss the first letter, and requiring it keeps "houston" off Boston
  // College and "kstate" off every "State".
  const max = typoBudget(w);
  if (!max) return null;
  let fuzzy = -1;
  for (const f of [ix.short, ix.loc]) {
    if (!f || f[0] !== w[0]) continue;
    const d = editDistance(w, f, max);
    if (d <= max) fuzzy = Math.max(fuzzy, 45 - 10 * d);
    if (w.length >= 5) {
      const p = prefixDistance(w, f, max);
      if (p <= max) fuzzy = Math.max(fuzzy, 40 - 10 * p);
    }
  }
  for (const t of ix.tokens) {
    if (t[0] !== w[0]) continue;
    const d = editDistance(w, t, max);
    if (d <= max) fuzzy = Math.max(fuzzy, 35 - 10 * d);
    if (w.length >= 5) {
      const p = prefixDistance(w, t, max);
      if (p <= max) fuzzy = Math.max(fuzzy, 30 - 10 * p);
    }
  }
  return fuzzy >= 0 ? { score: fuzzy, tier: 1 } : null;
}

const better = (a, b) => !!a && (!b || a.tier > b.tier || (a.tier === b.tier && a.score > b.score));

// A term is one typed word, or a multi-word alias like "ole miss".
function matchTerm(term, ix) {
  let best = null;
  const a = term.alias;
  if (a && (a.ids.includes(ix.id) || a.names.includes(ix.short) || a.names.includes(ix.loc) || a.names.includes(ix.name))) {
    best = { score: 95, tier: 3 };
  }
  let total = 0, tier = 3;
  for (const w of term.words) {
    const m = matchWord(w, ix);
    if (!m) return best;
    total += m.score;
    tier = Math.min(tier, m.tier);
  }
  const text = { score: total / term.words.length, tier };
  return better(text, best) ? text : best;
}

function parseQuery(query) {
  const qn = norm(query);
  if (!qn) return null;
  const words = qn.split(" ");
  const terms = [];
  for (let i = 0; i < words.length;) {
    let hit = null;
    for (let len = Math.min(3, words.length - i); len >= 1 && !hit; len--) {
      const key = words.slice(i, i + len).join(" ");
      const alias = ALIASES.get(key);
      if (alias) hit = { words: words.slice(i, i + len), alias };
    }
    if (!hit) hit = { words: [words[i]], alias: null };
    terms.push(hit);
    i += hit.words.length;
  }
  return { qn, compact: qn.replace(/ /g, ""), terms, multi: words.length > 1 };
}

function scoreGame(g, Q) {
  const A = teamIndex(g.away), H = teamIndex(g.home);
  let score = 0, tier = 3, allA = true, allH = true;
  for (const term of Q.terms) {
    const a = matchTerm(term, A), h = matchTerm(term, H);
    if (!a && !h) return null; // every word has to land on one of the two teams
    allA = allA && !!a;
    allH = allH && !!h;
    const best = better(h, a) ? h : a;
    score += best.score;
    tier = Math.min(tier, best.tier);
  }
  if (Q.terms.length > 1 && (allA || allH)) score += 15; // all words describe the same team
  if (Q.multi) {
    // The whole phrase against one team: "new mexico" is New Mexico exactly, New Mexico St by prefix.
    let phrase = 0;
    for (const ix of [A, H]) {
      if ([ix.short, ix.loc, ix.name].includes(Q.qn) || Q.compact === ix.abbr) phrase = Math.max(phrase, 60);
      else if (ix.short.startsWith(Q.qn) || ix.loc.startsWith(Q.qn) || ix.name.startsWith(Q.qn)) phrase = Math.max(phrase, 40);
    }
    if (phrase) { score += phrase; tier = 3; }
  }
  return { score, tier };
}

const kickMs = (g) => Date.parse(g?.date) || 0;
const byKickoff = (a, b) => kickMs(a) - kickMs(b);

// Ranked search over a slate. Every word must match the away or home team (school, short name,
// mascot, abbreviation, a few nicknames; prefixes and small typos are fine). Order: exact/prefix
// on short name or abbreviation, then other matches, then typo matches; ties go to games that
// are not final yet, then to the earlier kickoff.
export function searchGames(games, query) {
  const list = Array.isArray(games) ? games.filter(Boolean) : [];
  const Q = parseQuery(query);
  if (!Q) return [...list].sort(byKickoff);
  const hits = [];
  for (const g of list) {
    const r = scoreGame(g, Q);
    if (r) hits.push({ g, score: r.score, tier: r.tier });
  }
  hits.sort((x, y) =>
    y.tier - x.tier ||
    y.score - x.score ||
    (x.g.state === "post") - (y.g.state === "post") ||
    kickMs(x.g) - kickMs(y.g));
  return hits.map((h) => h.g);
}

/* ============================ leg helpers ============================ */

// Line typed by a person: "-3.5", "+7", "3,5", "−2.5" (unicode minus), "PK". null = empty, NaN = junk.
function parseLine(str) {
  let s = String(str ?? "").trim().toLowerCase().replace(/[−–—]/g, "-").replace(/\s+/g, "");
  if (!s) return null;
  if (/^(pk|pick|pickem|pick'em|ev|even)$/.test(s)) return 0;
  if (!s.includes(".")) s = s.replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  const n = Math.round(Number(s) * 10) / 10;
  return Number.isFinite(n) ? (n === 0 ? 0 : n) : NaN;
}

// American odds: "+150", "150" (= +150), "-110", "EVEN". null = empty, NaN = junk.
function parseOdds(str) {
  const s = String(str ?? "").trim().toLowerCase().replace(/[−–—]/g, "-").replace(/\s+/g, "");
  if (!s) return null;
  if (s === "ev" || s === "even" || s === "evs") return 100;
  if (!/^[+-]?\d+$/.test(s)) return NaN;
  const n = Number(s);
  return Math.abs(n) >= 100 && americanToDecimal(n) ? n : NaN;
}

// Dollars: "$25", "1,250.50". null when blank or not a sane amount.
function parseMoney(str) {
  const s = String(str ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

const fmtMoney = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

// ASCII versions for input values (the slip itself uses fmtLine/fmtOdds with a real minus sign).
function lineInput(v, signed) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  const t = String(Math.round(Math.abs(v) * 10) / 10);
  if (!signed) return t;
  if (v === 0) return "PK";
  return (v > 0 ? "+" : "-") + t;
}
const oddsInput = (o) => (o === null || o === undefined ? "" : o > 0 ? `+${o}` : String(o));

// Spread from the home team's side. Falls back to parsing "KU -1.5" when ESPN leaves spread blank.
function homeSpread(g) {
  const o = g?.odds;
  if (!o) return null;
  if (o.spread !== null && o.spread !== undefined) return o.spread;
  const d = String(o.details || "").trim();
  if (/^(even|pk|pick)/i.test(d)) return 0;
  const m = /^(.+?)\s+([+-]?\d+(?:\.\d+)?)$/.exec(d);
  if (!m) return null;
  const who = m[1].toUpperCase(), v = Number(m[2]);
  if (who === String(g.home.abbr).toUpperCase()) return v;
  if (who === String(g.away.abbr).toUpperCase()) return v === 0 ? 0 : -v;
  return null;
}
function spreadFor(g, teamId) {
  const h = homeSpread(g);
  if (h === null) return null;
  if (String(teamId) === g.home.id) return h;
  return h === 0 ? 0 : -h;
}
function mlFor(g, teamId) {
  const o = g?.odds;
  if (!o) return null;
  const v = String(teamId) === g.home.id ? o.homeML : o.awayML;
  return v === undefined ? null : v;
}

function cleanLeg(x) {
  const t = x?.t === "ml" || x?.t === "total" ? x.t : "spread";
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const l = t === "ml" ? null : num(x.l);
  return {
    e: String(x?.e ?? ""),
    t,
    s: String(x?.s ?? ""),
    l: l === 0 ? 0 : l,
    o: num(x?.o) || null,
    n: t === "total" ? null : (x?.n ?? null),
    g: String(x?.g ?? ""),
    k: x?.k ?? null,
  };
}

const sameLeg = (a, b) =>
  String(a.e) === String(b.e) && a.t === b.t && String(a.s) === String(b.s) && (a.l ?? null) === (b.l ?? null);

function ymd(iso) {
  const k = etDateKey(iso);
  return `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
}

function rand4() {
  const out = [];
  const bytes = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(4)) : null;
  for (let i = 0; i < 4; i++) out.push(((bytes ? bytes[i] : Math.floor(Math.random() * 256)) % 36).toString(36));
  return out.join("");
}

const localDayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(iso) {
  const label = new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  return localDayKey(iso) === localDayKey(Date.now()) ? `Today · ${label}` : label;
}
const shortDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const shortDay = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

const SEARCH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15.5 15.5 21 21" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

/* ================================ mount ================================ */

export function mountBuilder(root, { initial = null, onSave, onCancel } = {}) {
  const uid = `bld${Math.random().toString(36).slice(2, 7)}`;
  const ac = new AbortController();
  const on = (el, type, fn, opts) => el.addEventListener(type, fn, { ...(opts || {}), signal: ac.signal });
  const wide = window.matchMedia("(min-width: 900px)");
  let dead = false, reqToken = 0, selectOnFocus = false;

  const st = {
    week: null, seasonType: 2, year: null,
    slate: null, loading: true, error: null, lastReq: {},
    query: "",
    openId: null,
    ed: null, // open leg editor: { t, s, line, odds, err }
    legs: (Array.isArray(initial?.legs) ? initial.legs : []).map(cleanLeg),
    slipOpen: false,
    dirty: false,
  };
  const gamesById = new Map();   // every game from every week loaded in this session
  const weekOfEvent = new Map(); // event id -> { week, year } for the parlay id / default name
  const cache = new Map();       // "year:type:week" -> { slate, at }
  const openDays = new Set();    // all-final day groups the user expanded

  const idMatch = /^(\d{4})-w(\d+)-/.exec(String(initial?.id || ""));
  if (idMatch) for (const l of st.legs) weekOfEvent.set(l.e, { week: +idMatch[2], year: +idMatch[1] });

  const v = (x) => esc(x ?? "");
  root.innerHTML = `
    <div class="sheet-bar">
      <div class="wrap">
        <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
        <h2 class="sheet-title" id="${uid}-title" style="margin:0">Build the parlay</h2>
        <button type="button" class="btn gold" data-act="save" data-save disabled>Save</button>
      </div>
    </div>
    <div class="sheet-body builder">
      <div class="wrap">
        <div class="b-main">
          <div class="b-search" role="search">
            <div class="b-searchbox">
              ${SEARCH_ICON}
              <input class="b-q" type="search" data-field="q" enterkeyhint="search" autocomplete="off" autocorrect="off"
                autocapitalize="off" spellcheck="false" aria-label="Search for a team"
                placeholder="Search a team: Baylor, BYU, TCU…">
              <button type="button" class="b-clear" data-act="clear" aria-label="Clear search" hidden>×</button>
            </div>
          </div>
          <div class="b-weekbar">
            <button type="button" class="b-wk-btn" data-act="week" data-d="-1" aria-label="Previous week">‹</button>
            <div class="b-wk-label" aria-live="polite">
              <span class="b-wk-name" data-wk-name>This week</span>
              <span class="b-wk-sub" data-wk-sub>Loading…</span>
            </div>
            <button type="button" class="b-wk-btn" data-act="week" data-d="1" aria-label="Next week">›</button>
          </div>
          <p class="b-count" data-count aria-live="polite"></p>
          <div class="b-results" data-results></div>
        </div>
        <div class="b-scrim" data-act="slip" hidden></div>
        <aside class="b-slip" data-slip aria-labelledby="${uid}-slip">
          <button type="button" class="b-slip-bar" data-act="slip" aria-expanded="false" aria-controls="${uid}-panel">
            <span class="b-slip-in">
              <span class="b-slip-l">
                <span class="b-slip-k">Bet slip</span>
                <span class="b-slip-sum" data-sum>Empty</span>
              </span>
              <span class="b-pips" data-pips aria-hidden="true"></span>
              <span class="b-slip-price num" data-price></span>
              <span class="b-chev" aria-hidden="true"></span>
            </span>
          </button>
          <div class="b-slip-panel" id="${uid}-panel">
            <div class="b-slip-inner">
              <div class="b-slip-head">
                <h2 class="b-slip-title" id="${uid}-slip">Bet slip</h2>
                <span class="b-pips" data-pips aria-hidden="true"></span>
                <span class="b-slip-price num" data-price></span>
              </div>
              <ol class="b-legs" data-legs></ol>
              <p class="b-hint" data-hint hidden></p>
              <div class="b-fields">
                <label class="b-fld">
                  <span class="eyebrow">Name</span>
                  <input class="b-text" data-field="name" type="text" autocomplete="off" maxlength="60" value="${v(initial?.name)}">
                </label>
                <div class="b-money">
                  <label class="b-fld">
                    <span class="eyebrow">Stake</span>
                    <span class="b-dollar"><input class="b-text num" data-field="stake" type="text" inputmode="decimal" autocomplete="off" placeholder="optional" value="${v(initial?.stake)}"></span>
                  </label>
                  <label class="b-fld">
                    <span class="eyebrow">Payout</span>
                    <span class="b-dollar"><input class="b-text num" data-field="payout" type="text" inputmode="decimal" autocomplete="off" placeholder="optional" value="${v(initial?.payout)}"></span>
                  </label>
                </div>
                <p class="b-est" data-est></p>
              </div>
              <button type="button" class="btn gold b-save" data-act="save" data-save disabled>Save parlay</button>
            </div>
          </div>
        </aside>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const bar = $(".sheet-bar");
  const body = $(".builder");
  const qInput = $(".b-q");
  const clearBtn = $(".b-clear");
  const countEl = $("[data-count]");
  const resultsEl = $("[data-results]");
  const slipEl = $("[data-slip]");
  const slipBar = $(".b-slip-bar");
  const scrim = $(".b-scrim");
  const nameIn = $('[data-field="name"]');
  const stakeIn = $('[data-field="stake"]');
  const payoutIn = $('[data-field="payout"]');

  let setLabel = false;
  if (!root.hasAttribute("aria-label") && !root.hasAttribute("aria-labelledby")) {
    root.setAttribute("aria-labelledby", `${uid}-title`);
    setLabel = true;
  }

  // The search bar sticks right under the sheet bar, whatever height the bar ends up.
  const setBarH = () => body.style.setProperty("--b-bar-h", `${bar.offsetHeight}px`);
  setBarH();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(setBarH) : null;
  ro?.observe(bar);

  /* ---------------- week loading ---------------- */

  function weekLabel() {
    if (st.seasonType === 3) return "Bowls";
    if (st.seasonType === 1) return "Preseason";
    return st.week ? `Week ${st.week}` : "This week";
  }

  function renderWeek() {
    const canPrev = st.week != null && (st.seasonType === 3 || (st.seasonType === 2 && st.week > 1));
    const canNext = st.week != null && (st.seasonType === 1 || (st.seasonType === 2 && st.week < 16));
    const [prev, next] = $$(".b-wk-btn");
    prev.disabled = !canPrev;
    next.disabled = !canNext;
    $("[data-wk-name]").textContent = weekLabel();
    let sub = "Loading…";
    if (st.error) sub = "Couldn't load";
    else if (!st.loading && st.slate) {
      const gs = [...st.slate.games].sort(byKickoff);
      const n = gs.length;
      if (!n) sub = "No games";
      else {
        const a = shortDate(gs[0].date), b = shortDate(gs[n - 1].date);
        sub = `${a === b ? a : `${a} – ${b}`} · ${n} ${n === 1 ? "game" : "games"}`;
      }
    }
    $("[data-wk-sub]").textContent = sub;
  }

  function stepWeek(d) {
    let { week, seasonType } = st;
    if (week == null) return;
    if (seasonType === 3) { if (d > 0) return; week = 16; seasonType = 2; }
    else if (seasonType === 1) { if (d < 0) return; week = 1; seasonType = 2; }
    else { week += d; if (week < 1 || week > 16) return; }
    loadWeek({ week, seasonType, year: st.year ?? undefined });
  }

  async function loadWeek(req, { fallback = false } = {}) {
    const token = ++reqToken;
    st.lastReq = req;
    if (req.week) { st.week = req.week; st.seasonType = req.seasonType ?? 2; }
    if (req.year) st.year = req.year;
    const key = req.week && req.year ? `${req.year}:${req.seasonType ?? 2}:${req.week}` : null;
    const hit = key && cache.get(key);
    if (hit && Date.now() - hit.at < 120000) { applySlate(hit.slate); return; }

    st.loading = true;
    st.error = null;
    closeEditor();
    renderWeek();
    renderResults();
    try {
      const slate = await fetchWeekSlate(req);
      if (dead || token !== reqToken) return;
      cache.set(`${slate.year}:${slate.seasonType}:${slate.week}`, { slate, at: Date.now() });
      // Editing an old slip whose week guess was wrong: fall back to the current week once.
      if (fallback && st.legs.length && !slate.games.some((g) => st.legs.some((l) => l.e === g.id))) {
        loadWeek({});
        return;
      }
      applySlate(slate);
    } catch (err) {
      if (dead || token !== reqToken) return;
      st.loading = false;
      st.error = (err && err.message) || "Network error";
      renderWeek();
      renderResults();
    }
  }

  function applySlate(slate) {
    st.slate = slate;
    st.loading = false;
    st.error = null;
    st.week = slate.week ?? st.week;
    st.seasonType = slate.seasonType ?? st.seasonType;
    st.year = slate.year ?? st.year;
    for (const g of slate.games) {
      gamesById.set(g.id, g);
      if (!weekOfEvent.has(g.id)) weekOfEvent.set(g.id, { week: slate.week, year: slate.year });
    }
    if (st.openId && !slate.games.some((g) => g.id === st.openId)) { st.openId = null; st.ed = null; }
    renderWeek();
    renderResults();
    renderSlip();
  }

  /* ---------------- results ---------------- */

  const gameEl = (id) => (id ? root.querySelector(`.b-game[data-id="${CSS.escape(String(id))}"]`) : null);
  const legsOn = (id) => st.legs.filter((l) => l.e === id).length;

  function lineSummary(g) {
    const o = g.odds;
    if (!o) return "";
    const parts = [];
    if (o.details) parts.push(`<b>${esc(String(o.details).replace(/(^|\s)-(?=\d)/g, "$1−"))}</b>`);
    if (o.overUnder !== null && o.overUnder !== undefined) parts.push(`O/U ${esc(fmtLine(o.overUnder, false))}`);
    return parts.map((p) => `<span>${p}</span>`).join("");
  }

  function teamLineHTML(g, t, isHome) {
    const showScore = (g.state === "in" || g.state === "post") && t.score !== null && t.score !== undefined;
    return `<span class="b-team">
        <span class="b-at" aria-hidden="true">${isHome ? "@" : ""}</span>
        <span class="b-logo" aria-hidden="true">${logoHTML(t, "sm")}</span>
        ${t.rank ? `<span class="rank">${esc(t.rank)}</span>` : ""}
        <span class="b-tn">${isHome ? '<span class="sr">at </span>' : ""}${esc(t.short || t.abbr)}</span>
        ${showScore ? `<span class="b-score num">${esc(t.score)}</span>` : ""}
      </span>`;
  }

  function statusHTML(g) {
    if (g.state === "in") return `<span class="chip live">Live · ${esc(g.detail)}</span>`;
    if (g.state === "post") {
      if (!g.completed) return `<span class="chip even">${esc(g.detail || "Postponed")}</span>`;
      return `<span class="chip">${esc(/^final/i.test(g.detail || "") ? g.detail : "Final")}</span>`;
    }
    return `<span class="b-when">${esc(kickoffText(g.date))}</span>`;
  }

  function rowInner(g) {
    const n = legsOn(g.id);
    const line = lineSummary(g);
    return `<span class="b-teams">${teamLineHTML(g, g.away, false)}${teamLineHTML(g, g.home, true)}</span>
      <span class="b-meta">
        ${statusHTML(g)}
        ${line ? `<span class="b-odds">${line}</span>` : `<span class="b-odds none">No line</span>`}
        ${n ? `<span class="chip b-onslip">✓ ${n > 1 ? `${n} on slip` : "On slip"}</span>` : ""}
      </span>`;
  }

  function editorShell(g) {
    return `<div class="b-editor" id="${uid}-ed-${esc(g.id)}" role="group" aria-label="Add a leg from ${esc(g.shortName)}">${editorInner(g)}</div>`;
  }

  function gameHTML(g) {
    const open = st.openId === g.id && st.ed;
    return `<div class="b-game card${open ? " open" : ""}" data-id="${esc(g.id)}">
        <button type="button" class="b-row" data-act="toggle" data-id="${esc(g.id)}" aria-expanded="${open ? "true" : "false"}"${open ? ` aria-controls="${uid}-ed-${esc(g.id)}"` : ""}>${rowInner(g)}</button>
        ${open ? editorShell(g) : ""}
      </div>`;
  }

  // Empty search: the slate by day. Back-to-back days where every game is final (the midweek
  // games by Saturday) fold into one collapsed group so the live/upcoming slate is up top.
  function groupedHTML(games) {
    const groups = [];
    for (const g of [...games].sort(byKickoff)) {
      const key = localDayKey(g.date);
      let grp = groups[groups.length - 1];
      if (!grp || grp.key !== key) groups.push((grp = { key, date: g.date, games: [] }));
      grp.games.push(g);
    }
    const count = (n) => `${n} ${n === 1 ? "game" : "games"}`;
    const rows = (grp) => `<div class="b-list">${grp.games.map(gameHTML).join("")}</div>`;
    const allFinal = (grp) => grp.games.every((g) => g.state === "post");
    const out = [];
    for (let i = 0; i < groups.length;) {
      if (!allFinal(groups[i])) {
        const grp = groups[i++];
        out.push(`<section class="b-day"><h3 class="b-day-h"><span>${esc(dayLabel(grp.date))}</span><span class="b-day-n">${count(grp.games.length)}</span></h3>${rows(grp)}</section>`);
        continue;
      }
      const run = [];
      while (i < groups.length && allFinal(groups[i])) run.push(groups[i++]);
      const key = run.map((grp) => grp.key).join("|");
      const n = run.reduce((sum, grp) => sum + grp.games.length, 0);
      const label = run.length === 1 ? dayLabel(run[0].date) : `${shortDay(run[0].date)} – ${shortDay(run[run.length - 1].date)}`;
      const open = openDays.has(key) || run.some((grp) => grp.games.some((g) => g.id === st.openId));
      const inner = run.length === 1 ? rows(run[0])
        : run.map((grp) => `<h4 class="b-subday">${esc(dayLabel(grp.date))}</h4>${rows(grp)}`).join("");
      out.push(`<details class="b-day b-day-done" data-day="${esc(key)}"${open ? " open" : ""}>
          <summary class="b-day-h"><span>${esc(label)}</span><span class="b-day-n">${count(n)} · final<span class="b-day-chev" aria-hidden="true"></span></span></summary>
          ${inner}
        </details>`);
    }
    return out.join("");
  }

  function renderResults() {
    if (st.loading) {
      countEl.textContent = `Loading ${weekLabel()} from ESPN…`;
      resultsEl.innerHTML = `<div class="b-list" aria-hidden="true">${'<div class="b-skel card"><span></span><span></span></div>'.repeat(5)}</div>`;
      return;
    }
    if (st.error) {
      countEl.textContent = "";
      resultsEl.innerHTML = `<div class="banner error b-error" role="alert">
          <span>Couldn't load ${esc(weekLabel())} from ESPN (${esc(st.error)}).</span>
          <button type="button" class="btn" data-act="retry">Retry</button>
        </div>`;
      return;
    }
    const games = st.slate?.games || [];
    const qText = st.query.trim();
    if (!norm(qText)) {
      countEl.textContent = games.length ? "Every game this week · tap one to add a leg" : "";
      resultsEl.innerHTML = games.length
        ? groupedHTML(games)
        : `<div class="b-empty">ESPN has no FBS games listed for ${esc(weekLabel())}.</div>`;
      return;
    }
    const hits = searchGames(games, qText);
    countEl.textContent = hits.length
      ? `${hits.length} ${hits.length === 1 ? "game matches" : "games match"} “${qText}”`
      : "No matches";
    resultsEl.innerHTML = hits.length
      ? `<div class="b-list">${hits.map(gameHTML).join("")}</div>`
      : `<div class="b-empty">No games match <b>“${esc(qText)}”</b> in ${esc(weekLabel())}.<br>Check the spelling, or try another week.</div>`;
  }

  // While typing, keep the top result right under the sticky search instead of mid-list.
  function snapToResults() {
    const searchH = $(".b-search").offsetHeight;
    const y = countEl.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - bar.offsetHeight - searchH;
    if (root.scrollTop > y) root.scrollTop = Math.max(0, y);
  }

  function onQuery(value) {
    st.query = value;
    clearBtn.hidden = !value;
    renderResults();
    snapToResults();
  }

  function clearSearch() {
    qInput.value = "";
    onQuery("");
    qInput.focus({ preventScroll: true });
  }

  function openFirstResult() {
    if (!norm(st.query) || st.loading || st.error) return;
    const first = resultsEl.querySelector(".b-row");
    if (!first) return;
    const id = first.dataset.id;
    if (st.openId !== id) toggle(id);
    gameEl(id)?.querySelector(".b-row")?.focus({ preventScroll: true });
  }

  /* ---------------- leg editor ---------------- */

  function prefill(g, t, s) {
    const o = g.odds;
    if (t === "total") {
      return { line: o?.overUnder !== null && o?.overUnder !== undefined ? lineInput(o.overUnder, false) : "", odds: "-110" };
    }
    if (t === "spread") {
      const sp = s ? spreadFor(g, s) : null;
      return { line: sp !== null ? lineInput(sp, true) : "", odds: "-110" };
    }
    return { line: "", odds: s ? oddsInput(mlFor(g, s)) : "" };
  }

  function draftLeg(g) {
    const ed = st.ed;
    const team = ed.t === "total" ? null : ed.s === g.home.id ? g.home : ed.s === g.away.id ? g.away : null;
    const l = ed.t === "ml" ? null : parseLine(ed.line);
    const o = parseOdds(ed.odds);
    return {
      e: g.id, t: ed.t, s: ed.s,
      l: Number.isNaN(l) ? null : l,
      o: Number.isNaN(o) ? null : o,
      n: team ? team.short : null, g: g.shortName, k: g.date,
    };
  }

  function addLabel(g) {
    if (!st.ed?.s) return "Pick a side";
    const d = draftLeg(g);
    const label = legLabel(d, g).trim();
    return `Add ${label}${d.o !== null ? ` (${fmtOdds(d.o)})` : ""}`;
  }

  function sideBtn(value, icon, name, sub) {
    const pressed = st.ed.s === value;
    return `<button type="button" class="b-side" data-act="side" data-v="${esc(value)}" aria-pressed="${pressed}">
        ${icon}<span class="b-side-name">${esc(name)}</span><span class="b-side-sub num">${sub ? esc(sub) : "&nbsp;"}</span>
      </button>`;
  }

  function editorInner(g) {
    const ed = st.ed;
    const seg = [["ml", "Moneyline"], ["spread", "Spread"], ["total", "Total"]]
      .map(([val, label]) => `<button type="button" class="b-seg-btn" data-act="type" data-v="${val}" aria-pressed="${ed.t === val}">${label}</button>`)
      .join("");

    let sides;
    if (ed.t === "total") {
      const ou = g.odds?.overUnder;
      const sub = ou !== null && ou !== undefined ? fmtLine(ou, false) : "";
      sides = sideBtn("o", '<span class="b-side-ico" aria-hidden="true">▲</span>', "Over", sub) +
              sideBtn("u", '<span class="b-side-ico" aria-hidden="true">▼</span>', "Under", sub);
    } else {
      sides = [g.away, g.home].map((t) => {
        const sub = ed.t === "ml" ? fmtOdds(mlFor(g, t.id)) : fmtLine(spreadFor(g, t.id), true);
        return sideBtn(t.id, `<span class="b-side-logo" aria-hidden="true">${logoHTML(t)}</span>`, t.short || t.abbr, sub);
      }).join("");
    }

    const lineField = ed.t === "ml" ? "" : `
      <div class="b-field b-linefield">
        <label class="eyebrow" for="${uid}-line">${ed.t === "total" ? "Total points" : "Spread"}</label>
        <div class="b-stepper">
          <button type="button" class="b-step" data-act="step" data-d="-0.5" aria-label="Line down half a point">−</button>
          <input class="b-num" id="${uid}-line" data-field="line" type="text" inputmode="decimal" autocomplete="off"
            autocorrect="off" spellcheck="false" enterkeyhint="done" value="${esc(ed.line)}"
            placeholder="${ed.t === "total" ? "54.5" : "-3.5"}" aria-describedby="${uid}-err">
          <button type="button" class="b-step" data-act="step" data-d="0.5" aria-label="Line up half a point">+</button>
          ${ed.t === "spread" ? '<button type="button" class="b-step b-flip" data-act="flip" aria-label="Flip the sign of the line">±</button>' : ""}
        </div>
      </div>`;

    const oddsField = `
      <div class="b-field b-oddsfield">
        <label class="eyebrow" for="${uid}-odds">Odds <span class="b-opt">optional</span></label>
        <div class="b-stepper">
          <button type="button" class="b-step b-flip" data-act="oflip" aria-label="Flip plus or minus odds">±</button>
          <input class="b-num" id="${uid}-odds" data-field="odds" type="text" inputmode="numeric" autocomplete="off"
            autocorrect="off" spellcheck="false" enterkeyhint="done" value="${esc(ed.odds)}" placeholder="-110"
            aria-describedby="${uid}-err">
        </div>
      </div>`;

    return `
      <div class="b-seg" role="group" aria-label="Bet type">${seg}</div>
      <div class="b-sides" role="group" aria-label="${ed.t === "total" ? "Over or under" : "Pick a team"}">${sides}</div>
      <div class="b-inputs">${lineField}${oddsField}</div>
      <div class="b-ed-foot">
        <p class="b-err" id="${uid}-err" role="alert">${esc(ed.err)}</p>
        <button type="button" class="btn gold b-add" data-act="add"${ed.s ? "" : " disabled"}>${esc(addLabel(g))}</button>
      </div>`;
  }

  const editorEl = () => gameEl(st.openId)?.querySelector(".b-editor") || null;

  function renderEditor(focusSel) {
    const g = gamesById.get(st.openId);
    const el = editorEl();
    if (!g || !el || !st.ed) return;
    el.innerHTML = editorInner(g);
    if (focusSel) el.querySelector(focusSel)?.focus({ preventScroll: true });
  }

  function updateAddBtn() {
    const g = gamesById.get(st.openId);
    const btn = editorEl()?.querySelector(".b-add");
    if (!g || !btn) return;
    btn.textContent = addLabel(g);
    btn.disabled = !st.ed.s;
  }

  function setErr(msg) {
    if (!st.ed) return;
    st.ed.err = msg;
    const el = editorEl()?.querySelector(".b-err");
    if (el) el.textContent = msg;
  }

  function closeEditor() {
    const el = gameEl(st.openId);
    if (el) {
      el.classList.remove("open");
      el.querySelector(".b-editor")?.remove();
      const row = el.querySelector(".b-row");
      row?.setAttribute("aria-expanded", "false");
      row?.removeAttribute("aria-controls");
    }
    st.openId = null;
    st.ed = null;
  }

  function openEditor(id) {
    const g = gamesById.get(id);
    const el = gameEl(id);
    if (!g || !el) return;
    const t = homeSpread(g) !== null ? "spread" : mlFor(g, g.home.id) !== null ? "ml" : "spread";
    st.openId = id;
    st.ed = { t, s: null, err: "", ...prefill(g, t, null) };
    el.classList.add("open");
    const row = el.querySelector(".b-row");
    row.setAttribute("aria-expanded", "true");
    row.setAttribute("aria-controls", `${uid}-ed-${id}`);
    el.insertAdjacentHTML("beforeend", editorShell(g));
  }

  function toggle(id) {
    const before = gameEl(id)?.getBoundingClientRect().top;
    const wasOpen = st.openId === id;
    closeEditor();
    if (!wasOpen) openEditor(id);
    // Collapsing an editor above the tapped row shifts it; keep the row under the finger.
    const after = gameEl(id)?.getBoundingClientRect().top;
    if (before !== undefined && after !== undefined && after !== before) root.scrollTop += after - before;
    if (!wasOpen) gameEl(id)?.scrollIntoView({ block: "nearest" });
  }

  function setType(t) {
    const ed = st.ed;
    const g = gamesById.get(st.openId);
    if (!ed || !g || ed.t === t) return;
    // Moneyline <-> spread keeps the team you picked; anything involving totals starts over.
    const keepSide = ed.t !== "total" && t !== "total";
    ed.t = t;
    if (!keepSide) ed.s = null;
    Object.assign(ed, prefill(g, ed.t, ed.s), { err: "" });
    renderEditor(`[data-act="type"][data-v="${t}"]`);
  }

  function setSide(s) {
    const ed = st.ed;
    const g = gamesById.get(st.openId);
    if (!ed || !g) return;
    ed.s = s;
    Object.assign(ed, prefill(g, ed.t, s), { err: "" });
    renderEditor(`[data-act="side"][data-v="${CSS.escape(s)}"]`);
    editorEl()?.querySelector(".b-ed-foot")?.scrollIntoView({ block: "nearest" });
  }

  function stepLine(d) {
    const ed = st.ed;
    const g = gamesById.get(st.openId);
    if (!ed || !g || ed.t === "ml") return;
    let cur = parseLine(ed.line);
    if (cur === null || Number.isNaN(cur)) {
      const p = parseLine(prefill(g, ed.t, ed.s).line);
      cur = p === null || Number.isNaN(p) ? 0 : p;
    }
    let next = Math.round((cur + d) * 10) / 10;
    if (ed.t === "total" && next < 0.5) next = 0.5;
    ed.line = lineInput(next, ed.t === "spread");
    const input = editorEl()?.querySelector('[data-field="line"]');
    if (input) input.value = ed.line;
    setErr("");
    updateAddBtn();
  }

  function flipLine() {
    const ed = st.ed;
    if (!ed || ed.t !== "spread") return;
    const cur = parseLine(ed.line);
    if (cur === null || Number.isNaN(cur)) return;
    ed.line = lineInput(cur === 0 ? 0 : -cur, true);
    const input = editorEl()?.querySelector('[data-field="line"]');
    if (input) input.value = ed.line;
    updateAddBtn();
  }

  function flipOdds() {
    const ed = st.ed;
    if (!ed) return;
    const s = ed.odds.trim().replace(/^[−–—]/, "-");
    if (!s) return;
    ed.odds = s[0] === "-" ? `+${s.slice(1)}` : s[0] === "+" ? `-${s.slice(1)}` : `-${s}`;
    const input = editorEl()?.querySelector('[data-field="odds"]');
    if (input) input.value = ed.odds;
    setErr("");
    updateAddBtn();
  }

  function addLeg() {
    const ed = st.ed;
    const g = gamesById.get(st.openId);
    if (!ed || !g) return;
    if (!ed.s) return setErr("Pick a side first.");
    let l = null;
    if (ed.t !== "ml") {
      l = parseLine(ed.line);
      if (l === null) return setErr(ed.t === "total" ? "Enter the total, like 54.5." : "Enter the line, like -3.5, +7 or PK.");
      if (Number.isNaN(l)) return setErr("That line doesn't look right. Try -3.5, +7 or PK.");
      if (ed.t === "total" && l <= 0) return setErr("A total has to be above zero.");
    }
    const o = parseOdds(ed.odds);
    if (Number.isNaN(o)) return setErr("Odds should look like -110, +150 or 150.");
    const team = ed.t === "total" ? null : ed.s === g.home.id ? g.home : g.away;
    const leg = { e: g.id, t: ed.t, s: ed.s, l, o, n: team ? team.short || team.abbr : null, g: g.shortName, k: g.date };
    if (st.legs.some((x) => sameLeg(x, leg))) return setErr("That exact leg is already on your slip.");

    st.legs.push(leg);
    st.dirty = true;
    const id = g.id;
    closeEditor();
    const row = gameEl(id)?.querySelector(".b-row");
    if (row) { row.innerHTML = rowInner(g); row.focus({ preventScroll: true }); }
    selectOnFocus = true; // next tap on the search box selects the old query so typing replaces it
    renderSlip(true);
  }

  /* ---------------- slip ---------------- */

  function defaultName() {
    const w = weekForId();
    return w.week ? `Week ${w.week}` : "The bozo";
  }

  // Week/year of the earliest leg (falls back to the week on screen).
  function weekForId() {
    const at = (l) => { const ms = Date.parse(l.k); return Number.isFinite(ms) ? ms : Infinity; };
    for (const l of [...st.legs].sort((a, b) => at(a) - at(b))) {
      const w = weekOfEvent.get(String(l.e));
      if (w && w.week) return w;
    }
    return { week: st.week, year: st.year ?? new Date().getFullYear() };
  }

  function legHTML(leg, i) {
    const g = gamesById.get(String(leg.e)) || null;
    const label = legLabel(leg, g);
    let when = "";
    if (g?.state === "in") when = `<span class="chip live">Live</span>`;
    else if (g?.state === "post") when = `<span class="chip">Final</span>`;
    else if (g?.date || leg.k) when = `<span>${esc(kickoffText(g?.date || leg.k))}</span>`;
    return `<li class="b-leg">
        <span class="b-leg-n num" aria-hidden="true">${i + 1}</span>
        <div class="b-leg-main">
          <div class="b-leg-pick">${esc(label)}</div>
          <div class="b-leg-sub"><span>${esc(leg.g)}</span>${when}</div>
        </div>
        <span class="b-leg-odds num">${leg.o !== null && leg.o !== undefined ? esc(fmtOdds(leg.o)) : '<span class="b-noodds">no odds</span>'}</span>
        <button type="button" class="b-leg-x" data-act="remove" data-i="${i}" aria-label="Remove ${esc(label)}">×</button>
      </li>`;
  }

  function pipsHTML(n) {
    const total = Math.min(12, Math.max(6, n));
    let out = "";
    for (let i = 0; i < total; i++) out += `<i${i < n ? ' class="on"' : ""}></i>`;
    return out;
  }

  function renderMoney() {
    const n = st.legs.length;
    const dec = n ? parlayPrice(st.legs) : null;
    const stake = parseMoney(stakeIn.value);
    const payout = parseMoney(payoutIn.value);
    const est = dec && stake ? stake * dec : null;
    payoutIn.placeholder = est ? `≈ ${est.toFixed(2)}` : "optional";
    let html = "";
    if (n && !dec) html = "Add odds to every leg to price the parlay.";
    else if (dec) {
      html = `Price <b>${esc(fmtOdds(decimalToAmerican(dec)))}</b>`;
      if (est && payout === null) html += ` · ${esc(fmtMoney(stake))} pays about <b>${esc(fmtMoney(est))}</b>`;
      else if (est) html += ` · book math: ${esc(fmtMoney(est))}`;
      else html += " · add a stake to estimate the payout";
    }
    $("[data-est]").innerHTML = html;
  }

  function renderSlip(bump = false) {
    const n = st.legs.length;
    const dec = n ? parlayPrice(st.legs) : null;
    const price = dec ? fmtOdds(decimalToAmerican(dec)) : "";
    $("[data-sum]").textContent = n ? `${n} ${n === 1 ? "leg" : "legs"}` : "Empty";
    $$("[data-price]").forEach((el) => { el.textContent = price; });
    $$("[data-pips]").forEach((el) => { el.innerHTML = pipsHTML(n); });
    $("[data-legs]").innerHTML = n
      ? st.legs.map(legHTML).join("")
      : `<li class="b-leg-empty">No legs yet. Search a team, tap the game, pick a side.</li>`;

    const hint = $("[data-hint]");
    hint.classList.toggle("full", n === 6);
    hint.textContent =
      n === 6 ? "That's a full bozo. Six legs, locked in." :
      n === 5 ? "One more and it's a full bozo." :
      n > 6 ? `${n} legs. A full bozo is six, but nobody's stopping you.` : "";
    hint.hidden = !hint.textContent;

    $$("[data-save]").forEach((b) => { b.disabled = n === 0; });
    nameIn.placeholder = defaultName();
    renderMoney();
    if (bump) {
      slipBar.classList.remove("bump");
      void slipBar.offsetWidth; // restart the animation
      slipBar.classList.add("bump");
    }
  }

  function removeLeg(i) {
    const leg = st.legs[i];
    if (!leg) return;
    st.legs.splice(i, 1);
    st.dirty = true;
    renderSlip();
    const g = gamesById.get(String(leg.e));
    const row = gameEl(leg.e)?.querySelector(".b-row");
    if (g && row) row.innerHTML = rowInner(g);
    const nextX = root.querySelector(`[data-act="remove"][data-i="${Math.min(i, st.legs.length - 1)}"]`);
    if (nextX) nextX.focus({ preventScroll: true });
    else if (!wide.matches && st.slipOpen) slipBar.focus({ preventScroll: true });
    else qInput.focus({ preventScroll: true });
  }

  function setSlip(open) {
    st.slipOpen = !!open && !wide.matches;
    slipEl.classList.toggle("open", st.slipOpen);
    slipBar.setAttribute("aria-expanded", String(st.slipOpen));
    scrim.hidden = !st.slipOpen;
  }

  /* ---------------- save / cancel ---------------- */

  function save() {
    if (!st.legs.length) return;
    const legs = st.legs.map(cleanLeg);
    const at = (l) => { const ms = Date.parse(l.k); return Number.isFinite(ms) ? ms : Infinity; };
    const first = [...legs].sort((a, b) => at(a) - at(b))[0];
    const w = weekForId();
    const id = initial?.id || `${w.year}-w${w.week ?? 0}-${rand4()}`;
    const name = nameIn.value.trim() || defaultName();
    const date = first && Number.isFinite(at(first)) ? ymd(first.k) : (initial?.date ?? null);
    st.dirty = false;
    onSave?.({ id, name, date, stake: parseMoney(stakeIn.value), payout: parseMoney(payoutIn.value), legs });
  }

  function requestCancel() {
    if (st.dirty && !window.confirm("Discard the changes to this slip?")) return;
    onCancel?.();
  }

  /* ---------------- events ---------------- */

  on(root, "click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !root.contains(b) || b.disabled) return;
    switch (b.dataset.act) {
      case "cancel": requestCancel(); break;
      case "save": save(); break;
      case "toggle": toggle(b.dataset.id); break;
      case "type": setType(b.dataset.v); break;
      case "side": setSide(b.dataset.v); break;
      case "step": stepLine(Number(b.dataset.d)); break;
      case "flip": flipLine(); break;
      case "oflip": flipOdds(); break;
      case "add": addLeg(); break;
      case "remove": removeLeg(Number(b.dataset.i)); break;
      case "week": stepWeek(Number(b.dataset.d)); break;
      case "retry": loadWeek(st.lastReq); break;
      case "clear": clearSearch(); break;
      case "slip": setSlip(!st.slipOpen); break;
    }
  });

  on(root, "input", (e) => {
    const f = e.target.dataset?.field;
    if (!f) return;
    if (f === "q") onQuery(e.target.value);
    else if (f === "line" || f === "odds") {
      if (!st.ed) return;
      st.ed[f] = e.target.value;
      setErr("");
      updateAddBtn();
    } else {
      st.dirty = true;
      if (f !== "name") renderMoney();
    }
  });

  on(root, "keydown", (e) => {
    if (e.key === "Enter" || e.keyCode === 13) {
      if (e.isComposing) return;
      const f = e.target.dataset?.field;
      if (f === "q") { e.preventDefault(); openFirstResult(); }
      else if (f === "line" || f === "odds") { e.preventDefault(); addLeg(); }
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (st.slipOpen) { setSlip(false); slipBar.focus({ preventScroll: true }); return; }
    if (e.target === qInput && qInput.value) { clearSearch(); return; }
    if (st.openId) {
      const id = st.openId;
      closeEditor();
      gameEl(id)?.querySelector(".b-row")?.focus({ preventScroll: true });
      return;
    }
    requestCancel();
  });

  on(qInput, "focus", () => {
    if (!selectOnFocus) return;
    selectOnFocus = false;
    setTimeout(() => { if (!dead && qInput.value) qInput.setSelectionRange(0, qInput.value.length); }, 0);
  });

  // details toggle doesn't bubble; listen in the capture phase.
  on(root, "toggle", (e) => {
    const d = e.target;
    if (!d.matches?.("details.b-day")) return;
    if (d.open) openDays.add(d.dataset.day); else openDays.delete(d.dataset.day);
  }, { capture: true });

  on(wide, "change", () => { if (wide.matches) setSlip(false); });

  /* ---------------- go ---------------- */

  renderWeek();
  renderSlip();
  renderResults();
  loadWeek(idMatch ? { week: +idMatch[2], seasonType: 2, year: +idMatch[1] } : {}, { fallback: !!idMatch });

  if (window.matchMedia("(min-width: 900px) and (hover: hover) and (pointer: fine)").matches) {
    qInput.focus({ preventScroll: true });
  }

  return {
    destroy() {
      dead = true;
      ac.abort();
      ro?.disconnect();
      root.replaceChildren();
      if (setLabel) root.removeAttribute("aria-labelledby");
    },
  };
}
