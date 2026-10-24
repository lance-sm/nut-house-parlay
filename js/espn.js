// ESPN's public site API. Undocumented but CORS-open (access-control-allow-origin: *).
// Every game the app touches goes through normalizeGame() so the rest of the code sees one shape.

const BASE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

// ESPN buckets the scoreboard by US Eastern calendar day (a 10:15 PM ET kickoff is
// 02:15Z the next day but still lives under the Saturday date).
export function etDateKey(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}${get("month")}${get("day")}`;
}

// One calendar day of FBS games (groups=80 also includes FBS-vs-FCS games).
export async function fetchScoreboardDay(dateKey) {
  const data = await getJSON(`${BASE}/scoreboard?groups=80&limit=400&dates=${dateKey}`);
  return (data.events || []).map(normalizeGame);
}

// A whole week's slate. With no week, ESPN returns the current week.
// Returns { week, seasonType, year, games }.
export async function fetchWeekSlate({ week, seasonType = 2, year } = {}) {
  const params = new URLSearchParams({ groups: "80", limit: "400" });
  if (week) { params.set("week", week); params.set("seasontype", seasonType); }
  if (year) params.set("year", year);
  const data = await getJSON(`${BASE}/scoreboard?${params}`);
  return {
    week: data.week?.number ?? week ?? null,
    seasonType: data.season?.type ?? seasonType,
    year: data.season?.year ?? year ?? null,
    games: (data.events || []).map(normalizeGame),
  };
}

// Full game package: box score, drives, scoring plays, win probability, leaders...
// Returns the raw ESPN summary with a normalized `game` attached.
export async function fetchSummary(eventId) {
  const data = await getJSON(`${BASE}/summary?event=${eventId}`);
  data.game = normalizeSummaryGame(data);
  return data;
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function teamFrom(c) {
  const t = c.team || {};
  const logo = t.logo || t.logos?.[0]?.href || `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.id}.png`;
  const rank = c.curatedRank?.current ?? c.rank ?? null;
  const record = (c.records || c.record || []).find?.((r) => r.type === "total" || r.name === "overall" || r.type === "overall");
  return {
    id: String(t.id),
    abbr: t.abbreviation || "",
    name: t.displayName || t.name || "",
    short: t.shortDisplayName || t.location || t.displayName || "",
    location: t.location || "",
    mascot: t.name || "",
    logo,
    logoDark: logo.includes("/500/") ? logo.replace("/500/", "/500-dark/") : logo,
    color: t.color ? `#${t.color}` : null,
    altColor: t.alternateColor ? `#${t.alternateColor}` : null,
    score: num(c.score),
    rank: rank && rank < 99 ? rank : null,
    record: record?.summary || record?.displayValue || null,
    linescores: (c.linescores || []).map((l) => num(l.value ?? l.displayValue)),
    winner: c.winner === true,
  };
}

function oddsFrom(o, home, away) {
  if (!o) return null;
  const ml = o.moneyline || {};
  return {
    provider: o.provider?.displayName || o.provider?.name || null,
    details: o.details || null,                 // e.g. "KU -1.5"
    spread: num(o.spread),                      // from the HOME team's perspective
    overUnder: num(o.overUnder),
    homeML: num(ml.home?.close?.odds ?? o.homeTeamOdds?.moneyLine),
    awayML: num(ml.away?.close?.odds ?? o.awayTeamOdds?.moneyLine),
    homeId: home.id,
    awayId: away.id,
  };
}

function situationFrom(s) {
  if (!s) return null;
  return {
    possession: s.possession ? String(s.possession) : null,
    downDistance: s.downDistanceText || null,     // "2nd & 7 at KU 34"
    shortDownDistance: s.shortDownDistanceText || null,
    isRedZone: !!s.isRedZone,
    lastPlay: s.lastPlay?.text || null,
    homeTimeouts: num(s.homeTimeouts),
    awayTimeouts: num(s.awayTimeouts),
  };
}

function stateFrom(status) {
  const type = status?.type || {};
  return {
    state: type.state || "pre",                   // 'pre' | 'in' | 'post'
    completed: !!type.completed,
    statusName: type.name || "",                  // STATUS_FINAL, STATUS_POSTPONED, STATUS_HALFTIME...
    detail: type.shortDetail || type.detail || "",
    longDetail: type.detail || "",
    period: num(status?.period) ?? 0,
    clock: status?.displayClock || null,
    clockSeconds: num(status?.clock),
  };
}

export function normalizeGame(ev) {
  const c = ev.competitions?.[0] || {};
  const comps = c.competitors || [];
  const home = teamFrom(comps.find((x) => x.homeAway === "home") || comps[0] || {});
  const away = teamFrom(comps.find((x) => x.homeAway === "away") || comps[1] || {});
  const v = c.venue || {};
  const bc = (c.broadcasts || []).flatMap((b) => b.names || []);
  return {
    id: String(ev.id),
    date: ev.date || c.date,
    name: ev.name || "",
    shortName: ev.shortName || `${away.abbr} @ ${home.abbr}`,
    ...stateFrom(ev.status || c.status),
    home, away,
    neutral: !!c.neutralSite,
    odds: oddsFrom(c.odds?.[0], home, away),
    broadcast: bc.length ? bc.join(" / ") : (c.broadcast || null),
    venue: v.fullName ? [v.fullName, [v.address?.city, v.address?.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : null,
    situation: situationFrom(c.situation),
    weather: ev.weather ? { text: ev.weather.displayValue, temp: num(ev.weather.temperature) } : null,
  };
}

function normalizeSummaryGame(data) {
  const h = data.header || {};
  const c = h.competitions?.[0] || {};
  const comps = c.competitors || [];
  const home = teamFrom(comps.find((x) => x.homeAway === "home") || comps[0] || {});
  const away = teamFrom(comps.find((x) => x.homeAway === "away") || comps[1] || {});
  const gi = data.gameInfo || {};
  const v = gi.venue || {};
  const pick = data.pickcenter?.[0];
  const bc = (c.broadcasts || []).map((b) => b.media?.shortName).filter(Boolean);
  return {
    id: String(h.id),
    date: c.date,
    name: "",
    shortName: `${away.abbr} @ ${home.abbr}`,
    ...stateFrom(c.status),
    home, away,
    neutral: !!c.neutralSite,
    odds: pick ? {
      provider: pick.provider?.name || null,
      details: pick.details || null,
      spread: num(pick.spread),
      overUnder: num(pick.overUnder),
      homeML: num(pick.homeTeamOdds?.moneyLine),
      awayML: num(pick.awayTeamOdds?.moneyLine),
      homeId: home.id, awayId: away.id,
    } : null,
    broadcast: bc.length ? bc.join(" / ") : null,
    venue: v.fullName ? [v.fullName, [v.address?.city, v.address?.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : null,
    attendance: num(gi.attendance),
    situation: situationFrom(c.situation || data.situation),
    // gameInfo.weather.conditionId is sometimes text ("Mostly cloudy"), sometimes a numeric code.
    weather: gi.weather ? {
      text: gi.weather.displayValue || (isNaN(Number(gi.weather.conditionId)) ? gi.weather.conditionId : null) || null,
      temp: num(gi.weather.temperature),
    } : null,
  };
}

// Kickoff formatted in the viewer's own time zone.
export function kickoffText(iso, { withDay = true } = {}) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!withDay) return time;
  const day = d.toLocaleDateString([], { weekday: "short" });
  return `${day} ${time}`;
}

// Team logo that swaps to ESPN's dark-background variant in dark mode.
// cls: "" | "sm" | "lg" (sizes from base.css .logo)
export function logoHTML(team, cls = "") {
  const alt = escapeHTML(team.short || team.abbr || "");
  return `<picture class="logo ${cls}"><source media="(prefers-color-scheme: dark)" srcset="${team.logoDark}"><img class="logo ${cls}" src="${team.logo}" alt="${alt}" loading="lazy" onerror="this.style.visibility='hidden'"></picture>`;
}

export function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
