// practice.js — "Practice": missions on real SPHEREx data. A student opens a mission, the Blink viewer
// loads a field without saying what is in it, and the student has to find and click the object
// (a fast-moving star, a hidden brown dwarf, a star that changed). The site checks the click against
// the true position at the dates of the exposures. Teachers can share a ready mission or build their
// own from any field, and send it to the class as a link.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

import { TARGETS } from './targets.js';
import { propagate, sepArcsec, parseCoords, fmtRa, fmtDec } from './wcs.js';

const $ = id => document.getElementById(id);
const REF = 2026.2;

export const MISSIONS = [
  { id: 'barnard', level: 'Beginner', title: 'The fastest star', target: 'barnard', band: 6, fov: 9, off: [1.6, -1.1], tol: 15,
    q: 'One star in this field crosses the sky faster than any other star we know. Play the survey passes, or open “Difference”, and click it.',
    hint: 'In the Difference view a star that moved leaves a blue–orange pair: blue where it was, orange where it went.',
    why: 'This is Barnard’s Star, 6 light-years away. It moves 10.4″ per year, almost two SPHEREx pixels.' },
  { id: 'w0855', level: 'Intermediate', title: 'The invisible neighbour', target: 'w0855', band: 6, fov: 9, off: [-1.4, 1.2], tol: 15,
    q: 'Something here is too faint to see in a single exposure. Switch to “Survey passes, stacked”, find a faint dot that is in a different place in each pass, and click it.',
    hint: 'Stacking averages many exposures, so the noise drops. Compare the passes one after another and watch for a dot that steps sideways.',
    why: 'This is WISE 0855−0714, the coldest brown dwarf known (about 250 K, colder than ice). It is 7.4 light-years away and glows almost only at 4–5 µm.' },
  { id: 'epsindb', level: 'Intermediate', title: 'A brown-dwarf pair on the move', target: 'epsindb', band: 2, fov: 9, off: [1.2, 1.5], tol: 20,
    q: 'A pair of brown dwarfs travels across this field together. Find it and click it.',
    hint: 'Use the Difference view and look for a blue–orange pair. It moves about 4.7″ per year.',
    why: 'Epsilon Indi Ba and Bb orbit the star Epsilon Indi, 12 light-years away. SPHEREx sees the pair as one dot.' },
  { id: 'rwaur', level: 'Advanced', title: 'The star that changed', target: 'rwaur', band: 1, fov: 6, off: [-0.9, -0.8], tol: 15,
    q: 'One star here changed its brightness a lot within a year, without moving. Compare the passes and click it.',
    hint: 'In the Difference view a star that brightened or faded leaves a single coloured blob, not a pair. Then check its spectrum panel.',
    why: 'This is RW Aurigae, a young star whose light is blocked from time to time by dust in its disk. It became 1.5× brighter in the near-infrared.' },
];

// ------------------------------------------------------------------ links
const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
function fieldOf(m) {
  const tg = TARGETS.find(t => t.id === m.target);
  const [ra, dec] = tg ? propagate(tg.ra, tg.dec, tg.pmra, tg.pmdec, tg.epoch, REF, tg.plx || 0) : [m.ra, m.dec];
  const cosd = Math.cos(dec * Math.PI / 180);
  return { ra: ra + (m.off ? m.off[0] / 60 / cosd : 0), dec: dec + (m.off ? m.off[1] / 60 : 0) };
}
export function missionLink(m, custom = false) {
  const f = custom ? { ra: m.ra, dec: m.dec } : fieldOf(m);
  const code = custom ? `c:${b64(JSON.stringify(m))}` : `b:${m.id}`;
  return `${location.origin}${location.pathname}?ra=${f.ra.toFixed(5)}&dec=${f.dec.toFixed(5)}&fov=${m.fov}${m.band ? `&band=${m.band}` : ''}&mission=${encodeURIComponent(code)}`;
}
function readMission() {
  const code = new URLSearchParams(location.search).get('mission');
  if (!code) return null;
  if (code.startsWith('b:')) return MISSIONS.find(m => m.id === code.slice(2)) || null;
  if (code.startsWith('c:')) { try { const m = JSON.parse(unb64(code.slice(2))); m.custom = true; return m; } catch { return null; } }
  return null;
}
const solved = () => { try { return JSON.parse(localStorage.getItem('ib-solved') || '{}'); } catch { return {}; } };
const markSolved = id => { try { const s = solved(); s[id] = Date.now(); localStorage.setItem('ib-solved', JSON.stringify(s)); } catch { /* private mode */ } };

// ------------------------------------------------------------------ the banner shown in the Blink viewer
function answerSep(m, pick) {
  const st = window.__st;
  const years = (st.stacks && st.stacks.length ? st.stacks.map(s => s.year) : [REF]);
  const tg = m.target && TARGETS.find(t => t.id === m.target);
  return Math.min(...years.map(y => {
    const [ra, dec] = tg ? propagate(tg.ra, tg.dec, tg.pmra, tg.pmdec, tg.epoch, y, tg.plx || 0) : [m.ans[0], m.ans[1]];
    return sepArcsec(pick.ra, pick.dec, ra, dec);
  }));
}
export function initMission() {
  const m = readMission(); if (!m) return;
  const bar = document.createElement('section');
  bar.className = 'mission'; bar.id = 'missionBar';
  bar.innerHTML = `
    <div><span class="mission-tag">Mission${m.level ? ` · ${m.level}` : ''}</span><h2>${esc(m.title)}</h2><p>${esc(m.q)}</p></div>
    <div class="mission-actions">
      <button type="button" class="go" id="mCheck">Check my answer</button>
      <button type="button" class="ghost small" id="mHint">Hint</button>
      <button type="button" class="ghost small" id="mGive" hidden>Show the answer</button>
      <p class="sky-status" id="mOut">Wait for the field to load, then click the object you think it is.</p>
    </div>`;
  const bench = $('bench'); bench.parentNode.insertBefore(bar, bench);
  // hide what would give the answer away: target list and names
  document.body.classList.add('in-mission');
  let tries = 0;
  $('mHint').addEventListener('click', () => { $('mOut').textContent = m.hint || 'No hint for this one.'; $('mOut').className = 'sky-status'; });
  $('mCheck').addEventListener('click', () => {
    const st = window.__st;
    if (!st || st.busy || !st.loaded.length) { $('mOut').textContent = 'The field is still loading.'; return; }
    if (!st.pick || !Number.isFinite(st.pick.ra)) { $('mOut').textContent = 'First click a source in the image.'; $('mOut').className = 'sky-status warn'; return; }
    tries++;
    const d = answerSep(m, st.pick);
    if (d <= (m.tol || 15)) {
      $('mOut').innerHTML = `<b>Correct!</b> ${esc(m.why || '')}`; $('mOut').className = 'sky-status ok';
      markSolved(m.custom ? `c:${m.title}` : m.id);
    } else {
      $('mOut').textContent = `Not this one: you clicked ${d < 120 ? `${d.toFixed(0)}″` : `${(d / 60).toFixed(1)}′`} away from the answer. Try again${tries >= 2 ? ', or ask for a hint' : ''}.`;
      $('mOut').className = 'sky-status warn';
      if (tries >= 3) $('mGive').hidden = false;
    }
  });
  $('mGive').addEventListener('click', () => {
    const tg = m.target && TARGETS.find(t => t.id === m.target);
    const [ra, dec] = tg ? propagate(tg.ra, tg.dec, tg.pmra, tg.pmdec, tg.epoch, REF, tg.plx || 0) : m.ans;
    $('mOut').innerHTML = `The answer is at ${fmtRa(ra)} ${fmtDec(dec)}. ${esc(m.why || '')}`; $('mOut').className = 'sky-status';
  });
  window.addEventListener('sourcepicked', () => { $('mOut').textContent = 'Source selected. Press “Check my answer”.'; $('mOut').className = 'sky-status'; });
}
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ the Practice page
let role = 'student';
function build() {
  $('practiceView').innerHTML = `
  <header class="page-head">
    <h1>Practice: find it yourself</h1>
    <p class="lede">Missions on real SPHEREx images. The field opens without saying what is in it; you find the object and the site checks your answer.</p>
    <p class="why"><b>Why it matters.</b> Clicking through a finished result teaches little. Finding a moving or changing object yourself, in the same data astronomers use, is how the method really sinks in, and a teacher can send any field to the whole class as one link.</p>
  </header>
  <div class="tabs role-tabs" role="tablist">
    <button type="button" role="tab" data-r="student" aria-selected="true">Student</button>
    <button type="button" role="tab" data-r="teacher" aria-selected="false">Teacher</button>
  </div>
  <div id="pStudent"></div>
  <div id="pTeacher" hidden></div>`;
  for (const b of $('practiceView').querySelectorAll('[data-r]')) b.addEventListener('click', () => {
    role = b.dataset.r;
    for (const c of $('practiceView').querySelectorAll('[data-r]')) c.setAttribute('aria-selected', String(c === b));
    $('pStudent').hidden = role !== 'student'; $('pTeacher').hidden = role !== 'teacher';
  });
  renderStudent(); renderTeacher();
}
function renderStudent() {
  const s = solved();
  $('pStudent').innerHTML = `<div class="cards">${MISSIONS.map(m => `
    <article class="card-m">
      <span class="mission-tag">${m.level}${s[m.id] ? ' · solved ✓' : ''}</span>
      <h3>${m.title}</h3><p>${m.q}</p>
      <a class="go" href="${missionLink(m)}">Start mission</a>
    </article>`).join('')}</div>`;
}
function renderTeacher() {
  $('pTeacher').innerHTML = `
  <section class="panel">
    <h2>Ready missions for your class</h2>
    <p class="muted small">Copy a link and send it to students (chat, classroom page, QR code). Each link opens the field with the mission.</p>
    <div class="t-missions">${MISSIONS.map(m => `
      <div class="t-mission"><div><b>${m.title}</b> <span class="muted small">· ${m.level}</span></div>
      <button type="button" class="ghost small" data-copy="${encodeURIComponent(missionLink(m))}">Copy link</button>
      <a class="ghost small" href="${missionLink(m)}" target="_blank" rel="noopener">Open</a></div>`).join('')}</div>
  </section>
  <section class="panel">
    <h2>Make your own mission</h2>
    <p class="muted small">Choose any field and the object students must find. Tip: open the field in the Blink viewer first, click the object, then come back and press “Use my selected source”.</p>
    <form id="pForm" class="p-form" autocomplete="off">
      <label class="field">Title <input id="pTitle" type="text" value="Find the mystery object" maxlength="80"></label>
      <label class="field">Task for students <textarea id="pQ" rows="3" maxlength="400">Something in this field moves between survey passes. Find it and click it.</textarea></label>
      <div class="row split">
        <label class="field">Field centre (coordinates or name) <input id="pField" type="text" placeholder="269.45 +4.74  or  Vega"></label>
        <label class="field">Field of view <select id="pFov"><option>6</option><option selected>9</option><option>12</option></select></label>
      </div>
      <div class="row split">
        <label class="field">Answer position (RA Dec, degrees) <input id="pAns" type="text" placeholder="269.4521 +4.6934"></label>
        <label class="field">Detector band <select id="pBand"><option value="0">all</option><option value="1">D1</option><option value="2">D2</option><option value="3">D3</option><option value="4">D4</option><option value="5">D5</option><option value="6" selected>D6</option></select></label>
      </div>
      <button type="button" class="ghost small" id="pUsePick">Use my selected source (from the Blink viewer)</button>
      <label class="field">Hint (optional) <input id="pHint" type="text" maxlength="200"></label>
      <label class="field">Explanation shown when correct (optional) <input id="pWhy" type="text" maxlength="300"></label>
      <button type="submit" class="go">Create the mission link</button>
      <p class="sky-status" id="pOut"></p>
    </form>
    <p class="muted small">The answer travels inside the link in encoded form. That is fine for practice, not for graded tests.</p>
  </section>`;
  for (const b of $('pTeacher').querySelectorAll('[data-copy]')) b.addEventListener('click', () => copy(decodeURIComponent(b.dataset.copy), b));
  $('pUsePick').addEventListener('click', () => {
    const st = window.__st;
    if (st && st.pick && Number.isFinite(st.pick.ra)) {
      $('pAns').value = `${st.pick.ra.toFixed(5)} ${st.pick.dec >= 0 ? '+' : ''}${st.pick.dec.toFixed(5)}`;
      if (!$('pField').value) $('pField').value = `${st.ra.toFixed(4)} ${st.dec >= 0 ? '+' : ''}${st.dec.toFixed(4)}`;
      $('pBand').value = String(st.band || 0);
    } else $('pOut').textContent = 'No source is selected in the Blink viewer yet.';
  });
  $('pForm').addEventListener('submit', async e => {
    e.preventDefault();
    const out = $('pOut'); out.className = 'sky-status';
    let field = parseCoords($('pField').value);
    if (!field && $('pField').value.trim()) {
      try { const r = await fetch(`/api/resolve?name=${encodeURIComponent($('pField').value.trim())}`); const j = await r.json(); if (Number.isFinite(j.ra)) field = [j.ra, j.dec]; } catch { /* below */ }
    }
    const ans = parseCoords($('pAns').value);
    if (!field || !ans) { out.textContent = 'Enter a field centre and the answer position.'; out.className = 'sky-status warn'; return; }
    const m = { title: $('pTitle').value.trim() || 'Mission', q: $('pQ').value.trim(), ra: field[0], dec: field[1], fov: Number($('pFov').value), band: Number($('pBand').value), ans, tol: 15, hint: $('pHint').value.trim(), why: $('pWhy').value.trim(), level: 'Class mission' };
    const link = missionLink(m, true);
    out.innerHTML = `<input class="p-link" readonly value="${esc(link)}"> <button type="button" class="ghost small" id="pCopy">Copy</button> <a class="ghost small" href="${esc(link)}" target="_blank" rel="noopener">Open as a student</a>`;
    $('pCopy').addEventListener('click', () => copy(link, $('pCopy')));
  });
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = o; }, 1500); }
  catch { prompt('Copy this link', text); }
}

let built = false;
export function openPractice() { if (!built) { built = true; build(); } else renderStudent(); }
