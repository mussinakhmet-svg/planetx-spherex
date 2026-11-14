// fits.js — minimal FITS reader for SPHEREx Level-2 spectral images.
// Reads headers and small byte ranges over HTTP (Range requests), so the browser never
// downloads a whole ~62 MB file.
// Code written with AI assistance (Claude), reviewed and tested by team Sigma Boys.

export const BLOCK = 2880;
const ascii = new TextDecoder('ascii');

/** Parse one FITS header starting at byte offset `off`.
 *  Returns { h: {KEY: value}, dataOff, complete }.  HIERARCH cards are supported. */
export function parseHeader(bytes, off = 0) {
  const h = {};
  let end = false;
  while (!end && off + BLOCK <= bytes.length) {
    for (let i = 0; i < 36; i++) {
      const c = ascii.decode(bytes.subarray(off + i * 80, off + i * 80 + 80));
      if (c.startsWith('END') && c.slice(3).trim() === '') { end = true; break; }
      let k, v;
      if (c.startsWith('HIERARCH')) {
        const e = c.indexOf('=');
        if (e < 0) continue;
        k = c.slice(9, e).trim(); v = c.slice(e + 1);
      } else if (c[8] === '=') {
        k = c.slice(0, 8).trim(); v = c.slice(10);
      } else continue;
      v = v.trim();
      if (v[0] === "'") {
        v = v.slice(1, v.indexOf("'", 1)).trim();
      } else {
        v = v.split('/')[0].trim();
        if (v === 'T') v = true;
        else if (v === 'F') v = false;
        else { const n = Number(v); if (v !== '' && !Number.isNaN(n)) v = n; }
      }
      h[k] = v;
    }
    off += BLOCK;
  }
  return { h, dataOff: off, complete: end };
}

/** Size in bytes (padded to 2880) of the data unit described by header h. */
export function dataSize(h) {
  const naxis = h.NAXIS || 0;
  if (!naxis) return 0;
  let n = 1;
  for (let i = 1; i <= naxis; i++) n *= h['NAXIS' + i];
  const bytes = Math.abs(h.BITPIX) / 8 * (h.GCOUNT || 1) * ((h.PCOUNT || 0) + n);
  return Math.ceil(bytes / BLOCK) * BLOCK;
}

let netBytes = 0, netRequests = 0;
export function netStats() { return { bytes: netBytes, requests: netRequests }; }

/** Fetch an inclusive byte range. `range` may also be a suffix like '-11520'. Retries twice. */
export async function fetchRange(url, start, end, signal) {
  const range = typeof start === 'string' ? `bytes=${start}` : `bytes=${start}-${end}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { Range: range }, signal });
      if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      netBytes += buf.byteLength; netRequests++;
      return buf;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
      await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Run async jobs with a concurrency limit. `worker(item, index)`; errors are passed to onError. */
export async function pool(items, limit, worker, onError) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      try { await worker(items[i], i); }
      catch (e) { if (onError) onError(e, items[i], i); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
