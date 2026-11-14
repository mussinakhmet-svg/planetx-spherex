// spherex.js — find SPHEREx exposures that cover a sky position, read just the needed pixels
// from NASA's public cloud copy (AWS S3, HTTP Range requests), look up the wavelength of each
// exposure at that position, and re-project everything onto one north-up grid.
//
// Data: SPHEREx Level-2 spectral images, NASA/JPL-Caltech/IPAC, served by NASA/IPAC IRSA.
// Code written with AI assistance (Claude), reviewed and tested by team Sigma Boys.

import { parseHeader, fetchRange, BLOCK } from './fits.js';
import { makeWcs, tanForward, mjdToYear } from './wcs.js';

/** Collections to search. New IRSA releases only need a new name here (or ?collections=a,b in the URL). */
export let COLLECTIONS = ['spherex_dr1', 'spherex_qr3'];
export function setCollections(list) { if (list && list.length) COLLECTIONS = list; }

/** Search endpoint builder. The default goes through our tiny same-origin proxy (IRSA sends no CORS headers). */
export const API = {
  sia: (c, ra, dec, radius) => `/api/sia?collection=${encodeURIComponent(c)}&ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&radius=${radius}`,
};
const S3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
const IBE = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';
export const NPIX = 2040;            // detector is 2040 x 2040 active pixels
export const NATIVE_SCALE = 6.15;    // arcsec per pixel

/** Nominal wavelength coverage of the six detector arrays (µm). */
export const BANDS = [
  { det: 1, lo: 0.75, hi: 1.11 }, { det: 2, lo: 1.10, hi: 1.63 }, { det: 3, lo: 1.63, hi: 2.43 },
  { det: 4, lo: 2.40, hi: 3.83 }, { det: 5, lo: 3.81, hi: 4.43 }, { det: 6, lo: 4.41, hi: 5.01 },
];

// ---------------------------------------------------------------- search

function parseSiaCsv(text, collection) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const cols = lines[0].split(',');
  const ix = n => cols.indexOf(n);
  const iUrl = ix('access_url'), iBand = ix('energy_bandpassname'), iObs = ix('obs_id'),
    iReg = ix('s_region'), iT0 = ix('t_min'), iT1 = ix('t_max'), iExp = ix('t_exptime');
  const out = [];
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    const f = line.split(',');                    // fields we need come before the JSON column
    const url = f[iUrl];
    if (!url || !/\.fits$/.test(url)) continue;
    const key = (line.match(/"key"\s*:\s*"([^"]+)"/) || [])[1];
    const bucket = (line.match(/"bucket_name"\s*:\s*"([^"]+)"/) || [])[1];
    const region = (line.match(/"region"\s*:\s*"([^"]+)"/) || [])[1] || 'us-east-1';
    const s3 = key && bucket ? `https://${bucket}.s3.${region}.amazonaws.com/${key}`
      : url.startsWith(IBE) ? S3 + url.slice(IBE.length) : null;
    const reg = (f[iReg] || '').trim().split(/\s+/).slice(2).map(Number);
    const corners = [];
    for (let i = 0; i + 1 < reg.length && corners.length < 4; i += 2) corners.push([reg[i], reg[i + 1]]);
    const det = Number((f[iBand] || '').replace(/\D/g, '')) || Number((url.match(/_(\d)?D(\d)_spx/) || [])[2]);
    const t0 = Number(f[iT0]), t1 = Number(f[iT1]);
    out.push({
      id: `${f[iObs]}D${det}`, obsId: f[iObs], det, collection,
      mjd: (t0 + t1) / 2, exptime: Number(f[iExp]),
      ibeUrl: url, url: s3 || url, corners,
    });
  }
  return out;
}

/** Find all exposures covering (ra, dec). Returns frames sorted by time, de-duplicated. */
export async function searchFrames(ra, dec, { signal, radius = 0.002, onCollection } = {}) {
  const results = await Promise.all(COLLECTIONS.map(async c => {
    const q = API.sia(c, ra, dec, radius);
    try {
      const r = await fetch(q, { signal });
      if (!r.ok) throw new Error(`IRSA search failed (${r.status})`);
      const frames = parseSiaCsv(await r.text(), c);
      if (onCollection) onCollection(c, frames.length);
      return frames;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (onCollection) onCollection(c, -1, e);
      return [];
    }
  }));
  const seen = new Map();
  for (const list of results) for (const f of list) if (!seen.has(f.id)) seen.set(f.id, f);
  const frames = [...seen.values()].sort((a, b) => a.mjd - b.mjd);
  for (const f of frames) {
    f.year = mjdToYear(f.mjd);
    f.est = estimatePixel(f, ra, dec);
  }
  assignPasses(frames);
  return frames;
}

/** Group exposures into survey passes: a new pass starts after a gap of more than `gapDays`. */
export function assignPasses(frames, gapDays = 30) {
  let pass = 0;
  for (let i = 0; i < frames.length; i++) {
    if (i > 0 && frames[i].mjd - frames[i - 1].mjd > gapDays) pass++;
    frames[i].pass = pass;
  }
  return pass + 1;
}

/** Rough detector pixel of (ra, dec) from the footprint polygon alone (no file access).
 *  Polygon vertices map to pixel corners (0.5,0.5), (2040.5,0.5), (2040.5,2040.5), (0.5,2040.5). */
export function estimatePixel(frame, ra, dec) {
  const c = frame.corners;
  if (!c || c.length < 4) return null;
  const P = c.map(([a, d]) => tanForward(a, d, ra, dec));   // target is at (0, 0)
  let s = 0.5, t = 0.5;
  for (let it = 0; it < 12; it++) {
    const fx = (1 - s) * (1 - t) * P[0][0] + s * (1 - t) * P[1][0] + s * t * P[2][0] + (1 - s) * t * P[3][0];
    const fy = (1 - s) * (1 - t) * P[0][1] + s * (1 - t) * P[1][1] + s * t * P[2][1] + (1 - s) * t * P[3][1];
    const dxs = (1 - t) * (P[1][0] - P[0][0]) + t * (P[2][0] - P[3][0]);
    const dxt = (1 - s) * (P[3][0] - P[0][0]) + s * (P[2][0] - P[1][0]);
    const dys = (1 - t) * (P[1][1] - P[0][1]) + t * (P[2][1] - P[3][1]);
    const dyt = (1 - s) * (P[3][1] - P[0][1]) + s * (P[2][1] - P[1][1]);
    const det = dxs * dyt - dxt * dys;
    if (!det) break;
    s -= (fx * dyt - fy * dxt) / det;
    t -= (fy * dxs - fx * dys) / det;
  }
  return [0.5 + s * NPIX, 0.5 + t * NPIX];
}

// ---------------------------------------------------------------- wavelength lookup (WCS-WAVE)

const waveCache = new Map();

function parseWaveTable(buf) {
  const bytes = new Uint8Array(buf);
  // The file length is a multiple of 2880, so block boundaries line up from the end.
  for (let off = bytes.length - 2 * BLOCK; off >= 0; off -= BLOCK) {
    const tag = new TextDecoder('ascii').decode(bytes.subarray(off, off + 30));
    if (!tag.startsWith('XTENSION= \'BINTABLE\'')) continue;
    const { h, dataOff, complete } = parseHeader(bytes, off);
    if (!complete || h.EXTNAME !== 'WCS-WAVE') continue;
    const cols = {};
    let pos = dataOff;
    const dv = new DataView(buf);
    for (let i = 1; i <= h.TFIELDS; i++) {
      const form = String(h['TFORM' + i]);
      const rep = parseInt(form, 10) || 1, type = form.replace(/\d/g, '');
      const size = { J: 4, E: 4, D: 8, I: 2 }[type];
      const arr = [];
      for (let k = 0; k < rep; k++) {
        const p = pos + k * size;
        arr.push(type === 'J' ? dv.getInt32(p) : type === 'E' ? dv.getFloat32(p) : type === 'D' ? dv.getFloat64(p) : dv.getInt16(p));
      }
      cols[h['TTYPE' + i]] = arr;
      pos += rep * size;
    }
    return { X: cols.X, Y: cols.Y, V: cols.VALUES, nx: cols.X.length, ny: cols.Y.length };
  }
  throw new Error('WCS-WAVE table not found');
}

/** Per-detector wavelength lookup table (cached). It is the last extension in every file. */
export function getWaveTable(frame, signal) {
  const key = `${frame.collection}:${frame.det}`;
  if (!waveCache.has(key)) {
    const p = fetchRange(frame.url, '-11520', null, signal).then(parseWaveTable);
    p.catch(() => waveCache.delete(key));
    waveCache.set(key, p);
  }
  return waveCache.get(key);
}

function bracket(arr, v) {
  let i = 0;
  while (i < arr.length - 2 && v > arr[i + 1]) i++;
  const span = arr[i + 1] - arr[i];
  return [i, span ? Math.min(1, Math.max(0, (v - arr[i]) / span)) : 0];
}

/** Central wavelength and bandwidth (µm) at detector pixel (x, y), bilinear in the control grid. */
export function waveAt(tab, x, y) {
  const [ix, fx] = bracket(tab.X, x), [iy, fy] = bracket(tab.Y, y);
  const v = (i, j, k) => tab.V[k + 2 * (i + tab.nx * j)];
  const interp = k => (1 - fx) * (1 - fy) * v(ix, iy, k) + fx * (1 - fy) * v(ix + 1, iy, k)
    + (1 - fx) * fy * v(ix, iy + 1, k) + fx * fy * v(ix + 1, iy + 1, k);
  return [interp(0), interp(1)];
}

/** Fill frame.lambda / frame.dlambda from the footprint estimate (before any image is read). */
export async function estimateWavelengths(frames, signal) {
  const byDet = new Map();
  for (const f of frames) if (f.est) { const k = `${f.collection}:${f.det}`; if (!byDet.has(k)) byDet.set(k, f); }
  await Promise.all([...byDet.values()].map(f => getWaveTable(f, signal).catch(() => null)));
  for (const f of frames) {
    if (!f.est) continue;
    try {
      const tab = await getWaveTable(f, signal);
      const x = Math.min(NPIX, Math.max(1, f.est[0])), y = Math.min(NPIX, Math.max(1, f.est[1]));
      [f.lambda, f.dlambda] = waveAt(tab, x, y);
    } catch { /* leave undefined */ }
  }
}

// ---------------------------------------------------------------- reading + re-projection

const HEAD_BYTES = 10 * BLOCK;

/** Read one exposure and re-project it onto `grid`. Fills frame.img (Float32Array n*n, MJy/sr,
 *  NaN where there is no data) plus metadata. Costs two small HTTP requests. */
export async function loadFrame(frame, grid, signal) {
  // 1) header (primary + IMAGE extension)
  let head = new Uint8Array(await fetchRange(frame.url, 0, HEAD_BYTES - 1, signal));
  let prim = parseHeader(head, 0), img = parseHeader(head, prim.dataOff);
  if (!img.complete) {
    head = new Uint8Array(await fetchRange(frame.url, 0, 4 * HEAD_BYTES - 1, signal));
    prim = parseHeader(head, 0); img = parseHeader(head, prim.dataOff);
    if (!img.complete) throw new Error('header too long');
  }
  const h = img.h;
  if (h.BITPIX !== -32 || h.NAXIS1 !== NPIX) throw new Error('unexpected image format');
  const wcs = makeWcs(h);
  const n = grid.n;

  // 2) where does the output grid land on the detector?
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const edge = (i, j) => {
    const [ra, dec] = grid.toSky(i, j); const [x, y] = wcs.sky2pix(ra, dec);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  for (let k = 0; k < n; k += Math.max(1, Math.floor(n / 16))) { edge(k, 0); edge(k, n - 1); edge(0, k); edge(n - 1, k); }
  edge(n - 1, n - 1);
  const ya = Math.max(1, Math.floor(y0) - 1), yb = Math.min(NPIX, Math.ceil(y1) + 2);
  const [tx, ty] = wcs.sky2pix(grid.ra0, grid.dec0);
  frame.detX = tx; frame.detY = ty;
  frame.mjd = h['MJD-AVG'] || frame.mjd; frame.year = mjdToYear(frame.mjd);
  frame.dateObs = h['DATE-AVG'] || h['DATE-OBS'];
  frame.exptime = h.XPOSURE || frame.exptime;
  frame.psfFwhm = h.PSF_FWHM;
  frame.quality = {
    l2: h.L2DQAFLG, l1: h.L1DQAFLG, fineAstrometry: h.FINAST === 0,
    aurora: h.AURORA_CONT === true, shuttleGlow: h.SHUTTLE_GLOW_CONT === true, airglow: h.HE_AIRGLOW_CONT === true,
    satStreaks: h['L2 SATSTRKS'] || 0, sband: h.OBS_IN_SBAND === 'True',
  };
  const inside = tx >= 1 && tx <= NPIX && ty >= 1 && ty <= NPIX;
  try {
    const tab = await getWaveTable(frame, signal);
    [frame.lambda, frame.dlambda] = waveAt(tab, Math.min(NPIX, Math.max(1, tx)), Math.min(NPIX, Math.max(1, ty)));
    frame.waveTab = tab;
  } catch { /* keep estimate */ }
  frame.wcs = wcs;

  const out = new Float32Array(n * n).fill(NaN);
  frame.img = out;
  if (yb < ya || x1 < 1 || x0 > NPIX || !inside) { frame.empty = true; frame.coverage = 0; return frame; }

  // 3) the rows we need — one contiguous byte range
  const rowBytes = NPIX * 4;
  const buf = await fetchRange(frame.url, img.dataOff + (ya - 1) * rowBytes, img.dataOff + yb * rowBytes - 1, signal);
  const dv = new DataView(buf);
  const xa = Math.max(1, Math.floor(x0) - 1), xb = Math.min(NPIX, Math.ceil(x1) + 2);
  const w = xb - xa + 1, hh = yb - ya + 1;
  const sub = new Float32Array(w * hh);
  for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) sub[j * w + i] = dv.getFloat32((j * NPIX + (xa - 1 + i)) * 4, false);
  // Bright stars saturate: their cores come as NaN. Fill those (only next to very bright pixels)
  // so a star looks like a star; remember which pixels were filled.
  const st0 = robustStats(sub);
  const sat = new Uint8Array(w * hh);
  const bright = st0.median + 60 * (st0.sigma || 1e-3);
  for (let pass = 0; pass < 3; pass++) {
    const fill = [];
    for (let j = 1; j < hh - 1; j++) for (let i = 1; i < w - 1; i++) {
      const p = j * w + i;
      if (Number.isFinite(sub[p])) continue;
      let mx = -Infinity, nb = 0;               // need several very bright neighbours: a star core, not a lone bad pixel
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v = sub[p + dj * w + di]; if (v > mx) mx = v; if (v > bright) nb++; }
      if (nb >= 3) fill.push(p, mx);
    }
    if (!fill.length) break;
    for (let k = 0; k < fill.length; k += 2) { sub[fill[k]] = fill[k + 1] * 1.15; sat[fill[k]] = 1; }
  }
  frame.native = { data: sub, sat, w, h: hh, xa, ya };

  // 4) bilinear re-projection (NaN-aware), north up / east left
  const mask = new Uint8Array(n * n);
  let good = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [ra, dec] = grid.toSky(i, j);
    const [x, y] = wcs.sky2pix(ra, dec);
    const fx = x - xa, fy = y - ya;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= hh - 1) continue;
    const ax = fx - ix, ay = fy - iy, p = iy * w + ix;
    const ws = [(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay], ps = [p, p + 1, p + w, p + w + 1];
    let sum = 0, wsum = 0, isSat = 0;
    for (let k = 0; k < 4; k++) { const v = sub[ps[k]]; if (Number.isFinite(v)) { sum += ws[k] * v; wsum += ws[k]; if (sat[ps[k]] && ws[k] > 0.2) isSat = 1; } }
    if (wsum > 0.5) { out[j * n + i] = sum / wsum; mask[j * n + i] = isSat; good++; }
  }
  frame.mask = mask;
  frame.coverage = good / (n * n);
  frame.empty = good < 9;
  const st = robustStats(out);
  frame.bg = st.median; frame.sigma = st.sigma;
  return frame;
}

/** Median and robust sigma (1.4826 * MAD) of the finite values, with one clipping pass. */
export function robustStats(arr) {
  let v = Array.from(arr).filter(Number.isFinite);
  if (!v.length) return { median: NaN, sigma: NaN, n: 0 };
  const med = a => { const s = a.slice().sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  let m = med(v), s = 1.4826 * med(v.map(x => Math.abs(x - m)));
  if (s > 0) {
    const c = v.filter(x => Math.abs(x - m) < 3 * s);
    if (c.length > 8) { m = med(c); s = 1.4826 * med(c.map(x => Math.abs(x - m))); v = c; }
  }
  return { median: m, sigma: s, n: v.length };
}

// ---------------------------------------------------------------- stacking + photometry

/** Sigma-clipped mean of background-subtracted frames -> Float32Array (MJy/sr above sky). */
export function stackFrames(frames, n) {
  const out = new Float32Array(n * n).fill(NaN);
  const list = frames.filter(f => f.img && !f.empty && Number.isFinite(f.bg));
  if (!list.length) return out;
  const vals = new Float64Array(list.length);
  for (let p = 0; p < n * n; p++) {
    let m = 0;
    for (const f of list) { const v = f.img[p]; if (Number.isFinite(v)) vals[m++] = v - f.bg; }
    if (!m) continue;
    if (m < 4) { let s = 0; for (let k = 0; k < m; k++) s += vals[k]; out[p] = s / m; continue; }
    const srt = Array.from(vals.subarray(0, m)).sort((a, b) => a - b);
    const med = srt[m >> 1];
    const mad = srt.map(x => Math.abs(x - med)).sort((a, b) => a - b)[m >> 1] * 1.4826 || 1e-9;
    let s = 0, c = 0;
    for (let k = 0; k < m; k++) if (Math.abs(vals[k] - med) <= 3 * mad) { s += vals[k]; c++; }
    out[p] = c ? s / c : med;
  }
  return out;
}

/** Aperture photometry on a grid image at grid pixel (cx, cy).
 *  Returns flux in mJy (sum above local sky) and its rough error. radii in grid pixels. */
export function aperturePhot(img, n, scale, cx, cy, rAp, rIn, rOut) {
  const sky = [];
  let sum = 0, npx = 0;
  const x0 = Math.max(0, Math.floor(cx - rOut)), x1 = Math.min(n - 1, Math.ceil(cx + rOut));
  const y0 = Math.max(0, Math.floor(cy - rOut)), y1 = Math.min(n - 1, Math.ceil(cy + rOut));
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const v = img[j * n + i];
    if (!Number.isFinite(v)) continue;
    const r = Math.hypot(i - cx, j - cy);
    if (r <= rAp) { sum += v; npx++; }
    else if (r >= rIn && r <= rOut) sky.push(v);
  }
  if (npx < 3 || sky.length < 8) return null;
  const st = robustStats(sky);
  const omega = (scale / 206264.806) ** 2;             // sr per grid pixel
  const k = omega * 1e9;                                // MJy/sr * sr -> mJy
  return { flux: (sum - npx * st.median) * k, err: st.sigma * Math.sqrt(npx * (1 + npx / st.n)) * k, npx };
}

/** Intensity-weighted centroid near grid pixel (cx, cy) within radius r. Returns [x, y, peak] or null. */
export function centroid(img, n, cx, cy, r, bg = 0) {
  let best = -Infinity, bx = -1, by = -1;
  const x0 = Math.max(1, Math.floor(cx - r)), x1 = Math.min(n - 2, Math.ceil(cx + r));
  const y0 = Math.max(1, Math.floor(cy - r)), y1 = Math.min(n - 2, Math.ceil(cy + r));
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const v = img[j * n + i];
    if (Number.isFinite(v) && Math.hypot(i - cx, j - cy) <= r && v > best) { best = v; bx = i; by = j; }
  }
  if (bx < 0) return null;
  let sx = 0, sy = 0, sw = 0;
  const rr = 3;
  for (let j = Math.max(0, by - rr); j <= Math.min(n - 1, by + rr); j++) for (let i = Math.max(0, bx - rr); i <= Math.min(n - 1, bx + rr); i++) {
    const v = img[j * n + i] - bg;
    if (Number.isFinite(v) && v > 0) { sx += v * i; sy += v * j; sw += v; }
  }
  return sw > 0 ? [sx / sw, sy / sw, best - bg] : null;
}

/** Centroid of a (possibly saturated) star in the native detector pixels of one exposure,
 *  searched around sky position (ra, dec). Returns { ra, dec, x, y, peak, saturated } or null. */
export function nativeCentroid(frame, ra, dec, search = 2.5) {
  const nt = frame.native;
  if (!nt || !frame.wcs) return null;
  const [x, y] = frame.wcs.sky2pix(ra, dec);
  const fx = x - nt.xa, fy = y - nt.ya;
  let best = -Infinity, bx = -1, by = -1;
  for (let j = Math.max(3, Math.floor(fy - search)); j <= Math.min(nt.h - 4, Math.ceil(fy + search)); j++)
    for (let i = Math.max(3, Math.floor(fx - search)); i <= Math.min(nt.w - 4, Math.ceil(fx + search)); i++) {
      const v = nt.data[j * nt.w + i];
      if (Number.isFinite(v) && v > best) { best = v; bx = i; by = j; }
    }
  if (bx < 0 || !(best - frame.bg > 8 * frame.sigma)) return null;
  let cx = bx, cy = by, saturated = false;
  for (let it = 0; it < 3; it++) {              // iterate a 5x5 window centred on the running centroid
    let sx = 0, sy = 0, sw = 0;
    const ox = Math.round(cx), oy = Math.round(cy);
    for (let j = oy - 2; j <= oy + 2; j++) for (let i = ox - 2; i <= ox + 2; i++) {
      if (i < 0 || j < 0 || i >= nt.w || j >= nt.h) continue;
      const v = nt.data[j * nt.w + i] - frame.bg;
      if (!Number.isFinite(v) || v <= 0) continue;
      if (nt.sat[j * nt.w + i]) saturated = true;
      sx += v * i; sy += v * j; sw += v;
    }
    if (!sw) return null;
    cx = sx / sw; cy = sy / sw;
  }
  const px = cx + nt.xa, py = cy + nt.ya;
  const [cra, cdec] = frame.wcs.pix2sky(px, py);
  return { ra: cra, dec: cdec, x: px, y: py, peak: best - frame.bg, saturated };
}
