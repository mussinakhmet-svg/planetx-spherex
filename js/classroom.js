// classroom.js — "Classroom": short video lessons for students and lesson plans for teachers.
// Videos live on the team's YouTube channel; data/lessons.json lists them. Add a video by pasting
// its YouTube ID there; until then the card shows "Coming soon". Videos play inside the site
// (privacy-enhanced youtube-nocookie.com player) or on YouTube.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

import { MISSIONS, missionLink } from './practice.js';

const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ytId = v => { v = String(v || '').trim(); if (/^[\w-]{11}$/.test(v)) return v; const m = v.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/); return m ? m[1] : ''; };
let L = null, role = 'student';

function card(x) {
  const yt = ytId(x.youtube);
  // A lesson can also be a video file served by the site itself ("video": "videos/x.mp4", "poster": "videos/x.jpg").
  const id = yt || (x.video ? 'file:' + x.video : '');
  const thumb = yt ? `<img src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" alt="" loading="lazy">`
    : x.video ? `<img src="${esc(x.poster || '')}" alt="" loading="lazy">` : `<div class="v-soon"><span>Video coming soon</span></div>`;
  return `<article class="v-card${id ? '' : ' soon'}" ${id ? `data-yt="${esc(id)}" data-sub="${esc(x.subtitles || '')}" tabindex="0" role="button" aria-label="Play ${esc(x.title)}"` : ''}>
    <div class="v-thumb">${thumb}<span class="v-time">${x.minutes} min</span>${id ? '<span class="v-play" aria-hidden="true"></span>' : ''}</div>
    <div class="v-body">
      <span class="mission-tag">${esc(x.level || '')}</span>
      <h3>${esc(x.title)}</h3>
      <p>${esc(x.summary)}</p>
      <div class="v-links">
        ${x.try ? `<a class="ghost small" href="${esc(x.try.href)}">${esc(x.try.label)}</a>` : ''}
        ${yt ? `<a class="ghost small" href="https://www.youtube.com/watch?v=${yt}" target="_blank" rel="noopener">Watch on YouTube</a>` : ''}
      </div>
      ${x.plan ? plan(x.plan) : ''}
    </div>
  </article>`;
}
function plan(p) {
  const m = p.mission && MISSIONS.find(q => q.id === p.mission);
  return `<details class="how mini"><summary>Lesson plan</summary><div class="how-body">
    <h3>Goals</h3><ul>${p.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
    <h3>Steps</h3><ol>${p.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    ${m ? `<p>Class mission: <b>${esc(m.title)}</b>. <button type="button" class="ghost small" data-copy="${encodeURIComponent(missionLink(m))}">Copy the link for students</button></p>` : ''}
  </div></details>`;
}

function render() {
  const list = role === 'teacher' ? L.teacher : L.student;
  $('cGrid').innerHTML = list.map(card).join('');
  const ch = L.channel && L.channel.url;
  $('cChannel').innerHTML = ch ? `<a class="go" href="${esc(ch)}" target="_blank" rel="noopener">Our YouTube channel</a>` : `<span class="muted small">Our YouTube channel link will appear here.</span>`;
  for (const el of $('cGrid').querySelectorAll('[data-yt]')) {
    const open = e => { if (e.target.closest('a, button, details')) return; player(el.dataset.yt, el.querySelector('h3').textContent, el.dataset.sub); };
    el.addEventListener('click', open); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
  }
  for (const b of $('cGrid').querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
    const t = decodeURIComponent(b.dataset.copy);
    try { await navigator.clipboard.writeText(t); b.textContent = 'Copied'; } catch { prompt('Copy this link', t); }
  });
}

function player(id, title, sub) {
  const d = $('cPlayer');
  const file = id.startsWith('file:') ? id.slice(5) : '';
  d.querySelector('.v-frame').innerHTML = file
    ? `<video src="${esc(file)}" controls autoplay playsinline style="width:100%;height:100%;background:#000">${sub ? `<track kind="subtitles" srclang="en" label="English" src="${esc(sub)}">` : ''}</video>`
    : `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  d.querySelector('h3').textContent = title;
  const yl = d.querySelector('.v-yt');
  if (file) { yl.href = file; yl.textContent = 'Download video'; } else { yl.href = `https://www.youtube.com/watch?v=${id}`; yl.textContent = 'Watch on YouTube'; }
  d.showModal();
}

async function build() {
  $('classView').innerHTML = `
  <header class="page-head">
    <h1>Classroom</h1>
    <p class="lede">Short video lessons on blinking the sky, stacking, spectra and the search for Planet X, each followed by something to try on the real data. Teachers get lesson plans and ready class missions.</p>
    <p class="why"><b>Why it matters.</b> SPHEREx data are public, but nobody uses data they cannot read. Five-minute lessons and missions turn the site into a lab that a school class can run in one lesson, in English, Kazakh or Russian.</p>
  </header>
  <div class="class-head">
    <div class="tabs role-tabs" role="tablist">
      <button type="button" role="tab" data-r="student" aria-selected="true">Student</button>
      <button type="button" role="tab" data-r="teacher" aria-selected="false">Teacher</button>
    </div>
    <div id="cChannel"></div>
  </div>
  <div class="v-grid" id="cGrid"><p class="muted">Loading lessons…</p></div>
  <dialog class="v-dialog" id="cPlayer">
    <div class="v-dhead"><h3></h3><a class="ghost small v-yt" target="_blank" rel="noopener">Watch on YouTube</a><button type="button" class="ghost small" id="cClose">Close</button></div>
    <div class="v-frame"></div>
  </dialog>`;
  for (const b of $('classView').querySelectorAll('[data-r]')) b.addEventListener('click', () => {
    role = b.dataset.r;
    for (const c of $('classView').querySelectorAll('[data-r]')) c.setAttribute('aria-selected', String(c === b));
    render();
  });
  const close = () => { $('cPlayer').querySelector('.v-frame').innerHTML = ''; $('cPlayer').close(); };
  $('cClose').addEventListener('click', close);
  $('cPlayer').addEventListener('cancel', () => { $('cPlayer').querySelector('.v-frame').innerHTML = ''; });
  $('cPlayer').addEventListener('click', e => { if (e.target === $('cPlayer')) close(); });
  try { L = await (await fetch('data/lessons.json', { cache: 'no-cache' })).json(); render(); }
  catch { $('cGrid').innerHTML = '<p class="muted">The lesson list could not load.</p>'; }
}

let built = false;
export function openClassroom() { if (!built) { built = true; build(); } }
