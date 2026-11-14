// inject.js — "Does our method work?" An injection–recovery test on real SPHEREx data.
// We take the stacked images of two survey passes of the field loaded in the Blink viewer,
// add a fake point source (a Gaussian with the PSF width measured from field stars) that sits
// at one spot in the early pass and a shifted spot in the late pass, then run the same
// detection the site uses: subtract the passes and look for the +/− pair (a "dipole").
// Repeating this many times at random empty spots gives the completeness: the fraction of
// fakes we recover, as a function of brightness and of how far the source moved.
//
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

import { robustStats } from './spherex.js';
import { paint } from './render.js';
import { TARGETS } from './targets.js';

const $ = id => document.getElementById(id);
const ST = () => window.__st;
const K_SIGMA = 5;                         // detection threshold on each lobe
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const mJyToAB = f => -2.5 * Math.log10(f / 3.631e6);
const abToMJy = m => 3.631e6 * 10 ** (-0.4 * m);

let F = null;          // the prepared field
let rng = mulberry32(20261115);
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ field preparation
function prepareField() {
  const st = ST();
  if (!st || !st.stacks || st.stacks.length < 2 || !st.grid) return null;
  const solid = st.stacks.filter(s => s.frames.length >= 4);
  const use = solid.length >= 2 ? solid : st.stacks;
  const A = use[0], B = use[use.length - 1], n = st.n;
  const a = Float32Array.from(A.img, v => v - A.bg), b = Float32Array.from(B.img, v => v - B.bg);
  const sa = robustStats(a).sigma, sb = robustStats(b).sigma;
  const fwhm = measureFwhm(a, n, sa) || 2.6 * 1.0;     // grid pixels; fallback ~8″
  const sig = fwhm / 2.3548;
  const scale = st.grid.scale;
  const k = (scale / 206264.806) ** 2 * 1e9;           // MJy/sr per grid pixel -> mJy
  const d = new Float32Array(n * n);
  for (let p = 0; p < d.length; p++) d[p] = b[p] - a[p];
  const sd = robustStats(d).sigma;
  // 5σ depth of PSF-fitted flux on the difference image (one lobe)
  const sumW2 = 1 / (4 * Math.PI * sig * sig);
  const flux5 = K_SIGMA * sd / Math.sqrt(sumW2) * k;
  return { key: fieldKey(st), n, a, b, sa, sb, sd, fwhm, sig, scale, k, flux5, mag5: mJyToAB(flux5), A, B,
    name: st.name || `${st.ra.toFixed(3)} ${st.dec.toFixed(3)}`, band: st.band };
}

const fieldKey = st => `${st.ra}|${st.dec}|${st.band}|${st.stacks.map(s => s.frames.length).join(',')}`;

/** PSF width from the second moments of bright, unsaturated, isolated field stars in the early stack. */
function measureFwhm(img, n, s) {
  const peaks = [];
  for (let j = 6; j < n - 6; j++) for (let i = 6; i < n - 6; i++) {
    const v = img[j * n + i];
    if (!(v > 40 * s)) continue;
    let isMax = true;
    for (let dj = -2; dj <= 2 && isMax; dj++) for (let di = -2; di <= 2; di++) if ((di || dj) && !(img[(j + dj) * n + i + di] < v)) { isMax = false; break; }
    if (isMax) peaks.push([i, j, v]);
  }
  peaks.sort((p, q) => q[2] - p[2]);
  const ws = [];
  for (const [i, j] of peaks.slice(3, 40)) {                 // skip the very brightest (often saturated)
    let s0 = 0, sxx = 0, syy = 0, bad = false;
    for (let dj = -5; dj <= 5; dj++) for (let di = -5; di <= 5; di++) {
      const v = img[(j + dj) * n + i + di];
      if (!Number.isFinite(v)) { bad = true; continue; }
      if (di * di + dj * dj > 25) continue;
      const w = Math.max(0, v);
      s0 += w; sxx += w * di * di; syy += w * dj * dj;
    }
    if (bad || s0 <= 0) continue;
    const sg = Math.sqrt((sxx + syy) / (2 * s0));
    if (sg > 0.6 && sg < 4) ws.push(sg * 2.3548);
  }
  if (ws.length < 3) return null;
  ws.sort((x, y) => x - y);
  return ws[ws.length >> 1];
}

// ------------------------------------------------------------------ injection and detection
function addPsf(img, n, x, y, fluxImg, sig) {
  const r = Math.ceil(4 * sig), norm = 1 / (2 * Math.PI * sig * sig);
  for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++) for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const p = j * n + i;
    if (!Number.isFinite(img[p])) continue;
    img[p] += fluxImg * norm * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sig * sig));
  }
}
/** PSF-weighted (matched-filter) flux and S/N at a sub-pixel position. */
function psfSnr(img, n, x, y, sig, sd) {
  const r = Math.ceil(3 * sig), norm = 1 / (2 * Math.PI * sig * sig);
  let sw = 0, sww = 0;
  for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++) for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const v = img[j * n + i];
    if (!Number.isFinite(v)) continue;
    const w = norm * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sig * sig));
    sw += w * v; sww += w * w;
  }
  if (!sww) return { f: 0, snr: 0 };
  return { f: sw / sww, snr: sw / (sd * Math.sqrt(sww)) };
}
/** Best lobe within ±1.5 grid px of the expected spot (sign +1 for the bright lobe, −1 for the hole). */
function lobe(img, n, x, y, sig, sd, sign) {
  let best = { snr: -Infinity };
  for (let dy = -1.5; dy <= 1.5; dy += 0.5) for (let dx = -1.5; dx <= 1.5; dx += 0.5) {
    const r = psfSnr(img, n, x + dx, y + dy, sig, sd);
    const s = sign * r.snr;
    if (s > best.snr) best = { snr: s, x: x + dx, y: y + dy, f: sign * r.f };
  }
  return best;
}

/** A spot of empty sky with room for the shift; null after too many tries. */
function randomSpot(shiftPx) {
  const { n, a, b, sa, sb } = F;
  const m = Math.ceil(4 * F.sig + shiftPx + 3);
  for (let t = 0; t < 200; t++) {
    const x = m + rng() * (n - 2 * m), y = m + rng() * (n - 2 * m);
    const ang = rng() * 2 * Math.PI, x2 = x + shiftPx * Math.cos(ang), y2 = y + shiftPx * Math.sin(ang);
    if (busy(a, n, x, y, sa) || busy(b, n, x, y, sb) || busy(a, n, x2, y2, sa) || busy(b, n, x2, y2, sb)) continue;
    return { x, y, x2, y2 };
  }
  return null;
}
function busy(img, n, x, y, s) {
  const r = Math.ceil(3 * F.sig) + 2;
  for (let j = Math.round(y) - r; j <= Math.round(y) + r; j++) for (let i = Math.round(x) - r; i <= Math.round(x) + r; i++) {
    const v = img[j * n + i];
    if (!Number.isFinite(v) || Math.abs(v) > 8 * s) return true;
  }
  return false;
}

/** One trial. With mag = null nothing is injected (false-alarm check). */
function trial(mag, shiftArcsec, spot) {
  const { n, a, b, sig, k, sd } = F;
  const shiftPx = shiftArcsec / F.scale;
  spot = spot || randomSpot(shiftPx);
  if (!spot) return null;
  const ea = a.slice(), lb = b.slice();
  if (mag != null) {
    const fImg = abToMJy(mag) / k;
    addPsf(ea, n, spot.x, spot.y, fImg, sig);
    addPsf(lb, n, spot.x2, spot.y2, fImg, sig);
  }
  const d = new Float32Array(n * n);
  for (let p = 0; p < d.length; p++) d[p] = lb[p] - ea[p];
  const pos = lobe(d, n, spot.x2, spot.y2, sig, sd, +1), neg = lobe(d, n, spot.x, spot.y, sig, sd, -1);
  return { spot, ea, lb, d, pos, neg, found: pos.snr >= K_SIGMA && neg.snr >= K_SIGMA };
}

// ------------------------------------------------------------------ UI
function stamp(canvas, img, n, cx, cy, half, diverging, vmax, soft, marks) {
  const size = 2 * half + 1, sub = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = Math.round(cx) - half + i, y = Math.round(cy) - half + j;
    sub[j * size + i] = x >= 0 && y >= 0 && x < n && y < n ? img[y * n + x] : NaN;
  }
  const off = document.createElement('canvas'); off.width = off.height = size;
  paint(off.getContext('2d'), sub, size, { vmax, soft, cmap: 'gray', diverging });
  const S = canvas.clientWidth || 200, dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = S * dpr;
  const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, canvas.width, canvas.height);
  const sc = canvas.width / size;
  for (const [x, y, col] of marks) {
    g.strokeStyle = col; g.lineWidth = 1.5 * dpr;
    g.beginPath(); g.arc((x - (Math.round(cx) - half) + 0.5) * sc, (y - (Math.round(cy) - half) + 0.5) * sc, 2.2 * F.fwhm * sc / 2 + 4 * dpr, 0, Math.PI * 2); g.stroke();
  }
}

function runSingle() {
  if (!F) return;
  const mag = Number($('iMag').value), shift = Number($('iShift').value);
  const r = trial(mag, shift);
  if (!r) { $('iSingleOut').textContent = 'No empty spot was found with room for this shift. Try a smaller shift.'; return; }
  const { spot } = r, cx = (spot.x + spot.x2) / 2, cy = (spot.y + spot.y2) / 2;
  const half = Math.max(14, Math.ceil(Math.hypot(spot.x2 - spot.x, spot.y2 - spot.y) / 2 + 4 * F.fwhm));
  const vmax = Math.max(12 * F.sa, abToMJy(mag) / F.k / (2 * Math.PI * F.sig ** 2) * 1.2), soft = 2 * F.sa;
  stamp($('iEarly'), r.ea, F.n, cx, cy, half, false, vmax, soft, [[spot.x, spot.y, '#6fd3ff']]);
  stamp($('iLate'), r.lb, F.n, cx, cy, half, false, vmax, soft, [[spot.x2, spot.y2, '#ff8a4c']]);
  stamp($('iDiff'), r.d, F.n, cx, cy, half, true, vmax, 2 * F.sd, [[spot.x, spot.y, '#6fd3ff'], [spot.x2, spot.y2, '#ff8a4c']]);
  $('iSingleOut').innerHTML = `<div class="verdict ${r.found ? 'yes' : 'no'}"><b>${r.found ? 'FOUND' : 'NOT FOUND'}</b>
    <span>Bright lobe (where it went): S/N ${fmt(r.pos.snr)} · dark lobe (where it was): S/N ${fmt(r.neg.snr)}. Both must reach ${K_SIGMA}.</span></div>`;
}

let curve = null;
async function runCompleteness() {
  if (!F) return;
  const btn = $('iRun'); btn.disabled = true;
  const shifts = [1.5, 3, 6, 9, 15, 25, 40];
  const mags = []; for (let m = F.mag5 - 1.5; m <= F.mag5 + 1.51; m += 0.25) mags.push(Math.round(m * 100) / 100);
  const N = Number($('iTrials').value) || 20;
  const grid = mags.map(() => shifts.map(() => ({ n: 0, k: 0 })));
  let done = 0; const total = mags.length * shifts.length * N;
  rng = mulberry32(20261115);
  for (let mi = 0; mi < mags.length; mi++) {
    for (let si = 0; si < shifts.length; si++) for (let t = 0; t < N; t++) {
      const r = trial(mags[mi], shifts[si]);
      if (r) { grid[mi][si].n++; if (r.found) grid[mi][si].k++; }
      done++;
    }
    $('iProgress').textContent = `Running… ${Math.round(done / total * 100)}%`;
    await new Promise(res => setTimeout(res, 0));
  }
  // false alarms: same detector on random spots with nothing injected
  let fa = 0, fn = 0;
  for (let t = 0; t < 400; t++) { const r = trial(null, shifts[2 + (t % 5)]); if (r) { fn++; if (r.found) fa++; } }
  curve = { mags, shifts, grid, fa, fn, N };
  $('iProgress').textContent = `${total} injections on real ${F.name} data, plus ${fn} empty-sky checks.`;
  btn.disabled = false;
  drawHeat(); drawCurve();
}

function mag50(row) {
  // brightness where completeness crosses 50% (linear interpolation), for one shift column
  const { mags, grid } = curve;
  const c = mags.map((m, i) => (grid[i][row].n ? grid[i][row].k / grid[i][row].n : NaN));
  for (let i = 1; i < c.length; i++) if (c[i - 1] >= 0.5 && c[i] < 0.5) return mags[i - 1] + (mags[i] - mags[i - 1]) * (c[i - 1] - 0.5) / (c[i - 1] - c[i]);
  return NaN;
}

function drawHeat() {
  const { mags, shifts, grid, fa, fn } = curve;
  const cv = $('iHeat'), dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, Hh = 300;
  cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hh);
  const pad = { l: 60, r: 10, t: 10, b: 40 }, cw = (W - pad.l - pad.r) / shifts.length, ch = (Hh - pad.t - pad.b) / mags.length;
  g.font = '11px "Golos Text", system-ui, sans-serif';
  mags.forEach((m, i) => shifts.forEach((s, j) => {
    const c = grid[i][j], f = c.n ? c.k / c.n : NaN;
    const t = Number.isFinite(f) ? f : 0;
    // sequential single hue: dark navy -> ember
    const col = [Math.round(20 + t * 235), Math.round(28 + t * 110), Math.round(52 + t * 24)];
    g.fillStyle = Number.isFinite(f) ? `rgb(${col})` : '#11182b';
    g.fillRect(pad.l + j * cw + 1, pad.t + i * ch + 1, cw - 2, ch - 2);
    if (ch > 16) { g.fillStyle = t > 0.55 ? '#0b1020' : '#e8ecf4'; g.textAlign = 'center'; g.fillText(Number.isFinite(f) ? `${Math.round(f * 100)}` : '', pad.l + (j + 0.5) * cw, pad.t + (i + 0.5) * ch + 4); }
  }));
  g.fillStyle = '#95a2bf'; g.textAlign = 'right';
  mags.forEach((m, i) => { if (i % 2 === 0) g.fillText(m.toFixed(2), pad.l - 6, pad.t + (i + 0.5) * ch + 4); });
  g.textAlign = 'center';
  shifts.forEach((s, j) => g.fillText(`${s}″`, pad.l + (j + 0.5) * cw, Hh - pad.b + 16));
  g.fillText('Shift between the two passes (arcsec)', (pad.l + W - pad.r) / 2, Hh - 6);
  g.save(); g.translate(14, (pad.t + Hh - pad.b) / 2); g.rotate(-Math.PI / 2); g.fillText('Injected brightness (AB mag)', 0, 0); g.restore();
  const big = shifts.findIndex(s => s / F.scale >= 2 * F.fwhm);
  const m50 = mag50(big >= 0 ? big : shifts.length - 1);
  $('iSummary').innerHTML = `
    <div><b>${fmt(m50, 2)}</b><span>AB mag at 50% completeness, shifts ≥ ${shifts[big >= 0 ? big : shifts.length - 1]}″</span></div>
    <div><b>${fmt(F.mag5, 2)}</b><span>predicted 5σ depth of this difference image</span></div>
    <div><b>${fn ? fmt(fa / fn * 100, 1) : '—'}%</b><span>false alarms on empty sky (${fa} of ${fn})</span></div>
    <div><b>${fmt(F.fwhm * F.scale, 1)}″</b><span>PSF width measured from field stars</span></div>`;
}

function drawCurve() {
  const { mags, shifts, grid } = curve;
  const cv = $('iCurve'), dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, Hh = 240;
  cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hh);
  const pad = { l: 44, r: 12, t: 12, b: 36 };
  const x = m => pad.l + (m - mags[0]) / (mags[mags.length - 1] - mags[0]) * (W - pad.l - pad.r);
  const y = f => pad.t + (1 - f) * (Hh - pad.t - pad.b);
  g.strokeStyle = 'rgba(149,162,191,0.15)'; g.fillStyle = '#95a2bf'; g.font = '11px "Golos Text", system-ui, sans-serif';
  for (const f of [0, 0.25, 0.5, 0.75, 1]) { g.beginPath(); g.moveTo(pad.l, y(f)); g.lineTo(W - pad.r, y(f)); g.stroke(); g.textAlign = 'right'; g.fillText(`${f * 100}%`, pad.l - 6, y(f) + 4); }
  g.textAlign = 'center';
  for (let i = 0; i < mags.length; i += 2) g.fillText(mags[i].toFixed(1), x(mags[i]), Hh - pad.b + 16);
  g.fillText('Injected brightness (AB mag, fainter →)', (pad.l + W - pad.r) / 2, Hh - 4);
  const show = [[1, '#6fd3ff'], [3, '#9b76dc'], [5, '#ff8a4c']];
  const legend = [];
  for (const [j, col] of show) {
    g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
    mags.forEach((m, i) => { const c = grid[i][j]; const f = c.n ? c.k / c.n : 0; i ? g.lineTo(x(m), y(f)) : g.moveTo(x(m), y(f)); });
    g.stroke();
    legend.push(`<span><i style="border-top:2px solid ${col}"></i>moved ${shifts[j]}″ (${fmt(shifts[j] / F.scale / F.fwhm, 1)} × PSF width)</span>`);
  }
  $('iCurveLegend').innerHTML = legend.join('');
}

function renderField() {
  const box = $('iField');
  if (!F) {
    const st = ST();
    const loading = st && st.busy;
    box.innerHTML = `<p class="muted">${loading ? `Loading the field in the Blink viewer… <span id="iWait"></span>` : 'Load a field first: the test runs on the real SPHEREx stacks of whatever the Blink viewer has loaded.'}</p>
      <div class="chips">${TARGETS.filter(t => t.kind === 'mover').map(t => `<a class="chip" href="./?t=${t.id}#inject">${t.name}</a>`).join('')}</div>`;
    $('iBody').hidden = true;
    return;
  }
  const yr = s => s.frames[0] ? new Date((s.frames[0].mjd - 40587) * 864e5).toISOString().slice(0, 7) : '';
  box.innerHTML = `<dl class="meta">
    <dt>Field</dt><dd>${F.name}</dd>
    <dt>Passes compared</dt><dd>${yr(F.A)} (${F.A.frames.length} exp.) vs ${yr(F.B)} (${F.B.frames.length} exp.)</dd>
    <dt>PSF width (FWHM)</dt><dd>${fmt(F.fwhm * F.scale, 1)}″ = ${fmt(F.fwhm / 2, 2)} SPHEREx px</dd>
    <dt>Noise in the difference image</dt><dd>${(F.sd).toExponential(2)} MJy/sr per pixel</dd>
    <dt>Predicted 5σ depth</dt><dd>AB ${fmt(F.mag5, 2)}</dd></dl>`;
  $('iBody').hidden = false;
  $('iMag').min = (F.mag5 - 2).toFixed(1); $('iMag').max = (F.mag5 + 2).toFixed(1);
  if (!$('iMag').dataset.set) { $('iMag').value = (F.mag5 - 0.5).toFixed(1); $('iMag').dataset.set = '1'; }
  syncLabels();
}
function syncLabels() { $('iMagV').textContent = `AB ${Number($('iMag').value).toFixed(1)}`; $('iShiftV').textContent = `${$('iShift').value}″`; }

function build() {
  $('injectView').innerHTML = `
  <header class="page-head">
    <h1>Does our method work?</h1>
    <p class="lede">We hide a fake moving object in real SPHEREx images, run our own detection on it, and count how often it is found.</p>
    <p class="why"><b>Why it matters.</b> A pipeline that finds known objects could just be lucky. Planting thousands of fakes of known brightness and motion measures exactly how faint and how slow a mover can be before we miss it, and how often noise alone fools us.</p>
  </header>
  <div class="inject-grid">
    <aside class="panel">
      <h2>Real data used</h2>
      <div id="iField"></div>
    </aside>
    <div id="iBody" class="inject-body" hidden>
      <section class="panel">
        <h2>Plant one fake object</h2>
        <div class="row split">
          <label class="slider"><span>Brightness <b id="iMagV"></b></span><input id="iMag" type="range" step="0.1"></label>
          <label class="slider"><span>Shift between passes <b id="iShiftV"></b></span><input id="iShift" type="range" min="0" max="40" step="0.5" value="10"></label>
        </div>
        <button type="button" class="go" id="iOne">Plant it at a random empty spot and search</button>
        <div class="stamps">
          <figure><canvas id="iEarly"></canvas><figcaption>Early pass + fake (blue circle)</figcaption></figure>
          <figure><canvas id="iLate"></canvas><figcaption>Late pass + fake (orange circle)</figcaption></figure>
          <figure><canvas id="iDiff"></canvas><figcaption>Late − early: what our search sees</figcaption></figure>
        </div>
        <div id="iSingleOut"></div>
      </section>
      <section class="panel">
        <div class="row split"><h2>Completeness: how faint can we go?</h2>
          <label class="field">Trials per cell <select id="iTrials"><option>10</option><option selected>20</option><option>50</option></select></label></div>
        <button type="button" class="go" id="iRun">Run the completeness test</button>
        <p class="muted small" id="iProgress"></p>
        <div class="d-kpis i-kpis" id="iSummary"></div>
        <canvas id="iHeat" class="i-heat" height="300" aria-label="Completeness heat map: fraction of fakes found by brightness and shift"></canvas>
        <canvas id="iCurve" class="i-curve" height="240" aria-label="Completeness against brightness"></canvas>
        <div class="legend" id="iCurveLegend"></div>
      </section>
      <details class="how">
        <summary>How we calculated this</summary>
        <div class="how-body">
          <h3>1. The real images</h3>
          <p>The first and last survey passes loaded in the Blink viewer, each a 3σ-clipped stack of its exposures, sky removed. Noise, artefacts and crowding are all real.</p>
          <h3>2. The fake object</h3>
          <p class="formula">I(x, y) += F / (2πσ²) · exp(−((x − x₀)² + (y − y₀)²) / 2σ²), &nbsp; σ = FWHM / 2.355</p>
          <p>A Gaussian with the PSF width measured from the second moments of bright unsaturated field stars. Flux F comes from the AB magnitude (F = 3631 Jy · 10<sup>−0.4 m</sup>) and the pixel solid angle. It sits at (x₀, y₀) in the early pass and at a point shifted by the chosen amount, in a random direction, in the late pass. Spots near stars (any pixel above 8σ) and image edges are avoided. Assumption: the fake has a flat spectrum and does not move within one pass.</p>
          <h3>3. The search (same as the site)</h3>
          <p class="formula">D = late − early, &nbsp; F̂ = Σ wD / Σ w², &nbsp; S/N = Σ wD / (σ<sub>D</sub> √Σ w²)</p>
          <p>A PSF-shaped (matched) filter w measures the bright lobe where the object went and the dark lobe where it was, each within ±1.5 grid pixels of the expected spot. σ<sub>D</sub> is the robust noise of the difference image. <b>Found</b> means both lobes reach ${K_SIGMA}σ. A source that moved less than about one PSF width partly cancels itself, which is exactly what the curve shows.</p>
          <h3>4. False alarms</h3>
          <p>The same test on empty spots with nothing planted. Any "found" there is a false alarm.</p>
        </div>
      </details>
    </div>
  </div>`;
  $('iMag').addEventListener('input', syncLabels); $('iShift').addEventListener('input', syncLabels);
  $('iOne').addEventListener('click', runSingle);
  $('iRun').addEventListener('click', runCompleteness);
  window.addEventListener('resize', () => { if (curve) { drawHeat(); drawCurve(); } });
}

let built = false, poll = 0;
export function openInject() {
  if (!built) { built = true; build(); }
  const tryPrep = () => {
    const st = ST();
    const ready = st && !st.busy && st.stacks && st.stacks.length >= 2;
    if (ready && (!F || F.key !== fieldKey(st))) { F = prepareField(); curve = null; renderField(); if (F) runSingle(); }
    else if (!F) { renderField(); const w = $('iWait'); if (w) w.textContent = ($('status') || {}).textContent || ''; }
    if (!F || (st && st.busy)) { clearTimeout(poll); poll = setTimeout(tryPrep, 1000); }
  };
  tryPrep();
}
