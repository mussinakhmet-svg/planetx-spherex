// fingerprint.js — "Spectral fingerprint". Builds the 0.75–5 µm spectrum (SED) of the selected
// source from every loaded SPHEREx exposure, binned into SPHEREx-like channels, and compares it with
// simple physical templates: Sun-like star, red dwarf, cold methane brown dwarf, galaxy, asteroid,
// cold methane planet. A chi-square fit (free brightness scale) ranks them.
//
// Photometry is forced PSF fitting: the target and every Gaia DR3 neighbour within 40″ are fitted
// together with a Gaussian PSF whose width is measured in each exposure, plus a flat sky. SPHEREx pixels
// are 6.15″ wide, so without this a neighbour star a few arcseconds away would masquerade as the target.
//
// Templates are schematic physical shapes (blackbodies with absorption bands at their laboratory
// wavelengths), not observed spectra; see "How we calculated this" on the page.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

import { propagate } from './wcs.js';
import { TARGETS } from './targets.js';
import { tx } from './i18n-ui.js';

const $ = id => document.getElementById(id);
const ST = () => window.__st;
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const H = 6.62607015e-34, C = 2.99792458e8, KB = 1.380649e-23;
const bnu = (T, lam) => { const nu = C / (lam * 1e-6), x = H * nu / (KB * T); return x > 700 ? 0 : nu ** 3 / Math.expm1(x); };
const g = (lam, c, w) => Math.exp(-0.5 * ((lam - c) / w) ** 2);
const absorb = (lam, bands) => bands.reduce((f, [c, w, d]) => f * (1 - d * g(lam, c, w)), 1);
const interp = (pts, lam) => { for (let i = 1; i < pts.length; i++) if (lam <= pts[i][0]) { const [a, fa] = pts[i - 1], [b, fb] = pts[i]; return fa + (fb - fa) * (lam - a) / (b - a); } return pts[pts.length - 1][1]; };
const CH4_ALBEDO = [[0.75, 0.9], [0.86, 0.55], [0.89, 0.25], [0.95, 0.6], [1.0, 0.45], [1.08, 0.55], [1.15, 0.08], [1.28, 0.35], [1.38, 0.03], [1.58, 0.15], [1.7, 0.02], [2.08, 0.06], [2.3, 0.01], [3.0, 0.02], [3.3, 0.003], [3.6, 0.02], [4.0, 0.03], [5.0, 0.03]];

/** Template spectra, F_nu in arbitrary units. [centre µm, width µm, depth] for absorption bands. */
export const TEMPLATES = [
  { id: 'gstar', cls: 'Sun-like star (G type)', color: '#f2c14e', note: '5800 K blackbody.',
    f: l => bnu(5800, l) },
  { id: 'mdwarf', cls: 'Red dwarf (M type)', color: '#ff8a4c', note: '3100 K blackbody with water bands at 1.4, 1.9, 2.7 µm and CO at 2.3 and 4.6 µm.',
    f: l => bnu(3100, l) * absorb(l, [[1.4, 0.08, 0.25], [1.9, 0.1, 0.3], [2.7, 0.18, 0.35], [2.3, 0.05, 0.1], [4.6, 0.15, 0.08]]) },
  { id: 'bdwarf', cls: 'Brown dwarf (cold, methane)', color: '#6fd3ff', note: '450 K blackbody with deep CH₄ bands at 1.15, 1.4, 1.7, 2.2, 3.3 µm and water at 1.4, 1.9, 2.7 µm: the light escapes mainly at 4–5 µm.',
    f: l => bnu(450, l) * absorb(l, [[1.15, 0.05, 0.8], [1.4, 0.09, 0.9], [1.7, 0.08, 0.85], [2.2, 0.12, 0.85], [2.7, 0.2, 0.7], [3.3, 0.18, 0.95], [1.9, 0.1, 0.6]]) },
  { id: 'galaxy', cls: 'Galaxy (old stars)', color: '#9b76dc', note: 'Mix of 4500 K and 3500 K stars with the 1.6 µm "H-bump" and weak 3.3 µm dust (PAH) emission; no redshift.',
    f: l => (0.7 * bnu(4500, l) / bnu(4500, 1.6) + 0.3 * bnu(3500, l) / bnu(3500, 1.6)) * (1 + 0.15 * g(l, 1.6, 0.25)) + 0.04 * g(l, 3.3, 0.04) },
  { id: 'asteroid', cls: 'Asteroid (sunlight + warm surface)', color: '#a6d75b', note: 'Sunlight (5772 K) reflected by a slightly red surface, plus 220 K thermal glow that overtakes it beyond ~4 µm (main-belt distance).',
    f: l => bnu(5772, l) * (1 + 0.15 * (l - 1)) / bnu(5772, 1) + 3 * bnu(220, l) / bnu(220, 4.5) * bnu(5772, 4.5) / bnu(5772, 1) },
  { id: 'planet', cls: 'Cold planet (methane, reflected light)', color: '#e2536f', note: 'Sunlight reflected by a Neptune-like methane atmosphere: bright only between the CH₄ bands.',
    f: l => bnu(5772, l) * interp(CH4_ALBEDO, l) },
];

// ------------------------------------------------------------------ channels
const EDGES = (() => { const e = [0.75]; while (e[e.length - 1] < 5.0) { const l = e[e.length - 1]; e.push(l * (1 + 1 / (l < 3.82 ? 41 : 120))); } return e; })();

// ------------------------------------------------------------------ forced PSF photometry
function psfSigma(img, mask, n) {
  // second moments of bright, unsaturated, isolated peaks in this exposure
  let s = []; for (let p = 0; p < img.length; p += 7) if (Number.isFinite(img[p])) s.push(img[p]);
  s.sort((a, b) => a - b); const med = s[s.length >> 1], mad = 1.4826 * s.map(v => Math.abs(v - med)).sort((a, b) => a - b)[s.length >> 1];
  const out = [];
  for (let j = 5; j < n - 5; j++) for (let i = 5; i < n - 5; i++) {
    const v = img[j * n + i] - med;
    if (!(v > 30 * mad) || mask[j * n + i]) continue;
    let isMax = true;
    for (let dj = -2; dj <= 2 && isMax; dj++) for (let di = -2; di <= 2; di++) if ((di || dj) && !(img[(j + dj) * n + i + di] < img[j * n + i])) { isMax = false; break; }
    if (!isMax) continue;
    let s0 = 0, s2 = 0, bad = false;
    for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
      if (di * di + dj * dj > 16) continue;
      const q = (j + dj) * n + i + di, w = img[q] - med;
      if (!Number.isFinite(w) || mask[q]) { bad = true; break; }
      if (w > 0) { s0 += w; s2 += w * (di * di + dj * dj); }
    }
    if (!bad && s0 > 0) { const sg = Math.sqrt(s2 / (2 * s0)); if (sg > 0.7 && sg < 3.5) out.push(sg); }
    if (out.length > 25) break;
  }
  if (out.length < 3) return null;
  out.sort((a, b) => a - b); return out[out.length >> 1];
}

function solve(A, b) {               // small dense Gauss–Jordan; returns { x, inv } or null
  const m = A.length, M = A.map((r, i) => [...r, b[i], ...A.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < m; c++) {
    let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-30) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; for (let k = 0; k < M[c].length; k++) M[c][k] /= d;
    for (let r = 0; r < m; r++) if (r !== c) { const f = M[r][c]; if (f) for (let k = 0; k < M[r].length; k++) M[r][k] -= f * M[c][k]; }
  }
  return { x: M.map(r => r[m]), inv: M.map(r => r.slice(m + 1)) };
}

function forcedPhot(f, n, k, srcXY, nbXY, sigFallback) {
  const sig = (f._psfSig ||= psfSigma(f.img, f.mask, n)) || sigFallback;
  const R = Math.ceil(3.5 * sig) + 2, [tx, ty] = srcXY;
  const comps = [[tx, ty], ...nbXY.filter(([x, y]) => Math.hypot(x - tx, y - ty) < R + 3 * sig)];
  const norm = 1 / (2 * Math.PI * sig * sig), cols = comps.length + 1;
  const AtA = Array.from({ length: cols }, () => new Float64Array(cols)), Atb = new Float64Array(cols);
  const rows = [];
  let satHit = false;
  for (let j = Math.floor(ty - R); j <= Math.ceil(ty + R); j++) for (let i = Math.floor(tx - R); i <= Math.ceil(tx + R); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n || Math.hypot(i - tx, j - ty) > R) continue;
    const q = j * n + i, v = f.img[q];
    if (f.mask[q]) { if (Math.hypot(i - tx, j - ty) < 1.5 * sig) satHit = true; continue; }
    if (!Number.isFinite(v)) continue;
    const a = comps.map(([x, y]) => norm * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sig * sig)));
    a.push(1);
    for (let r = 0; r < cols; r++) { Atb[r] += a[r] * v; for (let c = 0; c < cols; c++) AtA[r][c] += a[r] * a[c]; }
    rows.push([a, v]);
  }
  if (satHit || rows.length < cols + 6) return null;
  const sol = solve(AtA.map(r => Array.from(r)), Array.from(Atb));
  if (!sol) return null;
  let rss = 0; for (const [a, v] of rows) { let m = 0; for (let c = 0; c < cols; c++) m += a[c] * sol.x[c]; rss += (v - m) ** 2; }
  const s2 = rss / Math.max(1, rows.length - cols);
  return { flux: sol.x[0] * k, err: Math.sqrt(Math.max(0, sol.inv[0][0] * s2)) * k, sig };
}


// Halo ("wing") photometry for saturated cores: the mean surface brightness in a ring 2.5–4.5 native
// pixels from the centre is a fixed fraction of a star's total light in a given exposure. We measure
// that fraction on bright unsaturated field stars in the same exposure and divide.
const RING = [5, 9], SKY = [12, 16], CORE = 6;          // grid pixels (2 per native pixel)
function ringStats(f, n, x, y) {
  const ring = [], sky = [];
  for (let j = Math.floor(y - SKY[1]); j <= Math.ceil(y + SKY[1]); j++) for (let i = Math.floor(x - SKY[1]); i <= Math.ceil(x + SKY[1]); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const q = j * n + i, v = f.img[q], d = Math.hypot(i - x, j - y);
    if (!Number.isFinite(v)) continue;
    if (d >= RING[0] && d <= RING[1] && !f.mask[q]) ring.push(v); else if (d >= SKY[0] && d <= SKY[1]) sky.push(v);
  }
  if (ring.length < 20 || sky.length < 20) return null;
  const sk = median(sky);
  return { ring: median(ring) - sk, sky: sk, skySig: 1.4826 * median(sky.map(v => Math.abs(v - sk))), nRing: ring.length };
}
function haloRatio(f, n) {
  if (f._halo !== undefined) return f._halo;
  const vals = [];
  const s = []; for (let p = 0; p < f.img.length; p += 5) if (Number.isFinite(f.img[p])) s.push(f.img[p]);
  const med = median(s), mad = 1.4826 * median(s.map(v => Math.abs(v - med)));
  for (let j = SKY[1] + 1; j < n - SKY[1] - 1 && vals.length < 30; j++) for (let i = SKY[1] + 1; i < n - SKY[1] - 1; i++) {
    const v = f.img[j * n + i];
    if (!(v - med > 150 * mad)) continue;
    let isMax = true, sat = false;
    for (let dj = -3; dj <= 3 && isMax; dj++) for (let di = -3; di <= 3; di++) { const q = (j + dj) * n + i + di; if (f.mask[q]) sat = true; if ((di || dj) && !(f.img[q] < v)) { isMax = false; break; } }
    if (!isMax || sat) continue;
    const rs = ringStats(f, n, i, j); if (!rs || rs.ring <= 0) continue;
    let tot = 0; for (let dj = -CORE; dj <= CORE; dj++) for (let di = -CORE; di <= CORE; di++) if (di * di + dj * dj <= CORE * CORE) { const w = f.img[(j + dj) * n + i + di]; if (Number.isFinite(w)) tot += w - rs.sky; }
    if (tot > 0) vals.push(rs.ring / tot);
  }
  f._halo = vals.length >= 3 ? { r: median(vals), rel: 1.4826 * median(vals.map(v => Math.abs(v - median(vals)))) / median(vals) / Math.sqrt(vals.length), n: vals.length } : null;
  return f._halo;
}
function haloPhot(f, n, k, [x, y]) {
  const cal = haloRatio(f, n); if (!cal) return null;
  const rs = ringStats(f, n, x, y); if (!rs || rs.ring <= 0) return null;
  const flux = rs.ring / cal.r * k;
  const relRing = rs.skySig / Math.sqrt(rs.nRing) / rs.ring;
  return { flux, err: flux * Math.hypot(cal.rel, relRing, 0.05), halo: true };
}

/** Plain aperture sum, for comparison (what a naive tool would report). */
function aperture(f, n, k, [x, y], r) {
  let s = 0, c = 0; const sky = [];
  for (let j = Math.floor(y - 3 * r); j <= Math.ceil(y + 3 * r); j++) for (let i = Math.floor(x - 3 * r); i <= Math.ceil(x + 3 * r); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const v = f.img[j * n + i]; if (!Number.isFinite(v)) continue;
    const d = Math.hypot(i - x, j - y); if (d <= r) { s += v; c++; } else if (d >= 2 * r) sky.push(v);
  }
  if (!c || sky.length < 8) return null;
  sky.sort((a, b) => a - b); return (s - c * sky[sky.length >> 1]) * k;
}

// ------------------------------------------------------------------ SED, fit, classification
export async function measure() {
  const st = ST();
  const src = st.pick && Number.isFinite(st.pick.ra) ? { ra: st.pick.ra, dec: st.pick.dec, pm: null, name: st.pick.name || 'Selected source' }
    : st.target ? { ra: st.target.ra, dec: st.target.dec, pm: st.target, name: st.target.name } : { ra: st.ra, dec: st.dec, pm: null, name: 'Field centre' };
  const posAt = year => (src.pm ? propagate(src.pm.ra, src.pm.dec, src.pm.pmra, src.pm.pmdec, src.pm.epoch, year, src.pm.plx || 0) : [src.ra, src.dec]);
  const [ra0, dec0] = posAt(2016.0);
  // Gaia DR3 neighbours (not the target itself)
  let nb = [];
  try {
    const txt = await (await fetch(`/api/gaia?ra=${ra0.toFixed(6)}&dec=${dec0.toFixed(6)}&radius=${(40 / 3600).toFixed(5)}`)).text();
    const L = txt.trim().split('\n'), H0 = L[0].split(',');
    const ix = c => H0.indexOf(c);
    nb = L.slice(1).map(l => l.split(',')).map(c => ({ ra: +c[ix('ra')], dec: +c[ix('dec')], pmra: +c[ix('pmra')] || 0, pmdec: +c[ix('pmdec')] || 0, plx: +c[ix('parallax')] || 0, g: +c[ix('phot_g_mean_mag')] }))
      .filter(o => Number.isFinite(o.ra) && Math.hypot((o.ra - ra0) * Math.cos(dec0 * Math.PI / 180), o.dec - dec0) * 3600 > 2.5 && o.g < 20.5);
  } catch (e) { console.warn('Gaia neighbours unavailable', e); }
  const n = st.n, k = (st.grid.scale / 206264.806) ** 2 * 1e9;
  const raw = [];
  for (const f of st.loaded) {
    if (!f.img || !Number.isFinite(f.lambda)) continue;
    const xy = st.grid.fromSky(...posAt(f.year));
    const nbXY = nb.map(o => st.grid.fromSky(...propagate(o.ra, o.dec, o.pmra, o.pmdec, 2016.0, f.year, o.plx)));
    const ph = forcedPhot(f, n, k, xy, nbXY, 1.0 * 2) || haloPhot(f, n, k, xy);
    const ap = aperture(f, n, k, xy, 3.2);
    raw.push({ lam: f.lambda, flux: ph ? ph.flux : NaN, err: ph ? ph.err : NaN, ap, sat: !ph, halo: !!(ph && ph.halo) });
  }
  // bin into channels: inverse-variance mean after rejecting points > 5 MAD from the channel median
  const ch = [];
  for (let c = 0; c < EDGES.length - 1; c++) {
    const pts = raw.filter(p => p.lam >= EDGES[c] && p.lam < EDGES[c + 1] && Number.isFinite(p.flux) && p.err > 0);
    const aps = raw.filter(p => p.lam >= EDGES[c] && p.lam < EDGES[c + 1] && Number.isFinite(p.ap)).map(p => p.ap);
    const mid = Math.sqrt(EDGES[c] * EDGES[c + 1]);
    if (!pts.length) { if (aps.length) ch.push({ lam: mid, ap: median(aps) }); continue; }
    const md = median(pts.map(p => p.flux)), mad = 1.4826 * median(pts.map(p => Math.abs(p.flux - md))) || Infinity;
    const keep = pts.length >= 3 ? pts.filter(p => Math.abs(p.flux - md) <= Math.max(5 * mad, 3 * p.err)) : pts;
    let sw = 0, sf = 0; for (const p of keep) { const w = 1 / p.err ** 2; sw += w; sf += w * p.flux; }
    ch.push({ lam: mid, flux: sf / sw, err: 1 / Math.sqrt(sw), n: keep.length, halo: keep.some(p => p.halo), ap: aps.length ? median(aps) : NaN });
  }
  return { src, nb, raw, ch, nSat: raw.filter(p => p.sat).length, nHalo: raw.filter(p => p.halo).length };
}
const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };

const SYS = 0.05;    // 5% calibration floor added in quadrature
export function classify(ch) {
  const pts = ch.filter(c => Number.isFinite(c.flux));
  const fits = TEMPLATES.map(T => {
    const t = pts.map(p => T.f(p.lam));
    const s2 = pts.map(p => p.err ** 2 + (SYS * Math.abs(p.flux)) ** 2);
    let num = 0, den = 0; pts.forEach((p, i) => { num += p.flux * t[i] / s2[i]; den += t[i] ** 2 / s2[i]; });
    const a = Math.max(0, num / den);
    let chi2 = 0; pts.forEach((p, i) => { chi2 += (p.flux - a * t[i]) ** 2 / s2[i]; });
    return { T, a, chi2 };
  });
  const dof = Math.max(1, pts.length - 1);
  const best = fits.reduce((b, f) => (f.chi2 < b.chi2 ? f : b), fits[0]);
  const s = Math.max(1, best.chi2 / dof);               // inflate by the best fit's reduced chi-square
  let tot = 0; for (const f of fits) { f.w = Math.exp(-(f.chi2 - best.chi2) / (2 * s)); tot += f.w; }
  for (const f of fits) f.p = f.w / tot;
  fits.sort((x, y) => y.p - x.p);
  return { fits, dof, s, nPts: pts.length, lamMin: Math.min(...pts.map(p => p.lam)), lamMax: Math.max(...pts.map(p => p.lam)) };
}

// ------------------------------------------------------------------ UI
let R = null, busy = false, showTpl = 3;
function draw() {
  const cv = $('fChart'); if (!cv || !R) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, Hh = 360;
  cv.width = W * dpr; cv.height = Hh * dpr;
  const gx = cv.getContext('2d'); gx.setTransform(dpr, 0, 0, dpr, 0, 0); gx.clearRect(0, 0, W, Hh);
  const pad = { l: 58, r: 14, t: 14, b: 36 };
  const pts = R.ch.filter(c => Number.isFinite(c.flux));
  const vals = pts.flatMap(p => [p.flux + p.err, p.flux - p.err]).concat(R.ch.map(c => c.ap).filter(Number.isFinite));
  let lo = Math.min(...vals), hi = Math.max(...vals); const span = hi - lo || 1; lo -= 0.08 * span; hi += 0.08 * span;
  const x = l => pad.l + (l - 0.75) / 4.25 * (W - pad.l - pad.r), y = v => pad.t + (hi - v) / (hi - lo) * (Hh - pad.t - pad.b);
  gx.font = '11px "Golos Text", system-ui, sans-serif'; gx.strokeStyle = 'rgba(149,162,191,0.15)'; gx.fillStyle = '#95a2bf';
  const step = niceStep((hi - lo) / 5);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) { gx.beginPath(); gx.moveTo(pad.l, y(v)); gx.lineTo(W - pad.r, y(v)); gx.stroke(); gx.textAlign = 'right'; gx.fillText(fmtFlux(v), pad.l - 6, y(v) + 4); }
  for (let l = 1; l <= 5; l++) { gx.textAlign = 'center'; gx.fillText(String(l), x(l), Hh - pad.b + 16); }
  gx.fillText(tx('Wavelength (µm)'), (pad.l + W - pad.r) / 2, Hh - 4);
  gx.save(); gx.translate(12, (pad.t + Hh - pad.b) / 2); gx.rotate(-Math.PI / 2); gx.fillText(tx('Flux density (mJy)'), 0, 0); gx.restore();
  if (lo < 0 && hi > 0) { gx.strokeStyle = 'rgba(232,236,244,0.35)'; gx.beginPath(); gx.moveTo(pad.l, y(0)); gx.lineTo(W - pad.r, y(0)); gx.stroke(); }
  gx.save(); gx.beginPath(); gx.rect(pad.l, pad.t, W - pad.l - pad.r, Hh - pad.t - pad.b); gx.clip();
  // naive aperture (grey) for comparison
  if ($('fShowAp').checked) { gx.fillStyle = 'rgba(149,162,191,0.55)'; for (const c of R.ch) if (Number.isFinite(c.ap)) { gx.beginPath(); gx.rect(x(c.lam) - 2.5, y(c.ap) - 2.5, 5, 5); gx.fill(); } }
  // templates
  R.cls.fits.slice(0, showTpl).forEach(f => {
    gx.strokeStyle = f.T.color; gx.lineWidth = 2; gx.beginPath();
    for (let l = 0.75; l <= 5.0001; l += 0.01) { const v = f.a * f.T.f(l), yy = y(v); l === 0.75 ? gx.moveTo(x(l), yy) : gx.lineTo(x(l), yy); }
    gx.stroke();
  });
  // measured channels
  for (const p of pts) {
    gx.strokeStyle = 'rgba(232,236,244,0.7)'; gx.lineWidth = 1; gx.beginPath(); gx.moveTo(x(p.lam), y(p.flux - p.err)); gx.lineTo(x(p.lam), y(p.flux + p.err)); gx.stroke();
    gx.beginPath(); gx.arc(x(p.lam), y(p.flux), 3, 0, Math.PI * 2);
    if (p.halo) { gx.strokeStyle = '#e8ecf4'; gx.lineWidth = 1.5; gx.stroke(); } else { gx.fillStyle = '#e8ecf4'; gx.fill(); }
  }
  gx.restore();
  $('fLegend').innerHTML = `<span><i style="border-top:0;width:8px;height:8px;border-radius:50%;background:#e8ecf4"></i>SPHEREx channels, deblended</span>${R.nHalo ? '<span><i style="border-top:0;width:7px;height:7px;border-radius:50%;border:1.5px solid #e8ecf4"></i>from the halo (saturated core)</span>' : ''}${$('fShowAp').checked ? '<span><i style="border-top:0;width:7px;height:7px;background:rgba(149,162,191,0.7)"></i>plain aperture (blended)</span>' : ''}` +
    R.cls.fits.slice(0, showTpl).map(f => `<span><i style="border-top:2px solid ${f.T.color}"></i>${f.T.cls}</span>`).join('');
}
const niceStep = s => { const p = 10 ** Math.floor(Math.log10(s)), m = s / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const fmtFlux = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));

function render() {
  const out = $('fResult');
  if (!R) return;
  const top = R.cls.fits[0];
  out.innerHTML = `
    <div class="verdict ${top.p > 0.6 ? 'yes' : 'no'}"><b>Most likely: ${top.T.cls.split(' (')[0].toLowerCase()} (${Math.round(top.p * 100)}%)</b>
      <span>${top.T.cls}. Fitted on ${R.cls.nPts} channels from ${fmt(R.cls.lamMin, 2)} to ${fmt(R.cls.lamMax, 2)} µm; reduced χ² of the best template ${fmt(R.cls.s, 1)}.${R.nHalo ? ` ${R.nHalo} exposures with a saturated core were measured from the star's halo (open circles).` : ''}${R.nSat ? ` ${R.nSat} exposures could not be measured and were left out.` : ''}${R.cls.lamMin > 3 ? ' Only the long-wavelength end is usable here, where every star looks alike (the Rayleigh–Jeans tail), so the star type is uncertain.' : ''}${/asteroid/i.test(top.T.cls) || R.cls.s > 5 ? ' Caution: for a faint source a warm asteroid and a cold brown dwarf look alike (both dark at short wavelengths, brighter at the long end), and a reduced χ² well above 1 means no template fits well. The motion decides: open the Blink viewer — a nearby star or brown dwarf moves a few arcseconds per year, an asteroid moves arcseconds per minute.' : ''}</span></div>
    <table class="ftable"><thead><tr><th>Template</th><th>χ² / dof</th><th>Probability</th></tr></thead><tbody>
      ${R.cls.fits.map(f => `<tr><td><i class="dot" style="background:${f.T.color}"></i>${f.T.cls}</td><td>${fmt(f.chi2 / R.cls.dof, 1)}</td><td><span class="pbar"><em style="width:${(f.p * 100).toFixed(1)}%;background:${f.T.color}"></em></span>${Math.round(f.p * 100)}%</td></tr>`).join('')}
    </tbody></table>`;
  $('fMeta').innerHTML = `<dl class="meta">
    <dt>Source</dt><dd>${R.src.name}</dd>
    <dt>Exposures used</dt><dd>${R.raw.length - R.nSat} of ${R.raw.length}${R.nHalo ? ` (${R.nHalo} via halo)` : ''}</dd>
    <dt>Channels with data</dt><dd>${R.cls.nPts} of ${EDGES.length - 1}</dd>
    <dt>Gaia neighbours fitted</dt><dd>${R.nb.length} within 40″</dd></dl>`;
  draw();
}

async function run() {
  if (busy) return;
  const st = ST();
  if (!st || st.busy || !st.loaded || !st.loaded.length) return;
  busy = true; $('fStatus').textContent = 'Measuring every exposure (forced PSF fit with Gaia neighbours)…';
  try { R = await measure(); R.cls = classify(R.ch); render(); $('fStatus').textContent = ''; }
  catch (e) { console.error(e); $('fStatus').textContent = 'Could not measure this source.'; }
  busy = false;
}

function renderState() {
  const st = ST(), box = $('fState');
  const allBands = st && st.band === 0;
  if (!st || (!st.loaded.length && !st.busy)) {
    box.innerHTML = `<p class="muted">Load a source with all wavelength bands first. One click:</p>${links()}`;
    $('fBody').hidden = true; return false;
  }
  if (st.busy) { box.innerHTML = `<p class="muted">Loading exposures in the Blink viewer… ${($('status') || {}).textContent || ''}</p>`; $('fBody').hidden = true; return false; }
  box.innerHTML = allBands ? `<p class="muted small">Using all ${st.loaded.length} loaded exposures. Click a different source in the Blink viewer to fingerprint it instead.</p>`
    : `<p class="muted small">Only one detector band is loaded (${st.loaded.length} exposures), so the spectrum covers part of 0.75–5 µm. For the full fingerprint load all bands:</p>${links()}`;
  $('fBody').hidden = false; return true;
}
function links() { return `<div class="chips">${TARGETS.map(t => `<a class="chip" href="./?t=${t.id}&band=0&n=0&fov=4#fingerprint">${t.name}</a>`).join('')}</div>`; }

function build() {
  $('fpView').innerHTML = `
  <header class="page-head">
    <h1>Spectral fingerprint</h1>
    <p class="lede">Every SPHEREx exposure sees a source at a slightly different wavelength. Put them together and you get its spectrum from 0.75 to 5 µm, which tells a star from a brown dwarf, a galaxy or an icy planet.</p>
    <p class="why"><b>Why it matters.</b> A moving dot is only interesting if we know what it is. The shape of the spectrum separates a cold methane world, the kind of object Planet X would be, from the stars, galaxies and asteroids that fill every image.</p>
  </header>
  <div class="detect-grid">
    <aside class="panel"><h2>Source</h2><div id="fState"></div><div id="fMeta"></div>
      <label class="check"><input type="checkbox" id="fShowAp" checked> <span>Show plain-aperture photometry (blended)</span></label>
      <label class="field">Templates drawn <select id="fTop"><option value="1">best 1</option><option value="3" selected>best 3</option><option value="6">all 6</option></select></label>
      <p class="sky-status" id="fStatus"></p></aside>
    <section class="panel d-main" id="fBody" hidden>
      <div id="fResult"></div>
      <div class="d-chart"><canvas id="fChart" height="360" aria-label="Measured spectrum with the best-fitting templates"></canvas></div>
      <div class="legend" id="fLegend"></div>
      <details class="how"><summary>How we calculated this</summary><div class="how-body">
        <h3>1. Measuring each exposure</h3>
        <p class="formula">I(x, y) = F₀ P(x − x₀, y − y₀) + Σ<sub>k</sub> F<sub>k</sub> P(x − x<sub>k</sub>, y − y<sub>k</sub>) + b</p>
        <p>P is a Gaussian PSF whose width is measured from bright unsaturated stars in that same exposure. x₀ is the source position at the exposure date (proper motion and parallax included); x<sub>k</sub> are all Gaia DR3 stars within 40″, moved to the same date. All fluxes and the sky b are fitted together by least squares, so a neighbour a few arcseconds away no longer leaks into the source. </p>
        <h3>1b. Saturated cores</h3>
        <p class="formula">F = ⟨I⟩<sub>ring</sub> / r, &nbsp; r = median over field stars of ⟨I⟩<sub>ring</sub> / F<sub>star</sub></p>
        <p>When the source's core is saturated we use its halo: the mean surface brightness in a ring 2.5–4.5 SPHEREx pixels from the centre. In one exposure that ring holds a fixed fraction r of a star's light. We measure r on bright unsaturated stars in the same exposure and divide. Such points are drawn as open circles; their errors include the scatter of r and a 5% floor.</p>
        <h3>2. Channels</h3>
        <p>Measurements are grouped into channels of width λ/41 below 3.82 µm and λ/120 above (≈ SPHEREx's 102 channels), averaged with inverse-variance weights after rejecting points more than 5 MAD from the channel median (cosmic rays).</p>
        <h3>3. Templates</h3>
        <ul>${TEMPLATES.map(t => `<li><b>${t.cls}</b>: ${t.note}</li>`).join('')}</ul>
        <p>These are schematic shapes built from blackbodies and the laboratory wavelengths of the main absorption bands, not observed spectra. They capture the broad differences that matter here, not fine detail.</p>
        <h3>4. Fit and probabilities</h3>
        <p class="formula">χ² = Σ (F<sub>i</sub> − a T(λ<sub>i</sub>))² / (σ<sub>i</sub>² + (0.05 F<sub>i</sub>)²), &nbsp; a = Σ F T / σ² ÷ Σ T² / σ²</p>
        <p class="formula">p<sub>k</sub> ∝ exp(−(χ²<sub>k</sub> − χ²<sub>min</sub>) / 2s), &nbsp; s = max(1, χ²<sub>min</sub> / dof)</p>
        <p>Each template gets its best brightness scale a. A 5% calibration floor is added to every error. Because no schematic template fits perfectly, the χ² differences are divided by the best fit's reduced χ² before turning them into relative probabilities. The percentages compare these six templates only: an object of another kind would still be forced into one of them.</p>
      </div></details>
    </section>
  </div>`;
  $('fShowAp').addEventListener('change', draw);
  $('fTop').addEventListener('change', e => { showTpl = Number(e.target.value); render(); });
  window.addEventListener('resize', draw);
}

let built = false, poll = 0, lastKey = '';
export function openFingerprint() {
  if (!built) { built = true; build(); }
  const tick = () => {
    const ok = renderState(), st = ST();
    if (ok) {
      const key = `${st.ra}|${st.dec}|${st.band}|${st.loaded.length}|${st.pick ? st.pick.ra + ',' + st.pick.dec : ''}`;
      if (key !== lastKey) { lastKey = key; run(); }
    } else { clearTimeout(poll); poll = setTimeout(tick, 1000); }
  };
  tick();
}
