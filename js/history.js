// The book: every pick from the "Bozo Picks" sheet (data/history.json), all seasons.
//
// history.json holds the raw picks, one per player per week, already graded W/L/P on the
// sheet. Everything shown here (records, splits, streaks, solo kills) is counted from
// those picks on load; only the bios' written takes are stored.

import { avatarHTML } from "./crew.js?v=20261113a";
import { escapeHTML as esc } from "./espn.js?v=20261113a";

export async function loadHistory() {
  try {
    const res = await fetch("data/history.json?v=20261113a", { cache: "no-cache" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const blank = () => ({ w: 0, l: 0, p: 0 });
const add = (rec, r) => { if (r === "W") rec.w++; else if (r === "L") rec.l++; else if (r === "P") rec.p++; };
const games = (rec) => rec.w + rec.l + rec.p;
const pctOf = (rec) => (rec.w + rec.l ? rec.w / (rec.w + rec.l) : null);
const recText = (rec) => `${rec.w}–${rec.l}${rec.p ? `–${rec.p}` : ""}`;
const pctText = (rec) => { const p = pctOf(rec); return p === null ? "—" : `${Math.round(p * 100)}%`; };

function pickStyle(pick) {
  if (pick.kind === "ml") return "ml";
  if (pick.kind === "total") return "total";
  return pick.line < 0 ? "lay" : "take";
}

function pickTeams(pick) {
  return pick.kind === "total" ? [] : [pick.team];
}

// Count everything once. Returns { years, people: Map(id -> stats), group }.
export function crunch(doc) {
  const years = [...(doc?.years || [])].sort((a, b) => a.year - b.year);
  const people = new Map();
  const person = (id) => {
    if (!people.has(id)) {
      people.set(id, {
        id, all: blank(), byYear: new Map(), style: { lay: blank(), take: blank(), ml: blank(), total: blank() },
        overs: blank(), unders: blank(), teams: new Map(), seq: [], soloKills: 0, firstYear: null,
      });
    }
    return people.get(id);
  };
  const group = [];

  for (const y of years) {
    const weeks = [...y.weeks].sort((a, b) => Number(a.wk) - Number(b.wk));
    const legs = blank();
    let cashed = 0;
    const cashedWeeks = [];
    for (const w of weeks) {
      const entries = Object.entries(w.picks);
      const losers = entries.filter(([, p]) => p.r === "L").map(([id]) => id);
      if (!losers.length && entries.some(([, p]) => p.r === "W")) { cashed++; cashedWeeks.push(w.wk); }
      for (const [id, pick] of entries) {
        const s = person(id);
        if (s.firstYear === null) s.firstYear = y.year;
        add(legs, pick.r);
        add(s.all, pick.r);
        if (!s.byYear.has(y.year)) s.byYear.set(y.year, blank());
        add(s.byYear.get(y.year), pick.r);
        add(s.style[pickStyle(pick)], pick.r);
        if (pick.kind === "total" && pick.side === "o") add(s.overs, pick.r);
        if (pick.kind === "total" && pick.side === "u") add(s.unders, pick.r);
        for (const t of pickTeams(pick)) {
          if (!s.teams.has(t)) s.teams.set(t, blank());
          add(s.teams.get(t), pick.r);
        }
        s.seq.push({ year: y.year, wk: w.wk, r: pick.r });
        if (losers.length === 1 && losers[0] === id) s.soloKills++;
      }
    }
    group.push({ year: y, weeks: weeks.length, legs, cashed, cashedWeeks });
  }

  for (const s of people.values()) {
    let run = 0, kind = null;
    s.bestW = 0; s.bestL = 0;
    for (const { r } of s.seq) {
      if (r === "P") continue;
      if (r === kind) run++; else { kind = r; run = 1; }
      if (r === "W") s.bestW = Math.max(s.bestW, run); else s.bestL = Math.max(s.bestL, run);
    }
    s.streak = kind ? `${kind}${run}` : "";
    const seasons = [...s.byYear.entries()].filter(([, rec]) => rec.w + rec.l >= 4);
    s.bestYear = seasons.sort((a, b) => pctOf(b[1]) - pctOf(a[1]) || b[1].w - a[1].w)[0] || null;
    const teams = [...s.teams.entries()].filter(([, rec]) => games(rec) >= 3)
      .sort((a, b) => games(b[1]) - games(a[1]) || pctOf(b[1]) - pctOf(a[1]));
    s.goTo = teams[0] || null;
  }

  const order = [...people.values()].sort((a, b) =>
    (pctOf(b.all) ?? -1) - (pctOf(a.all) ?? -1) || b.all.w - a.all.w || a.id.localeCompare(b.id));
  return { years, people: order, group };
}

// ---------- render ----------

function yearName(y) {
  return y.season ? `${y.label} · ${y.season}` : y.label;
}

function shortYear(y) {
  return `Y${y.year}`;
}

function cell(rec, best) {
  if (!rec || !games(rec)) return `<td class="bk-none">—</td>`;
  return `<td${best ? ` class="bk-best"` : ""}><b>${recText(rec)}</b><span>${pctText(rec)}</span></td>`;
}

function tableHTML(data, nameOf, photoOf) {
  const { years, people, group } = data;
  const bestPct = years.map((y) => Math.max(...people.map((s) => {
    const rec = s.byYear.get(y.year);
    return rec && rec.w + rec.l >= 4 ? pctOf(rec) : -1;
  })));
  const bestAll = Math.max(...people.map((s) => pctOf(s.all) ?? -1));
  const groupAll = blank();
  let cashedAll = 0, weeksAll = 0;
  for (const g of group) { groupAll.w += g.legs.w; groupAll.l += g.legs.l; groupAll.p += g.legs.p; cashedAll += g.cashed; weeksAll += g.weeks; }

  return `<div class="bk-x"><table class="bk-table">
    <thead><tr><th scope="col" class="bk-who">Player</th>${years.map((y) => `<th scope="col"><abbr title="${esc(yearName(y))}">${esc(shortYear(y))}</abbr><span>${esc(y.season || "")}</span></th>`).join("")}<th scope="col" class="bk-tot">All-time</th></tr></thead>
    <tbody>
      ${people.map((s, i) => `<tr>
        <th scope="row" class="bk-who"><span class="bk-rank num">${i + 1}</span>${avatarHTML({ name: nameOf(s.id), photo: photoOf(s.id) }, "sm")}<span>${esc(nameOf(s.id))}</span></th>
        ${years.map((y, j) => { const rec = s.byYear.get(y.year); return cell(rec, rec && rec.w + rec.l >= 4 && pctOf(rec) === bestPct[j]); }).join("")}
        ${cell(s.all, pctOf(s.all) === bestAll).replace("<td", `<td data-tot`)}
      </tr>`).join("")}
    </tbody>
    <tfoot><tr>
      <th scope="row" class="bk-who"><span class="bk-rank num"></span><span>The house</span></th>
      ${group.map((g) => `<td><b>${recText(g.legs)}</b><span>${g.cashed}/${g.weeks} cashed</span></td>`).join("")}
      <td data-tot><b>${recText(groupAll)}</b><span>${cashedAll}/${weeksAll} cashed</span></td>
    </tr></tfoot>
  </table></div>`;
}

function logHTML(year, data, nameOf) {
  const ids = data.people.map((s) => s.id).filter((id) => year.weeks.some((w) => w.picks[id]));
  const weeks = [...year.weeks].sort((a, b) => Number(a.wk) - Number(b.wk));
  const tone = { W: "won", L: "lost", P: "push" };
  return `<div class="bk-x"><table class="bk-log">
    <thead><tr><th scope="col">Wk</th>${ids.map((id) => `<th scope="col">${esc(nameOf(id))}</th>`).join("")}<th scope="col">Ticket</th></tr></thead>
    <tbody>${weeks.map((w) => {
      const rs = Object.values(w.picks).map((p) => p.r);
      const misses = rs.filter((r) => r === "L").length;
      const ticket = misses ? `<span class="chip lost">${misses} ${misses === 1 ? "miss" : "misses"}</span>` : `<span class="chip won">Cashed</span>`;
      return `<tr><th scope="row" class="num">${esc(w.wk)}</th>${ids.map((id) => {
        const p = w.picks[id];
        if (!p) return `<td class="bk-none">—</td>`;
        return `<td class="bk-pick" data-tone="${tone[p.r]}"><span class="bk-r">${esc(p.r)}</span>${esc(p.text)}</td>`;
      }).join("")}<td>${ticket}</td></tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function styleChip(label, rec) {
  if (!games(rec)) return "";
  return `<li><span>${esc(label)}</span><b class="num">${recText(rec)}</b></li>`;
}

function bioHTML(s, doc, data, nameOf, photoOf) {
  const bio = doc.bios?.[s.id] || {};
  const yearsById = new Map(data.years.map((y) => [y.year, y]));
  const st = s.style;
  const facts = [
    styleChip("Laying points", st.lay),
    styleChip("Getting points", st.take),
    styleChip("Moneyline", st.ml),
    styleChip("Overs", s.overs),
    styleChip("Unders", s.unders),
  ].join("");
  const extra = [];
  if (s.goTo) extra.push(`<li><span>Go-to: ${esc(s.goTo[0])}</span><b class="num">${recText(s.goTo[1])}</b></li>`);
  if (s.bestYear) extra.push(`<li><span>Best year: ${esc(shortYear(yearsById.get(s.bestYear[0])))}</span><b class="num">${recText(s.bestYear[1])}</b></li>`);
  extra.push(`<li><span>Longest heater</span><b class="num">W${s.bestW}</b></li>`);
  extra.push(`<li><span>Longest skid</span><b class="num">L${s.bestL}</b></li>`);
  extra.push(`<li><span>Solo kills</span><b class="num">${s.soloKills}</b></li>`);
  return `<article class="bk-bio card">
    <header class="bk-bio-h">
      ${avatarHTML({ name: nameOf(s.id), photo: photoOf(s.id) }, "lg")}
      <div class="bk-bio-id">
        <h3>${esc(nameOf(s.id))}</h3>
        ${bio.tag ? `<span class="eyebrow">${esc(bio.tag)}</span>` : ""}
      </div>
      <div class="bk-bio-rec num"><b>${recText(s.all)}</b><span>${pctText(s.all)}${s.streak ? ` · now ${esc(s.streak)}` : ""}</span></div>
    </header>
    ${bio.take ? `<p class="bk-take">${esc(bio.take)}</p>` : ""}
    <ul class="bk-facts">${facts}${extra.join("")}</ul>
  </article>`;
}

export function mountHistory(root, { crew = [] } = {}) {
  let doc = null;
  let data = null;
  let shownYear = null;
  let people = new Map(crew.map((c) => [String(c.id), c]));
  const nameOf = (id) => people.get(id)?.name || id.charAt(0).toUpperCase() + id.slice(1);
  const photoOf = (id) => people.get(id)?.photo || null;

  function render() {
    if (!doc) {
      root.innerHTML = `<div class="bk-sec-h"><h2 class="bk-h2">The book</h2></div><p class="crew-note">Loading the record book…</p>`;
      return;
    }
    if (!data.years.length) {
      root.innerHTML = `<div class="bk-sec-h"><h2 class="bk-h2">The book</h2></div><p class="crew-note">No history yet.</p>`;
      return;
    }
    const last = data.years[data.years.length - 1];
    const lastWk = [...last.weeks].sort((a, b) => Number(b.wk) - Number(a.wk))[0]?.wk;
    const year = data.years.find((y) => y.year === shownYear) || last;
    const cashedWks = data.group.flatMap((g) => g.cashedWeeks);
    const sameWeek = cashedWks.length > 1 && cashedWks.every((w) => w === cashedWks[0]);

    root.innerHTML = `
      <div class="bk-sec-h"><h2 class="bk-h2">The book</h2><span class="bk-aux">${esc(doc.source || "")} · through ${esc(last.label)} Week ${esc(lastWk || "")}</span></div>
      ${tableHTML(data, nameOf, photoOf)}
      <p class="crew-note">Leg record by season, W–L(–push). Gold marks the best percentage each season.${sameWeek ? ` Every ticket that ever cashed came in Week ${esc(cashedWks[0])}.` : ""}</p>

      <div class="bk-sec-h"><h2 class="bk-h2">Week by week</h2>
        <div class="bk-seg" role="group" aria-label="Season">${data.years.map((y) =>
          `<button type="button" class="bk-seg-b" data-year="${y.year}" aria-pressed="${y.year === year.year}">${esc(y.label)}</button>`).join("")}</div>
      </div>
      <p class="bk-aux bk-yr">${esc(yearName(year))}</p>
      ${logHTML(year, data, nameOf)}

      <div class="bk-sec-h"><h2 class="bk-h2">Scouting reports</h2></div>
      <div class="bk-bios">${data.people.map((s) => bioHTML(s, doc, data, nameOf, photoOf)).join("")}</div>
      <p class="crew-note">A solo kill is a week where theirs was the only leg that missed. Streaks run across seasons and skip pushes. Moneylines count separately because the sheet doesn't record the odds.</p>`;
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-year]");
    if (!b) return;
    shownYear = Number(b.dataset.year);
    render();
  });

  render();
  loadHistory().then((d) => {
    doc = d || { years: [] };
    data = crunch(doc);
    render();
  });

  return {
    update(next) {
      if (next.crew) { people = new Map(next.crew.map((c) => [String(c.id), c])); render(); }
    },
  };
}
