// track.js — "Track a solar-system object". Asks NASA/IPAC IRSA's Moving Object Search Tool (MOST)
// which SPHEREx exposures covered a known body (Pluto by default) and where JPL Horizons predicts it
// in each one. Every exposure is then cut out around the predicted position ("follow the object"):
// the body stays in the centre while the stars stream past. Stacking these cut-outs per survey pass
// (median) wipes out the stars and keeps the body: the "shift-and-stack" method that a search for a
// faint Planet X would need, shown on a real object. We also measure how far the body is from the
// prediction in each exposure.
//
// Data: SPHEREx Level-2 images (NASA/JPL-Caltech/IPAC) via IRSA; ephemerides from MOST / JPL Horizons.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

import { searchFrames, loadFrame, nativeCentroid, aperturePhot, robustStats, BANDS, NATIVE_SCALE } from './spherex.js';
import { makeGrid, mjdToDate, sepArcsec, fmtRa, fmtDec } from './wcs.js';
import { pool } from './fits.js';
import { paint } from './render.js';

const $ = id => document.getElementById(id);
const SCALE = NATIVE_SCALE / 2;          // arcsec per grid pixel, as in the Blink viewer
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const fmtDay = mjd => mjdToDate(mjd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const OBJECTS = [
  { label: 'Pluto', naif: 999, note: 'V ≈ 14.5, about 35 AU. The object Clyde Tombaugh found by blinking in 1930.' },
  { label: 'Makemake', naif: 2136472, note: 'Dwarf planet, V ≈ 17, about 53 AU.' },
  { label: 'Haumea', naif: 2136108, note: 'Dwarf planet, V ≈ 17.3, about 50 AU.' },
  { label: 'Eris', naif: 2136199, note: 'Dwarf planet, V ≈ 18.7, about 96 AU: near SPHEREx’s limit.' },
  { label: 'Sedna', naif: 2090377, note: 'V ≈ 21, about 83 AU: too faint for SPHEREx. A good test of an honest non-detection.' },
  { label: 'Vesta', naif: 2000004, note: 'Bright main-belt asteroid, V ≈ 6–8: moves fast and saturates.' },
];

const T = { obj: OBJECTS[0], band: 0, max: 48, rows: [], frames: [], passes: [], idx: 0, mode: 'follow', timer: null, busy: false, n: 0 };

// ------------------------------------------------------------------ MOST
function parseMost(text) {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex(l => l.startsWith('|') && l.includes('ra_obj'));
  if (hi < 0) {
    const msg = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(/Multiple matches/.test(msg) ? 'That name matches several objects. Try its number (e.g. 136199 for Eris).' : msg.slice(0, 300) || 'MOST returned no table.');
  }
  // fixed-width IPAC table: column boundaries are the '|' positions of the header line
  const H = lines[hi], bars = []; for (let i = 0; i < H.length; i++) if (H[i] === '|') bars.push(i);
  const names = bars.slice(0, -1).map((b, k) => H.slice(b + 1, bars[k + 1]).trim());
  const rows = [];
  for (const l of lines.slice(hi + 1)) {
    if (!l.trim() || l.startsWith('|') || l.startsWith('\\')) continue;
    const o = {}; names.forEach((nm, k) => { o[nm] = l.slice(bars[k], bars[k + 1] + 1).trim(); });
    const det = Number((o.uri.match(/_\d+D(\d)_spx/) || [])[1]) || Number(String(o.productid).replace(/\D/g, ''));
    rows.push({ raObj: +o.ra_obj, decObj: +o.dec_obj, rSun: +o.sun_dist, rGeo: +o.geo_dist, obsId: o.observationid, det,
      mjd: (+o.mjd_start + +o.mjd_end) / 2, exptime: +o.exposure_time, uri: o.uri,
      corners: [[+o.ra1, +o.dec1], [+o.ra2, +o.dec2], [+o.ra3, +o.dec3], [+o.ra4, +o.dec4]] });
  }
  return rows.filter(r => Number.isFinite(r.raObj) && Number.isFinite(r.mjd)).sort((a, b) => a.mjd - b.mjd);
}

function groupPasses(rows) {
  const passes = []; let cur = null;
  for (const r of rows) { if (!cur || r.mjd - cur.rows[cur.rows.length - 1].mjd > 20) { cur = { rows: [] }; passes.push(cur); } cur.rows.push(r); }
  passes.forEach((p, k) => { p.k = k; p.rows.forEach(r => { r.pass = k; }); p.a = p.rows[0].mjd; p.b = p.rows[p.rows.length - 1].mjd; });
  return passes;
}

/** Spread the chosen number of exposures over passes and wavelengths. */
function choose(rows) {
  let list = T.band ? rows.filter(r => r.det === T.band) : rows;
  if (!T.max || list.length <= T.max) return list;
  const byPass = groupPasses(list), per = Math.max(2, Math.floor(T.max / byPass.length)), out = [];
  for (const p of byPass) { const step = p.rows.length / per; for (let i = 0; i < Math.min(per, p.rows.length); i++) out.push(p.rows[Math.floor(i * step)]); }
  return out.sort((a, b) => a.mjd - b.mjd);
}

/** Current file URLs come from our normal IRSA search; MOST can list an older processing version. */
async function attachFiles(rows) {
  const passes = groupPasses(rows.slice());
  for (const p of passes) {
    const ra = p.rows.reduce((s, r) => s + r.raObj, 0) / p.rows.length, dec = p.rows.reduce((s, r) => s + r.decObj, 0) / p.rows.length;
    const rad = Math.min(0.5, Math.max(...p.rows.map(r => sepArcsec(ra, dec, r.raObj, r.decObj) / 3600)) + 0.02);
    let frames = [];
    try { frames = await searchFrames(ra, dec, { radius: rad }); } catch { /* fall back to MOST paths */ }
    const byId = new Map(frames.map(f => [f.id, f]));
    for (const r of p.rows) {
      const f = byId.get(`${r.obsId}D${r.det}`);
      r.frame = f ? { ...f } : { id: `${r.obsId}D${r.det}`, obsId: r.obsId, det: r.det, collection: 'most', mjd: r.mjd, exptime: r.exptime, corners: r.corners,
        ibeUrl: `https://irsa.ipac.caltech.edu/${r.uri}`, url: `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/${r.uri.replace(/^ibe\/data\/spherex\//, '')}` };
    }
  }
}

// ------------------------------------------------------------------ run
async function run() {
  if (T.busy) return;
  T.busy = true; stop(); $('tGo').disabled = true;
  T.rows = []; T.frames = []; T.passes = []; T.idx = 0;
  $('tView').hidden = true;
  status(`Asking IRSA's Moving Object Search Tool where ${T.obj.label} was during SPHEREx's survey… (this can take up to a minute)`);
  try {
    const qs = T.obj.naif ? `naif=${T.obj.naif}` : `name=${encodeURIComponent(T.obj.label)}`;
    const r = await fetch(`/api/most?${qs}&begin=2025-05-01&end=${new Date().toISOString().slice(0, 10)}`);
    const text = await r.text();
    T.rows = parseMost(text);
    if (!T.rows.length) throw new Error(`SPHEREx has no public exposures of ${T.obj.label} yet.`);
    T.passes = groupPasses(T.rows);
    const sel = choose(T.rows);
    status(`${T.rows.length} SPHEREx exposures covered ${T.obj.label} in ${T.passes.length} survey passes. Reading ${sel.length} of them…`);
    $('tEmpty').hidden = true; drawTrack();
    await attachFiles(sel);
    T.n = Math.round(Number($('tFov').value) * 60 / SCALE) | 1;
    let done = 0;
    const loaded = [];
    await pool(sel, 6, async row => {
      const f = row.frame;
      const grid = makeGrid(row.raObj, row.decObj, T.n, SCALE);
      await loadFrame(f, grid);
      f.row = row; f.grid = grid;
      const s = robustStats(f.img); f.bgv = s.median; f.sig = s.sigma;
      // where is it really? centroid near the prediction, in native pixels
      const c = nativeCentroid(f, row.raObj, row.decObj, 2);
      if (c && !c.saturated) {
        f.offset = sepArcsec(row.raObj, row.decObj, c.ra, c.dec);
        const [x, y] = grid.fromSky(c.ra, c.dec);
        const ph = aperturePhot(f.img, T.n, SCALE, x, y, 3.2, 7, 12);
        f.snr = ph && ph.err > 0 ? ph.flux / ph.err : NaN;
        f.detected = f.offset < 1.5 * NATIVE_SCALE && f.snr >= 5;
      } else { f.offset = NaN; f.snr = NaN; f.detected = false; f.saturated = !!(c && c.saturated); }
      loaded.push(f);
      done++; progress(done / sel.length);
    }, () => { done++; progress(done / sel.length); });
    T.frames = loaded.filter(f => f.img).sort((a, b) => a.mjd - b.mjd);
    if (!T.frames.length) throw new Error('None of the exposures could be read.');
    buildStacks();
    progress(null);
    const det = T.frames.filter(f => f.detected);
    status(`${T.obj.label} found in ${det.length} of ${T.frames.length} exposures, on average ${fmt(median(det.map(f => f.offset)))}″ from where JPL Horizons predicts it.`);
    $('tView').hidden = false; $('tEmpty').hidden = true;
    renderResults(); drawTrack(); show(); play();
  } catch (e) {
    console.error(e); progress(null);
    status(String(e.message || e), true);
  }
  T.busy = false; $('tGo').disabled = false;
}
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };

function buildStacks() {
  // median of the follow-the-object cut-outs in each pass: stars move through and vanish, the body stays
  const n = T.n, byPass = new Map();
  for (const f of T.frames) { if (!byPass.has(f.row.pass)) byPass.set(f.row.pass, []); byPass.get(f.row.pass).push(f); }
  T.stacks = [...byPass.entries()].sort((a, b) => a[0] - b[0]).map(([pass, fr]) => {
    const img = new Float32Array(n * n), vals = new Float64Array(fr.length);
    for (let p = 0; p < n * n; p++) {
      let m = 0; for (const f of fr) { const v = f.img[p]; if (Number.isFinite(v)) vals[m++] = v - f.bgv; }
      if (!m) { img[p] = NaN; continue; }
      const s = Array.from(vals.subarray(0, m)).sort((a, b) => a - b); img[p] = m % 2 ? s[m >> 1] : (s[m / 2 - 1] + s[m / 2]) / 2;
    }
    const st = robustStats(img), c = (n - 1) / 2;
    const ph = aperturePhot(img, n, SCALE, c, c, 3.2, 7, 12);
    return { pass, frames: fr, img, sig: st.sigma, snr: ph && ph.err > 0 ? ph.flux / ph.err : NaN, a: fr[0].mjd, b: fr[fr.length - 1].mjd };
  });
}

// ------------------------------------------------------------------ display
function items() { return T.mode === 'stack' ? T.stacks : T.frames; }
function show() {
  const list = items(); if (!list.length) return;
  T.idx = Math.min(T.idx, list.length - 1);
  const it = list[T.idx], n = T.n, cv = $('tSky');
  if (cv.width !== n) { cv.width = cv.height = n; }
  const img = T.mode === 'stack' ? it.img : it.img.map(v => v - it.bgv);
  const sig = T.mode === 'stack' ? it.sig : it.sig;
  paint(cv.getContext('2d'), img, n, { vmax: 25 * sig, soft: 2 * sig, cmap: 'heat' });
  // overlay: predicted position (centre) and, in exposures, the measured one
  const ov = $('tOver'), S = ov.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1);
  ov.width = ov.height = S * dpr; const g = ov.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, S, S);
  const k = S / n, c = (n / 2) * k;
  g.strokeStyle = 'rgba(111,211,255,0.9)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(c, c, 2.2 * NATIVE_SCALE / SCALE * k, 0, Math.PI * 2); g.stroke();
  g.font = '600 12px "Golos Text", system-ui, sans-serif'; g.fillStyle = 'rgba(111,211,255,0.95)';
  g.fillText('JPL prediction', c + 2.4 * NATIVE_SCALE / SCALE * k + 4, c - 4);
  const cap = $('tCap');
  if (T.mode === 'stack') {
    cap.innerHTML = `<b>Pass ${it.pass + 1}: ${fmtDay(it.a)} – ${fmtDay(it.b)}</b><span>Median of ${it.frames.length} cut-outs that follow ${T.obj.label}. Stars moved through and were removed; ${T.obj.label} stayed in the centre (S/N ${fmt(it.snr, 0)}).</span>`;
  } else {
    const b = BANDS[it.det - 1];
    cap.innerHTML = `<b>${fmtDay(it.mjd)} · ${mjdToDate(it.mjd).toISOString().slice(11, 16)} UTC</b><span>D${it.det} · ${fmt(it.lambda, 2)} µm · ${fmt(it.row.rGeo, 2)} AU from Earth · ${it.detected ? `found ${fmt(it.offset)}″ from the prediction (S/N ${fmt(it.snr, 0)})` : it.saturated ? 'saturated core' : 'not detected in this exposure'}</span>`;
    void b;
  }
  $('tCount').textContent = `${T.idx + 1} / ${list.length}`;
  $('tScrub').max = String(list.length - 1); $('tScrub').value = String(T.idx);
  drawTrack();
}
function play() { stop(); T.timer = setInterval(() => { T.idx = (T.idx + 1) % items().length; show(); }, T.mode === 'stack' ? 1200 : 450); $('tPlay').textContent = 'Pause'; }
function stop() { clearInterval(T.timer); T.timer = null; const b = $('tPlay'); if (b) b.textContent = 'Play'; }

function drawTrack() {
  const cv = $('tTrack'); if (!cv || !T.rows.length) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, Hh = 260;
  cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hh);
  const ra0 = T.rows[0].raObj, dec0 = T.rows[0].decObj, cosd = Math.cos(dec0 * Math.PI / 180);
  const P = T.rows.map(r => [(((r.raObj - ra0 + 540) % 360) - 180) * cosd, r.decObj - dec0]);
  let xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.05) * 1.15;
  const mx = (Math.max(...xs) + Math.min(...xs)) / 2, my = (Math.max(...ys) + Math.min(...ys)) / 2;
  const pad = 34, sc = Math.min(W - 2 * pad, Hh - 2 * pad) / span;
  const X = x => W / 2 - (x - mx) * sc, Y = y => Hh / 2 - (y - my) * sc;     // east to the left, as on the sky
  const cols = ['#5aa9e6', '#ff8a4c', '#9b76dc', '#58c98b', '#f2c14e'];
  g.strokeStyle = 'rgba(149,162,191,0.35)'; g.lineWidth = 1; g.beginPath();
  P.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); g.stroke();
  T.rows.forEach((r, i) => { g.fillStyle = cols[r.pass % cols.length]; g.beginPath(); g.arc(X(P[i][0]), Y(P[i][1]), 2.5, 0, Math.PI * 2); g.fill(); });
  const cur = items()[T.idx];
  if (cur && T.mode === 'follow') { const r = cur.row, i = T.rows.indexOf(r); if (i >= 0) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(X(P[i][0]), Y(P[i][1]), 7, 0, Math.PI * 2); g.stroke(); } }
  g.fillStyle = '#95a2bf'; g.font = '11px "Golos Text", system-ui, sans-serif'; g.textAlign = 'left';
  g.fillText(`${T.obj.label}'s path on the sky, ${fmtDay(T.rows[0].mjd)} – ${fmtDay(T.rows[T.rows.length - 1].mjd)}  (north up, east left; the loops are Earth's own yearly motion, parallax)`, 8, Hh - 8);
  const bar = Math.pow(10, Math.floor(Math.log10(span / 3)));
  g.strokeStyle = '#e8ecf4'; g.beginPath(); g.moveTo(W - 20 - bar * sc, 16); g.lineTo(W - 20, 16); g.stroke(); g.textAlign = 'right'; g.fillStyle = '#e8ecf4';
  g.fillText(bar >= 1 ? `${bar}°` : `${(bar * 60).toFixed(0)}′`, W - 20, 30);
  $('tTrackLegend').innerHTML = T.passes.map(p => `<span><i style="border-top:0;width:8px;height:8px;border-radius:50%;background:${cols[p.k % cols.length]}"></i>Pass ${p.k + 1}: ${fmtDay(p.a)} – ${fmtDay(p.b)} (${p.rows.length} exp.)</span>`).join('');
}

function renderResults() {
  const box = $('tResults');
  const det = T.frames.filter(f => f.detected);
  box.innerHTML = `
    <div class="d-kpis i-kpis">
      <div><b>${T.rows.length}</b><span>SPHEREx exposures covered it (MOST)</span></div>
      <div><b>${det.length} / ${T.frames.length}</b><span>found in the exposures we read (≥5σ, within 1.5 px)</span></div>
      <div><b>${fmt(median(det.map(f => f.offset)))}″</b><span>median distance from the JPL prediction</span></div>
      <div><b>${fmt(median(T.rows.map(r => r.rGeo)), 1)} AU</b><span>distance from Earth</span></div>
    </div>
    <table class="ftable"><thead><tr><th>Pass</th><th>Dates</th><th>Exposures read</th><th>Found</th><th>Stacked S/N</th></tr></thead><tbody>
    ${T.stacks.map(s => `<tr><td>${s.pass + 1}</td><td>${fmtDay(s.a)} – ${fmtDay(s.b)}</td><td>${s.frames.length}</td><td>${s.frames.filter(f => f.detected).length}</td><td>${fmt(s.snr, 0)}</td></tr>`).join('')}
    </tbody></table>`;
}

function status(text, warn) { const el = $('tStatus'); el.textContent = text; el.className = `sky-status ${warn ? 'warn' : 'busy'}`; }
function progress(f) { const el = $('tProgress'); if (f == null) { el.hidden = true; return; } el.hidden = false; el.firstElementChild.style.width = `${Math.round(f * 100)}%`; }

function build() {
  $('trackView').innerHTML = `
  <header class="page-head">
    <h1>Track a solar-system object</h1>
    <p class="lede">Pick a known body. NASA's archive tells us which SPHEREx exposures caught it and where it should be in each. We cut every exposure out around that spot, so the body stands still while the stars stream past.</p>
    <p class="why"><b>Why it matters.</b> Planet X would be too faint for one exposure, but adding many exposures <i>along its orbit</i> could reveal it. Here that "shift-and-stack" method runs on Pluto, the planet found by blinking in 1930, and we check that SPHEREx sees it where JPL predicts.</p>
  </header>
  <div class="detect-grid">
    <aside class="panel">
      <h2>Object</h2>
      <div class="chips presets" id="tObjs">${OBJECTS.map((o, i) => `<button type="button" class="chip" data-i="${i}" aria-pressed="${i === 0}">${o.label}</button>`).join('')}</div>
      <p class="muted small" id="tNote"></p>
      <form id="tForm" class="search" autocomplete="off">
        <label for="tName">or any asteroid / comet (name or number)</label>
        <input id="tName" type="text" placeholder="Ceres, 433, 2P …" spellcheck="false">
      </form>
      <label class="field">Detector band <select id="tBand"><option value="0">all</option>${BANDS.map(b => `<option value="${b.det}">D${b.det} · ${b.lo}–${b.hi} µm</option>`).join('')}</select></label>
      <label class="field">Exposures to read <select id="tMax"><option>24</option><option selected>48</option><option>96</option></select></label>
      <label class="field">Cut-out size <select id="tFov"><option value="4">4′</option><option value="6" selected>6′</option><option value="9">9′</option></select></label>
      <button type="button" class="go" id="tGo">Find it in SPHEREx</button>
      <p class="sky-status" id="tStatus"></p>
      <div class="progress" id="tProgress" hidden><i></i></div>
    </aside>
    <section class="panel d-main">
      <p class="muted" id="tEmpty">Pick an object and press <b>Find it in SPHEREx</b>. Pluto takes about a minute: the archive search, then reading the pixels.</p>
      <div id="tView" hidden>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" data-m="follow" aria-selected="true">Follow the object (every exposure)</button>
          <button type="button" role="tab" data-m="stack" aria-selected="false">Stacked along the orbit (each pass)</button>
        </div>
        <div class="t-plate"><canvas id="tSky"></canvas><canvas id="tOver"></canvas></div>
        <div class="t-cap" id="tCap"></div>
        <div class="transport"><button type="button" class="ghost small" id="tPlay">Play</button><input type="range" id="tScrub" min="0" max="0" value="0"><span id="tCount" class="muted small"></span></div>
        <div id="tResults"></div>
      </div>
      <canvas id="tTrack" class="t-track" height="260" aria-label="The object's path on the sky during the SPHEREx survey"></canvas>
      <div class="legend" id="tTrackLegend"></div>
      <details class="how"><summary>How we calculated this</summary><div class="how-body">
        <h3>1. Where was it?</h3>
        <p>IRSA's Moving Object Search Tool (MOST) takes the body's orbit from JPL Horizons, steps along it through the SPHEREx survey and lists every exposure whose footprint contained it, with the predicted RA and Dec at that exposure's time (ra_obj, dec_obj), its distance from the Sun and from Earth.</p>
        <h3>2. Following it</h3>
        <p>For each chosen exposure we read only the pixels around the predicted position (HTTP range requests on NASA's public cloud copy) and re-project them onto a north-up grid centred on that position, 3.075″ per grid pixel. The body therefore sits in the centre of every cut-out, and background stars move.</p>
        <h3>3. Did SPHEREx see it there?</h3>
        <p class="formula">offset = angle between the predicted position and the light centroid; &nbsp; found if offset &lt; 1.5 px (9.2″) and S/N ≥ 5</p>
        <p>The centroid is measured on the original detector pixels within 2 pixels of the prediction; S/N comes from aperture photometry with a local sky ring.</p>
        <h3>4. Shift-and-stack</h3>
        <p>In each survey pass the follow-the-object cut-outs are combined with a per-pixel median. A star sits on a given pixel in only a few cut-outs, so the median removes it; the body sits on the centre pixel in all of them, so it survives, and the noise drops roughly as 1/√N. A search for an unseen Planet X would have to try many possible orbits this way.</p>
        <p>Sources: <a href="https://irsa.ipac.caltech.edu/applications/MOST/" target="_blank" rel="noopener">IRSA MOST</a>, <a href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noopener">JPL Horizons</a>.</p>
      </div></details>
    </section>
  </div>`;
  const setObj = i => { T.obj = OBJECTS[i]; $('tNote').textContent = T.obj.note; for (const b of $('tObjs').querySelectorAll('[data-i]')) b.setAttribute('aria-pressed', String(Number(b.dataset.i) === i)); };
  for (const b of $('tObjs').querySelectorAll('[data-i]')) b.addEventListener('click', () => { setObj(Number(b.dataset.i)); $('tName').value = ''; });
  setObj(0);
  $('tForm').addEventListener('submit', e => { e.preventDefault(); const v = $('tName').value.trim(); if (!v) return; T.obj = { label: v, note: '' }; for (const b of $('tObjs').querySelectorAll('[data-i]')) b.setAttribute('aria-pressed', 'false'); run(); });
  $('tBand').addEventListener('change', e => { T.band = Number(e.target.value); });
  $('tMax').addEventListener('change', e => { T.max = Number(e.target.value); });
  $('tGo').addEventListener('click', () => { const v = $('tName').value.trim(); if (v) T.obj = { label: v, note: '' }; run(); });
  for (const b of document.querySelectorAll('#trackView [data-m]')) b.addEventListener('click', () => {
    T.mode = b.dataset.m; T.idx = 0;
    for (const c of document.querySelectorAll('#trackView [data-m]')) c.setAttribute('aria-selected', String(c === b));
    show(); play();
  });
  $('tPlay').addEventListener('click', () => (T.timer ? stop() : play()));
  $('tScrub').addEventListener('input', e => { stop(); T.idx = Number(e.target.value); show(); });
  window.addEventListener('resize', () => { drawTrack(); if (T.frames.length) show(); });
}

let built = false;
export function openTrack() { if (!built) { built = true; build(); } }
