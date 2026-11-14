// render.js — turn a Float32 sky image into pixels: asinh stretch + colour maps, and the overlay
// (reticle, predicted positions, catalogue stars, compass, scale bar).
// Code written with AI assistance (Claude), reviewed and tested by team Sigma Boys.

function ramp(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, a] = stops[k], [t1, b] = stops[k + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
  }
  return lut;
}

export const CMAPS = {
  // sequential: one hue family, dark -> light
  heat: ramp([[0, [4, 6, 14]], [0.25, [52, 22, 58]], [0.5, [158, 48, 54]], [0.75, [248, 140, 60]], [1, [255, 246, 224]]]),
  gray: ramp([[0, [0, 0, 0]], [1, [255, 255, 255]]]),
  invert: ramp([[0, [255, 255, 255]], [1, [0, 0, 0]]]),
  // diverging: two hues around a neutral dark midpoint (for difference images)
  diff: ramp([[0, [150, 215, 255]], [0.25, [38, 110, 190]], [0.5, [14, 16, 22]], [0.75, [205, 88, 40]], [1, [255, 222, 170]]]),
};

/** Draw `img` (n*n, already background-subtracted) into ImageData.
 *  opts: { vmax, soft, cmap, diverging, bg } — asinh stretch of (value - bg) up to vmax. */
export function paint(ctx, img, n, opts) {
  const { vmax, soft, cmap = 'heat', diverging = false, bg = 0 } = opts;
  const lut = CMAPS[diverging ? 'diff' : cmap] || CMAPS.heat;
  const id = ctx.createImageData(n, n), d = id.data;
  const norm = Math.asinh(vmax / soft) || 1;
  const floor = diverging ? 0 : -1.5 * soft;                // show a little noise below sky
  const nf = Math.asinh((vmax - floor) / soft) || 1;
  for (let p = 0; p < n * n; p++) {
    let v = img[p] - bg;
    if (!Number.isFinite(v)) v = 0;            // masked pixels are drawn at sky level
    let t;
    if (diverging) t = 0.5 + 0.5 * Math.max(-1, Math.min(1, Math.asinh(v / soft) / norm));
    else t = Math.max(0, Math.min(1, Math.asinh((v - floor) / soft) / nf));
    const k = Math.round(t * 255) * 3;
    d[p * 4] = lut[k]; d[p * 4 + 1] = lut[k + 1]; d[p * 4 + 2] = lut[k + 2]; d[p * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

/** Overlay drawn on a separate hi-dpi canvas. `m` maps grid pixel -> canvas px. */
export function drawOverlay(ctx, size, n, scale, items) {
  const s = size / n, m = v => (v + 0.5) * s;
  ctx.clearRect(0, 0, size, size);
  ctx.lineWidth = 1.5; ctx.font = '600 12px "Golos Text", system-ui, sans-serif'; ctx.textBaseline = 'middle';

  if (items.gaia) {
    ctx.strokeStyle = 'rgba(160, 232, 196, 0.75)';
    for (const g of items.gaia) {
      const r = Math.max(3.5, 9 - 0.45 * (g.mag || 15));
      ctx.beginPath(); ctx.arc(m(g.x), m(g.y), r, 0, 6.2832); ctx.stroke();
      if (g.trail) { ctx.beginPath(); ctx.moveTo(m(g.trail[0]), m(g.trail[1])); ctx.lineTo(m(g.x), m(g.y)); ctx.stroke(); }
    }
  }
  if (items.input) {             // where the user's coordinates point
    const x = m(items.input[0]), y = m(items.input[1]), a = 9, b = 22;
    ctx.strokeStyle = 'rgba(230, 234, 242, 0.85)';
    ctx.beginPath();
    ctx.moveTo(x - b, y); ctx.lineTo(x - a, y); ctx.moveTo(x + a, y); ctx.lineTo(x + b, y);
    ctx.moveTo(x, y - b); ctx.lineTo(x, y - a); ctx.moveTo(x, y + a); ctx.lineTo(x, y + b);
    ctx.stroke();
  }
  if (items.track && items.track.length > 1) {   // predicted path across the survey
    ctx.strokeStyle = 'rgba(111, 211, 255, 0.55)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); items.track.forEach((p, i) => (i ? ctx.lineTo(m(p[0]), m(p[1])) : ctx.moveTo(m(p[0]), m(p[1])))); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (items.predicted) {         // where the catalogue says the object is at this date
    const x = m(items.predicted[0]), y = m(items.predicted[1]);
    ctx.strokeStyle = '#6FD3FF'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, 6.2832); ctx.stroke();
    if (items.predictedLabel) { ctx.fillStyle = '#6FD3FF'; ctx.fillText(items.predictedLabel, x + 18, y - 14); }
    ctx.lineWidth = 1.5;
  }
  if (items.measured) {
    const x = m(items.measured[0]), y = m(items.measured[1]);
    ctx.strokeStyle = '#FFD36F'; ctx.beginPath();
    ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
  }
  if (items.pick) {
    const x = m(items.pick[0]), y = m(items.pick[1]);
    ctx.strokeStyle = '#FF8A4C'; ctx.lineWidth = 2;
    ctx.strokeRect(x - 10, y - 10, 20, 20); ctx.lineWidth = 1.5;
  }
  // compass (north up, east left) + scale bar
  ctx.strokeStyle = ctx.fillStyle = 'rgba(230, 234, 242, 0.9)';
  const cx = size - 34, cy = 46;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 26); ctx.moveTo(cx, cy); ctx.lineTo(cx - 26, cy); ctx.stroke();
  ctx.fillText('N', cx - 4, cy - 34); ctx.fillText('E', cx - 40, cy);
  const arcmin = 60 / scale * s;                 // canvas px per arcminute
  const bx = 18, by = size - 22;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + arcmin, by); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
  ctx.moveTo(bx + arcmin, by - 4); ctx.lineTo(bx + arcmin, by + 4); ctx.stroke();
  ctx.fillText('1′', bx + arcmin + 8, by);
}
