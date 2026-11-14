// sky.js — the "Sky map" tab: an interactive map of the whole sky (stars, constellations, the
// Milky Way, coordinate grids) that you can drag and zoom, plus a SPHEREx layer: pick any spot and
// the map draws every real SPHEREx exposure that covers it, coloured by date, with a time brush,
// playback through the survey and filters by detector band. Click a footprint to blink that spot.
//
// Background data: d3-celestial (BSD-3-Clause, Olaf Frohn), built by tools/build-sky-data.py;
// stars from Hipparcos. SPHEREx footprints: NASA/IPAC IRSA (via /api/sia).
// Code written with AI assistance (Claude), reviewed and tested by team Sigma Boys.

import { searchFrames, BANDS } from './spherex.js';
import { parseCoords, fmtRa, fmtDec, mjdToDate, sunVector } from './wcs.js';
import { TARGETS } from './targets.js';
import { t, lang } from './i18n.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const $ = id => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const vec = (ra, dec) => { const a = ra * D2R, d = dec * D2R, c = Math.cos(d); return [c * Math.cos(a), c * Math.sin(a), Math.sin(d)]; };
const toRaDec = v => { const r = Math.hypot(v[0], v[1], v[2]); return [((Math.atan2(v[1], v[0]) * R2D) + 360) % 360, Math.asin(clamp(v[2] / r, -1, 1)) * R2D]; };

// J2000 equatorial -> galactic rotation (rows), and the ecliptic tilt.
const GAL = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
const EPS = 23.4392911 * D2R;
const galOf = v => toRaDec([GAL[0][0] * v[0] + GAL[0][1] * v[1] + GAL[0][2] * v[2], GAL[1][0] * v[0] + GAL[1][1] * v[1] + GAL[1][2] * v[2], GAL[2][0] * v[0] + GAL[2][1] * v[1] + GAL[2][2] * v[2]]);
const fromGal = (l, b) => { const g = vec(l, b); return toRaDec([GAL[0][0] * g[0] + GAL[1][0] * g[1] + GAL[2][0] * g[2], GAL[0][1] * g[0] + GAL[1][1] * g[1] + GAL[2][1] * g[2], GAL[0][2] * g[0] + GAL[1][2] * g[1] + GAL[2][2] * g[2]]); };
const fromEcl = lon => { const l = lon * D2R; return toRaDec([Math.cos(l), Math.sin(l) * Math.cos(EPS), Math.sin(l) * Math.sin(EPS)]); };

// Colours per SPHEREx detector band (short -> long wavelength), validated for colour-blind separation.
const BAND_COL = ['#5aa9e6', '#3fc1a5', '#a6d75b', '#f2c14e', '#f08a4b', '#e2536f'];
// Date ramp for footprints: ice -> violet -> ember.
const RAMP = [[111, 211, 255], [155, 118, 220], [255, 138, 76]];
const rampAt = f => { f = clamp(f, 0, 1) * (RAMP.length - 1); const i = Math.min(RAMP.length - 2, Math.floor(f)), u = f - i; return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * u)); };

const S = {
  ready: false, data: null, faint: null, faintLoading: false,
  ra: 266.4, dec: -29.0, fov: 120, W: 0, H: 0, dpr: 1,
  layers: { mw: true, lines: true, names: true, bounds: false, grid: true, ecl: true, gal: false, starNames: true, messier: true, targets: true, fp: true, p9: true, p9orbit: true, tno: true },
  pick: null, hover: null, fp: [], fpCenter: null, fpBusy: false, fpSel: null,
  bands: new Set([1, 2, 3, 4, 5, 6]), range: null, play: null, raf: 0, fly: null,
};

let cv, ctx, mwCanvas, mwData, mwW = 1024, mwH = 512, mwLayer, starVec, faintVec;

// ------------------------------------------------------------------ projection (stereographic)
let C, E, N, scale, cx, cy;
function setView() {
  C = vec(S.ra, S.dec);
  const a = S.ra * D2R, d = S.dec * D2R;
  E = [-Math.sin(a), Math.cos(a), 0];
  N = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  scale = (Math.min(S.W, S.H * 1.6) / 2) / (2 * Math.tan(S.fov * D2R / 4));
  cx = S.W / 2; cy = S.H / 2;
}
const LIMIT = -0.55;   // hide points more than ~123 degrees from the centre
function projV(v) {
  const z = v[0] * C[0] + v[1] * C[1] + v[2] * C[2];
  if (z < LIMIT) return null;
  const k = 2 / (1 + z) * scale;
  return [cx - k * (v[0] * E[0] + v[1] * E[1] + v[2] * E[2]), cy - k * (v[0] * N[0] + v[1] * N[1] + v[2] * N[2])];
}
const proj = (ra, dec) => projV(vec(ra, dec));
function unproj(sx, sy) {
  const X = (cx - sx) / scale, Y = (cy - sy) / scale, r2 = X * X + Y * Y;
  const z = (4 - r2) / (4 + r2), f = (1 + z) / 2, x = X * f, y = Y * f;
  return toRaDec([x * E[0] + y * N[0] + z * C[0], x * E[1] + y * N[1] + z * C[1], x * E[2] + y * N[2] + z * C[2]]);
}


// ------------------------------------------------------------------ Planet Nine: where could it be?
// Brown & Batygin (2021, AJ 162, 219): a = 380 (+140/−80) AU, q = 300 (+85/−60) AU, i = 16 ± 5°,
// Ω = 97° (median), ϖ = 254° (maximum likelihood). We draw orbits from these (log-normal for a and q,
// normal for the angles; the ±20° spreads of Ω and ϖ are our assumption, the paper gives no
// percentiles for them), put the planet at a random time along each orbit (mean anomaly uniform in
// time, so it lingers near aphelion), and bin the sky positions. Seeded, so every visitor sees the same map.
const P9 = { a: 380, sLnA: 0.25, q: 300, sLnQ: 0.22, i: 16, sI: 5, om: 97, sOm: 20, varpi: 254, sVarpi: 20, N: 60000 };
let p9Tex = null, p9Layer = null, p9Peak = null, p9Orbit = null;
function gauss(r) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function seeded(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
/** Heliocentric ecliptic J2000 position (AU) from elements in degrees, mean anomaly M in degrees. */
function keplerXYZ(a, e, iD, omD, wD, MD) {
  const M = ((MD % 360) + 360) % 360 * D2R;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 50; k++) { const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= dE; if (Math.abs(dE) < 1e-12) break; }
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)), r = a * (1 - e * Math.cos(E));
  const i = iD * D2R, om = omD * D2R, u = wD * D2R + nu;
  return [r * (Math.cos(om) * Math.cos(u) - Math.sin(om) * Math.sin(u) * Math.cos(i)), r * (Math.sin(om) * Math.cos(u) + Math.cos(om) * Math.sin(u) * Math.cos(i)), r * Math.sin(u) * Math.sin(i)];
}
const eclToEq = ([x, y, z]) => [x, y * Math.cos(EPS) - z * Math.sin(EPS), y * Math.sin(EPS) + z * Math.cos(EPS)];
function buildP9() {
  const r = seeded(97254), W = 360, Hh = 180, h = new Float32Array(W * Hh);
  for (let k = 0; k < P9.N; k++) {
    const a = P9.a * Math.exp(P9.sLnA * gauss(r));
    const q = Math.min(0.95 * a, Math.max(150, P9.q * Math.exp(P9.sLnQ * gauss(r))));
    const e = 1 - q / a, i = clamp(P9.i + P9.sI * gauss(r), 0, 40), om = P9.om + P9.sOm * gauss(r), vp = P9.varpi + P9.sVarpi * gauss(r);
    const [ra, dec] = toRaDec(eclToEq(keplerXYZ(a, e, i, om, vp - om, r() * 360)));
    h[Math.min(Hh - 1, Math.floor(90 - dec)) * W + Math.min(W - 1, Math.floor(ra))]++;
  }
  // smooth with a Gaussian of 2 bins (wrap in RA), then normalise to the peak
  const blur = (src, horiz) => { const out = new Float32Array(W * Hh), ker = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(d => [d, Math.exp(-d * d / 8)]);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { let s = 0, w = 0; for (const [d, k] of ker) { const xx = horiz ? (x + d + W) % W : x, yy = horiz ? y : y + d; if (yy < 0 || yy >= Hh) continue; s += src[yy * W + xx] * k; w += k; } out[y * W + x] = s / w; } return out; };
  p9Tex = blur(blur(h, true), false);
  let mx = 0, at = 0; for (let k = 0; k < p9Tex.length; k++) if (p9Tex[k] > mx) { mx = p9Tex[k]; at = k; }
  for (let k = 0; k < p9Tex.length; k++) p9Tex[k] /= mx;
  p9Peak = { ra: (at % W) + 0.5, dec: 90 - Math.floor(at / W) - 0.5 };
  const eN = 1 - P9.q / P9.a;
  p9Orbit = []; for (let m = 0; m <= 360; m += 2) p9Orbit.push(toRaDec(eclToEq(keplerXYZ(P9.a, eN, P9.i, P9.om, P9.varpi - P9.om, m))));
  p9Layer = document.createElement('canvas');
}
function drawP9() {
  if (!p9Tex) buildP9();
  const step = S.fov < 30 ? 6 : 4, w = Math.ceil(S.W / step), h = Math.ceil(S.H / step);
  if (p9Layer.width !== w || p9Layer.height !== h) { p9Layer.width = w; p9Layer.height = h; }
  const g = p9Layer.getContext('2d'), img = g.createImageData(w, h), px = img.data;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const X = (cx - (i + 0.5) * step) / scale, Y = (cy - (j + 0.5) * step) / scale, r2 = X * X + Y * Y, z = (4 - r2) / (4 + r2);
    if (z < LIMIT) continue;
    const f = (1 + z) / 2, x = X * f, y = Y * f;
    const vx = x * E[0] + y * N[0] + z * C[0], vy = x * E[1] + y * N[1] + z * C[1], vz = x * E[2] + y * N[2] + z * C[2];
    const ra = ((Math.atan2(vy, vx) * R2D) + 360) % 360, dec = Math.asin(clamp(vz, -1, 1)) * R2D;
    const fx = ra - 0.5, fy = clamp(90 - dec - 0.5, 0, 178.999), x0 = Math.floor(fx), y0 = Math.floor(fy), ux = fx - x0, uy = fy - y0;
    const xa = (x0 + 360) % 360, xb = (x0 + 361) % 360;
    const t = (p9Tex[y0 * 360 + xa] * (1 - ux) + p9Tex[y0 * 360 + xb] * ux) * (1 - uy) + (p9Tex[(y0 + 1) * 360 + xa] * (1 - ux) + p9Tex[(y0 + 1) * 360 + xb] * ux) * uy;
    if (t < 0.03) continue;
    const o = (j * w + i) * 4, [cr, cg, cb] = t > 0.5 ? [255, 120 + (t - 0.5) * 140, 70] : [190 + t * 130, 70 + t * 100, 90];
    px[o] = cr; px[o + 1] = cg; px[o + 2] = cb; px[o + 3] = Math.min(255, 18 + t * 115);
  }
  g.putImageData(img, 0, 0);
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(p9Layer, 0, 0, w * step, h * step); ctx.restore();
}

// Extreme TNOs from the JPL Small-Body Database, propagated with two-body Kepler motion to today.
let tnos = null, tnoLoading = false;
async function loadTnos() {
  if (tnos || tnoLoading) return; tnoLoading = true; setP9Status('Getting orbits of extreme TNOs from the JPL Small-Body Database…');
  try {
    const j = await (await fetch('/api/sbdb')).json();
    const now = new Date(), jd = now.getTime() / 864e5 + 2440587.5, year = 2000 + (jd - 2451545) / 365.25;
    const sun = sunVector(year);                                            // geocentric Sun, equatorial AU
    tnos = (j.objects || []).filter(o => !o.error).map(o => {
      const h = eclToEq(keplerXYZ(o.a, o.e, o.i, o.om, o.w, o.ma + o.n * (jd - o.epoch)));
      const geo = [h[0] + sun[0], h[1] + sun[1], h[2] + sun[2]];             // Earth = −Sun
      const [ra, dec] = toRaDec(geo);
      const rest = o.name.replace(/^\d+\s*/, '');
      const short = rest.startsWith('(') ? rest.replace(/[()]/g, '') : rest.replace(/\s*\(.*\)/, '');
      return { name: short, full: o.name, ra, dec, r: Math.hypot(...h), a: o.a, q: o.q };
    });
    setP9Status(`${tnos.length} extreme TNOs placed for ${now.toISOString().slice(0, 10)} (JPL SBDB elements, Kepler motion).`);
  } catch (e) { console.error(e); setP9Status('The JPL Small-Body Database did not answer; TNO positions are not shown.'); tnos = []; }
  draw();
}
function setP9Status(t) { const el = $('skyP9Status'); if (el) el.textContent = t; }

// ------------------------------------------------------------------ data
async function loadData() {
  const r = await fetch('data/sky.json');
  S.data = await r.json();
  starVec = new Float32Array(S.data.stars.length * 3);
  S.data.stars.forEach((s, i) => starVec.set(vec(s[0], s[1]), i * 3));
  buildMilkyWay();
  S.ready = true;
}
async function loadFaint() {
  if (S.faint || S.faintLoading) return;
  S.faintLoading = true;
  try {
    S.faint = (await (await fetch('data/stars8.json')).json()).stars;
    faintVec = new Float32Array(S.faint.length * 3);
    S.faint.forEach((s, i) => faintVec.set(vec(s[0], s[1]), i * 3));
    draw();
  } catch { S.faintLoading = false; }
}

/** Rasterise the Milky Way outline (five nested brightness contours) into an equirectangular texture. */
function buildMilkyWay() {
  const c = document.createElement('canvas'); c.width = mwW; c.height = mwH;
  const g = c.getContext('2d');
  const X = ra => (360 - ra) / 360 * mwW, Y = dec => (90 - dec) / 180 * mwH;
  const levels = ['ol1', 'ol2', 'ol3', 'ol4', 'ol5'];
  levels.forEach((id, li) => {
    const polys = S.data.mw[id] || [];
    g.fillStyle = `rgba(255,255,255,${0.16 + li * 0.04})`;
    for (const shift of [-mwW, 0, mwW]) {
      g.beginPath();
      for (const poly of polys) for (const ring of poly) {
        let prev = null;
        ring.forEach(([lon, lat], i) => {
          let x = X((lon + 360) % 360);
          if (prev !== null) { while (x - prev > mwW / 2) x -= mwW; while (prev - x > mwW / 2) x += mwW; }
          prev = x;
          i ? g.lineTo(x + shift, Y(lat)) : g.moveTo(x + shift, Y(lat));
        });
        g.closePath();
      }
      g.fill('evenodd');
    }
  });
  // Soften: shrink and grow back (works in every browser, unlike ctx.filter).
  const s = document.createElement('canvas'); s.width = mwW / 8; s.height = mwH / 8;
  s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
  const b = document.createElement('canvas'); b.width = mwW; b.height = mwH;
  const bg = b.getContext('2d'); bg.imageSmoothingQuality = 'high';
  bg.globalAlpha = 0.65; bg.drawImage(s, 0, 0, mwW, mwH);
  bg.globalAlpha = 0.5; bg.drawImage(c, 0, 0);
  mwData = bg.getImageData(0, 0, mwW, mwH).data;
  mwLayer = document.createElement('canvas');
}

function drawMilkyWay() {
  const step = S.fov < 30 ? 6 : 4, w = Math.ceil(S.W / step), h = Math.ceil(S.H / step);
  if (mwLayer.width !== w || mwLayer.height !== h) { mwLayer.width = w; mwLayer.height = h; }
  const g = mwLayer.getContext('2d'), img = g.createImageData(w, h), px = img.data;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const X = (cx - (i + 0.5) * step) / scale, Y = (cy - (j + 0.5) * step) / scale, r2 = X * X + Y * Y;
    const z = (4 - r2) / (4 + r2);
    if (z < LIMIT) continue;
    const f = (1 + z) / 2, x = X * f, y = Y * f;
    const vx = x * E[0] + y * N[0] + z * C[0], vy = x * E[1] + y * N[1] + z * C[1], vz = x * E[2] + y * N[2] + z * C[2];
    const ra = ((Math.atan2(vy, vx) * R2D) + 360) % 360, dec = Math.asin(clamp(vz, -1, 1)) * R2D;
    const fx = (360 - ra) / 360 * mwW - 0.5, fy = clamp((90 - dec) / 180 * mwH - 0.5, 0, mwH - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ux = fx - x0, uy = fy - y0;
    const xa = (x0 + mwW) % mwW, xb = (x0 + 1 + mwW) % mwW, ya = y0 * mwW, yb = (y0 + 1) * mwW;
    const a = (mwData[(ya + xa) * 4 + 3] * (1 - ux) + mwData[(ya + xb) * 4 + 3] * ux) * (1 - uy)
      + (mwData[(yb + xa) * 4 + 3] * (1 - ux) + mwData[(yb + xb) * 4 + 3] * ux) * uy;
    if (!a) continue;
    const o = (j * w + i) * 4;
    px[o] = 150; px[o + 1] = 172; px[o + 2] = 230; px[o + 3] = a * 0.42;
  }
  g.putImageData(img, 0, 0);
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mwLayer, 0, 0, w * step, h * step); ctx.restore();
}

// ------------------------------------------------------------------ drawing helpers
function polyline(points, close = false) {
  // points: [[ra,dec],...]; long edges are subdivided along great circles; the path breaks behind the view.
  let pen = false;
  const n = points.length, last = close ? n : n - 1;
  const step = Math.max(0.5, Math.min(3, S.fov / 40));
  for (let i = 0; i < last; i++) {
    const a = vec(...points[i]), b = vec(...points[(i + 1) % n]);
    const ang = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) * R2D;
    const k = Math.max(1, Math.ceil(ang / step));
    for (let s = (i === 0 ? 0 : 1); s <= k; s++) {
      const u = s / k, v = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      const p = projV(v.map(x => x / Math.hypot(...v)));
      if (!p) { pen = false; continue; }
      pen ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
      pen = true;
    }
  }
}
function curve(fn, from, to, step) { const pts = []; for (let x = from; x <= to + 1e-9; x += step) pts.push(fn(x)); return pts; }

function bvColor(bv) {
  const t = clamp((bv + 0.3) / 2.0, 0, 1);
  const stops = [[155, 180, 255], [215, 225, 255], [255, 247, 232], [255, 214, 160], [255, 170, 110]];
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * u));
}

function label(text, x, y, { color = 'rgba(200,210,235,0.75)', size = 11, weight = 500, align = 'left', dx = 6, dy = -6, spacing = 0 } = {}) {
  ctx.font = `${weight} ${size}px "Golos Text", system-ui, sans-serif`;
  ctx.textAlign = align; ctx.fillStyle = color;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(text, x + dx, y + dy);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

// ------------------------------------------------------------------ main draw
function limitMag() { return clamp(5.2 + 2.6 * Math.log10(120 / S.fov), 4.6, 8.0); }

function draw() {
  if (!S.ready || !cv) return;
  setView();
  const L = S.layers;
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(cx, cy));
  bg.addColorStop(0, '#0b1124'); bg.addColorStop(1, '#04060e');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, S.W, S.H);

  if (L.mw) drawMilkyWay();
  if (L.p9) drawP9();

  // horizon of the view (the edge of the drawn hemisphere)
  const edge = 2 * Math.sqrt((1 - LIMIT) / (1 + LIMIT)) * scale;
  if (edge < Math.hypot(S.W, S.H)) {
    ctx.beginPath(); ctx.arc(cx, cy, edge, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(111,211,255,0.18)'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.lineWidth = 1;
  if (L.grid) {
    const sd = S.fov > 90 ? 30 : S.fov > 30 ? 10 : S.fov > 8 ? 5 : 1, sr = S.fov > 90 ? 30 : S.fov > 30 ? 15 : S.fov > 8 ? 5 : 1;
    ctx.strokeStyle = 'rgba(120,140,190,0.14)'; ctx.beginPath();
    for (let d = -90 + sd; d < 90; d += sd) polyline(curve(r => [r, d], 0, 360, 2));
    for (let r = 0; r < 360; r += sr) polyline(curve(d => [r, d], -89, 89, 2));
    ctx.stroke();
    // RA hour labels along the equator, Dec labels along the central meridian
    for (let r = 0; r < 360; r += Math.max(15, sr)) { const p = proj(r, 0); if (p && p[0] > 4 && p[0] < S.W - 30 && p[1] > 10 && p[1] < S.H - 10) label(`${r / 15}h`, p[0], p[1], { color: 'rgba(150,170,215,0.55)', size: 10 }); }
    for (let d = -60; d <= 60; d += 30) { const p = proj(S.ra, d); if (p && d !== 0) label(`${d > 0 ? '+' : ''}${d}°`, p[0], p[1], { color: 'rgba(150,170,215,0.55)', size: 10 }); }
  }
  if (L.ecl) {
    ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(242,184,75,0.45)'; ctx.beginPath(); polyline(curve(fromEcl, 0, 360, 2)); ctx.stroke(); ctx.setLineDash([]);
    const p = proj(...fromEcl(((S.ra + 20) % 360))); if (p) label(t('skyEcliptic'), p[0], p[1], { color: 'rgba(242,184,75,0.75)', size: 10 });
  }
  if (L.gal) {
    ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(155,118,220,0.55)'; ctx.beginPath(); polyline(curve(l => fromGal(l, 0), 0, 360, 2)); ctx.stroke(); ctx.setLineDash([]);
    const p = proj(...fromGal(0, 0)); if (p) label(t('skyGalCentre'), p[0], p[1], { color: 'rgba(185,160,235,0.85)', size: 10 });
  }
  if (L.bounds) {
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(120,140,190,0.22)'; ctx.beginPath();
    for (const polys of Object.values(S.data.bounds)) for (const ring of polys) polyline(ring, true);
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (L.lines) {
    ctx.strokeStyle = 'rgba(111,211,255,0.28)'; ctx.lineWidth = 1; ctx.beginPath();
    for (const segs of Object.values(S.data.lines)) for (const seg of segs) polyline(seg);
    ctx.stroke();
  }

  if (L.p9orbit) {
    if (!p9Orbit) buildP9();
    ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(255,138,76,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); polyline(p9Orbit); ctx.stroke(); ctx.setLineDash([]);
    const ap = proj(...p9Orbit[90]);
    if (ap) { ctx.fillStyle = '#ff8a4c'; ctx.beginPath(); ctx.arc(ap[0], ap[1], 4, 0, Math.PI * 2); ctx.fill(); label('Planet Nine aphelion (nominal orbit)', ap[0], ap[1], { color: '#ffb48a', size: 11, weight: 600 }); }
  }
  if (L.tno) {
    if (!tnos) loadTnos();
    else for (const o of tnos) {
      const p = proj(o.ra, o.dec); if (!p) continue;
      ctx.fillStyle = '#9fe3c0'; ctx.beginPath(); ctx.moveTo(p[0], p[1] - 5); ctx.lineTo(p[0] + 5, p[1]); ctx.lineTo(p[0], p[1] + 5); ctx.lineTo(p[0] - 5, p[1]); ctx.closePath(); ctx.fill();
      if (S.fov < 170) label(o.name, p[0], p[1], { color: 'rgba(170,235,200,0.95)', size: 11, weight: 600 });
    }
  }
  if (L.fp && S.fp.length) drawFootprints();

  // stars
  const lim = limitMag();
  const drawSet = (list, vecs) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]; if (s[2] > lim) break;   // both lists are sorted by magnitude
      const p = projV([vecs[i * 3], vecs[i * 3 + 1], vecs[i * 3 + 2]]);
      if (!p || p[0] < -10 || p[1] < -10 || p[0] > S.W + 10 || p[1] > S.H + 10) continue;
      const r = Math.max(0.55, (lim + 1.2 - s[2]) * 0.42 * clamp(Math.sqrt(120 / S.fov) * 0.55, 0.8, 1.6));
      const [cr, cg, cb] = bvColor(s[3]);
      if (s[2] < 1.6) {
        const gl = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 4);
        gl.addColorStop(0, `rgba(${cr},${cg},${cb},0.35)`); gl.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(p[0], p[1], r * 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
    }
  };
  drawSet(S.data.stars, starVec);
  if (lim > 6.5) { if (S.faint) drawSet(S.faint, faintVec); else loadFaint(); }

  if (L.messier && S.fov < 100) {
    for (const m of S.data.messier) {
      const p = proj(m.ra, m.dec); if (!p) continue;
      ctx.strokeStyle = 'rgba(88,201,139,0.75)'; ctx.lineWidth = 1;
      ctx.beginPath();
      if (m.type === 'gc' || m.type === 'oc') ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
      else ctx.ellipse(p[0], p[1], 6, 3, -0.5, 0, Math.PI * 2);
      ctx.stroke();
      if (S.fov < 60) label(m.id, p[0], p[1], { color: 'rgba(120,220,160,0.85)', size: 10 });
    }
  }
  if (L.starNames) {
    const nlim = S.fov > 90 ? 1.3 : S.fov > 40 ? 2.2 : 3.5;
    S.data.stars.forEach((s, i) => {
      if (s[2] > nlim) return;
      const nm = S.data.names[S.data.starIds[i]]; if (!nm) return;
      const p = proj(s[0], s[1]); if (p) label(nm, p[0], p[1], { color: 'rgba(230,234,242,0.78)', size: 11 });
    });
  }
  if (L.names) {
    const maxRank = S.fov > 100 ? 1 : S.fov > 50 ? 2 : 3;
    for (const c of S.data.cons) {
      if (c.rank > maxRank) continue;
      const p = proj(c.ra, c.dec); if (!p) continue;
      const nm = (lang === 'ru' ? c.ru : c.name).toUpperCase();
      label(nm, p[0], p[1], { color: 'rgba(150,175,230,0.5)', size: 10, weight: 600, align: 'center', dx: 0, dy: 0, spacing: 1.5 });
    }
  }
  if (L.targets) for (const tg of TARGETS) {
    const p = proj(tg.ra, tg.dec); if (!p) continue;
    ctx.strokeStyle = '#ff8a4c'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p[0] - 12, p[1]); ctx.lineTo(p[0] - 8, p[1]); ctx.moveTo(p[0] + 8, p[1]); ctx.lineTo(p[0] + 12, p[1]);
    ctx.moveTo(p[0], p[1] - 12); ctx.lineTo(p[0], p[1] - 8); ctx.moveTo(p[0], p[1] + 8); ctx.lineTo(p[0], p[1] + 12); ctx.stroke();
    label(tg.name, p[0], p[1], { color: '#ffb48a', size: 11, weight: 600, dx: 12, dy: -10 });
  }
  if (S.pick) {
    const p = proj(S.pick.ra, S.pick.dec);
    if (p) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p[0] - 14, p[1]); ctx.lineTo(p[0] - 5, p[1]); ctx.moveTo(p[0] + 5, p[1]); ctx.lineTo(p[0] + 14, p[1]);
      ctx.moveTo(p[0], p[1] - 14); ctx.lineTo(p[0], p[1] - 5); ctx.moveTo(p[0], p[1] + 5); ctx.lineTo(p[0], p[1] + 14); ctx.stroke();
      // 0.5 degree search circle used for the SPHEREx layer
      const q = proj(S.pick.ra, Math.min(89.9, S.pick.dec + 0.5));
      if (q) { const rr = Math.hypot(q[0] - p[0], q[1] - p[1]); if (rr > 18) { ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); } }
    }
  }
  drawScale();
  $('skyFov').textContent = fmtFov(S.fov);
}

function fmtFov(f) { return f >= 2 ? `${f.toFixed(f < 10 ? 1 : 0)}°` : `${(f * 60).toFixed(0)}′`; }
function drawScale() {
  // a scale bar of a "round" angle
  const nice = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 45];
  const target = S.fov / 6;
  const a = nice.reduce((b, x) => Math.abs(x - target) < Math.abs(b - target) ? x : b, nice[0]);
  const px = 2 * Math.tan(a * D2R / 2) * scale;
  const x0 = 18, y0 = S.H - 18;
  ctx.strokeStyle = 'rgba(230,234,242,0.7)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 4); ctx.stroke();
  label(a >= 1 ? `${a}°` : `${a * 60}′`, x0 + px / 2, y0, { align: 'center', dx: 0, dy: -8, color: 'rgba(230,234,242,0.8)', size: 11 });
}

// ------------------------------------------------------------------ SPHEREx footprints
function visibleFrames() {
  return S.fp.filter(f => S.bands.has(f.det) && (!S.range || (f.mjd >= S.range[0] && f.mjd <= S.range[1])));
}
function drawFootprints() {
  const list = visibleFrames();
  const [m0, m1] = [S.fp[0].mjd, S.fp[S.fp.length - 1].mjd];
  const fa = clamp(2.2 / Math.max(1, list.length), 0.006, 0.06), sa = clamp(14 / Math.max(1, list.length), 0.22, 0.75);
  for (const f of list) {
    if (!f.corners || f.corners.length < 4) continue;
    const [r, g, b] = rampAt((f.mjd - m0) / Math.max(1, m1 - m0));
    ctx.beginPath(); polyline(f.corners, true); ctx.closePath();
    const sel = S.fpSel === f, hov = S.hover === f;
    ctx.fillStyle = `rgba(${r},${g},${b},${sel ? 0.22 : hov ? 0.14 : fa})`; ctx.fill();
    ctx.strokeStyle = `rgba(${r},${g},${b},${sel || hov ? 1 : sa})`; ctx.lineWidth = sel ? 2.5 : hov ? 1.8 : 0.8; ctx.stroke();
  }
}
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function footprintAt(sx, sy) {
  if (!S.layers.fp || !S.fp.length) return null;
  const list = visibleFrames();
  let best = null, bestD = Infinity;
  for (const f of list) {
    const pts = f.corners.map(c => proj(c[0], c[1]));
    if (pts.some(p => !p) || !pointInPoly(sx, sy, pts)) continue;
    const cxp = pts.reduce((s, p) => s + p[0], 0) / 4, cyp = pts.reduce((s, p) => s + p[1], 0) / 4;
    const d = Math.hypot(sx - cxp, sy - cyp);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

async function loadFootprints(ra, dec) {
  if (S.fpBusy) return;
  S.fpBusy = true; S.fpCenter = { ra, dec }; S.fp = []; S.fpSel = null; S.range = null; stopPlay();
  setFpStatus(t('skyFpLoading'), 'busy'); renderStats(); draw();
  const t0 = performance.now();
  try {
    const frames = await searchFrames(ra, dec, { radius: 0.5 });
    S.fp = frames.filter(f => f.corners && f.corners.length === 4);
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    setFpStatus(S.fp.length ? t('skyFpLoaded', { n: S.fp.length, s: secs }) : t('skyFpNone'), S.fp.length ? '' : 'warn');
  } catch (e) {
    console.error(e); setFpStatus(t('searchFailed'), 'warn');
  }
  S.fpBusy = false; S.layers.fp = true; syncLayerChecks();
  renderStats(); drawHist(); draw();
}
function setFpStatus(text, cls) { const el = $('skyFpStatus'); el.textContent = text; el.className = 'sky-status ' + (cls || ''); }

// ------------------------------------------------------------------ side panel: stats, histogram, time brush
function renderStats() {
  const box = $('skyStats');
  if (!S.fp.length) { box.innerHTML = `<p class="muted">${t('skyFpHint')}</p>`; $('skyTime').hidden = true; $('skyBandsBox').hidden = true; return; }
  $('skyTime').hidden = false; $('skyBandsBox').hidden = false;
  const vis = visibleFrames();
  const passes = new Map();
  for (const f of S.fp) { const p = passes.get(f.pass) || { n: 0, a: f.mjd, b: f.mjd }; p.n++; p.a = Math.min(p.a, f.mjd); p.b = Math.max(p.b, f.mjd); passes.set(f.pass, p); }
  const byBand = BANDS.map(b => vis.filter(f => f.det === b.det).length);
  const maxB = Math.max(1, ...byBand);
  box.innerHTML = `
    <div class="sky-kpis">
      <div><b>${vis.length}</b><span>${t('skyShown')}</span></div>
      <div><b>${S.fp.length}</b><span>${t('skyTotal')}</span></div>
      <div><b>${passes.size}</b><span>${t('skyPasses')}</span></div>
    </div>
    <div class="sky-bars">${BANDS.map((b, i) => `
      <div class="sky-bar"><span>D${b.det} · ${b.lo.toFixed(2)}–${b.hi.toFixed(2)} µm</span>
      <i><em style="width:${(byBand[i] / maxB * 100).toFixed(1)}%;background:${BAND_COL[i]}"></em></i><b>${byBand[i]}</b></div>`).join('')}
    </div>
    <div class="sky-passes">${[...passes.entries()].map(([k, p]) => `
      <button type="button" class="chip" data-pass="${k}">${fmtSpan(p.a, p.b)} <small>${p.n}</small></button>`).join('')}
      <button type="button" class="chip" data-pass="all">${t('skyAllTime')}</button>
    </div>`;
  for (const b of box.querySelectorAll('[data-pass]')) b.addEventListener('click', () => {
    stopPlay();
    if (b.dataset.pass === 'all') S.range = null;
    else { const p = passes.get(Number(b.dataset.pass)); S.range = [p.a - 0.5, p.b + 0.5]; }
    renderStats(); drawHist(); draw();
  });
  renderSelection();
}
function fmtSpan(a, b) {
  const da = mjdToDate(a), db = mjdToDate(b);
  const m = d => d.toLocaleDateString(lang === 'en' ? 'en-GB' : lang === 'ru' ? 'ru-RU' : 'kk-KZ', { month: 'short', year: 'numeric' });
  return m(da) === m(db) ? m(da) : `${m(da)} – ${m(db)}`;
}
const fmtDay = mjd => mjdToDate(mjd).toLocaleDateString(lang === 'en' ? 'en-GB' : lang === 'ru' ? 'ru-RU' : 'kk-KZ', { day: 'numeric', month: 'short', year: 'numeric' });

let hist = null;
function drawHist() {
  const c = $('skyHist'); if (!c || !S.fp.length) return;
  const w = c.clientWidth, h = 70, dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const m0 = S.fp[0].mjd - 3, m1 = S.fp[S.fp.length - 1].mjd + 3, span = m1 - m0;
  const nb = Math.max(20, Math.min(90, Math.round(span / 7)));
  const bins = new Array(nb).fill(0);
  for (const f of S.fp) if (S.bands.has(f.det)) bins[Math.min(nb - 1, Math.floor((f.mjd - m0) / span * nb))]++;
  const mx = Math.max(1, ...bins), bw = w / nb;
  hist = { m0, m1, w };
  g.clearRect(0, 0, w, h);
  if (S.range) { const x0 = (S.range[0] - m0) / span * w, x1 = (S.range[1] - m0) / span * w; g.fillStyle = 'rgba(255,138,76,0.14)'; g.fillRect(x0, 0, Math.max(2, x1 - x0), h - 16); }
  bins.forEach((n, i) => {
    if (!n) return;
    const mid = m0 + (i + 0.5) / nb * span, [r, gg, b] = rampAt((mid - S.fp[0].mjd) / Math.max(1, S.fp[S.fp.length - 1].mjd - S.fp[0].mjd));
    const inR = !S.range || (mid >= S.range[0] && mid <= S.range[1]);
    g.fillStyle = `rgba(${r},${gg},${b},${inR ? 0.95 : 0.25})`;
    const bh = Math.max(2, n / mx * (h - 22));
    g.fillRect(i * bw + 1, h - 16 - bh, Math.max(1, bw - 2), bh);
  });
  g.fillStyle = 'rgba(149,162,191,0.9)'; g.font = '11px "Golos Text", system-ui, sans-serif';
  g.textAlign = 'left'; g.fillText(fmtDay(S.fp[0].mjd), 0, h - 2);
  g.textAlign = 'right'; g.fillText(fmtDay(S.fp[S.fp.length - 1].mjd), w, h - 2);
  $('skyRange').textContent = S.range ? `${fmtDay(S.range[0])} – ${fmtDay(S.range[1])}` : t('skyAllTime');
}
function histMjd(clientX) { const r = $('skyHist').getBoundingClientRect(); return hist.m0 + clamp((clientX - r.left) / r.width, 0, 1) * (hist.m1 - hist.m0); }

function stopPlay() { if (S.play) { cancelAnimationFrame(S.play.raf); S.play = null; } const b = $('skyPlay'); if (b) b.textContent = t('skyPlay'); }
function startPlay() {
  if (!S.fp.length) return;
  const m0 = S.fp[0].mjd - 1, m1 = S.fp[S.fp.length - 1].mjd + 1, win = Math.max(4, (m1 - m0) / 25);
  // Skip the long gaps between passes so playback stays lively.
  const days = [...new Set(S.fp.map(f => Math.floor(f.mjd)))].sort((a, b) => a - b);
  let k = 0, last = 0;
  S.play = { raf: 0 };
  $('skyPlay').textContent = t('skyPause');
  const tick = ts => {
    if (!S.play) return;
    if (ts - last > 110) {
      last = ts;
      const d = days[k];
      S.range = [d - win, d + 0.99];
      k++;
      if (k >= days.length) { stopPlay(); S.range = null; }
      drawHist(); renderStats(); draw();
    }
    if (S.play) S.play.raf = requestAnimationFrame(tick);
  };
  S.play.raf = requestAnimationFrame(tick);
}

function renderSelection() {
  const box = $('skySel');
  const f = S.fpSel;
  if (!f) { box.hidden = true; return; }
  box.hidden = false;
  const b = BANDS[f.det - 1];
  box.innerHTML = `
    <h3>${t('skyExposure')}</h3>
    <dl class="meta">
      <dt>${t('skyDate')}</dt><dd>${fmtDay(f.mjd)} · ${mjdToDate(f.mjd).toISOString().slice(11, 16)} UTC</dd>
      <dt>${t('skyBand')}</dt><dd><i class="dot" style="background:${BAND_COL[f.det - 1]}"></i>D${f.det} · ${b.lo.toFixed(2)}–${b.hi.toFixed(2)} µm</dd>
      <dt>${t('skyPass')}</dt><dd>${f.pass + 1}</dd>
      <dt>${t('skyRelease')}</dt><dd>${f.collection.replace('spherex_', '').toUpperCase()}</dd>
      <dt>ID</dt><dd class="mono-s">${f.obsId}</dd>
    </dl>`;
}

// ------------------------------------------------------------------ info for the picked point
function constellationAt(ra, dec) {
  if (dec > 86.5) return 'UMi';
  if (dec < -82.5) return 'Oct';
  for (const [id, polys] of Object.entries(S.data.bounds)) for (const ring of polys) {
    const pts = ring.map(([lon, lat]) => { let d = ((lon - ra + 540) % 360) - 180; return [d, lat]; });
    if (pts.some((p, i) => i && Math.abs(p[0] - pts[i - 1][0]) > 180)) continue;
    if (pointInPoly(0, dec, pts)) return id;
  }
  return null;
}
const consName = id => { const c = S.data.cons.find(c => c.id === id); return c ? (lang === 'ru' ? c.ru : c.name) : id || '—'; };

function renderPick() {
  const box = $('skyPick');
  if (!S.pick) { box.innerHTML = `<p class="muted">${t('skyPickHint')}</p>`; $('skyBlink').disabled = true; $('skyLoadFp').disabled = true; return; }
  const { ra, dec } = S.pick, [l, b] = galOf(vec(ra, dec));
  box.innerHTML = `
    ${S.pick.name ? `<p class="sky-pickname">${S.pick.name}</p>` : ''}
    <dl class="meta">
      <dt>RA, Dec</dt><dd>${fmtRa(ra)} ${fmtDec(dec)}</dd>
      <dt>${t('skyDegrees')}</dt><dd>${ra.toFixed(4)}° ${dec >= 0 ? '+' : ''}${dec.toFixed(4)}°</dd>
      <dt>${t('skyGalactic')}</dt><dd>l ${l.toFixed(2)}°, b ${b >= 0 ? '+' : ''}${b.toFixed(2)}°</dd>
      <dt>${t('skyConstellation')}</dt><dd>${consName(constellationAt(ra, dec))}</dd>
    </dl>`;
  $('skyBlink').disabled = false; $('skyLoadFp').disabled = false;
}

function setPick(ra, dec, name = '') { S.pick = { ra, dec, name }; renderPick(); writeHash(); draw(); }

function nearestNamedObject(sx, sy) {
  let best = null, bd = 14;
  for (const tg of TARGETS) { const p = proj(tg.ra, tg.dec); if (p) { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bd) { bd = d; best = { ra: tg.ra, dec: tg.dec, name: tg.name }; } } }
  if (tnos && S.layers.tno) for (const o of tnos) { const p = proj(o.ra, o.dec); if (p) { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bd) { bd = d; best = { ra: o.ra, dec: o.dec, name: `${o.full} · ${o.r.toFixed(0)} AU from the Sun` }; } } }
  if (best) return best;
  if (S.fov < 100) for (const m of S.data.messier) { const p = proj(m.ra, m.dec); if (p) { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bd) { bd = d; best = { ra: m.ra, dec: m.dec, name: m.alt ? `${m.id} · ${m.alt}` : m.id }; } } }
  if (best) return best;
  S.data.stars.forEach((s, i) => { if (s[2] > 3.5) return; const nm = S.data.names[S.data.starIds[i]]; if (!nm) return; const p = proj(s[0], s[1]); if (p) { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bd) { bd = d; best = { ra: s[0], dec: s[1], name: nm }; } } });
  return best;
}

// ------------------------------------------------------------------ view changes, fly-to, URL
function flyTo(ra, dec, fov = S.fov, ms = 900) {
  const a0 = vec(S.ra, S.dec), a1 = vec(ra, dec), f0 = S.fov, t0 = performance.now();
  const ang = Math.acos(clamp(a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2], -1, 1));
  const mid = Math.min(180, Math.max(f0, fov, ang * R2D * 1.2));
  cancelAnimationFrame(S.fly);
  const step = now => {
    const u = clamp((now - t0) / ms, 0, 1), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    let v;
    if (ang < 1e-6) v = a1; else { const s = Math.sin(ang), w0 = Math.sin((1 - e) * ang) / s, w1 = Math.sin(e * ang) / s; v = [a0[0] * w0 + a1[0] * w1, a0[1] * w0 + a1[1] * w1, a0[2] * w0 + a1[2] * w1]; }
    [S.ra, S.dec] = toRaDec(v);
    const zf = e < 0.5 ? f0 + (mid - f0) * (e * 2) : mid + (fov - mid) * ((e - 0.5) * 2);
    S.fov = ang * R2D > 20 ? zf : f0 + (fov - f0) * e;
    draw();
    if (u < 1) S.fly = requestAnimationFrame(step); else writeHash();
  };
  S.fly = requestAnimationFrame(step);
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = [`sky`, S.ra.toFixed(3), S.dec.toFixed(3), S.fov.toFixed(2)];
    if (S.pick) p.push(S.pick.ra.toFixed(5), S.pick.dec.toFixed(5));
    history.replaceState(null, '', `${location.pathname}${location.search}#${p.join('/')}`);
  }, 250);
}
function readHash() {
  const p = location.hash.replace(/^#/, '').split('/');
  if (p[0] !== 'sky') return;
  const n = p.slice(1).map(Number);
  if (Number.isFinite(n[0]) && Number.isFinite(n[1])) { S.ra = ((n[0] % 360) + 360) % 360; S.dec = clamp(n[1], -90, 90); }
  if (Number.isFinite(n[2])) S.fov = clamp(n[2], 0.3, 200);
  if (Number.isFinite(n[3]) && Number.isFinite(n[4])) S.pick = { ra: n[3], dec: n[4], name: '' };
}

// ------------------------------------------------------------------ input
function resize() {
  const box = $('skyStage'); if (!box) return;
  const r = box.getBoundingClientRect();
  S.dpr = Math.min(2, window.devicePixelRatio || 1);
  S.W = Math.max(200, r.width); S.H = Math.max(200, r.height);
  cv.width = Math.round(S.W * S.dpr); cv.height = Math.round(S.H * S.dpr);
  draw(); drawHist();
}

function zoomAt(factor, sx = cx, sy = cy) {
  const before = unproj(sx, sy);
  S.fov = clamp(S.fov * factor, 0.3, 200);
  setView();
  const after = unproj(sx, sy);
  // keep the point under the cursor fixed: rotate the centre by the difference
  const a = vec(...before), b = vec(...after), c = vec(S.ra, S.dec);
  const axis = [b[1] * a[2] - b[2] * a[1], b[2] * a[0] - b[0] * a[2], b[0] * a[1] - b[1] * a[0]];
  const s = Math.hypot(...axis), co = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  if (s > 1e-9) {
    const k = axis.map(x => x / s), ang = Math.atan2(s, co) * -1;
    const cr = [k[1] * c[2] - k[2] * c[1], k[2] * c[0] - k[0] * c[2], k[0] * c[1] - k[1] * c[0]], kd = k[0] * c[0] + k[1] * c[1] + k[2] * c[2];
    const cs = Math.cos(-ang), sn = Math.sin(-ang);
    const v = c.map((x, i) => x * cs + cr[i] * sn + k[i] * kd * (1 - cs));
    [S.ra, S.dec] = toRaDec(v);
  }
  draw(); writeHash();
}

function bindInput() {
  const ptrs = new Map();
  let drag = null, moved = false, pinch = null;
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
    cancelAnimationFrame(S.fly);
    if (ptrs.size === 2) { const [p, q] = [...ptrs.values()]; pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]), fov: S.fov }; drag = null; }
    else { drag = { x: e.offsetX, y: e.offsetY, ra: S.ra, dec: S.dec, v: vec(...unproj(e.offsetX, e.offsetY)) }; moved = false; }
  });
  cv.addEventListener('pointermove', e => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pinch && ptrs.size === 2) {
      const [p, q] = [...ptrs.values()], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      S.fov = clamp(pinch.fov * pinch.d / Math.max(10, d), 0.3, 200); draw(); return;
    }
    if (drag) {
      if (Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) > 3) moved = true;
      if (!moved) return;
      // rotate so the grabbed sky point follows the cursor
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      const k = (S.fov / Math.min(S.W, S.H * 1.6)) * 1.0;
      S.ra = ((drag.ra + dx * k / Math.max(0.15, Math.cos(S.dec * D2R))) % 360 + 360) % 360;
      S.dec = clamp(drag.dec + dy * k, -89.9, 89.9);
      draw();
      return;
    }
    hoverAt(e.offsetX, e.offsetY);
  });
  const up = e => {
    ptrs.delete(e.pointerId);
    if (pinch && ptrs.size < 2) { pinch = null; writeHash(); return; }
    if (drag && !moved) clickAt(e.offsetX, e.offsetY);
    if (drag && moved) writeHash();
    drag = null;
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); drag = null; pinch = null; });
  cv.addEventListener('pointerleave', () => { $('skyTip').hidden = true; if (S.hover) { S.hover = null; draw(); } });
  cv.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.offsetX, e.offsetY); }, { passive: false });
  cv.addEventListener('dblclick', e => zoomAt(0.5, e.offsetX, e.offsetY));
  cv.tabIndex = 0;
  cv.addEventListener('keydown', e => {
    const k = S.fov / 12;
    if (e.key === '+' || e.key === '=') zoomAt(0.8); else if (e.key === '-') zoomAt(1.25);
    else if (e.key === 'ArrowLeft') { S.ra = (S.ra + k / Math.max(0.15, Math.cos(S.dec * D2R)) + 360) % 360; draw(); }
    else if (e.key === 'ArrowRight') { S.ra = (S.ra - k / Math.max(0.15, Math.cos(S.dec * D2R)) + 360) % 360; draw(); }
    else if (e.key === 'ArrowUp') { S.dec = clamp(S.dec + k, -89.9, 89.9); draw(); }
    else if (e.key === 'ArrowDown') { S.dec = clamp(S.dec - k, -89.9, 89.9); draw(); }
    else return;
    e.preventDefault(); writeHash();
  });

  // time brush on the histogram
  const hc = $('skyHist'); let brush = null;
  hc.addEventListener('pointerdown', e => { if (!hist) return; stopPlay(); hc.setPointerCapture(e.pointerId); brush = { a: histMjd(e.clientX), moved: false }; });
  hc.addEventListener('pointermove', e => { if (!brush) return; const b = histMjd(e.clientX); if (Math.abs(b - brush.a) > 0.5) { brush.moved = true; S.range = [Math.min(brush.a, b), Math.max(brush.a, b)]; drawHist(); renderStats(); draw(); } });
  hc.addEventListener('pointerup', () => { if (brush && !brush.moved) { S.range = null; drawHist(); renderStats(); draw(); } brush = null; });
}

function hoverAt(sx, sy) {
  const [ra, dec] = unproj(sx, sy);
  $('skyCursor').textContent = `${fmtRa(ra)}  ${fmtDec(dec)}`;
  const [l, b] = galOf(vec(ra, dec));
  $('skyCursorGal').textContent = `l ${l.toFixed(1)}°  b ${b >= 0 ? '+' : ''}${b.toFixed(1)}°`;
  $('skyCursorCon').textContent = consName(constellationAt(ra, dec));
  const f = footprintAt(sx, sy);
  if (f !== S.hover) { S.hover = f; draw(); }
  const tip = $('skyTip');
  if (f) {
    const b2 = BANDS[f.det - 1];
    tip.innerHTML = `<b>${fmtDay(f.mjd)}</b><span><i class="dot" style="background:${BAND_COL[f.det - 1]}"></i>D${f.det} · ${b2.lo.toFixed(2)}–${b2.hi.toFixed(2)} µm</span><span>${t('skyPass')} ${f.pass + 1}</span>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(sx + 14, S.W - 190)}px`; tip.style.top = `${Math.min(sy + 14, S.H - 70)}px`;
  } else tip.hidden = true;
  cv.style.cursor = f ? 'pointer' : 'grab';
}

function clickAt(sx, sy) {
  const f = footprintAt(sx, sy);
  const obj = nearestNamedObject(sx, sy);
  if (obj) setPick(obj.ra, obj.dec, obj.name);
  else { const [ra, dec] = unproj(sx, sy); setPick(ra, dec, ''); }
  S.fpSel = f || null; renderSelection(); draw();
}

// ------------------------------------------------------------------ panel wiring
const LAYERS = [['mw', 'skyLMw'], ['lines', 'skyLLines'], ['names', 'skyLNames'], ['bounds', 'skyLBounds'], ['grid', 'skyLGrid'], ['ecl', 'skyLEcl'], ['gal', 'skyLGal'], ['starNames', 'skyLStars'], ['messier', 'skyLMessier'], ['targets', 'skyLTargets'], ['fp', 'skyLFp'], ['p9', 'skyLP9'], ['p9orbit', 'skyLP9Orbit'], ['tno', 'skyLTno']];
function syncLayerChecks() { for (const [k] of LAYERS) { const el = document.querySelector(`[data-layer="${k}"]`); if (el) el.checked = S.layers[k]; } }

function buildPanel() {
  $('skyLayers').innerHTML = LAYERS.map(([k, key]) => `<label class="check"><input type="checkbox" data-layer="${k}" ${S.layers[k] ? 'checked' : ''}> <span>${t(key)}</span></label>`).join('');
  for (const el of $('skyLayers').querySelectorAll('[data-layer]')) el.addEventListener('change', () => { S.layers[el.dataset.layer] = el.checked; draw(); });
  $('skyTargets').innerHTML = TARGETS.map(tg => `<button type="button" class="chip" data-t="${tg.id}">${tg.name}</button>`).join('');
  for (const b of $('skyTargets').querySelectorAll('[data-t]')) b.addEventListener('click', () => {
    const tg = TARGETS.find(x => x.id === b.dataset.t);
    setPick(tg.ra, tg.dec, tg.name); flyTo(tg.ra, tg.dec, 8);
  });
  $('skyBandChips').innerHTML = BANDS.map((b, i) => `<button type="button" class="chip band-chip" data-det="${b.det}" aria-pressed="${S.bands.has(b.det)}"><i class="dot" style="background:${BAND_COL[i]}"></i>D${b.det}</button>`).join('');
  for (const b of $('skyBandChips').querySelectorAll('[data-det]')) b.addEventListener('click', () => {
    const d = Number(b.dataset.det);
    S.bands.has(d) ? S.bands.delete(d) : S.bands.add(d);
    if (!S.bands.size) S.bands = new Set([1, 2, 3, 4, 5, 6]);
    for (const c of $('skyBandChips').querySelectorAll('[data-det]')) c.setAttribute('aria-pressed', String(S.bands.has(Number(c.dataset.det))));
    renderStats(); drawHist(); draw();
  });
  renderPick(); renderStats();
}

function bindPanel() {
  $('skySearch').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('skyQ').value.trim(); if (!q) return;
    const st = $('skySearchStatus'); st.textContent = '';
    const c = parseCoords(q);
    if (c) { setPick(c[0], c[1], ''); flyTo(c[0], c[1], Math.min(S.fov, 10)); return; }
    st.textContent = t('skyResolving');
    try {
      const r = await fetch(`/api/resolve?name=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok || !Number.isFinite(j.ra)) throw new Error('not found');
      st.textContent = '';
      setPick(j.ra, j.dec, j.name || q); flyTo(j.ra, j.dec, Math.min(S.fov, 8));
    } catch { st.textContent = t('skyNotFound', { q }); }
  });
  $('skyLink').addEventListener('click', async () => {
    clearTimeout(hashTimer);
    const p = [`sky`, S.ra.toFixed(3), S.dec.toFixed(3), S.fov.toFixed(2)];
    if (S.pick) p.push(S.pick.ra.toFixed(5), S.pick.dec.toFixed(5));
    const url = `${location.origin}${location.pathname}#${p.join('/')}`;
    try { await navigator.clipboard.writeText(url); $('skyLink').textContent = 'Link copied'; } catch { prompt('Copy this link', url); }
    setTimeout(() => { $('skyLink').textContent = 'Copy link'; }, 1800);
  });
  $('skyZoomIn').addEventListener('click', () => zoomAt(0.6));
  $('skyZoomOut').addEventListener('click', () => zoomAt(1 / 0.6));
  $('skyReset').addEventListener('click', () => flyTo(266.4, -29.0, 120));
  $('skySave').addEventListener('click', () => {
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
    const g = c.getContext('2d'); g.drawImage(cv, 0, 0);
    g.font = `${13 * S.dpr}px "Golos Text", system-ui, sans-serif`; g.fillStyle = 'rgba(230,234,242,0.85)'; g.textAlign = 'right';
    g.fillText(`InfraBlink · ${S.fp.length ? 'SPHEREx: NASA/JPL-Caltech/IPAC (IRSA) · ' : ''}Stars: Hipparcos via d3-celestial`, c.width - 12 * S.dpr, c.height - 12 * S.dpr);
    c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `infrablink-sky-${S.ra.toFixed(1)}_${S.dec.toFixed(1)}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
  });
  $('skyLoadFp').addEventListener('click', () => { if (S.pick) { loadFootprints(S.pick.ra, S.pick.dec); flyTo(S.pick.ra, S.pick.dec, 16); } });
  $('skyBlink').addEventListener('click', () => {
    if (!S.pick) return;
    const band = S.fpSel ? S.fpSel.det : 0;
    location.href = `./?ra=${S.pick.ra.toFixed(6)}&dec=${S.pick.dec.toFixed(6)}${band ? `&band=${band}` : ''}`;
  });
  $('skyPlay').addEventListener('click', () => (S.play ? stopPlay() : startPlay()));
  $('skyP9Go').addEventListener('click', () => {
    if (!p9Peak) buildP9();
    S.layers.p9 = S.layers.p9orbit = S.layers.tno = true; syncLayerChecks();
    setPick(p9Peak.ra, p9Peak.dec, 'Most likely Planet Nine region (model peak)'); flyTo(p9Peak.ra, p9Peak.dec, 110);
  });
  window.addEventListener('resize', resize);
  window.addEventListener('langchange', () => { buildPanel(); drawHist(); draw(); });
}

// ------------------------------------------------------------------ entry
let started = false;
export async function openSky() {
  if (!started) {
    started = true;
    cv = $('skyCanvas'); ctx = cv.getContext('2d');
    readHash();
    buildPanel(); bindPanel(); bindInput();
    $('skyLoading').hidden = false;
    try { await loadData(); } catch (e) { console.error(e); $('skyLoading').textContent = t('skyDataFailed'); return; }
    $('skyLoading').hidden = true;
    renderPick();
  }
  requestAnimationFrame(resize);
}
