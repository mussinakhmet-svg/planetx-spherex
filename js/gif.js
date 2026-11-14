// gif.js — a small animated-GIF encoder (per-frame adaptive palette + LZW), no dependencies.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

function quantize(rgba) {
  // popularity quantiser on 5 bits per channel
  const counts = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += 4) counts[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)]++;
  const bins = [];
  for (let b = 0; b < 32768; b++) if (counts[b]) bins.push(b);
  bins.sort((a, b) => counts[b] - counts[a]);
  const top = bins.slice(0, 256);
  const pal = new Uint8Array(256 * 3);
  top.forEach((b, k) => { pal[k * 3] = ((b >> 10) & 31) << 3 | 4; pal[k * 3 + 1] = ((b >> 5) & 31) << 3 | 4; pal[k * 3 + 2] = (b & 31) << 3 | 4; });
  const map = new Int16Array(32768).fill(-1);
  top.forEach((b, k) => { map[b] = k; });
  const idx = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const b = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let k = map[b];
    if (k < 0) {
      let best = 0, bd = Infinity;
      for (let q = 0; q < top.length; q++) {
        const dr = rgba[i] - pal[q * 3], dg = rgba[i + 1] - pal[q * 3 + 1], db = rgba[i + 2] - pal[q * 3 + 2], d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = q; }
      }
      k = map[b] = best;
    }
    idx[p] = k;
  }
  return { pal, idx };
}

function lzw(idx, out) {
  const minCode = 8, clear = 256, eoi = 257;
  out.push(minCode);
  let codeSize = 9, next = 258, cur = 0, bits = 0;
  const block = [];
  const flush = () => { while (block.length) { const n = Math.min(255, block.length); out.push(n, ...block.splice(0, n)); } };
  const emit = c => {
    cur |= c << bits; bits += codeSize;
    while (bits >= 8) { block.push(cur & 255); cur >>>= 8; bits -= 8; if (block.length >= 255) flush(); }
  };
  let dict = new Map();
  emit(clear);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << codeSize) && codeSize < 12) codeSize++; }
    else { emit(clear); dict = new Map(); codeSize = 9; next = 258; }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) block.push(cur & 255);
  flush();
  out.push(0);
}

/** frames: array of ImageData (same size). delay in 1/100 s. Returns Uint8Array. */
export function encodeGif(frames, w, h, delay = 25) {
  const out = [];
  const str = s => { for (const c of s) out.push(c.charCodeAt(0)); };
  const u16 = v => out.push(v & 255, (v >> 8) & 255);
  str('GIF89a'); u16(w); u16(h); out.push(0x70, 0, 0);                       // no global palette
  out.push(0x21, 0xff, 11); str('NETSCAPE2.0'); out.push(3, 1, 0, 0, 0);       // loop forever
  for (const f of frames) {
    const { pal, idx } = quantize(f.data);
    out.push(0x21, 0xf9, 4, 0x04); u16(delay); out.push(0, 0);
    out.push(0x2c); u16(0); u16(0); u16(w); u16(h); out.push(0x87);            // local palette, 256 entries
    for (let i = 0; i < 768; i++) out.push(pal[i]);
    lzw(idx, out);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}
