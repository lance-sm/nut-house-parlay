// Where parlays live:
//   parlays.json      the season log committed to the repo (everyone sees it)
//   localStorage      parlays built or opened on this device
//   #p=<code> links   a parlay packed into the URL so it can be dropped in the group chat

const LOCAL_KEY = "nh.parlays.v1";
const CURRENT_KEY = "nh.current.v1";
const RESULTS_KEY = "nh.results.v1";

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine */ }
}

export async function loadSeasonLog() {
  try {
    const res = await fetch("parlays.json", { cache: "no-cache" });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.parlays || []).map((p) => ({ ...p, source: "log" }));
  } catch {
    return [];
  }
}

export function localParlays() {
  return readLS(LOCAL_KEY, []).map((p) => ({ ...p, source: "local" }));
}

export function saveLocal(parlay) {
  const list = readLS(LOCAL_KEY, []).filter((p) => p.id !== parlay.id);
  const { source, ...clean } = parlay;
  list.push(clean);
  writeLS(LOCAL_KEY, list);
}

export function removeLocal(id) {
  writeLS(LOCAL_KEY, readLS(LOCAL_KEY, []).filter((p) => p.id !== id));
}

// The season log wins for ids it has, unless this device has an edited copy.
export function mergeParlays(log, local) {
  const byId = new Map(log.map((p) => [p.id, p]));
  for (const p of local) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id));
}

export function getCurrentId() { return readLS(CURRENT_KEY, null); }
export function setCurrentId(id) { writeLS(CURRENT_KEY, id); }

// Settled ticket results, so the season record doesn't refetch old weeks.
export function cachedResults() { return readLS(RESULTS_KEY, {}); }
export function cacheResult(id, status) {
  const all = readLS(RESULTS_KEY, {});
  all[id] = status;
  writeLS(RESULTS_KEY, all);
}

// ---------- share links ----------

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code) {
  const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeParlay(p) {
  const compact = {
    v: 1, i: p.id, m: p.name, d: p.date, s: p.stake ?? null, p: p.payout ?? null,
    L: p.legs.map((l) => [l.e, l.t, l.s, l.l ?? null, l.o ?? null, l.n ?? null, l.g ?? null, l.k ?? null]),
  };
  return toBase64Url(JSON.stringify(compact));
}

export function decodeParlay(code) {
  const c = JSON.parse(fromBase64Url(code));
  if (c.v !== 1 || !Array.isArray(c.L)) throw new Error("Unrecognized parlay link");
  return {
    id: String(c.i), name: c.m || "Parlay", date: c.d || null, stake: c.s ?? null, payout: c.p ?? null,
    legs: c.L.map(([e, t, s, l, o, n, g, k]) => ({ e: String(e), t, s: String(s), l, o, n, g, k })),
  };
}

export function shareURL(p) {
  return `${location.origin}${location.pathname}#p=${encodeParlay(p)}`;
}
