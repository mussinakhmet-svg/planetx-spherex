// app.js — the interface: pick a position, load exposures, blink them, measure motion, read spectra.
// Code written with AI assistance (Claude), reviewed and tested by team Sigma Boys.

import { searchFrames, estimateWavelengths, loadFrame, stackFrames, aperturePhot, nativeCentroid, robustStats, BANDS, NATIVE_SCALE, setCollections } from './spherex.js';
import { makeGrid, propagate, parseCoords, fmtRa, fmtDec, mjdToDate, mjdToYear, tanForward, sepArcsec } from './wcs.js';
import { pool, netStats } from './fits.js';
import { paint, drawOverlay } from './render.js';
import { TARGETS, targetById } from './targets.js';
import { t, setLang, initialLang, lang } from './i18n.js';
import { startPlanet } from './planet.js';

const $ = id => document.getElementById(id);
const PASS_COLORS = ['#3B98D6', '#DB6A2A', '#9B76DC', '#36A871'];   // validated for colour-blind separation on the dark surface
const passColor = k => PASS_COLORS[k % PASS_COLORS.length];
const OVERSAMPLE = 2;                         // grid pixels per native pixel
const SCALE = NATIVE_SCALE / OVERSAMPLE;      // arcsec per grid pixel
const REF_EPOCH = 2026.2;                     // where to centre a moving target (middle of the survey so far)

const st = {
  ra: null, dec: null, name: '', target: null, fov: 6, band: 0, max: 48,
  all: [], sel: [], loaded: [], grid: null, n: 0,
  mode: 'frames', idx: 0, playing: false, timer: null, gain: 0, cmap: 'heat', order: 'time',
  stacks: [], diffs: [], levels: null, pick: null, gaia: null, runId: 0, busy: false, spec: null,
};
window.__st = st;   // handy for debugging in the console

// ------------------------------------------------------------------ setup

function buildTargets() {
  const box = $('targets');
  box.innerHTML = '';
  for (const tg of TARGETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'target'; b.dataset.id = tg.id;
    b.setAttribute('aria-pressed', String(st.target && st.target.id === tg.id));
    b.innerHTML = `<b></b><span class="kind"></span><span class="why"></span>`;
    b.children[0].textContent = tg.name;
    b.children[1].textContent = t(tg.kind === 'mover' ? 'kindMover' : 'kindVariable');
    b.children[2].textContent = tg.note[lang] || tg.note.en;
    b.addEventListener('click', () => chooseTarget(tg));
    box.appendChild(b);
  }
}

function buildBands() {
  const box = $('bands');
  box.innerHTML = '';
  const mk = (det, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.det = det; b.textContent = label;
    b.setAttribute('aria-pressed', String(st.band === det));
    b.addEventListener('click', () => { st.band = det; buildBands(); });
    box.appendChild(b);
  };
  mk(0, t('bandAll'));
  for (const b of BANDS) mk(b.det, `${b.lo.toFixed(1)}–${b.hi.toFixed(1)} µm`);
}

function chooseTarget(tg) {
  st.band = tg.band; $('fov').value = String(tg.fov);
  $('q').value = tg.name;
  buildBands();
  run({ target: tg });
}

function setStatus(msg, isErr = false) {
  const el = $('status');
  el.textContent = msg; el.classList.toggle('err', isErr);
}
function setProgress(f) {
  const p = $('progress');
  p.hidden = f === null;
  if (f !== null) p.firstElementChild.style.width = `${Math.round(f * 100)}%`;
}

// ------------------------------------------------------------------ resolve what the user typed

async function resolveQuery(text) {
  const preset = TARGETS.find(x => x.name.toLowerCase() === text.trim().toLowerCase());
  if (preset) return { target: preset };
  const c = parseCoords(text);
  if (c) return { ra: c[0], dec: c[1], name: '' };
  if (!/[a-z]/i.test(text)) return { error: t('badCoords') };
  setStatus(t('resolving', { name: text.trim() }));
  try {
    const r = await fetch(`/api/resolve?name=${encodeURIComponent(text.trim())}`);
    if (!r.ok) return { error: t('notFound', { name: text.trim() }) };
    const o = await r.json();
    const hasPm = Number.isFinite(o.pmra) && Number.isFinite(o.pmdec) && Math.hypot(o.pmra, o.pmdec) > 0;
    return { target: { id: null, name: o.name || text.trim(), ra: o.ra, dec: o.dec, epoch: 2000.0, pmra: hasPm ? o.pmra : 0, pmdec: hasPm ? o.pmdec : 0, plx: o.plx, source: o.source } };
  } catch { return { error: t('searchFailed') }; }
}

// ------------------------------------------------------------------ main pipeline

async function run(opts = {}) {
  const runId = ++st.runId;
  stop();
  let res = opts.target ? { target: opts.target } : (opts.ra != null ? { ra: opts.ra, dec: opts.dec, name: '' } : await resolveQuery($('q').value));
  if (runId !== st.runId) return;
  if (res.error) { setStatus(res.error, true); return; }

  st.fov = Number($('fov').value); st.max = Number($('maxFrames').value);
  st.target = res.target || null;
  let note = '';
  if (st.target) {
    const tg = st.target;
    [st.ra, st.dec] = propagate(tg.ra, tg.dec, tg.pmra, tg.pmdec, tg.epoch, REF_EPOCH);   // proper motion only: a steady field centre
    st.name = tg.name;
    const moved = sepArcsec(tg.ra, tg.dec, st.ra, st.dec);
    if (moved > 3) note = t('movedNote', { epoch: tg.epoch.toFixed(1), d: moved.toFixed(0) });
  } else { st.ra = res.ra; st.dec = res.dec; st.name = ''; }
  for (const b of document.querySelectorAll('.target')) b.setAttribute('aria-pressed', String(!!st.target && b.dataset.id === st.target.id));
  writeUrl();

  st.offsets = null; st.all = []; st.sel = []; st.loaded = []; st.stacks = []; st.diffs = []; st.pick = null; st.spec = null; st.levels = null; st.idx = 0;
  st.n = Math.round(st.fov * 60 / SCALE); if (st.n % 2 === 0) st.n++;
  st.grid = makeGrid(st.ra, st.dec, st.n, SCALE);
  const sky = $('sky'); sky.width = sky.height = st.n;
  $('empty').hidden = false; $('empty').firstElementChild.textContent = '';
  $('share').hidden = true;
  renderMotion(); drawSpectrum(); renderMeta();
  setMode('frames', false);
  st.busy = true; $('go').disabled = true;
  setStatus(t('searching')); setProgress(0.02);
  const t0 = performance.now(), net0 = netStats().bytes;

  let frames;
  try {
    frames = await searchFrames(st.ra, st.dec);
    if (runId !== st.runId) return;
    await estimateWavelengths(frames);
  } catch (e) {
    if (runId !== st.runId) return;
    finish(); setStatus(t('searchFailed'), true); console.error(e); return;
  }
  if (runId !== st.runId) return;
  st.all = frames;
  const sel = selectFrames(frames);
  if (!sel.length) { finish(); setStatus(t('noFrames'), true); $('empty').firstElementChild.textContent = t('noFrames'); drawTimeline(); return; }
  st.sel = sel;
  const nPass = new Set(frames.map(f => f.pass)).size;
  setStatus(t('found', { n: frames.length, p: nPass, m: sel.length }));
  drawTimeline();
  if ($('showGaia').checked) loadGaia();

  let done = 0, bad = 0;
  await pool(sel, 6, async f => {
    if (runId !== st.runId) return;
    await loadFrame(f, st.grid);
    if (runId !== st.runId) return;
    done++;
    if (f.empty) { bad++; return; }
    st.loaded.push(f); sortLoaded();
    setProgress(0.05 + 0.95 * done / sel.length);
    setStatus(t('loading', { i: done, m: sel.length }));
    if (st.loaded.length === 1 || done % 4 === 0) { computeLevels(); $('empty').hidden = true; show(); }
  }, e => { done++; bad++; console.warn(e); });
  if (runId !== st.runId) return;

  finish();
  const secs = ((performance.now() - t0) / 1000).toFixed(0), mb = ((netStats().bytes - net0) / 1e6).toFixed(1);
  if (!st.loaded.length) { setStatus(t('noFrames'), true); $('empty').hidden = false; $('empty').firstElementChild.textContent = t('noFrames'); return; }
  const msg = bad ? t('doneSome', { ok: st.loaded.length, m: sel.length, mb, s: secs, bad }) : t('done', { m: st.loaded.length, mb, s: secs });
  setStatus(note ? `${msg} ${note}` : msg);
  st.timing = { secs: Number(secs), mb: Number(mb), frames: st.loaded.length };
  $('share').hidden = false;
  computeLevels(); buildStacks();
  st.pick = st.pendingPick || (st.target ? { target: true } : null); st.pendingPick = null;   // a shared link can carry a picked source
  if (st.pick) { measureMotion(); buildSpectrum(); }
  window.dispatchEvent(new CustomEvent('fieldloaded'));
  if (st.stacks.length >= 2) { setMode('epochs'); play(); } else { show(); play(); }
}

function finish() { st.busy = false; $('go').disabled = false; setProgress(null); }

/** Choose which exposures to read: the chosen band, evenly thinned within each survey pass. */
function selectFrames(frames) {
  let list = frames.filter(f => f.est && f.est[0] > 2 && f.est[0] < 2039 && f.est[1] > 2 && f.est[1] < 2039);
  if (st.band) list = list.filter(f => f.det === st.band);
  if (!st.max || list.length <= st.max) return list;
  const byPass = new Map();
  for (const f of list) { if (!byPass.has(f.pass)) byPass.set(f.pass, []); byPass.get(f.pass).push(f); }
  const per = Math.max(1, Math.floor(st.max / byPass.size));
  const out = [];
  for (const arr of byPass.values()) {
    arr.sort((a, b) => (a.lambda || 0) - (b.lambda || 0));         // spread across wavelength too
    if (arr.length <= per) { out.push(...arr); continue; }
    for (let k = 0; k < per; k++) out.push(arr[Math.round(k * (arr.length - 1) / (per - 1 || 1))]);
  }
  return [...new Set(out)].sort((a, b) => a.mjd - b.mjd);
}

function sortLoaded() {
  if (st.order === 'wave') st.loaded.sort((a, b) => (a.lambda - b.lambda) || (a.mjd - b.mjd));
  else st.loaded.sort((a, b) => a.mjd - b.mjd);
}

function computeLevels() {
  const fr = st.loaded;
  if (!fr.length) return;
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const sig = med(fr.map(f => f.sigma).filter(Number.isFinite)) || 0.05;
  const tops = fr.map(f => {
    if (f.p995 === undefined) {
      const v = Array.from(f.img).filter(Number.isFinite).sort((a, b) => a - b);
      f.p995 = v.length ? v[Math.floor(v.length * 0.995)] - f.bg : 0;
    }
    return f.p995;
  });
  st.levels = { sigma: sig, top: Math.max(med(tops), 25 * sig) };
}

function passLabel(frames) {
  const fmt = new Intl.DateTimeFormat(lang === 'kk' ? 'kk' : lang, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const a = fmt.format(mjdToDate(frames[0].mjd)), b = fmt.format(mjdToDate(frames[frames.length - 1].mjd));
  return a === b ? a : t('passDates', { a, b });
}

function buildStacks() {
  const byPass = new Map();
  for (const f of st.loaded) { if (!byPass.has(f.pass)) byPass.set(f.pass, []); byPass.get(f.pass).push(f); }
  st.stacks = [...byPass.entries()].sort((a, b) => a[0] - b[0]).map(([pass, fr]) => {
    fr = fr.slice().sort((a, b) => a.mjd - b.mjd);
    const img = stackFrames(fr, st.n), s = robustStats(img);
    return { pass, frames: fr, img, sigma: s.sigma, bg: s.median, year: fr.reduce((q, f) => q + f.year, 0) / fr.length,
      lamLo: Math.min(...fr.map(f => f.lambda)), lamHi: Math.max(...fr.map(f => f.lambda)) };
  });
  st.diffs = [];
  const S = st.stacks;
  const solid = S.map((s, i) => i).filter(i => S[i].frames.length >= 4);
  const use = solid.length >= 2 ? solid : S.map((s, i) => i);        // leave out passes with too few exposures to trust
  const mk = (a, b) => {
    const img = new Float32Array(st.n * st.n);
    for (let p = 0; p < img.length; p++) img[p] = (S[b].img[p] - S[b].bg) - (S[a].img[p] - S[a].bg);
    st.diffs.push({ a, b, img, sigma: robustStats(img).sigma, year: S[b].year });
  };
  if (use.length > 2) mk(use[0], use[use.length - 1]);                   // longest baseline first
  for (let k = 1; k < use.length; k++) mk(use[k - 1], use[k]);
}

// ------------------------------------------------------------------ viewing

function items() { return st.mode === 'frames' ? st.loaded : st.mode === 'epochs' ? st.stacks : st.diffs; }

function targetAt(year) {
  const tg = st.target;
  return tg ? propagate(tg.ra, tg.dec, tg.pmra, tg.pmdec, tg.epoch, year, tg.plx || 0) : null;
}

function show() {
  const list = items();
  const ctx = $('sky').getContext('2d');
  $('scrub').max = String(Math.max(0, list.length - 1));
  if (!list.length || !st.levels) { $('count').textContent = '0 / 0'; drawTimeline(); return; }
  st.idx = Math.min(st.idx, list.length - 1);
  const it = list[st.idx];
  const gain = Math.pow(10, -st.gain / 20);
  const L = st.levels;
  let year;
  if (st.mode === 'frames') {
    paint(ctx, it.img, st.n, { bg: it.bg, vmax: L.top * gain, soft: 3 * L.sigma, cmap: st.cmap });
    year = it.year;
    $('caption').innerHTML = `${esc(fmtDate(it.mjd, true))}<small>${esc(t('frameSub', { lam: it.lambda.toFixed(2), det: it.det }))}</small>`;
  } else if (st.mode === 'epochs') {
    paint(ctx, it.img, st.n, { bg: it.bg, vmax: L.top * gain, soft: 3 * Math.max(it.sigma, L.sigma / 6), cmap: st.cmap });
    year = it.year;
    $('caption').innerHTML = `${esc(passLabel(it.frames))}<small>${esc(t('stackOf', { n: it.frames.length }))}</small>`;
  } else {
    paint(ctx, it.img, st.n, { vmax: 0.5 * L.top * gain, soft: 3 * Math.max(it.sigma, L.sigma / 6), diverging: true });
    year = it.year;
    $('caption').innerHTML = esc(t('minus', { a: passLabel(st.stacks[it.a].frames), b: passLabel(st.stacks[it.b].frames) }));
  }
  $('scrub').value = String(st.idx);
  $('count').textContent = `${st.idx + 1} / ${list.length}`;
  drawOver(year);
  drawTimeline();
  renderMeta();
}

function drawOver(year) {
  const cv = $('overlay'), box = $('plate').getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1), size = Math.round(box.width);
  if (cv.width !== size * dpr) { cv.width = cv.height = size * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = st.grid, o = {};
  if (st.target) {
    const p = targetAt(year);
    o.predicted = g.fromSky(p[0], p[1]);
    o.predictedLabel = t('predictedHere');
    if (st.all.length && Math.hypot(st.target.pmra, st.target.pmdec) > 100) {
      const y0 = st.all[0].year, y1 = st.all[st.all.length - 1].year;
      o.track = [g.fromSky(...targetAt(y0)), g.fromSky(...targetAt(y1))];
    }
  } else if (st.ra != null) o.input = g.fromSky(st.ra, st.dec);
  if (st.pick && !st.pick.target) o.pick = g.fromSky(st.pick.ra, st.pick.dec);
  if ($('showGaia').checked && st.gaia) {
    o.gaia = st.gaia.filter(s => s.mag <= 16.5).slice(0, 150).map(s => {     // only stars SPHEREx can plausibly see
      const [ra, dec] = propagate(s.ra, s.dec, s.pmra, s.pmdec, 2016.0, year, s.plx > 20 ? s.plx : 0);
      const [x, y] = g.fromSky(ra, dec);
      return { x, y, mag: s.mag };
    }).filter(s => s.x > 0 && s.y > 0 && s.x < st.n - 1 && s.y < st.n - 1);
  }
  drawOverlay(ctx, size, st.n, SCALE, o);
}

function setMode(mode, redraw = true) {
  st.mode = mode; st.idx = 0;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  if (redraw) show();
}

function step(d) { const n = items().length; if (!n) return; st.idx = (st.idx + d + n) % n; show(); }
function play() {
  stop(); if (items().length < 2) return;
  st.playing = true; $('playIcon').textContent = '❚❚';
  const fps = st.mode === 'frames' ? Number($('fps').value) : Math.max(0.8, Number($('fps').value) / 3);
  st.timer = setInterval(() => step(1), 1000 / fps);
}
function stop() { st.playing = false; clearInterval(st.timer); $('playIcon').textContent = '▶'; }

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtDate(mjd, time = false) {
  const d = mjdToDate(mjd), loc = lang === 'kk' ? 'kk' : lang;
  const o = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  if (time) Object.assign(o, { hour: '2-digit', minute: '2-digit', hour12: false });
  return new Intl.DateTimeFormat(loc, o).format(d) + (time ? ' UTC' : '');
}

// ------------------------------------------------------------------ timeline

function drawTimeline() {
  const cv = $('timeline'), w = cv.clientWidth, h = 58, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const fr = st.sel; if (!fr.length) return;
  const t0 = fr[0].mjd, t1 = fr[fr.length - 1].mjd, span = Math.max(1, t1 - t0), pad = 10;
  const X = m => pad + (w - 2 * pad) * (m - t0) / span;
  st.tlX = X;
  ctx.font = '12px "Golos Text", system-ui, sans-serif'; ctx.fillStyle = '#95a2bf'; ctx.textBaseline = 'alphabetic';
  // one row per detector band, ticks coloured by survey pass
  const cur = st.mode === 'frames' ? items()[st.idx] : null;
  const curPass = st.mode === 'epochs' && st.stacks[st.idx] ? [st.stacks[st.idx].pass] : st.mode === 'diff' && st.diffs[st.idx] ? [st.stacks[st.diffs[st.idx].a].pass, st.stacks[st.diffs[st.idx].b].pass] : null;
  for (const f of fr) {
    const x = X(f.mjd), y = 4 + (f.det - 1) * 6;
    ctx.globalAlpha = f.img && !f.empty ? (curPass && !curPass.includes(f.pass) ? 0.35 : 1) : 0.25;
    ctx.fillStyle = passColor(f.pass);
    ctx.fillRect(Math.round(x) - 1, y, 2.5, 5);
  }
  ctx.globalAlpha = 1;
  if (cur) { const x = X(cur.mjd); ctx.strokeStyle = '#e8ecf4'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, 41); ctx.stroke(); }
  // pass labels
  const seen = new Map();
  for (const f of fr) { if (!seen.has(f.pass)) seen.set(f.pass, []); seen.get(f.pass).push(f); }
  ctx.fillStyle = '#95a2bf';
  for (const [, arr] of seen) {
    const xm = (X(arr[0].mjd) + X(arr[arr.length - 1].mjd)) / 2, label = passLabel(arr), tw = ctx.measureText(label).width;
    ctx.fillText(label, Math.max(2, Math.min(w - tw - 2, xm - tw / 2)), 55);
  }
}

$('timeline').addEventListener('click', e => {
  if (!st.sel.length || !st.tlX) return;
  const x = e.offsetX;
  if (st.mode === 'frames') {
    let best = 0, bd = Infinity;
    st.loaded.forEach((f, i) => { const d = Math.abs(st.tlX(f.mjd) - x); if (d < bd) { bd = d; best = i; } });
    stop(); st.idx = best; show();
  } else if (st.mode === 'epochs') {
    let best = 0, bd = Infinity;
    st.stacks.forEach((s, i) => { const d = Math.abs(st.tlX(s.frames[s.frames.length >> 1].mjd) - x); if (d < bd) { bd = d; best = i; } });
    stop(); st.idx = best; show();
  }
});

// ------------------------------------------------------------------ metadata panel

function renderMeta() {
  const dl = $('meta'), it = items()[st.idx];
  if (!it) { dl.innerHTML = `<dt class="muted">${esc(t('nothingYet'))}</dt>`; return; }
  const rows = [];
  const flag = (ok, text) => `<span class="flag ${ok ? 'ok' : 'warn'}">${esc(text)}</span>`;
  if (st.mode === 'frames') {
    const q = it.quality || {};
    const flags = [flag(q.l2 === 'Pass', `L2 ${q.l2 === 'Pass' ? t('passed') : t('failed')}`), flag(q.fineAstrometry, q.fineAstrometry ? t('astromOk') : t('astromPoor'))];
    if (q.aurora) flags.push(flag(false, t('aurora')));
    if (q.airglow) flags.push(flag(false, t('airglow')));
    if (q.shuttleGlow) flags.push(flag(false, t('glow')));
    if (q.satStreaks) flags.push(flag(false, t('streaks')));
    rows.push([t('date'), esc(fmtDate(it.mjd, true))],
      [t('wavelength2'), `${it.lambda.toFixed(3)} µm <span class="muted">(±${(it.dlambda / 2).toFixed(3)})</span>`],
      [t('detector'), `${it.det} <span class="muted">(${BANDS[it.det - 1].lo}–${BANDS[it.det - 1].hi} µm)</span>`],
      [t('exposure'), `${Math.round(it.exptime)} s`],
      [t('psf'), it.psfFwhm ? `${it.psfFwhm.toFixed(1)}″` : '–'],
      [t('onDetector'), `${Math.round(it.detX)}, ${Math.round(it.detY)}`],
      [t('quality'), flags.join(' ')],
      [t('release'), esc(it.collection.replace('spherex_', '').toUpperCase())],
      [t('file'), `<a href="${esc(it.ibeUrl)}" target="_blank" rel="noopener" title="${esc(it.id)}">${esc(it.id)}</a>`]);
  } else {
    const s = st.mode === 'epochs' ? it : null;
    if (s) {
      rows.push([t('dates'), esc(`${fmtDate(s.frames[0].mjd)} – ${fmtDate(s.frames[s.frames.length - 1].mjd)}`)],
        [t('nAveraged'), String(s.frames.length)],
        [t('waveRange'), `${s.lamLo.toFixed(2)}–${s.lamHi.toFixed(2)} µm`]);
    } else {
      rows.push([t('dates'), esc(t('minus', { a: passLabel(st.stacks[it.a].frames), b: passLabel(st.stacks[it.b].frames) }))],
        [t('waveRange'), `${Math.min(st.stacks[it.a].lamLo, st.stacks[it.b].lamLo).toFixed(2)}–${Math.max(st.stacks[it.a].lamHi, st.stacks[it.b].lamHi).toFixed(2)} µm`]);
    }
  }
  rows.unshift(['RA, Dec', `${fmtRa(st.ra)} ${fmtDec(st.dec)}`]);
  dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + (st.mode === 'diff' ? `<dd class="wide muted">${esc(t('diffHelp'))}</dd>` : '');
}

// ------------------------------------------------------------------ motion measurement

function pickPosAt(year) {
  if (st.pick.target) return targetAt(year);
  return [st.pick.ra, st.pick.dec];
}

/** Relative astrometry: pick ordinary field stars and find, for every exposure, how far its sky
 *  calibration is off from the average (median offset of those stars). Cached per load. */
function frameOffsets() {
  if (st.offsets) return st.offsets;
  const n = st.n, S = st.stacks[0];
  if (!S) return (st.offsets = new Map());
  const avoid = st.pick && !st.pick.target ? st.grid.fromSky(st.pick.ra, st.pick.dec) : st.grid.fromSky(...(st.target ? targetAt(S.year) : [st.ra, st.dec]));
  const cand = [];
  for (let j = 8; j < n - 8; j++) for (let i = 8; i < n - 8; i++) {
    const v = S.img[j * n + i] - S.bg;
    if (!(v > 25 * S.sigma) || Math.hypot(i - avoid[0], j - avoid[1]) < 24) continue;
    let peak = true;
    for (let dj = -3; dj <= 3 && peak; dj++) for (let di = -3; di <= 3; di++) if ((di || dj) && S.img[(j + dj) * n + i + di] > S.img[j * n + i]) { peak = false; break; }
    if (!peak) continue;
    let sat = false;
    for (const f of S.frames) if (f.mask[j * n + i]) { sat = true; break; }
    if (!sat) cand.push([v, i, j]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  const refs = [];
  for (const [, i, j] of cand) { if (refs.every(r => Math.hypot(r.i - i, r.j - j) > 10)) refs.push({ i, j }); if (refs.length >= 12) break; }
  for (const r of refs) [r.ra, r.dec] = st.grid.toSky(r.i, r.j);
  const med = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // star positions measured in every exposure, then each star's own median position
  const meas = refs.map(r => st.loaded.map(f => { const c = nativeCentroid(f, r.ra, r.dec, 1.5); return c && !c.saturated ? tanForward(c.ra, c.dec, r.ra, r.dec).map(v => v * 3600) : null; }));
  const home = meas.map(list => { const ok = list.filter(Boolean); return ok.length >= 3 ? [med(ok.map(o => o[0])), med(ok.map(o => o[1]))] : null; });
  const out = new Map();
  st.loaded.forEach((f, k) => {
    const de = [], dn = [];
    meas.forEach((list, s) => { if (home[s] && list[k]) { de.push(list[k][0] - home[s][0]); dn.push(list[k][1] - home[s][1]); } });
    if (de.length >= 3) out.set(f, [med(de), med(dn), de.length]);
  });
  st.offsets = out; st.nRefs = refs.filter((r, s) => home[s]).length;
  return out;
}

function measureMotion() {
  st.motion = null;
  if (!st.pick) return renderMotion();
  const offs = frameOffsets();
  const ref = st.pick.target ? targetAt(st.loaded[0].year) : [st.pick.ra, st.pick.dec];
  const byPass = new Map();
  let anySat = false;
  for (const f of st.loaded) {
    const [ra, dec] = pickPosAt(f.year);
    const c = nativeCentroid(f, ra, dec, 2.5);
    if (!c) continue;
    if (c.saturated) anySat = true;
    const [xi, eta] = tanForward(c.ra, c.dec, ref[0], ref[1]);
    const o = offs.get(f) || [0, 0];                 // remove this exposure's calibration offset
    if (!byPass.has(f.pass)) byPass.set(f.pass, []);
    byPass.get(f.pass).push({ e: xi * 3600 - o[0], n: eta * 3600 - o[1], year: f.year, f });
  }
  const med = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const rows = [...byPass.entries()].sort((a, b) => a[0] - b[0]).filter(([, a]) => a.length >= 2).map(([pass, a]) => {
    const e = med(a.map(o => o.e)), n = med(a.map(o => o.n));
    const se = k => 1.4826 * med(a.map(o => Math.abs(o[k] - (k === 'e' ? e : n)))) * 1.2533 / Math.sqrt(a.length);
    const year = a.reduce((q, o) => q + o.year, 0) / a.length;
    let pred = null;
    if (st.target && st.pick.target) { const p = targetAt(year); const [xi, eta] = tanForward(p[0], p[1], ref[0], ref[1]); pred = [xi * 3600, eta * 3600]; }
    return { pass, n: a.length, e, north: n, ee: Math.hypot(se('e'), 0.25), en: Math.hypot(se('n'), 0.25), year, pred, label: passLabel(a.map(o => o.f)) };
  });
  st.motion = { rows, anySat, nRefs: st.nRefs || 0, nMeasured: [...byPass.values()].reduce((q, a) => q + a.length, 0) };
  renderMotion();
}

function renderMotion() {
  const box = $('motion');
  if (!st.pick || !st.motion) { box.innerHTML = `<p class="muted">${esc(t('motionHint'))}</p>`; return; }
  const { rows, anySat, nMeasured } = st.motion;
  if (!nMeasured) { box.innerHTML = `<p class="muted">${esc(t('noCentroid'))}</p>`; return; }
  if (rows.length < 2) { box.innerHTML = `<p class="muted">${esc(t('needTwo'))}</p>`; return; }
  const a = rows[0], b = rows[rows.length - 1];
  const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);
  let html = `<p class="muted">${esc(st.pick.target ? t('motionTarget', { name: st.name }) : t('motionPick'))}</p><table><thead><tr><th>${esc(t('colPass'))}</th><th>${esc(t('colN'))}</th><th>${esc(t('colEast'))}</th><th>${esc(t('colNorth'))}</th>${a.pred ? `<th>${esc(t('colPred'))}</th>` : ''}</tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr><td><span class="swatch" style="background:${passColor(r.pass)}"></span>${esc(r.label)}</td><td>${r.n}</td><td>${sgn(r.e - a.e)}″</td><td>${sgn(r.north - a.north)}″</td>${r.pred ? `<td>${sgn(r.pred[0] - a.pred[0])}″, ${sgn(r.pred[1] - a.pred[1])}″</td>` : ''}</tr>`;
  }
  html += '</tbody></table>';
  const de = b.e - a.e, dn = b.north - a.north, d = Math.hypot(de, dn), err = Math.hypot(a.ee, a.en, b.ee, b.en) / Math.SQRT2, yr = b.year - a.year;
  if (d > 3 * err && d > 1.5) {
    const ang = (Math.atan2(de, dn) * 180 / Math.PI + 360) % 360;
    html += `<p class="verdict">${t('verdictMoved', { d: d.toFixed(1), px: (d / NATIVE_SCALE).toFixed(1), yr: yr.toFixed(2), rate: (d / yr).toFixed(1), dir: esc(t('dirs')[Math.round(ang / 45) % 8]) })}</p>`;
  } else html += `<p class="verdict">${esc(t('verdictStill', { d: d.toFixed(1), e: err.toFixed(1) }))}</p>`;
  if (a.pred) {
    const pe = b.pred[0] - a.pred[0], pn = b.pred[1] - a.pred[1];
    html += `<p class="muted">${esc(t('verdictPred', { d: Math.hypot(pe, pn).toFixed(1), diff: Math.hypot(de - pe, dn - pn).toFixed(1) }))}</p>`;
  }
  if (st.motion.nRefs >= 3) html += `<p class="muted">${esc(t('refsUsed', { n: st.motion.nRefs }))}</p>`;
  if (anySat) html += `<p class="muted">${esc(t('saturated'))}</p>`;
  box.innerHTML = html;
}

// ------------------------------------------------------------------ spectrum

function buildSpectrum() {
  st.spec = null;
  if (!st.pick) return drawSpectrum();
  const rAp = 1.6 * OVERSAMPLE, rIn = 3.5 * OVERSAMPLE, rOut = 6 * OVERSAMPLE, pts = [];
  for (const f of st.loaded) {
    const [ra, dec] = pickPosAt(f.year);
    const [x, y] = st.grid.fromSky(ra, dec);
    const ph = aperturePhot(f.img, st.n, SCALE, x, y, rAp, rIn, rOut);
    if (!ph) continue;
    let sat = false;
    for (let j = Math.round(y - rAp); j <= Math.round(y + rAp) && !sat; j++) for (let i = Math.round(x - rAp); i <= Math.round(x + rAp); i++)
      if (i >= 0 && j >= 0 && i < st.n && j < st.n && f.mask[j * st.n + i]) { sat = true; break; }
    // the bilinear re-sampling keeps surface brightness, so flux is the sum over grid pixels
    pts.push({ lam: f.lambda, flux: ph.flux, err: ph.err, pass: f.pass, mjd: f.mjd, sat, f, wing: wingBrightness(f, x, y) });
  }
  pts.sort((a, b) => a.lam - b.lam);
  // A lone point far from its wavelength neighbours in the same pass is a cosmic-ray hit, a hot pixel
  // or a bad exposure, not a spectral feature. Real spectra of stars change smoothly.
  const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  for (const k of new Set(pts.map(q => q.pass))) {
    const pp = pts.filter(q => q.pass === k);
    pp.forEach((q, i) => {
      const nb = [pp[i - 2], pp[i - 1], pp[i + 1], pp[i + 2]].filter(Boolean).map(o => o.flux);
      if (nb.length < 2 || q.sat) return;
      const ref = median(nb), dev = Math.abs(q.flux - ref);
      q.bad = dev > Math.max(10 * q.err, 0.6 * Math.abs(ref), 0.5);
    });
  }
  st.spec = pts;
  st.vari = variability(pts);
  drawSpectrum();
}

/** Mean brightness of a star's halo, 2.5–4.5 native pixels from the centre, ignoring saturated pixels.
 *  At a fixed wavelength the halo is a fixed fraction of the star's light, so the halo can stand in
 *  for the star when the core is saturated. Returns { v, e } in MJy/sr above sky, or null. */
function wingBrightness(f, cx, cy) {
  const n = st.n, r0 = 2.5 * OVERSAMPLE, r1 = 4.5 * OVERSAMPLE, s0 = 6 * OVERSAMPLE, s1 = 8 * OVERSAMPLE;
  const ring = [], sky = [];
  for (let j = Math.floor(cy - s1); j <= Math.ceil(cy + s1); j++) for (let i = Math.floor(cx - s1); i <= Math.ceil(cx + s1); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const v = f.img[j * n + i], r = Math.hypot(i - cx, j - cy);
    if (!Number.isFinite(v)) continue;
    if (r >= r0 && r <= r1 && !f.mask[j * n + i]) ring.push(v);
    else if (r >= s0 && r <= s1) sky.push(v);
  }
  if (ring.length < 12 || sky.length < 20) return null;
  const sk = robustStats(sky), mean = ring.reduce((a, b) => a + b, 0) / ring.length;
  return { v: mean - sk.median, e: sk.sigma / Math.sqrt(ring.length) };
}

/** Compare survey passes at matching wavelengths. Returns per-band brightness ratios (last / first pass). */
function variability(pts) {
  const passes = [...new Set(pts.filter(q => !q.bad).map(q => q.pass))].sort((a, b) => a - b);
  if (passes.length < 2) return null;
  // Saturated star: compare the halo instead of the core, for every point, so all ratios are like for like.
  const useWing = pts.filter(q => !q.bad && q.sat).length > pts.length / 4;
  const good = pts.filter(q => !q.bad).map(q => useWing ? (q.wing ? { ...q, flux: q.wing.v, err: q.wing.e } : null) : (q.sat ? null : q))
    .filter(q => q && q.flux > 3 * q.err && q.flux > 0);
  const interp = (arr, lam) => {            // log-flux linear interpolation within one pass
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i], b = arr[i + 1];
      if (lam >= a.lam && lam <= b.lam && b.lam - a.lam < 0.35) {
        const f = (lam - a.lam) / (b.lam - a.lam || 1);
        return Math.exp((1 - f) * Math.log(a.flux) + f * Math.log(b.flux));
      }
    }
    return null;
  };
  const p0 = passes[0], p1 = passes[passes.length - 1];
  const A = good.filter(q => q.pass === p0), B = good.filter(q => q.pass === p1);
  if (A.length < 3 || B.length < 3) return null;
  const rows = [];
  for (const band of BANDS) {
    const ratios = [];
    for (const q of B) if (q.lam >= band.lo && q.lam < band.hi) { const r = interp(A, q.lam); if (r) ratios.push(q.flux / r); }
    for (const q of A) if (q.lam >= band.lo && q.lam < band.hi) { const r = interp(B, q.lam); if (r) ratios.push(r / q.flux); }
    if (ratios.length < 2) continue;
    const lr = ratios.map(Math.log).sort((a, b) => a - b), m = lr[lr.length >> 1];
    const scatter = 1.4826 * lr.map(v => Math.abs(v - m)).sort((a, b) => a - b)[lr.length >> 1] / Math.sqrt(lr.length);
    rows.push({ lo: band.lo, hi: band.hi, ratio: Math.exp(m), err: Math.hypot(scatter, 0.08), n: ratios.length });   // 8% systematic floor, set with constant field stars
  }
  if (!rows.length) return null;
  const fr = k => pts.filter(q => q.pass === k).map(q => q.f).sort((a, b) => a.mjd - b.mjd);
  return { rows, from: passLabel(fr(p0)), to: passLabel(fr(p1)), p0, p1, useWing };
}

function renderVariability() {
  const box = $('vari');
  const v = st.vari;
  if (!v) { box.hidden = true; return; }
  box.hidden = false;
  const real = v.rows.filter(r => Math.abs(Math.log(r.ratio)) > Math.max(3 * r.err, Math.log(1.25)));
  const fmtR = r => (r >= 1 ? `×${r.toFixed(2)}` : `÷${(1 / r).toFixed(2)}`);
  let html = `<p class="muted">${esc(t('variIntro', { a: v.from, b: v.to }))}</p><table><thead><tr><th>${esc(t('colBand'))}</th><th>${esc(t('colChange'))}</th></tr></thead><tbody>`;
  for (const r of v.rows) {
    const sig = real.includes(r);
    html += `<tr><td>${r.lo.toFixed(2)}–${r.hi.toFixed(2)} µm</td><td>${sig ? '<b>' : ''}${fmtR(r.ratio)}${sig ? '</b>' : ''} <span class="muted">±${Math.round(r.err * 100)}%</span></td></tr>`;
  }
  html += '</tbody></table>';
  html += `<p class="verdict">${real.length >= 2 ? t('variYes') : real.length === 1 ? esc(t('variOne')) : esc(t('variNo'))}</p>`;
  if (v.useWing) html += `<p class="muted">${esc(t('variWing'))}</p>`;
  box.innerHTML = html;
}

function drawSpectrum(hover = null) {
  const cv = $('spec'), h = 230, dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.style.display = st.spec ? 'block' : 'none';
  const w = cv.clientWidth;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const pts = st.spec, leg = $('specLegend');
  renderVariability();
  $('specHint').hidden = !!(pts && pts.length);
  leg.innerHTML = '';
  if (!pts || !w) { $('specHint').textContent = t('specHint'); return; }
  $('specHint').textContent = t(pts.length ? 'specHint' : 'specNone');
  if (!pts.length) { $('specHint').hidden = false; return; }
  const m = { l: 54, r: 8, t: 10, b: 34 }, pw = w - m.l - m.r, phh = h - m.t - m.b;
  let x0 = Math.min(...pts.map(p => p.lam)), x1 = Math.max(...pts.map(p => p.lam));
  const padX = Math.max(0.05, (0.5 - (x1 - x0)) / 2, (x1 - x0) * 0.04);
  x0 = Math.max(0.6, x0 - padX); x1 = Math.min(5.2, x1 + padX);
  const fl = pts.filter(p => !p.bad).map(p => p.flux).sort((a, b) => a - b);
  const hi = Math.max(fl[Math.min(fl.length - 1, Math.floor(fl.length * 0.98))] * 1.15, 1e-3), lo = Math.min(0, fl[0]);
  const X = v => m.l + pw * (v - x0) / (x1 - x0), Y = v => m.t + phh * (1 - (Math.min(v, hi) - lo) / (hi - lo));
  ctx.font = '12px "Golos Text", system-ui, sans-serif'; ctx.textBaseline = 'middle';
  // grid + axes (recessive)
  ctx.strokeStyle = '#26324f'; ctx.fillStyle = '#95a2bf'; ctx.lineWidth = 1;
  const stepY = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) {
    ctx.beginPath(); ctx.moveTo(m.l, Y(v)); ctx.lineTo(w - m.r, Y(v)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(fmtNum(v), m.l - 6, Y(v));
  }
  ctx.textAlign = 'center';
  const stepX = niceStep((x1 - x0) / 5);
  for (let v = Math.ceil(x0 / stepX) * stepX; v <= x1 + 1e-9; v += stepX) ctx.fillText(stepX < 1 ? v.toFixed(stepX < 0.1 ? 2 : 1) : String(Math.round(v)), X(v), h - m.b + 12);
  ctx.fillText(t('specAxisX'), m.l + pw / 2, h - 8);
  ctx.save(); ctx.translate(10, m.t + phh / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(t('specAxisY'), 0, 0); ctx.restore();
  if (lo < 0) { ctx.strokeStyle = '#4a5a82'; ctx.beginPath(); ctx.moveTo(m.l, Y(0)); ctx.lineTo(w - m.r, Y(0)); ctx.stroke(); }
  // one thin line per pass, then markers
  const passes = [...new Set(pts.map(p => p.pass))].sort((a, b) => a - b);
  for (const k of passes) {
    const pp = pts.filter(p => p.pass === k && !p.bad);
    ctx.strokeStyle = passColor(k); ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5; ctx.beginPath();
    pp.forEach((p, i) => (i ? ctx.lineTo(X(p.lam), Y(p.flux)) : ctx.moveTo(X(p.lam), Y(p.flux)))); ctx.stroke(); ctx.globalAlpha = 1;
  }
  st.specXY = pts.map(p => [X(p.lam), Y(p.flux)]);
  pts.forEach((p, i) => {
    const [x, y] = st.specXY[i];
    if (p.bad) { ctx.strokeStyle = '#5f6c8a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - 3, m.t + 2); ctx.lineTo(x + 3, m.t + 8); ctx.moveTo(x + 3, m.t + 2); ctx.lineTo(x - 3, m.t + 8); ctx.stroke(); return; }
    ctx.beginPath(); ctx.arc(x, y, hover === i ? 6 : 4, 0, 6.2832);
    if (p.sat) { ctx.fillStyle = '#0f1528'; ctx.fill(); ctx.strokeStyle = passColor(p.pass); ctx.lineWidth = 2; ctx.stroke(); }
    else { ctx.fillStyle = passColor(p.pass); ctx.fill(); ctx.strokeStyle = '#0f1528'; ctx.lineWidth = 1.5; ctx.stroke(); }
  });
  for (const k of passes) {
    const fr = pts.filter(p => p.pass === k).map(p => p.f).sort((a, b) => a.mjd - b.mjd);
    const s = document.createElement('span'); s.innerHTML = `<span class="swatch" style="background:${passColor(k)}"></span>`; s.append(passLabel(fr)); leg.appendChild(s);
  }
  if (pts.some(p => p.bad)) { const s = document.createElement('span'); s.textContent = `× ${t('specBad')}`; leg.appendChild(s); }
  if (pts.some(p => p.sat)) { const s = document.createElement('span'); s.textContent = `○ ${t('specSat')}`; leg.appendChild(s); }
}
const niceStep = r => { const p = Math.pow(10, Math.floor(Math.log10(r))), f = r / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
const fmtNum = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));

$('spec').addEventListener('mousemove', e => {
  if (!st.spec || !st.specXY) return;
  let best = -1, bd = 18;
  st.specXY.forEach(([x, y], i) => { const d = Math.hypot(x - e.offsetX, y - e.offsetY); if (d < bd) { bd = d; best = i; } });
  const tip = $('specTip');
  drawSpectrum(best < 0 ? null : best);
  if (best < 0) { tip.hidden = true; return; }
  const p = st.spec[best];
  tip.textContent = t('specTip', { lam: p.lam.toFixed(3), f: fmtNum(p.flux), date: fmtDate(p.mjd) }) + (p.sat ? ` · ${t('specSat')}` : '');
  tip.hidden = false;
  const wrap = $('specWrap').getBoundingClientRect();
  tip.style.left = `${Math.min(wrap.width - tip.offsetWidth - 4, Math.max(0, st.specXY[best][0] - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(0, st.specXY[best][1] - 38)}px`;
});
$('spec').addEventListener('mouseleave', () => { $('specTip').hidden = true; drawSpectrum(); });
$('spec').addEventListener('click', e => {
  if (!st.spec || !st.specXY) return;
  let best = -1, bd = 18;
  st.specXY.forEach(([x, y], i) => { const d = Math.hypot(x - e.offsetX, y - e.offsetY); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return;
  const i = st.loaded.indexOf(st.spec[best].f);
  if (i >= 0) { stop(); setMode('frames', false); st.idx = i; show(); }
});

// ------------------------------------------------------------------ plate interaction

function plateToGrid(e) {
  const r = $('plate').getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * st.n - 0.5, (e.clientY - r.top) / r.height * st.n - 0.5];
}
$('plate').addEventListener('mousemove', e => {
  const it = items()[st.idx], hv = $('hover');
  if (!it || !st.grid) { hv.hidden = true; return; }
  const [x, y] = plateToGrid(e), i = Math.round(x), j = Math.round(y);
  if (i < 0 || j < 0 || i >= st.n || j >= st.n) { hv.hidden = true; return; }
  const [ra, dec] = st.grid.toSky(x, y);
  const v = it.img[j * st.n + i] - (st.mode === 'diff' ? 0 : it.bg);
  hv.hidden = false;
  hv.textContent = `${fmtRa(ra)} ${fmtDec(dec)}` + (Number.isFinite(v) ? ` · ${t('hoverVal', { v: fmtNum(v) })}` : '');
});
$('plate').addEventListener('mouseleave', () => { $('hover').hidden = true; });
$('plate').addEventListener('click', e => {
  if (!st.loaded.length || st.busy) return;
  const [x, y] = plateToGrid(e);
  // snap to the brightest pixel nearby in what is on screen
  const it = items()[st.idx];
  const img = st.mode === 'diff' ? st.stacks[it.b].img : it.img;
  let bx = Math.round(x), by = Math.round(y), best = -Infinity;
  for (let j = Math.round(y) - 4; j <= Math.round(y) + 4; j++) for (let i = Math.round(x) - 4; i <= Math.round(x) + 4; i++) {
    if (i < 0 || j < 0 || i >= st.n || j >= st.n) continue;
    const v = img[j * st.n + i]; if (Number.isFinite(v) && v > best) { best = v; bx = i; by = j; }
  }
  const [ra, dec] = st.grid.toSky(bx, by);
  const nearTarget = st.target && sepArcsec(ra, dec, ...targetAt(it.year ?? REF_EPOCH)) < 12;
  st.pick = nearTarget ? { target: true } : { ra, dec };
  if (!nearTarget) {     // refine on the first exposure that sees it
    for (const f of st.loaded) { const c = nativeCentroid(f, ra, dec, 2); if (c) { st.pick = { ra: c.ra, dec: c.dec }; break; } }
  }
  st.offsets = null;
  measureMotion(); buildSpectrum(); show(); writeUrl();
  window.dispatchEvent(new CustomEvent('sourcepicked'));
});

// ------------------------------------------------------------------ Gaia overlay

async function loadGaia() {
  if (st.ra == null) return;
  const key = `${st.ra.toFixed(4)},${st.dec.toFixed(4)},${st.fov}`;
  if (st.gaiaKey === key) return;
  st.gaiaKey = key; st.gaia = null;
  try {
    const r = await fetch(`/api/gaia?ra=${st.ra.toFixed(6)}&dec=${st.dec.toFixed(6)}&radius=${(st.fov / 60 * 0.75).toFixed(4)}`);
    if (!r.ok) throw new Error(String(r.status));
    const lines = (await r.text()).trim().split(/\r?\n/).slice(1);
    st.gaia = lines.map(l => { const c = l.split(','); return { ra: +c[1], dec: +c[2], pmra: +c[3] || 0, pmdec: +c[4] || 0, plx: +c[5] || 0, mag: +c[6] }; }).filter(s => Number.isFinite(s.ra) && Number.isFinite(s.dec));
    if (st.gaiaKey === key) show();
  } catch { st.gaiaKey = null; if (!st.busy) setStatus(t('gaiaFailed'), true); }
}

// ------------------------------------------------------------------ URL, saving, events

function writeUrl() {
  const p = new URLSearchParams();
  if (st.target && st.target.id) p.set('t', st.target.id);
  else if (st.target) p.set('name', st.target.name);
  else { p.set('ra', st.ra.toFixed(5)); p.set('dec', st.dec.toFixed(5)); }
  p.set('fov', String(st.fov)); if (st.band) p.set('band', String(st.band)); if (st.max !== 48) p.set('n', String(st.max));
  if (lang !== 'en') p.set('lang', lang);
  if (st.pick && Number.isFinite(st.pick.ra)) p.set('pick', `${st.pick.ra.toFixed(6)},${st.pick.dec.toFixed(6)}`);
  const cur = new URLSearchParams(location.search);
  for (const k of ['collections', 'mission']) { const v = cur.get(k); if (v) p.set(k, v); }
  history.replaceState(null, '', `${location.pathname}?${p}${location.hash}`);   // keep the open tab
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('collections')) setCollections(p.get('collections').split(',').filter(s => /^spherex_[a-z0-9_]+$/.test(s)));
  if (p.get('fov') && [...$('fov').options].some(o => o.value === p.get('fov'))) $('fov').value = p.get('fov');
  if (p.get('n') && [...$('maxFrames').options].some(o => o.value === p.get('n'))) $('maxFrames').value = p.get('n');
  if (p.get('band')) st.band = Math.max(0, Math.min(6, Number(p.get('band')) || 0));
  const pk = (p.get('pick') || '').split(',').map(Number);
  st.pendingPick = pk.length === 2 && pk.every(Number.isFinite) ? { ra: pk[0], dec: pk[1] } : null;
  const tg = p.get('t') && targetById(p.get('t'));
  if (tg) { if (!p.get('band')) st.band = tg.band; if (!p.get('fov')) $('fov').value = String(tg.fov); $('q').value = tg.name; buildBands(); return run({ target: tg }); }
  if (p.get('name')) { $('q').value = p.get('name'); buildBands(); return run(); }
  const ra = Number(p.get('ra')), dec = Number(p.get('dec'));
  if (p.get('ra') !== null && p.get('dec') !== null && Number.isFinite(ra) && Number.isFinite(dec)) { $('q').value = `${ra} ${dec >= 0 ? '+' : ''}${dec}`; buildBands(); return run({ ra, dec }); }
  buildBands();
}

function composite(sizePx = 720) {
  const c = document.createElement('canvas'); c.width = c.height = sizePx;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = $('smooth').checked;
  ctx.drawImage($('sky'), 0, 0, sizePx, sizePx); ctx.drawImage($('overlay'), 0, 0, sizePx, sizePx);
  const cap = $('caption').innerText.split('\n');
  ctx.font = '600 20px "Golos Text", system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 6; ctx.textBaseline = 'top';
  ctx.fillText(cap[0] || '', 16, 14); ctx.font = '15px "Golos Text", system-ui, sans-serif'; if (st.mode !== 'diff') ctx.fillText(cap[1] || '', 16, 42);
  ctx.font = '13px "Golos Text", system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('Data: SPHEREx / NASA / JPL-Caltech / IPAC (IRSA)', sizePx - 12, sizePx - 10);
  return c;
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const fileStem = () => (st.name || `${st.ra.toFixed(3)}_${st.dec.toFixed(3)}`).replace(/[^\w.+-]+/g, '_');

$('savePng').addEventListener('click', () => { if (items().length) composite().toBlob(b => download(b, `${fileStem()}_${st.mode}_${st.idx + 1}.png`)); });
$('saveGif').addEventListener('click', async () => {
  const list = items(); if (!list.length) return;
  const { encodeGif } = await import('./gif.js');
  stop(); const keep = st.idx, frames = [];
  for (let i = 0; i < list.length; i++) { st.idx = i; show(); frames.push(composite(480).getContext('2d').getImageData(0, 0, 480, 480)); }
  st.idx = keep; show();
  const delay = st.mode === 'frames' ? Math.round(100 / Number($('fps').value)) : 70;
  download(new Blob([encodeGif(frames, 480, 480, delay)], { type: 'image/gif' }), `${fileStem()}_${st.mode}.gif`);
});

$('searchForm').addEventListener('submit', e => { e.preventDefault(); if ($('q').value.trim()) run(); });
$('prev').addEventListener('click', () => { stop(); step(-1); });
$('next').addEventListener('click', () => { stop(); step(1); });
$('play').addEventListener('click', () => (st.playing ? stop() : play()));
$('scrub').addEventListener('input', e => { stop(); st.idx = Number(e.target.value); show(); });
$('fps').addEventListener('input', () => { if (st.playing) play(); });
$('gain').addEventListener('input', e => { st.gain = Number(e.target.value); show(); });
$('cmap').addEventListener('change', e => { st.cmap = e.target.value; show(); });
$('order').addEventListener('change', e => { st.order = e.target.value; const cur = items()[st.idx]; sortLoaded(); if (st.mode === 'frames') st.idx = Math.max(0, st.loaded.indexOf(cur)); show(); });
$('smooth').addEventListener('change', e => { $('sky').classList.toggle('smooth', e.target.checked); });
$('showGaia').addEventListener('change', e => { if (e.target.checked) loadGaia(); show(); });
$('share').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); setStatus(t('copied')); } catch { prompt('', location.href); } });
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => { const was = st.playing; setMode(b.dataset.mode); if (was) play(); });
for (const b of document.querySelectorAll('.lang button')) b.addEventListener('click', () => { setLang(b.dataset.lang); buildTargets(); buildBands(); if (st.ra != null) writeUrl(); show(); renderMotion(); drawSpectrum(); });
document.addEventListener('keydown', e => {
  if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); st.playing ? stop() : play(); }
  else if (e.key === 'ArrowLeft') { stop(); step(-1); }
  else if (e.key === 'ArrowRight') { stop(); step(1); }
});
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { show(); drawSpectrum(); }, 120); });

window.__app = { composite, show, setMode, items, stop, encode: async (frames, w, h, d) => (await import('./gif.js')).encodeGif(frames, w, h, d) };   // for exporting slide images

setLang(initialLang());
import('./i18n-ui.js').then(m => m.initUiI18n()).catch(e => console.error(e));
buildTargets();
startPlanet($('planet'));
readUrl();

// ---------------------------------------------------------------- views (tabs): #sky, #detect, #inject, #fingerprint
const VIEWS = { sky: ['skymap', () => import('./sky.js').then(m => m.openSky())],
  detect: ['detectView', () => import('./detect.js').then(m => m.openDetect())],
  inject: ['injectView', () => import('./inject.js').then(m => m.openInject())],
  fingerprint: ['fpView', () => import('./fingerprint.js').then(m => m.openFingerprint())],
  track: ['trackView', () => import('./track.js').then(m => m.openTrack())],
  practice: ['practiceView', () => import('./practice.js').then(m => m.openPractice())],
  classroom: ['classView', () => import('./classroom.js').then(m => m.openClassroom())] };
function applyView() {
  const v = location.hash.replace(/^#/, '').split('/')[0];
  const cur = VIEWS[v] ? v : '';
  document.body.classList.toggle('view-sky', cur === 'sky');
  document.body.classList.toggle('view-page', !!cur && cur !== 'sky');
  for (const [k, [id]] of Object.entries(VIEWS)) { const el = $(id); if (el) el.hidden = k !== cur; }
  for (const a of document.querySelectorAll('.views a')) {
    if ((a.dataset.view || '') === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (cur) VIEWS[cur][1]().catch(e => console.error(e));
  if (cur && cur !== 'sky') window.scrollTo(0, 0);
}
window.addEventListener('hashchange', applyView);
applyView();
if (new URLSearchParams(location.search).get('mission')) import('./practice.js').then(m => m.initMission()).catch(e => console.error(e));
