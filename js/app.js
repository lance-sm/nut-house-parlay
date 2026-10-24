import { fetchScoreboardDay, fetchSummary, etDateKey, kickoffText, logoHTML, escapeHTML } from "./espn.js";
import { gradeLeg, gradeParlay, legLabel, fmtOdds, parlayPrice, decimalToAmerican } from "./grade.js";
import {
  loadSeasonLog, localParlays, saveLocal, mergeParlays, getCurrentId, setCurrentId,
  cachedResults, cacheResult, decodeParlay, shareURL,
} from "./store.js";

const LIVE_MS = 20_000;
const IDLE_MS = 60_000;

const $ = (id) => document.getElementById(id);
const state = {
  parlays: [],
  current: null,
  games: new Map(),     // event id -> normalized game
  updatedAt: null,
  error: null,
  timer: null,
  sheet: null,          // { el, handle, kind }
  sheetViaNav: false,   // true when the open sheet came from an in-site tap (so Back can pop it)
  scout: null,          // mounted Scouting tab, created on first visit
};

// ---------- data ----------

function dayKeysFor(parlay) {
  const keys = new Set();
  for (const leg of parlay.legs) if (leg.k) keys.add(etDateKey(leg.k));
  return [...keys];
}

async function refresh() {
  const parlay = state.current;
  if (!parlay) return;
  try {
    const days = await Promise.all(dayKeysFor(parlay).map(fetchScoreboardDay));
    const games = new Map();
    for (const list of days) for (const g of list) games.set(g.id, g);
    // Legs ESPN didn't put on the FBS board (FCS-only games, or legs saved without a kickoff).
    const missing = parlay.legs.filter((l) => !games.has(String(l.e)));
    const extra = await Promise.all(missing.map((l) => fetchSummary(l.e).then((d) => d.game).catch(() => null)));
    for (const g of extra) if (g) games.set(g.id, g);
    if (parlay !== state.current) return; // switched weeks mid-fetch
    state.games = games;
    state.updatedAt = new Date();
    state.error = null;
    const result = gradeParlay(parlay.legs, games);
    if (result.status === "cashed" || result.status === "busted" || result.status === "push") {
      if (result.settled === result.total) cacheResult(parlay.id, result.status);
    }
  } catch (err) {
    state.error = err.message || "Couldn't reach ESPN";
  }
  render();
  schedule();
}

function schedule() {
  clearTimeout(state.timer);
  if (document.hidden || !state.current) return;
  const games = state.current.legs.map((l) => state.games.get(String(l.e))).filter(Boolean);
  const soon = Date.now() + 15 * 60_000;
  const live = games.some((g) => g.state === "in" || (g.state === "pre" && new Date(g.date).getTime() < soon));
  const pending = games.length < state.current.legs.length || games.some((g) => g.state !== "post");
  if (state.error) state.timer = setTimeout(refresh, LIVE_MS);
  else if (live) state.timer = setTimeout(refresh, LIVE_MS);
  else if (pending) state.timer = setTimeout(refresh, IDLE_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(state.timer);
  else refresh();
});

// ---------- render ----------

const VERDICT = {
  pending: "Waiting on kickoff",
  alive: "Still alive",
  cashed: "Cashed",
  busted: "Bozo’d",
  push: "Pushed",
};

function sortedLegs(parlay) {
  return parlay.legs
    .map((leg, i) => ({ leg, i }))
    .sort((a, b) => (a.leg.k || "").localeCompare(b.leg.k || "") || a.i - b.i)
    .map((x) => x.leg);
}

function render() {
  renderWeekSelect();
  const parlay = state.current;
  $("share-btn").hidden = !parlay;
  $("edit-btn").hidden = !parlay;

  if (!parlay) {
    $("verdict-word").textContent = "No parlay yet";
    $("verdict-word").className = "verdict-word";
    $("verdict-line").textContent = "";
    $("meter").innerHTML = "";
    $("money").hidden = true;
    $("legs").innerHTML = `<li class="card empty"><h2>Nothing on the ticket</h2><p>Search this week's games, add the six legs, and share the link in the group chat.</p><button class="btn primary" type="button" data-action="new">Build this week's parlay</button></li>`;
    $("updated").textContent = "";
    return;
  }

  const legs = sortedLegs(parlay);
  const result = gradeParlay(legs, state.games);

  const word = $("verdict-word");
  word.textContent = state.games.size ? VERDICT[result.status] : "Loading…";
  word.className = `verdict-word ${result.status}`;
  $("verdict-line").textContent = summaryLine(result);

  $("meter").innerHTML = result.grades.map((g) => `<span class="${g.tone}"></span>`).join("");
  renderMoney(parlay, legs, result);

  $("legs").innerHTML = legs.map((leg, i) => legHTML(leg, state.games.get(String(leg.e)), result.grades[i])).join("");

  const upd = $("updated");
  if (state.error) upd.innerHTML = `<span class="error-text">${escapeHTML(state.error)}. Retrying…</span>`;
  else if (state.updatedAt) {
    const anyLive = legs.some((l) => state.games.get(String(l.e))?.state === "in");
    upd.textContent = `Updated ${state.updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}${anyLive ? " · refreshing every 20s" : ""}`;
  }
}

function summaryLine(r) {
  const bits = [];
  if (r.won) bits.push(`${r.won} hit`);
  if (r.winning) bits.push(`${r.winning} hitting`);
  if (r.even) bits.push(`${r.even} even`);
  if (r.losing) bits.push(`${r.losing} losing`);
  if (r.lost) bits.push(`${r.lost} missed`);
  if (r.push) bits.push(`${r.push} push`);
  if (r.pending) bits.push(`${r.pending} to play`);
  return bits.join(" · ");
}

function money(n) {
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function renderMoney(parlay, legs, result) {
  const el = $("money");
  const bits = [];
  const dec = parlayPrice(legs, result.grades);
  const american = dec ? decimalToAmerican(dec) : null;
  if (american) bits.push(`Odds <b>${fmtOdds(american)}</b>`);
  if (parlay.stake) bits.push(`Stake <b>${money(parlay.stake)}</b>`);
  if (parlay.payout) bits.push(`Pays <b>${money(parlay.payout)}</b>`);
  else if (parlay.stake && dec) bits.push(`Pays <b>${money(Math.round(parlay.stake * dec * 100) / 100)}</b>`);
  el.innerHTML = bits.map((b) => `<span>${b}</span>`).join("");
  el.hidden = bits.length === 0;
}

function teamLine(team, game, leg) {
  const mine = leg.t !== "total" && team.id === String(leg.s);
  const poss = game.state === "in" && game.situation?.possession === team.id ? `<span class="poss" title="Has the ball">◀</span>` : "";
  const other = team.id === game.home.id ? game.away : game.home;
  const lead = game.state !== "pre" && team.score !== null && other.score !== null
    ? (team.score > other.score ? "lead" : team.score < other.score ? "trail" : "") : "";
  return `
    <span class="team-line${mine ? " mine" : ""}">${logoHTML(team, "sm")}${team.rank ? `<span class="rank">${team.rank}</span>` : ""}<span class="tname">${escapeHTML(team.short)}</span>${poss}</span>
    <span class="score ${lead}">${game.state === "pre" ? "" : team.score ?? ""}</span>`;
}

function clockHTML(game) {
  if (game.state === "pre") {
    return `${game.broadcast ? `<span>${escapeHTML(game.broadcast)}</span>` : ""}${game.odds?.details ? `<span>${escapeHTML(game.odds.details)}${game.odds.overUnder ? ` · O/U ${game.odds.overUnder}` : ""}</span>` : ""}`;
  }
  if (game.state === "in") {
    const s = game.situation;
    return `<span class="chip live">${escapeHTML(game.detail)}</span>${s?.downDistance ? `<span class="dd">${escapeHTML(s.downDistance)}</span>` : ""}${s?.isRedZone ? `<span class="rz">${escapeHTML([game.home, game.away].find((t) => t.id === s.possession)?.abbr || "")} red zone</span>` : ""}${game.broadcast ? `<span>${escapeHTML(game.broadcast)}</span>` : ""}`;
  }
  return `<span>${escapeHTML(game.detail || "Final")}</span>`;
}

function legHTML(leg, game, grade) {
  const label = legLabel(leg, game);
  const odds = leg.o ? `<span class="odds">${fmtOdds(leg.o)}</span>` : "";
  const chipText = grade.tone === "pending" && game?.state === "pre" ? kickoffText(game.date) : grade.text;
  const chip = `<span class="chip ${grade.tone}">${escapeHTML(chipText)}</span>`;
  if (!game) {
    return `<li><a class="leg" data-tone="pending" href="#g=${encodeURIComponent(leg.e)}">
      <span class="leg-pick">${escapeHTML(label)} ${odds}</span><span class="leg-status">${chip}</span>
      <span class="leg-sub">${escapeHTML(leg.g || "")}</span></a></li>`;
  }
  return `<li><a class="leg" data-tone="${grade.tone}" href="#g=${encodeURIComponent(leg.e)}" aria-label="${escapeHTML(label)}: ${escapeHTML(grade.text)}. Open game details">
    <span class="leg-pick">${escapeHTML(label)} ${odds}</span>
    <span class="leg-status">${chip}</span>
    <span class="score-row">${teamLine(game.away, game, leg)}${teamLine(game.home, game, leg)}</span>
    <span class="game-clock">${clockHTML(game)}${grade.sub ? `<span>${escapeHTML(grade.sub)}</span>` : ""}<span class="leg-detail-hint" style="margin-left:auto">Box score ›</span></span>
  </a></li>`;
}

function renderWeekSelect() {
  const sel = $("week-select");
  const results = cachedResults();
  const label = (p) => {
    const r = results[p.id];
    const tag = r === "cashed" ? " · cashed" : r === "busted" ? " · bozo’d" : r === "push" ? " · push" : "";
    const d = p.date ? new Date(`${p.date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    return `${p.name}${d ? ` · ${d}` : ""}${tag}${p.source === "local" ? " (this device)" : ""}`;
  };
  sel.innerHTML = state.parlays.map((p) => `<option value="${escapeHTML(p.id)}"${p === state.current ? " selected" : ""}>${escapeHTML(label(p))}</option>`).join("");
  sel.hidden = state.parlays.length === 0;

  const settled = state.parlays.map((p) => results[p.id]).filter(Boolean);
  const w = settled.filter((r) => r === "cashed").length;
  const l = settled.filter((r) => r === "busted").length;
  $("season-record").textContent = settled.length ? `Season ${w}–${l}` : "";
}

function banner(html, kind = "") {
  $("banner").innerHTML = html ? `<div class="banner ${kind}">${html}</div>` : "";
}

// ---------- selection ----------

function selectParlay(id) {
  const p = state.parlays.find((x) => x.id === id) || state.parlays[0] || null;
  state.current = p;
  state.games = new Map();
  state.updatedAt = null;
  if (p) setCurrentId(p.id);
  render();
  refresh();
  state.scout?.update({ parlays: state.parlays, currentParlay: state.current });
}

// ---------- tabs ----------

const TAB_KEY = "nh.tab.v1";

async function showTab(tab) {
  for (const btn of document.querySelectorAll(".tab")) btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  $("ticket-view").hidden = tab !== "ticket";
  $("scout-view").hidden = tab !== "scout";
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* fine */ }
  if (tab !== "scout" || state.scout) return;
  try {
    const { mountScout } = await import("./scout.js");
    state.scout = mountScout($("scout-view"), {
      parlays: state.parlays,
      currentParlay: state.current,
      onOpenGame: (eventId) => { location.hash = `g=${encodeURIComponent(eventId)}`; },
    });
  } catch (err) {
    $("scout-view").innerHTML = `<p class="banner error">Couldn't load scouting: ${escapeHTML(err.message)}</p>`;
  }
}

for (const btn of document.querySelectorAll(".tab")) btn.addEventListener("click", () => showTab(btn.dataset.tab));

$("week-select").addEventListener("change", (e) => {
  banner("");
  selectParlay(e.target.value);
});

// ---------- sheets (game detail, builder) ----------

function openSheet(kind) {
  closeSheet();
  const el = document.createElement("div");
  el.className = "sheet";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  document.body.appendChild(el);
  document.body.style.overflow = "hidden";
  state.sheet = { el, handle: null, kind };
  return el;
}

function closeSheet() {
  if (!state.sheet) return;
  try { state.sheet.handle?.destroy(); } catch { /* module already torn down */ }
  state.sheet.el.remove();
  state.sheet = null;
  document.body.style.overflow = "";
}

function leaveSheet() {
  // Sheets are opened through the hash so the phone's back gesture closes them.
  // A sheet opened straight from a link has no in-site page to go back to.
  if (location.hash && state.sheetViaNav) history.back();
  else {
    history.replaceState(null, "", location.pathname + location.search);
    closeSheet();
  }
}

async function openDetail(eventId) {
  const el = openSheet("detail");
  const legs = state.current?.legs.filter((l) => String(l.e) === String(eventId)) || [];
  try {
    const { mountDetail } = await import("./detail.js");
    if (state.sheet?.el !== el) return;
    state.sheet.handle = mountDetail(el, { eventId, legs, onClose: leaveSheet });
  } catch (err) {
    el.innerHTML = `<div class="wrap sheet-body"><p class="banner error">Couldn't open the game view: ${escapeHTML(err.message)}</p><button class="btn" type="button" id="sheet-close">Back</button></div>`;
    el.querySelector("#sheet-close").onclick = leaveSheet;
  }
}

async function openBuilder(initial) {
  const el = openSheet("builder");
  try {
    const { mountBuilder } = await import("./builder.js");
    if (state.sheet?.el !== el) return;
    state.sheet.handle = mountBuilder(el, {
      initial,
      onCancel: leaveSheet,
      onSave: (parlay) => {
        saveLocal(parlay);
        state.parlays = mergeParlays(state.parlays.filter((p) => p.source === "log"), localParlays());
        leaveSheet();
        selectParlay(parlay.id);
        banner(`<span>Saved on this phone.</span><button class="btn" type="button" data-action="share">Share with the house</button>`);
      },
    });
  } catch (err) {
    el.innerHTML = `<div class="wrap sheet-body"><p class="banner error">Couldn't open the builder: ${escapeHTML(err.message)}</p><button class="btn" type="button" id="sheet-close">Back</button></div>`;
    el.querySelector("#sheet-close").onclick = leaveSheet;
  }
}

function route() {
  const h = location.hash.slice(1);
  if (h.startsWith("g=")) return openDetail(decodeURIComponent(h.slice(2)));
  if (h === "new") return openBuilder(null);
  if (h === "edit") return openBuilder(state.current);
  closeSheet();
}

// A #p= share link, consumed into this device's saved parlays.
function takeSharedLink() {
  if (!location.hash.startsWith("#p=")) return null;
  let incoming = null;
  try {
    incoming = decodeParlay(location.hash.slice(3));
    saveLocal(incoming);
  } catch {
    banner("That parlay link looks cut off. Ask for it again.", "error");
  }
  history.replaceState(null, "", location.pathname + location.search);
  return incoming;
}

function announceShared(p) {
  banner(`<span>Loaded <b>${escapeHTML(p.name)}</b> from a shared link. It's saved on this device now.</span>`);
}

window.addEventListener("hashchange", () => {
  const incoming = takeSharedLink();
  if (incoming) {
    state.parlays = mergeParlays(state.parlays.filter((p) => p.source === "log"), localParlays());
    selectParlay(incoming.id);
    announceShared(incoming);
    return;
  }
  state.sheetViaNav = true;
  route();
});

// ---------- actions ----------

async function share() {
  if (!state.current) return;
  const url = shareURL(state.current);
  const text = `${state.current.name} bozo parlay`;
  if (navigator.share) {
    try { await navigator.share({ title: text, url }); return; } catch { /* cancelled; fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    banner(`Link copied. Paste it in the group chat and everyone sees this ticket live.`);
  } catch {
    banner(`Copy this link: <input class="share-input" readonly value="${escapeHTML(url)}" onclick="this.select()">`);
  }
}

$("new-btn").addEventListener("click", () => { location.hash = "new"; });
$("edit-btn").addEventListener("click", () => { location.hash = "edit"; });
$("share-btn").addEventListener("click", share);
document.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "new") location.hash = "new";
  if (action === "share") share();
});

// ---------- boot ----------

async function boot() {
  const incoming = takeSharedLink();
  const log = await loadSeasonLog();
  state.parlays = mergeParlays(log, localParlays());
  const want = incoming?.id || getCurrentId();
  selectParlay(state.parlays.some((p) => p.id === want) ? want : state.parlays[0]?.id);
  if (incoming) announceShared(incoming);
  let tab = "ticket";
  try { tab = localStorage.getItem(TAB_KEY) === "scout" ? "scout" : "ticket"; } catch { /* fine */ }
  if (location.hash === "#scout") {
    tab = "scout";
    history.replaceState(null, "", location.pathname + location.search);
  }
  showTab(tab);
  state.sheetViaNav = false;
  route();
}

boot();
