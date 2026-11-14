// wcs.js — World Coordinate System math for SPHEREx images (TAN projection + SIP distortion)
// and helpers for a north-up tangent-plane grid.
// Validated against the official IRSA cutout service: same pixels, same sky positions (docs/VALIDATION.md).
// Code written with AI assistance (Claude), reviewed and tested by team Sigma Boys.

const D = Math.PI / 180;

function sipPoly(h, pre) {
  const ord = h[pre + '_ORDER'] || 0;
  const t = [];
  for (let p = 0; p <= ord; p++) for (let q = 0; q <= ord - p; q++) {
    const c = h[`${pre}_${p}_${q}`];
    if (c) t.push(p, q, c);
  }
  return (u, v) => {
    let s = 0;
    for (let i = 0; i < t.length; i += 3) s += t[i + 2] * (u ** t[i]) * (v ** t[i + 1]);
    return s;
  };
}

/** Gnomonic (TAN) projection of (ra,dec) about (ra0,dec0). All degrees. Returns [xi, eta, cosc]. */
export function tanForward(ra, dec, ra0, dec0) {
  const a = ra * D, d = dec * D, a0 = ra0 * D, d0 = dec0 * D;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = Math.cos(d) * Math.sin(a - a0) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  return [xi / D, eta / D, cosc];
}

/** Inverse gnomonic projection. (xi, eta) in degrees -> [ra, dec] degrees. */
export function tanInverse(xi, eta, ra0, dec0) {
  const x = xi * D, e = eta * D, a0 = ra0 * D, d0 = dec0 * D;
  const den = Math.cos(d0) - e * Math.sin(d0);
  const ra = a0 + Math.atan2(x, den);
  const dec = Math.atan2(Math.sin(d0) + e * Math.cos(d0), Math.hypot(x, den));
  return [((ra / D) % 360 + 360) % 360, dec / D];
}

/** Build a WCS object from a FITS header (RA---TAN-SIP / DEC--TAN-SIP, PC matrix or CD matrix).
 *  Pixel coordinates are FITS 1-based. */
export function makeWcs(h) {
  const crpix = [h.CRPIX1, h.CRPIX2], crval = [h.CRVAL1, h.CRVAL2];
  let m;
  if (h.CD1_1 !== undefined) m = [[h.CD1_1, h.CD1_2 || 0], [h.CD2_1 || 0, h.CD2_2]];
  else {
    const c1 = h.CDELT1 ?? 1, c2 = h.CDELT2 ?? 1;
    m = [[(h.PC1_1 ?? 1) * c1, (h.PC1_2 ?? 0) * c1], [(h.PC2_1 ?? 0) * c2, (h.PC2_2 ?? 1) * c2]];
  }
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  const im = [[m[1][1] / det, -m[0][1] / det], [-m[1][0] / det, m[0][0] / det]];
  const A = sipPoly(h, 'A'), B = sipPoly(h, 'B'), AP = sipPoly(h, 'AP'), BP = sipPoly(h, 'BP');

  const pix2sky = (x, y) => {
    const u = x - crpix[0], v = y - crpix[1];
    const U = u + A(u, v), V = v + B(u, v);
    return tanInverse(m[0][0] * U + m[0][1] * V, m[1][0] * U + m[1][1] * V, crval[0], crval[1]);
  };
  const sky2pix = (ra, dec) => {
    const [xi, eta, cosc] = tanForward(ra, dec, crval[0], crval[1]);
    const U = im[0][0] * xi + im[0][1] * eta, V = im[1][0] * xi + im[1][1] * eta;
    // Start from the header's inverse polynomial, then refine with the exact forward one.
    let u = U + AP(U, V), v = V + BP(U, V);
    for (let i = 0; i < 5; i++) { const fu = u + A(u, v) - U, fv = v + B(u, v) - V; u -= fu; v -= fv; }
    return [u + crpix[0], v + crpix[1], cosc];
  };
  // degrees per pixel (geometric mean of the two axes)
  const pixScale = Math.sqrt(Math.abs(det));
  return { pix2sky, sky2pix, pixScale, crpix, crval };
}

/** A north-up, east-left square grid centred on (ra0, dec0).
 *  n pixels across, `scale` arcsec per pixel. Row 0 is north, column 0 is east. */
export function makeGrid(ra0, dec0, n, scale) {
  const c = (n - 1) / 2, s = scale / 3600;
  return {
    ra0, dec0, n, scale,
    /** grid pixel (i = column, j = row) -> [ra, dec] */
    toSky: (i, j) => tanInverse(-(i - c) * s, (c - j) * s, ra0, dec0),
    /** [ra, dec] -> grid pixel [i, j] (fractional) */
    fromSky: (ra, dec) => { const [xi, eta] = tanForward(ra, dec, ra0, dec0); return [c - xi / s, c - eta / s]; },
  };
}

/** Geocentric Sun vector (AU, equatorial J2000) from the low-precision Astronomical Almanac formula.
 *  Good to about 0.01 degree, far better than needed for parallax at SPHEREx resolution. */
export function sunVector(year) {
  const nd = (year - 2000) * 365.25;                 // days since J2000.0
  const L = (280.460 + 0.9856474 * nd) * D, g = (357.528 + 0.9856003 * nd) * D;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const eps = (23.439 - 0.0000004 * nd) * D;
  return [R * Math.cos(lam), R * Math.cos(eps) * Math.sin(lam), R * Math.sin(eps) * Math.sin(lam)];
}

/** Where a star appears at a given date: linear proper motion plus (if plx is given) annual parallax.
 *  pm in mas/yr (pmra includes cos dec), plx in mas, epochs in Julian years. Returns [ra, dec] degrees.
 *  Parallax matters here: SPHEREx always looks about 90 degrees from the Sun, where the
 *  parallactic shift is largest, and it flips sign between passes six months apart. */
export function propagate(ra, dec, pmra, pmdec, epoch0, epoch, plx = 0) {
  const dt = epoch - epoch0;
  let dAlphaStar = (pmra || 0) * dt, dDelta = (pmdec || 0) * dt;      // mas
  if (plx) {
    const [sx, sy, sz] = sunVector(epoch), X = -sx, Y = -sy, Z = -sz; // Earth = -Sun
    const a = ra * D, d = dec * D;
    dAlphaStar += plx * (X * Math.sin(a) - Y * Math.cos(a));
    dDelta += plx * (X * Math.cos(a) * Math.sin(d) + Y * Math.sin(a) * Math.sin(d) - Z * Math.cos(d));
  }
  return [ra + dAlphaStar / 3.6e6 / Math.cos(dec * D), dec + dDelta / 3.6e6];
}

export const mjdToYear = mjd => 2000 + (mjd - 51544.5) / 365.25;
export function mjdToDate(mjd) { return new Date((mjd - 40587) * 86400000); }

/** Angular separation in arcsec (small angles fine). */
export function sepArcsec(ra1, dec1, ra2, dec2) {
  const [xi, eta] = tanForward(ra1, dec1, ra2, dec2);
  return Math.hypot(xi, eta) * 3600;
}

/** Parse "17 57 48.5 +04 41 36", "17h57m48.5s +4d41m36s", "269.452 4.693", "269.452, -4.693". */
export function parseCoords(text) {
  const t = String(text).trim().replace(/\u2212/g, '-').replace(/[hdms\u00b0\u2032\u2033'":,]/gi, ' ');
  const p = t.split(/\s+/).filter(Boolean);
  if (!p.length || p.some(x => !/^[+-]?\d+(\.\d*)?$/.test(x))) return null;
  const n = p.map(Number);
  const sgn = s => (s.startsWith('-') ? -1 : 1);
  let ra, dec;
  if (n.length === 2) { ra = n[0]; dec = n[1]; }
  else if (n.length === 6) {
    ra = (n[0] + n[1] / 60 + n[2] / 3600) * 15;
    dec = sgn(p[3]) * (Math.abs(n[3]) + n[4] / 60 + n[5] / 3600);
  } else if (n.length === 4) {
    ra = (n[0] + n[1] / 60) * 15;
    dec = sgn(p[2]) * (Math.abs(n[2]) + n[3] / 60);
  } else return null;
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) return null;
  return [ra, dec];
}

export function fmtRa(ra) {
  const h = ra / 15, hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m), s = (m - mm) * 60;
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}m${s.toFixed(2).padStart(5, '0')}s`;
}
export function fmtDec(dec) {
  const sg = dec < 0 ? '−' : '+', a = Math.abs(dec), dd = Math.floor(a), m = (a - dd) * 60, mm = Math.floor(m), s = (m - mm) * 60;
  return `${sg}${String(dd).padStart(2, '0')}°${String(mm).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″`;
}
