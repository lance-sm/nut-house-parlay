// The house: who picked each leg, and everyone's record.
//
// parlays.json carries  crew: [{ id, name, photo }]  and each leg can carry  by: "<crew id>".
// Records are never stored; like the ticket they are regraded from ESPN finals every load.

import { gradeLeg, legLabel } from "./grade.js?v=20261112c";
import { escapeHTML as esc } from "./espn.js?v=20261112c";

export function crewMap(crew) {
  return new Map((crew || []).map((c) => [String(c.id), c]));
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// Photo when there is one, initials otherwise (and if the photo fails to load).
export function avatarHTML(person, size = "sm") {
  if (!person) return `<span class="avatar ${size} none" aria-hidden="true">?</span>`;
  const ini = esc(initials(person.name));
  if (!person.photo) return `<span class="avatar ${size}" aria-hidden="true">${ini}</span>`;
  return `<span class="avatar ${size}" aria-hidden="true" data-ini="${ini}"><img src="${esc(person.photo)}" alt="" loading="lazy"
    onerror="this.parentNode.textContent=this.parentNode.dataset.ini"></span>`;
}

const kickMs = (leg) => { const ms = Date.parse(leg.k); return Number.isFinite(ms) ? ms : 0; };

// One row per crew member (plus "unassigned" legs counted on the side).
//   resolveGame(eventId) -> normalized game or null
export function crewRecords(parlays, crew, resolveGame) {
  const people = crewMap(crew);
  const rows = new Map([...people.values()].map((p) => [p.id, {
    person: p, won: 0, lost: 0, push: 0, live: 0, picks: [], killed: 0, soleKill: 0,
  }]));
  let unassigned = 0;

  for (const parlay of parlays) {
    const graded = parlay.legs.map((leg) => ({ leg, grade: gradeLeg(leg, resolveGame(String(leg.e))) }));
    const losers = graded.filter((x) => x.grade.tone === "lost");
    for (const { leg, grade } of graded) {
      const row = leg.by ? rows.get(String(leg.by)) : null;
      if (!row) { unassigned++; continue; }
      const tone = grade.tone;
      if (tone === "won") row.won++;
      else if (tone === "lost") {
        row.lost++;
        row.killed++;
        if (losers.length === 1) row.soleKill++;
      } else if (tone === "push" || tone === "void") row.push++;
      else row.live++;
      row.picks.push({ leg, grade, parlay, label: legLabel(leg, resolveGame(String(leg.e))) });
    }
  }

  for (const row of rows.values()) {
    row.picks.sort((a, b) => kickMs(b.leg) - kickMs(a.leg)); // newest first
    const decided = row.won + row.lost;
    row.pct = decided ? row.won / decided : null;
    // Current streak over settled, non-push picks.
    let streak = 0, kind = null;
    for (const p of row.picks) {
      const t = p.grade.tone;
      if (t !== "won" && t !== "lost") continue;
      if (kind === null) kind = t;
      if (t !== kind) break;
      streak++;
    }
    row.streak = kind ? `${kind === "won" ? "W" : "L"}${streak}` : "";
  }

  const list = [...rows.values()].sort((a, b) =>
    (b.pct ?? -1) - (a.pct ?? -1) || (b.won - a.won) || a.lost - b.lost || a.person.name.localeCompare(b.person.name));
  return { list, unassigned };
}

function pctText(p) {
  return p === null ? "—" : `${Math.round(p * 100)}%`;
}

function recordText(r) {
  return `${r.won}–${r.lost}${r.push ? `–${r.push}` : ""}`;
}

const TONE_WORD = { won: "Hit", lost: "Miss", push: "Push", void: "Void" };

function pickRow(p) {
  const tone = p.grade.tone;
  const word = TONE_WORD[tone] || (tone === "pending" ? "To play" : "Live");
  return `<li class="crew-pick">
    <a href="#g=${encodeURIComponent(p.leg.e)}">
      <span class="crew-pick-wk">${esc(p.parlay.name)}</span>
      <span class="crew-pick-label">${esc(p.label)}</span>
      <span class="chip ${esc(tone)}">${esc(word)}</span>
    </a></li>`;
}

export function mountCrew(root, { parlays = [], crew = [], resolveGame }) {
  let open = null; // crew id expanded to show every pick

  function render() {
    if (!crew.length) {
      root.innerHTML = `<div class="card empty"><h2>No team yet</h2>
        <p>Add the team to <code>parlays.json</code> under <code>crew</code>, then tag each leg with who picked it.</p></div>`;
      return;
    }
    const { list, unassigned } = crewRecords(parlays, crew, resolveGame);
    const leader = list.find((r) => r.pct !== null);
    const bozo = [...list].filter((r) => r.killed).sort((a, b) => b.killed - a.killed || b.soleKill - a.soleKill)[0];

    root.innerHTML = `
      <div class="crew-head">
        ${leader ? `<div class="crew-award"><span class="eyebrow">Sharpest</span>${avatarHTML(leader.person, "md")}<b>${esc(leader.person.name)}</b><span class="num">${recordText(leader)} · ${pctText(leader.pct)}</span></div>` : ""}
        ${bozo ? `<div class="crew-award bozo"><span class="eyebrow">Head bozo</span>${avatarHTML(bozo.person, "md")}<b>${esc(bozo.person.name)}</b><span class="num">${bozo.killed} ${bozo.killed === 1 ? "miss" : "misses"}${bozo.soleKill ? ` · ${bozo.soleKill} solo ${bozo.soleKill === 1 ? "kill" : "kills"}` : ""}</span></div>` : ""}
      </div>
      <ol class="crew-list">
        ${list.map((r, i) => `<li class="crew-row${open === r.person.id ? " open" : ""}">
          <button type="button" class="crew-main" data-crew="${esc(r.person.id)}" aria-expanded="${open === r.person.id}">
            <span class="crew-rank num">${r.pct === null ? "" : i + 1}</span>
            ${avatarHTML(r.person, "lg")}
            <span class="crew-name">${esc(r.person.name)}
              <span class="crew-sub">${r.picks.length} ${r.picks.length === 1 ? "pick" : "picks"}${r.live ? ` · ${r.live} open` : ""}${r.soleKill ? ` · ${r.soleKill} solo ${r.soleKill === 1 ? "kill" : "kills"}` : ""}</span>
            </span>
            <span class="crew-rec num"><b>${recordText(r)}</b><span>${pctText(r.pct)}${r.streak ? ` · ${r.streak}` : ""}</span></span>
          </button>
          ${open === r.person.id ? `<ol class="crew-picks">${r.picks.length ? r.picks.map(pickRow).join("") : `<li class="muted crew-none">No picks tagged yet.</li>`}</ol>` : ""}
        </li>`).join("")}
      </ol>
      <p class="crew-note">Record is W–L(–push). A solo kill is a miss that was the only leg to lose that week.${unassigned ? ` ${unassigned} ${unassigned === 1 ? "leg isn't" : "legs aren't"} tagged to anyone yet.` : ""}</p>`;
  }

  const onClick = (e) => {
    const b = e.target.closest("[data-crew]");
    if (!b) return;
    open = open === b.dataset.crew ? null : b.dataset.crew;
    render();
  };
  root.addEventListener("click", onClick);
  render();

  return {
    update(next) {
      if (next.parlays) parlays = next.parlays;
      if (next.crew) crew = next.crew;
      if (next.resolveGame) resolveGame = next.resolveGame;
      render();
    },
  };
}
