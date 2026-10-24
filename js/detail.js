// Game detail sheet: everything about one game a parlay leg rides on.
// Scoreboard, the leg(s) and how they grade, live situation, linescore, win probability,
// Box score / Players / Scoring / Drives tabs, and game info. Polls ESPN while the game is live.
//
// Contract (called by the main app):
//   mountDetail(root, { eventId, legs, onClose }) -> { destroy() }
//   root: an empty <div class="sheet" role="dialog" aria-modal="true"> (fixed, full screen,
//   and the scroll container). Styles live in css/detail.css, all scoped under .detail.

import { fetchSummary, logoHTML, escapeHTML as esc, kickoffText } from "./espn.js";
import { gradeLeg, legLabel, fmtLine, fmtOdds, teamById } from "./grade.js";

const POLL_MS = 20000;                    // live refresh cadence
const PREGAME_WINDOW_MS = 15 * 60000;     // start polling this close to kickoff
const MAX_IDLE_MS = 30 * 60000;           // longest sleep before re-checking a far-off kickoff

const DASH = "\u2013";
const DOT = " \u00b7 ";

const ICON = {
  back: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ball: '<svg class="dt-ball" viewBox="0 0 26 16" width="18" height="11" aria-hidden="true" focusable="false"><ellipse cx="13" cy="8" rx="12" ry="7"/><path d="M8 8h10M10.5 6v4M13 6v4M15.5 6v4"/></svg>',
};
const RZ_FLAG = '<span class="dt-rz">Red zone</span>';

const TONES = new Set(["pending", "winning", "losing", "even", "won", "lost", "push", "void"]);
const MARKET = { ml: "Moneyline", spread: "Spread", total: "Total" };

// Team stat rows, in the order a bettor reads them. Anything else ESPN sends is appended.
const BOX_MAIN = [
  ["totalYards", "Total yards"], ["netPassingYards", "Passing"], ["rushingYards", "Rushing"],
  ["firstDowns", "First downs"], ["thirdDownEff", "3rd down"], ["fourthDownEff", "4th down"],
  ["turnovers", "Turnovers"], ["totalPenaltiesYards", "Penalties"], ["possessionTime", "Possession"],
];
const BOX_MINOR = [
  ["completionAttempts", "Comp / Att"], ["yardsPerPass", "Yards / pass"], ["rushingAttempts", "Rush attempts"],
  ["yardsPerRushAttempt", "Yards / rush"], ["fumblesLost", "Fumbles lost"], ["interceptions", "INTs thrown"],
];

const CAT_ORDER = ["passing", "rushing", "receiving", "defensive", "interceptions", "kicking", "punting", "kickReturns", "puntReturns", "fumbles"];
const CAT_TITLE = {
  passing: "Passing", rushing: "Rushing", receiving: "Receiving", defensive: "Defense",
  interceptions: "Interceptions", kicking: "Kicking", punting: "Punting",
  kickReturns: "Kick returns", puntReturns: "Punt returns", fumbles: "Fumbles",
};

const DRIVE_FAIL = /INT|FUMBLE|DOWNS|MISSED|BLOCK|SAFETY|TURNOVER/i;

let mounts = 0;

export function mountDetail(root, { eventId, legs = [], onClose } = {}) {
  const uid = `dt${++mounts}`;
  legs = Array.isArray(legs) ? legs.filter(Boolean) : [];

  const state = {
    data: null, game: null, error: null, updatedAt: null, loading: false,
    tab: null,          // selected tab key (null = first available)
    side: null,         // Players tab team: "away" | "home" (null = picked team's side)
    open: new Map(),    // drive id -> expanded?
  };
  const painted = new WeakMap(); // section element -> last HTML written
  let timer = null;
  let seq = 0;
  let destroyed = false;

  root.innerHTML = `
    <div class="sheet-bar detail dt-bar">
      <div class="wrap">
        <button type="button" class="btn ghost dt-back" data-act="close" aria-label="Back to the parlay">${ICON.back}<span>Back</span></button>
        <h2 class="sheet-title dt-title" id="${uid}-title"></h2>
        <span class="dt-stamp num"></span>
      </div>
    </div>
    <div class="sheet-body detail"><div class="wrap dt-wrap"></div></div>`;
  root.setAttribute("aria-labelledby", `${uid}-title`);
  const titleEl = root.querySelector(".dt-title");
  const stampEl = root.querySelector(".dt-stamp");
  const wrap = root.querySelector(".dt-wrap");

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);

  render();
  root.querySelector(".dt-back")?.focus({ preventScroll: true });
  load();

  // ---------- data ----------

  async function load() {
    if (destroyed) return;
    clearTimeout(timer);
    timer = null;
    const mine = ++seq;
    state.loading = true;
    paintStamp();
    let data = null;
    let err = null;
    try {
      data = await fetchSummary(eventId);
    } catch (e) {
      err = e;
    }
    if (destroyed || mine !== seq) return;
    state.loading = false;
    if (data && data.game) {
      state.data = data;
      state.game = data.game;
      state.error = null;
      state.updatedAt = new Date();
    } else {
      state.error = (err && err.message) || "No data";
    }
    render();
    schedule();
  }

  // ms until the next poll, or null when there is nothing left to watch.
  function nextDelay() {
    const g = state.game;
    if (!g) return POLL_MS; // never loaded: keep trying quietly behind the Retry button
    if (g.state === "in") return POLL_MS;
    if (g.state === "pre") {
      const until = Date.parse(g.date) - Date.now();
      if (!Number.isFinite(until) || until <= PREGAME_WINDOW_MS) return POLL_MS;
      return Math.min(until - PREGAME_WINDOW_MS, MAX_IDLE_MS);
    }
    return null; // final / postponed
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (destroyed || document.hidden) return;
    const delay = nextDelay();
    if (delay !== null) timer = setTimeout(load, delay);
  }

  function onVisibility() {
    if (destroyed) return;
    if (document.hidden) {
      clearTimeout(timer);
      timer = null;
      return;
    }
    if (state.error || nextDelay() === POLL_MS) load();
    else schedule();
  }

  // ---------- events ----------

  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || !root.contains(el)) return;
    const act = el.getAttribute("data-act");
    if (act === "close") {
      if (typeof onClose === "function") onClose();
    } else if (act === "retry") {
      load();
    } else if (act === "tab") {
      const key = el.getAttribute("data-tab");
      if (key && key !== state.tab) { state.tab = key; paintBody(); }
    } else if (act === "side") {
      state.side = el.getAttribute("data-side") === "home" ? "home" : "away";
      paintBody();
    } else if (act === "drive") {
      state.open.set(el.getAttribute("data-id") || "", el.getAttribute("aria-expanded") !== "true");
      paintBody();
    }
  }

  function onKey(e) {
    if (e.key === "Escape") {
      if (typeof onClose === "function") { e.preventDefault(); onClose(); }
      return;
    }
    const t = e.target;
    if (!t || !t.getAttribute || t.getAttribute("role") !== "tab") return;
    const tabs = [...t.parentElement.querySelectorAll('[role="tab"]')];
    let i = tabs.indexOf(t);
    if (e.key === "ArrowRight") i = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") i = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = tabs.length - 1;
    else return;
    e.preventDefault();
    state.tab = tabs[i].getAttribute("data-tab");
    paintBody();
    const next = wrap.querySelector(`[data-fk="tab-${cssEscape(state.tab)}"]`);
    if (next) next.focus({ preventScroll: true });
  }

  // ---------- paint ----------

  function render() {
    paintBar();
    paintBody();
  }

  function paintBar() {
    const g = state.game;
    titleEl.textContent = g
      ? `${g.away.abbr || g.away.short} ${g.neutral ? "vs" : "@"} ${g.home.abbr || g.home.short}`
      : (legs[0] && legs[0].g) || "Game";
    paintStamp();
  }

  function paintStamp() {
    stampEl.textContent = state.updatedAt
      ? `Updated ${clockTime(state.updatedAt)}`
      : state.loading ? "Loading\u2026" : "";
    stampEl.classList.toggle("busy", state.loading);
  }

  // Only sections whose HTML changed are rewritten, so a poll does not flash logos or
  // drop the selected tab, open drives, focus, or table scroll positions.
  function paintBody() {
    const sections = buildSections();
    const top = root.scrollTop;
    const lefts = [];
    wrap.querySelectorAll("[data-sk]").forEach((el) => {
      if (el.scrollLeft) lefts.push([el.getAttribute("data-sk"), el.scrollLeft]);
    });
    const active = document.activeElement;
    const fk = active && wrap.contains(active) ? active.getAttribute("data-fk") : null;

    reconcile(wrap, sections, painted);

    for (const [k, x] of lefts) {
      const el = wrap.querySelector(`[data-sk="${cssEscape(k)}"]`);
      if (el) el.scrollLeft = x;
    }
    if (fk && document.activeElement !== active) {
      const el = wrap.querySelector(`[data-fk="${cssEscape(fk)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
    if (top > 0 && root.scrollTop === 0) root.scrollTop = top;
  }

  function buildSections() {
    const out = [];
    const add = (key, fn) => {
      let html = "";
      try {
        html = fn() || "";
      } catch (err) {
        console.error(`[detail] ${key} section failed`, err);
      }
      if (html) out.push([key, html]);
    };

    if (state.error) add("error", () => errorHTML(!!state.data));
    const g = state.game;
    if (!g) {
      if (!state.error) add("loading", loadingHTML);
      add("picks", () => picksHTML(legs, null));
      return out;
    }

    const c = makeCtx(state, legs, uid);
    add("board", () => boardHTML(c));
    add("picks", () => picksHTML(legs, g));
    if (c.pre) {
      add("info", () => infoHTML(c));
      add("note", () => noteHTML(c));
      add("tabs", () => tabsHTML(c));
      return out;
    }
    add("situation", () => situationHTML(c));
    add("linescore", () => linescoreHTML(c));
    add("wp", () => winProbHTML(c));
    add("tabs", () => tabsHTML(c));
    add("info", () => infoHTML(c));
    return out;
  }

  return {
    destroy() {
      destroyed = true;
      seq++;
      clearTimeout(timer);
      timer = null;
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

// Keyed section diff: reuse each section element, rewrite it only when its HTML changed.
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
      el.className = `dt-sec dt-sec-${key}`;
      el.setAttribute("data-sec", key);
    }
    if (painted.get(el) !== html) {
      el.innerHTML = html;
      painted.set(el, html);
    }
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (el !== want) parent.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}

// ---------- context ----------

function makeCtx(state, legs, uid) {
  const data = state.data || {};
  const g = state.game;
  // The team the bettor is riding (first ML/spread leg on this game), if any.
  const pickLeg = legs.find((l) => (l.t === "ml" || l.t === "spread") && teamById(g, l.s));
  const pick = pickLeg ? teamById(g, pickLeg.s) : null;
  return {
    uid, data, g, legs, ui: state,
    pre: g.state === "pre",
    live: g.state === "in",
    post: g.state === "post",
    pick,
    sit: g.state === "in" ? situationFrom(data, g) : null,
  };
}

// The summary endpoint usually has no `situation` block, so possession, down & distance,
// red zone and timeouts are pieced together from the header competitors and the current drive.
function situationFrom(data, g) {
  const s = g.situation || {};
  const comps = data.header?.competitions?.[0]?.competitors || [];
  const comp = (side) => comps.find((x) => x && x.homeAway === side) || {};
  const cur = data.drives?.current || null;
  const plays = Array.isArray(cur?.plays) ? cur.plays : [];
  const last = plays[plays.length - 1] || null;
  const driveOpen = !!cur && !cur.result && !cur.displayResult && !cur.shortDisplayResult;

  const flagged = comps.find((x) => x && x.possession === true);
  let possession = s.possession || (flagged ? String(flagged.team?.id ?? flagged.id) : null);
  if (!possession && driveOpen && cur.team?.id != null) possession = String(cur.team.id);

  const end = last?.end || {};
  const live = driveOpen && Number(end.down) > 0;
  const downDistance = s.downDistance || (live ? end.downDistanceText || null : null);
  const toGo = Number(end.yardsToEndzone);
  const redZone = g.situation ? !!s.isRedZone : live && toGo > 0 && toGo <= 20;

  let lastPlay = s.lastPlay || last?.text || null;
  if (!lastPlay) {
    const prev = data.drives?.previous;
    const lp = Array.isArray(prev) && prev.length ? prev[prev.length - 1]?.plays : null;
    lastPlay = (Array.isArray(lp) && lp.length && lp[lp.length - 1]?.text) || null;
  }

  const timeouts = (side, fromSit) => {
    if (fromSit !== null && fromSit !== undefined) return fromSit;
    const used = comp(side).timeoutsUsed;
    if (used === null || used === undefined || !Number.isFinite(Number(used))) return null;
    return Math.max(0, 3 - Number(used));
  };

  return {
    possession, downDistance, redZone, lastPlay,
    awayTO: timeouts("away", s.awayTimeouts),
    homeTO: timeouts("home", s.homeTimeouts),
  };
}

// ---------- sections ----------

function errorHTML(hasData) {
  const msg = hasData ? "Couldn\u2019t refresh. Showing the last update." : "Couldn\u2019t load this game from ESPN.";
  return `<div class="banner error dt-err" role="alert"><span>${msg}</span><button type="button" class="btn" data-act="retry" data-fk="retry">Retry</button></div>`;
}

function loadingHTML() {
  return `<div class="card dt-loading" aria-busy="true"><span class="dt-loading-bar"></span><p>Loading the game from ESPN\u2026</p></div>`;
}

function statusInfo(c) {
  const g = c.g;
  if (c.live) return { kind: "live", text: liveClock(g) };
  if (c.post) return { kind: "final", text: finalText(g) };
  if (!g.statusName || /SCHEDULED/.test(g.statusName)) {
    if (!g.date) return { kind: "pre", text: "TBD" };
    if (c.data.header?.timeValid === false) return { kind: "pre", text: `${shortDay(g.date)}${DOT}TBD` };
    return { kind: "pre", text: kickoffText(g.date) };
  }
  return { kind: "pre", text: g.detail || (g.date ? kickoffText(g.date) : "TBD") };
}

function boardHTML(c) {
  const { g } = c;
  // Postponed/canceled games come back as 'post' with 0-0; don't print that as a score.
  const called = c.post && !g.completed && !(g.away.score || g.home.score);
  const scored = !c.pre && !called && (isNum(g.away.score) || isNum(g.home.score));
  const diff = (g.away.score ?? 0) - (g.home.score ?? 0);
  const brk = /HALFTIME|END_PERIOD/.test(g.statusName);
  const poss = c.live && !brk ? c.sit?.possession || null : null;
  const st = statusInfo(c);

  const side = (t, which) => {
    const lead = scored && (which === "away" ? diff > 0 : diff < 0);
    const trail = scored && (which === "away" ? diff < 0 : diff > 0);
    const cls = ["dt-side", which, lead && "lead", trail && "trail", c.pick === t && "mine"].filter(Boolean).join(" ");
    const ball = poss === t.id ? ICON.ball : "";
    return `<div class="${cls}">
      <div class="dt-side-top">${logoHTML(t, "lg")}${scored ? `<span class="dt-pts-wrap">${ball}<span class="dt-pts num">${esc(t.score ?? 0)}</span></span>` : ""}</div>
      <div class="dt-tname">${t.rank ? `<span class="rank">${esc(t.rank)}</span>` : ""}<span class="dt-tn">${esc(t.short || t.abbr)}</span></div>
      <div class="dt-rec num">${esc(t.record || "")}${c.pick === t ? '<span class="dt-tag">Pick</span>' : ""}</div>
    </div>`;
  };

  const status = st.kind === "live"
    ? `<span class="chip live dt-clock">${esc(st.text)}</span>`
    : st.kind === "final"
      ? `<span class="dt-final">${esc(st.text)}</span>`
      : `<span class="eyebrow">Kickoff</span><span class="dt-kick num">${esc(st.text)}</span>`;
  const rz = c.live && !brk && c.sit?.redZone ? RZ_FLAG : "";
  const tv = g.broadcast ? `<span class="dt-tv">${esc(g.broadcast)}</span>` : "";

  const possTeam = poss ? teamById(g, poss) : null;
  const sr = [
    `${g.away.short || g.away.abbr}${scored ? ` ${g.away.score ?? 0}` : ""}`,
    `${g.home.short || g.home.abbr}${scored ? ` ${g.home.score ?? 0}` : ""}`,
  ].join(c.pre ? " at " : ", ") + `. ${st.text}.` + (possTeam ? ` ${possTeam.short || possTeam.abbr} has the ball.` : "");

  return `<div class="card dt-board">
    <p class="dt-sr">${esc(sr)}</p>
    <div class="dt-score" aria-hidden="true">
      ${side(g.away, "away")}
      <div class="dt-mid">${status}${rz}${tv}</div>
      ${side(g.home, "home")}
    </div>
  </div>`;
}

function picksHTML(legs, g) {
  if (!legs.length) return "";
  const rows = legs.map((leg) => {
    const gr = gradeLeg(leg, g) || {};
    const tone = TONES.has(gr.tone) ? gr.tone : "pending";
    const team = g && leg.t !== "total" ? teamById(g, leg.s) : null;
    const odds = leg.o !== null && leg.o !== "" && isNum(Number(leg.o)) ? fmtOdds(Number(leg.o)) : "";
    const mark = team
      ? logoHTML(team, "sm")
      : leg.t === "total" ? `<span class="dt-ou" aria-hidden="true">${leg.s === "o" ? "O" : "U"}</span>` : "";
    return `<div class="dt-pick" data-tone="${tone}">
      <div class="eyebrow dt-pick-eb">Your pick${DOT}${esc(MARKET[leg.t] || "Leg")}</div>
      <div class="dt-pick-main">${mark}<span class="dt-pick-label">${esc(legLabel(leg, g))}</span>${odds ? `<span class="dt-odds num">${esc(odds)}</span>` : ""}</div>
      <div class="dt-pick-grade"><span class="chip ${tone}">${esc(gr.text || "")}</span>${gr.sub ? `<span class="dt-pick-sub num">${esc(gr.sub)}</span>` : ""}</div>
    </div>`;
  }).join("");
  return `<div class="card dt-picks">${rows}</div>`;
}

function noteHTML() {
  return `<p class="dt-note">Box score, drives and win probability fill in at kickoff.</p>`;
}

function situationHTML(c) {
  const s = c.sit;
  if (!s) return "";
  const { g } = c;
  const brk = /HALFTIME|END_PERIOD/.test(g.statusName);
  const dd = brk ? null : s.downDistance;
  const pos = s.possession ? teamById(g, s.possession) : null;
  const hasTO = s.awayTO !== null || s.homeTO !== null;
  if (!dd && !s.lastPlay && !hasTO) return "";

  const pips = (n) => [0, 1, 2].map((i) => `<i${i < n ? ' class="on"' : ""}></i>`).join("");
  const to = (t, n) => (n === null ? "" : `<span class="dt-to"><span>${esc(t.abbr)}</span><span class="dt-pips" role="img" aria-label="${n} timeout${n === 1 ? "" : "s"} left">${pips(n)}</span></span>`);

  return `<div class="card dt-sit">
    <div class="dt-h"><h3 class="eyebrow">${brk ? esc(liveClock(g)) : "On the field"}</h3>${s.redZone && !brk ? RZ_FLAG : ""}</div>
    ${dd ? `<div class="dt-dd">${pos ? logoHTML(pos, "sm") : ""}<span class="num">${esc(dd)}</span></div>` : ""}
    ${s.lastPlay ? `<p class="dt-last"><span class="dt-k">Last play</span>${esc(s.lastPlay)}</p>` : ""}
    ${hasTO ? `<div class="dt-tos"><span class="dt-k">Timeouts</span>${to(g.away, s.awayTO)}${to(g.home, s.homeTO)}</div>` : ""}
  </div>`;
}

function linescoreHTML(c) {
  const { g } = c;
  const al = g.away.linescores || [];
  const hl = g.home.linescores || [];
  if (!al.length && !hl.length) return "";
  const n = Math.max(4, al.length, hl.length);
  const cur = c.live ? (g.period || 0) - 1 : -1;
  const cols = Array.from({ length: n }, (_, i) => periodShort(i + 1));
  const diff = (g.away.score ?? 0) - (g.home.score ?? 0);

  const row = (t, ls, lead) => {
    const cells = cols.map((_, i) => {
      const v = ls[i];
      const cls = [v === null || v === undefined ? "nil" : "", i === cur ? "cur" : ""].filter(Boolean).join(" ");
      return `<td${cls ? ` class="${cls}"` : ""}>${v === null || v === undefined ? DASH : esc(v)}</td>`;
    }).join("");
    return `<tr${lead ? ' class="lead"' : ""}><th scope="row" class="pl"><span class="dt-ls-team">${logoHTML(t, "sm")}<span>${esc(t.abbr)}</span></span></th>${cells}<td class="tot">${esc(t.score ?? DASH)}</td></tr>`;
  };

  const head = cols.map((h, i) => `<th scope="col"${i === cur ? ' class="cur"' : ""}>${esc(h)}</th>`).join("");
  return `<div class="card dt-ls">
    <div class="dt-x" data-sk="linescore">
      <table class="dt-tbl dt-lstbl">
        <thead><tr><th scope="col" class="pl"><span class="dt-sr">Team</span></th>${head}<th scope="col" class="tot">T</th></tr></thead>
        <tbody>${row(g.away, al, diff > 0)}${row(g.home, hl, diff < 0)}</tbody>
      </table>
    </div>
  </div>`;
}

// Win probability: plotted from the picked team's side when the leg is ML/spread
// (away pick = 1 - homeWinPercentage), otherwise home win%. Drawn in a 0-100 viewBox
// stretched to the box; text, the endpoint and gridlines are HTML so they stay crisp.
function winProbHTML(c) {
  const raw = Array.isArray(c.data.winprobability) ? c.data.winprobability : [];
  const wp = raw.filter((w) => w && w.homeWinPercentage !== null && w.homeWinPercentage !== undefined && Number.isFinite(Number(w.homeWinPercentage)));
  if (wp.length < 2) return "";
  const { g } = c;
  const top = c.pick || g.home;
  const bottom = top === g.home ? g.away : g.home;
  const flip = top === g.away;
  const ps = wp.map((w) => {
    const h = clamp01(Number(w.homeWinPercentage));
    return flip ? 1 - h : h;
  });
  const n = ps.length;
  const X = (i) => (i / (n - 1)) * 100;
  const Y = (p) => (1 - p) * 100;
  const pts = ps.map((p, i) => `${f2(X(i))},${f2(Y(p))}`).join("L");
  const line = `M${pts}`;
  const area = `M0,50L${pts}L100,50Z`;
  const last = ps[n - 1];
  const ly = Y(last);

  // Quarter boundaries, by matching win-prob play ids to the drives' plays.
  const periods = playPeriods(c.data);
  const marks = [];
  let prevP = null;
  wp.forEach((w, i) => {
    const p = periods.get(String(w.playId));
    if (p === undefined) return;
    if (prevP !== null && p > prevP) marks.push({ x: X(i), label: periodShort(p) });
    prevP = p;
  });

  const neutral = !c.pick;
  const tone = neutral ? "neutral" : last >= 0.5 ? "up" : "dn";
  const id = c.uid;
  const name = top.short || top.abbr;
  return `<div class="card dt-wp${neutral ? " neutral" : ""}${c.live ? " live" : ""}">
    <div class="dt-h"><h3 class="eyebrow">Win probability</h3><span class="dt-h-aux">${esc(neutral ? `${top.abbr} (home)` : `${top.abbr}, your pick`)}</span></div>
    <div class="dt-wp-chart">
      <div class="dt-wp-axis" aria-hidden="true"><span class="t">${esc(top.abbr)}</span><span class="m">50%</span><span class="b">${esc(bottom.abbr)}</span></div>
      <div class="dt-wp-plot" role="img" aria-label="${esc(`${name} win probability ${fmtPct(last)}`)}">
        <span class="dt-wp-mid"></span>
        ${marks.length ? `<span class="dt-wp-q first" style="left:0%"><span>Q1</span></span>` : ""}
        ${marks.map((m) => `<span class="dt-wp-q" style="left:${f2(m.x)}%"><span>${esc(m.label)}</span></span>`).join("")}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs>
            <clipPath id="${id}-up"><rect x="-2" y="-2" width="104" height="52"/></clipPath>
            <clipPath id="${id}-dn"><rect x="-2" y="50" width="104" height="52"/></clipPath>
          </defs>
          <path class="area up" d="${area}" clip-path="url(#${id}-up)"/>
          <path class="area dn" d="${area}" clip-path="url(#${id}-dn)"/>
          <path class="ln up" d="${line}" clip-path="url(#${id}-up)" vector-effect="non-scaling-stroke"/>
          <path class="ln dn" d="${line}" clip-path="url(#${id}-dn)" vector-effect="non-scaling-stroke"/>
        </svg>
        <span class="dt-wp-dot ${tone}" style="top:${f2(ly)}%"></span>
        <span class="dt-wp-val ${tone}${ly < 26 ? " below" : ""}" style="top:${f2(ly)}%">${esc(fmtPct(last))}</span>
      </div>
    </div>
  </div>`;
}

function availableTabs(c) {
  const bs = c.data.boxscore || {};
  const hasTeam = (bs.teams || []).some((t) => (t?.statistics || []).length);
  const hasPlayers = (bs.players || []).some((p) => (p?.statistics || []).some((s) => (s?.athletes || []).length));
  const hasScoring = (c.data.scoringPlays || []).length > 0;
  const d = c.data.drives || {};
  const hasDrives = (Array.isArray(d.previous) && d.previous.length > 0) || !!(d.current && d.current.id !== undefined);
  if (c.pre) return hasTeam ? [{ key: "box", label: "Season stats" }] : [];
  const keep = (has) => has || c.live;
  return [
    keep(hasTeam) && { key: "box", label: "Box score" },
    keep(hasPlayers) && { key: "players", label: "Players" },
    keep(hasScoring) && { key: "scoring", label: "Scoring" },
    keep(hasDrives) && { key: "drives", label: "Drives" },
  ].filter(Boolean);
}

function tabsHTML(c) {
  const tabs = availableTabs(c);
  if (!tabs.length) return "";
  const cur = tabs.some((t) => t.key === c.ui.tab) ? c.ui.tab : tabs[0].key;
  const render = { box: boxHTML, players: playersHTML, scoring: scoringHTML, drives: drivesHTML }[cur];
  const btns = tabs.map((t) => {
    const on = t.key === cur;
    return `<button type="button" role="tab" class="dt-tab" id="${c.uid}-tab-${t.key}" aria-controls="${c.uid}-panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-act="tab" data-tab="${t.key}" data-fk="tab-${t.key}">${esc(t.label)}</button>`;
  }).join("");
  return `<div class="card dt-tabcard">
    <div class="dt-tabs" role="tablist" aria-label="Game details">${btns}</div>
    <div class="dt-panel" role="tabpanel" id="${c.uid}-panel" aria-labelledby="${c.uid}-tab-${cur}">${render(c)}</div>
  </div>`;
}

// --- Box score tab ---

function boxHTML(c) {
  const teams = c.data.boxscore?.teams || [];
  const A = statMap(findTeamBlock(teams, c.g.away, "away", 0));
  const H = statMap(findTeamBlock(teams, c.g.home, "home", 1));
  if (!A.size && !H.size) return emptyHTML("Team stats show up after the first snap.");

  const seen = new Set();
  const rows = [];
  const push = (name, label, minor) => {
    if (seen.has(name)) return;
    const a = A.get(name);
    const h = H.get(name);
    if (!a && !h) return;
    seen.add(name);
    rows.push(cmpRow(c, label || a?.label || h?.label || name, a, h, name, minor));
  };
  BOX_MAIN.forEach(([n, l]) => push(n, l, false));
  BOX_MINOR.forEach(([n, l]) => push(n, l, true));
  for (const n of new Set([...A.keys(), ...H.keys()])) push(n, null, !c.pre);

  const team = (t, cls) => `<span class="dt-cmp-team ${cls}${c.pick === t ? " mine" : ""}">${logoHTML(t, "sm")}<span>${esc(t.abbr)}</span></span>`;
  return `<div class="dt-cmp">
    <div class="dt-cmp-h">${team(c.g.away, "a")}<span class="eyebrow">${c.pre ? "Season, per game" : "Team stats"}</span>${team(c.g.home, "h")}</div>
    ${rows.join("")}
  </div>`;
}

function statMap(block) {
  const m = new Map();
  for (const s of block?.statistics || []) {
    if (!s || !s.name) continue;
    m.set(s.name, { label: s.label || s.name, display: String(s.displayValue ?? "").trim(), value: s.value });
  }
  return m;
}

function findTeamBlock(list, team, side, idx) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find((b) => b && String(b.team?.id) === team.id)
    || list.find((b) => b && b.homeAway === side)
    || list[idx]
    || null;
}

// A number to size the comparison bar with, or null when the stat isn't comparable.
function statNumber(s, name) {
  const dv = s.display;
  let m;
  if (/Eff$/.test(name) && (m = /^(\d+)\s*-\s*(\d+)$/.exec(dv))) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : 0;
  if (typeof s.value === "number" && Number.isFinite(s.value)) return s.value;
  if (/^-?\d+(\.\d+)?$/.test(dv)) return parseFloat(dv);
  if ((m = /^(\d+):(\d{2})$/.exec(dv))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d+)\s*[-/]\s*\d+$/.exec(dv))) return Number(m[1]);
  return null;
}

function cmpRow(c, label, a, h, name, minor) {
  const an = a ? statNumber(a, name) : null;
  const hn = h ? statNumber(h, name) : null;
  let bar = "";
  if (an !== null && hn !== null && an >= 0 && hn >= 0 && an + hn > 0) {
    const cls = (side) => (c.pick ? (c.pick === c.g[side] ? "mine" : "") : side);
    bar = `<span class="dt-bar" aria-hidden="true"><i class="${cls("away")}" style="flex-grow:${f2(an)}"></i><i class="${cls("home")}" style="flex-grow:${f2(hn)}"></i></span>`;
  }
  return `<div class="dt-cmp-row${minor ? " minor" : ""}">
    <span class="dt-cmp-v a num">${esc(a?.display || DASH)}</span>
    <span class="dt-cmp-l">${esc(label)}</span>
    <span class="dt-cmp-v h num">${esc(h?.display || DASH)}</span>
    ${bar}
  </div>`;
}

// --- Players tab ---

function playersHTML(c) {
  const blocks = c.data.boxscore?.players || [];
  const side = c.ui.side || (c.pick === c.g.home ? "home" : "away");
  const team = c.g[side];
  const block = findTeamBlock(blocks, team, side, side === "away" ? 0 : 1);
  const order = (name) => {
    const i = CAT_ORDER.indexOf(name);
    return i === -1 ? 99 : i;
  };
  const cats = (block?.statistics || [])
    .filter((s) => s && (s.athletes || []).length && (s.labels || []).length)
    .sort((x, y) => order(x.name) - order(y.name));

  const toggle = `<div class="dt-seg" role="group" aria-label="Team">${["away", "home"].map((s) => `<button type="button" class="dt-seg-b" aria-pressed="${s === side}" data-act="side" data-side="${s}" data-fk="side-${s}">${logoHTML(c.g[s], "sm")}<span>${esc(c.g[s].abbr || c.g[s].short)}</span></button>`).join("")}</div>`;
  const tables = cats.map((cat) => catTable(cat, side)).join("");
  return toggle + (tables || emptyHTML(`No ${team.short || team.abbr} player stats yet.`));
}

function catTable(cat, side) {
  const labels = cat.labels || [];
  const desc = cat.descriptions || [];
  const head = labels.map((l, i) => `<th scope="col"${desc[i] ? ` title="${esc(desc[i])}"` : ""}>${esc(l)}</th>`).join("");
  const rows = cat.athletes.map((a) => {
    const p = a?.athlete || {};
    const stats = a?.stats || [];
    const jersey = p.jersey ? `<span class="dt-jr">#${esc(p.jersey)}</span>` : "";
    return `<tr><th scope="row" class="pl"><span class="dt-pn" title="${esc(p.displayName || "")}">${esc(shortName(p))}</span>${jersey}</th>${labels.map((_, i) => `<td>${esc(stats[i] ?? "")}</td>`).join("")}</tr>`;
  }).join("");
  // A totals row only adds information when more than one player is listed.
  const totals = Array.isArray(cat.totals) && cat.totals.length && cat.athletes.length > 1
    ? `<tfoot><tr><th scope="row" class="pl">Team</th>${labels.map((_, i) => `<td>${esc(cat.totals[i] ?? "")}</td>`).join("")}</tr></tfoot>`
    : "";
  const title = CAT_TITLE[cat.name] || cat.text || cat.name || "";
  return `<div class="dt-cat">
    <h3 class="eyebrow dt-cat-h">${esc(title)}</h3>
    <div class="dt-x" data-sk="pl-${side}-${esc(cat.name || "")}">
      <table class="dt-tbl dt-ptbl"><thead><tr><th scope="col" class="pl">Player</th>${head}</tr></thead><tbody>${rows}</tbody>${totals}</table>
    </div>
  </div>`;
}

function shortName(p) {
  if (p.shortName) return p.shortName;
  if (p.firstName && p.lastName) return `${p.firstName.charAt(0)}. ${p.lastName}`;
  return p.displayName || "";
}

// --- Scoring tab ---

function scoringHTML(c) {
  const plays = (c.data.scoringPlays || []).filter(Boolean);
  if (!plays.length) return emptyHTML(c.live ? "No points yet." : "No scoring plays.");
  const groups = new Map();
  for (const p of plays) {
    const n = Number(p.period?.number) || 0;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(p);
  }
  const { away, home } = c.g;
  let first = true;
  const out = [];
  for (const [n, list] of groups) {
    out.push(`<div class="dt-q">
      <div class="dt-q-h"><h3 class="eyebrow">${esc(periodLong(n))}</h3>${first ? `<span class="eyebrow num">${esc(away.abbr)} ${DASH} ${esc(home.abbr)}</span>` : ""}</div>
      <ol class="dt-sp-list">${list.map((p) => scoringRow(c, p)).join("")}</ol>
    </div>`);
    first = false;
  }
  return out.join("");
}

function scoringRow(c, p) {
  const team = teamById(c.g, p.team?.id) || teamLite(p.team);
  const isAway = !!team && team.id === c.g.away.id;
  const isHome = !!team && team.id === c.g.home.id;
  const type = p.scoringType?.abbreviation || p.type?.abbreviation || p.type?.text || "";
  const score = (v) => (v === null || v === undefined ? DASH : esc(v));
  return `<li class="dt-sp">
    <span class="dt-sp-logo">${team ? logoHTML(team, "sm") : ""}</span>
    <div class="dt-sp-main">
      <div class="dt-sp-meta">${type ? `<span class="dt-sp-type${/^TD$/i.test(type) ? " td" : ""}">${esc(type)}</span>` : ""}<span class="num">${esc(p.clock?.displayValue || "")}</span>${team ? `<span>${esc(team.abbr)}</span>` : ""}</div>
      <p class="dt-sp-text">${esc(p.text || p.type?.text || "")}</p>
    </div>
    <span class="dt-sp-score num"><span${isAway ? ' class="hl"' : ""}>${score(p.awayScore)}</span>${DASH}<span${isHome ? ' class="hl"' : ""}>${score(p.homeScore)}</span></span>
  </li>`;
}

// --- Drives tab ---

function drivesHTML(c) {
  const d = c.data.drives || {};
  const prev = Array.isArray(d.previous) ? d.previous.filter(Boolean) : [];
  const cur = d.current && d.current.id !== undefined && d.current.id !== null ? d.current : null;
  const curId = cur ? String(cur.id) : null;
  const items = [];
  if (cur) items.push([cur, c.live]);
  // ESPN also lists the current drive at the end of `previous`; show it once, on top.
  for (let i = prev.length - 1; i >= 0; i--) {
    if (String(prev[i].id) !== curId) items.push([prev[i], false]);
  }
  if (!items.length) return emptyHTML(c.live ? "Waiting on the first drive." : "No drive data.");
  return `<ol class="dt-drives">${items.map(([dr, live]) => driveHTML(c, dr, live)).join("")}</ol>`;
}

function driveHTML(c, dr, live) {
  const id = String(dr.id ?? "");
  const team = teamById(c.g, dr.team?.id) || teamLite(dr.team);
  const open = c.ui.open.has(id) ? c.ui.open.get(id) : live;
  const res = dr.shortDisplayResult || dr.result || dr.displayResult || "";
  const kind = dr.isScore ? "score" : DRIVE_FAIL.test(res) ? "fail" : "";
  const pid = `${c.uid}-dp-${id}`;
  const sp = dr.start?.period?.number;
  const when = sp ? `${periodShort(sp)} ${dr.start?.clock?.displayValue || ""}`.trim() : "";
  const path = [dr.start?.text, dr.end?.text].filter(Boolean).map(esc).join(" \u2192 ");
  const plays = Array.isArray(dr.plays) ? dr.plays.filter(Boolean) : [];
  const list = open
    ? `<ol class="dt-plays" id="${esc(pid)}">${plays.length ? plays.map(playHTML).join("") : '<li class="dt-play dt-empty-play">No play-by-play yet.</li>'}</ol>`
    : "";
  return `<li class="dt-drive${live ? " live" : ""}${open ? " open" : ""}">
    <button type="button" class="dt-drive-h" data-act="drive" data-id="${esc(id)}" data-fk="drive-${esc(id)}" aria-expanded="${open}"${open ? ` aria-controls="${esc(pid)}"` : ""}>
      <span class="dt-drive-logo">${team ? logoHTML(team, "sm") : ""}</span>
      <span class="dt-drive-main">
        <span class="dt-drive-top">${res ? `<span class="dt-res ${kind}">${esc(res)}</span>` : ""}${live ? '<span class="chip live">Live</span>' : ""}${team ? `<span class="dt-drive-team">${esc(team.abbr)}</span>` : ""}${when ? `<span class="dt-drive-when num">${esc(when)}</span>` : ""}</span>
        ${dr.description ? `<span class="dt-drive-desc num">${esc(dr.description)}</span>` : ""}
        ${path ? `<span class="dt-drive-path num">${path}</span>` : ""}
      </span>
      <span class="dt-chev">${ICON.chev}</span>
    </button>
    ${list}
  </li>`;
}

function playHTML(p) {
  const when = [p.period?.number ? periodShort(p.period.number) : "", p.clock?.displayValue || ""].filter(Boolean).join(" ");
  const dd = p.start?.downDistanceText || "";
  const cls = ["dt-play", p.scoringPlay ? "scoring" : "", p.isTurnover ? "turnover" : ""].filter(Boolean).join(" ");
  return `<li class="${cls}">
    <div class="dt-play-meta">${when ? `<span class="num">${esc(when)}</span>` : ""}${dd ? `<span>${esc(dd)}</span>` : ""}${p.scoringPlay && p.type?.abbreviation ? `<span class="dt-play-tag">${esc(p.type.abbreviation)}</span>` : ""}</div>
    <p class="dt-play-text">${esc(p.text || p.type?.text || "")}</p>
  </li>`;
}

// --- Game info ---

function infoHTML(c) {
  const { g, data } = c;
  const rows = [];
  const o = g.odds;
  if (o && (o.details || isNum(o.overUnder))) {
    const main = [o.details || "", isNum(o.overUnder) ? `O/U ${fmtLine(o.overUnder, false)}` : ""].filter(Boolean).join(DOT);
    const sub = [
      isNum(o.awayML) && isNum(o.homeML) ? `ML ${g.away.abbr} ${fmtOdds(o.awayML)}${DOT}${g.home.abbr} ${fmtOdds(o.homeML)}` : "",
      o.provider ? `via ${o.provider}` : "",
    ].filter(Boolean).join(DOT);
    rows.push(["Line", `<span class="dt-strong num">${esc(main)}</span>${sub ? `<span class="dt-sub num">${esc(sub)}</span>` : ""}`]);
  }
  if (c.pre && data.predictor) {
    const pr = data.predictor;
    const byId = (id) => [pr.awayTeam, pr.homeTeam].find((t) => t && String(t.id) === id);
    const av = Number(byId(g.away.id)?.gameProjection);
    const hv = Number(byId(g.home.id)?.gameProjection);
    if (Number.isFinite(av) && Number.isFinite(hv) && (av > 0 || hv > 0)) {
      rows.push(["ESPN FPI", `<span class="num">${esc(g.away.abbr)} ${esc(trim1(av))}%${DOT}${esc(g.home.abbr)} ${esc(trim1(hv))}%</span>`]);
    }
  }
  if (g.date) {
    const tbd = data.header?.timeValid === false;
    const when = tbd ? `${longDay(g.date)}${DOT}time TBD` : fullDate(g.date);
    if (when) rows.push(["Kickoff", esc(when)]);
  }
  if (g.broadcast) rows.push(["TV", esc(g.broadcast)]);
  if (g.venue) rows.push(["Venue", `${esc(g.venue)}${g.neutral ? '<span class="dt-sub">Neutral site</span>' : ""}`]);
  if (g.attendance) rows.push(["Attendance", `<span class="num">${esc(Number(g.attendance).toLocaleString())}</span>`]);
  const wx = weatherText(data, g);
  if (wx) rows.push(["Weather", esc(wx)]);
  if (!rows.length) return "";
  return `<div class="card dt-info">
    <h3 class="eyebrow dt-h">Game info</h3>
    <dl class="dt-dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
  </div>`;
}

// gameInfo.weather has no displayValue in these payloads; conditionId is sometimes text
// ("Mostly cloudy") and sometimes a numeric code, which is skipped.
function weatherText(data, g) {
  const w = data.gameInfo?.weather;
  if (!w) return g.weather?.text || null;
  const parts = [];
  const temp = Number(w.temperature);
  if (w.temperature !== null && w.temperature !== undefined && Number.isFinite(temp)) parts.push(`${Math.round(temp)}\u00b0F`);
  const cond = w.displayValue || (typeof w.conditionId === "string" && w.conditionId && !/^\d+$/.test(w.conditionId) ? w.conditionId : "");
  if (cond) parts.push(cond);
  const gust = Number(w.gust);
  if (w.gust !== null && w.gust !== undefined && Number.isFinite(gust) && gust > 0) parts.push(`gusts ${Math.round(gust)} mph`);
  return parts.join(DOT) || null;
}

function emptyHTML(text) {
  return `<p class="dt-empty">${esc(text)}</p>`;
}

// ---------- helpers ----------

function playPeriods(data) {
  const map = new Map();
  const d = data.drives || {};
  const all = [...(Array.isArray(d.previous) ? d.previous : []), d.current].filter(Boolean);
  for (const dr of all) {
    for (const p of dr.plays || []) {
      const n = Number(p?.period?.number);
      if (p && p.id !== undefined && Number.isFinite(n)) map.set(String(p.id), n);
    }
  }
  return map;
}

// Minimal team object (for logoHTML) from a drive/scoring-play team when it is not one of the
// game's two teams. URLs are escaped here because logoHTML writes them into attributes as-is.
function teamLite(t) {
  if (!t || t.id === undefined || t.id === null) return null;
  const logos = Array.isArray(t.logos) ? t.logos : [];
  const rel = (r) => logos.find((l) => Array.isArray(l?.rel) && l.rel.includes(r))?.href;
  const logo = t.logo || rel("default") || logos[0]?.href || `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.id}.png`;
  const dark = rel("dark") || (logo.includes("/500/") ? logo.replace("/500/", "/500-dark/") : logo);
  return {
    id: String(t.id),
    abbr: t.abbreviation || "",
    short: t.shortDisplayName || t.displayName || t.abbreviation || "",
    logo: esc(logo),
    logoDark: esc(dark),
  };
}

function liveClock(g) {
  if (/HALFTIME/.test(g.statusName)) return "Halftime";
  if (/END_PERIOD/.test(g.statusName)) return g.detail || `End of ${periodShort(g.period)}`;
  if (/DELAY/.test(g.statusName)) return g.detail || "Delayed";
  const p = g.period ? periodShort(g.period) : "";
  if (g.clock && p) return `${p}${DOT}${g.clock}`;
  return g.detail || p || "Live";
}

function finalText(g) {
  if (!g.completed) return g.detail || "Postponed";
  const d = g.detail || "Final";
  if (/^final$/i.test(d) && g.period > 4) return g.period === 5 ? "Final/OT" : `Final/${g.period - 4}OT`;
  return d;
}

function periodShort(n) {
  n = Number(n) || 0;
  if (n <= 4) return `Q${n}`;
  return n === 5 ? "OT" : `${n - 4}OT`;
}

function periodLong(n) {
  if (n >= 1 && n <= 4) return `${ordinal(n)} Quarter`;
  if (n === 5) return "Overtime";
  if (n > 5) return `${ordinal(n - 4)} Overtime`;
  return "Other";
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${s}`;
}

function clockTime(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function validDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fullDate(iso) {
  const d = validDate(iso);
  return d ? d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

function longDay(iso) {
  const d = validDate(iso);
  return d ? d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "";
}

function shortDay(iso) {
  const d = validDate(iso);
  return d ? d.toLocaleDateString([], { weekday: "short" }) : "";
}

function fmtPct(p) {
  const v = p * 100;
  if (v > 99.5 && v < 100) return ">99%";
  if (v > 0 && v < 0.5) return "<1%";
  return `${Math.round(v)}%`;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function trim1(v) {
  return String(Math.round(v * 10) / 10);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function f2(v) {
  return String(Math.round(v * 100) / 100);
}

function cssEscape(s) {
  const str = String(s ?? "");
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(str) : str.replace(/["\\]/g, "\\$&");
}
