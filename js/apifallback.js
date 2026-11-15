// apifallback.js — keeps the site working when an upstream archive (NASA/IPAC IRSA, ESA Gaia, JPL) is down.
// Every /api/... answer the site needs for the built-in examples, missions and Pluto was saved once from the
// real archives into data/apicache/ (see keyOf below). If a live /api call fails, we serve that saved copy.
// Live answers are always tried first; the saved copy is only a safety net. Pixels still come from NASA's cloud.
const live = window.fetch.bind(window);
async function sha1(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
// Archive searches for a position are keyed by the position rounded to 0.01°, so a target whose catalogue
// position moves a little from day to day (proper motion) still finds its saved answer.
async function keyOf(u) {
  const q = u.searchParams;
  if (u.pathname === '/api/sia' && q.get('ra') && q.get('dec'))
    return `sia_${q.get('collection')}_${(+q.get('ra')).toFixed(2)}_${(+q.get('dec')).toFixed(2)}_${q.get('radius')}`;
  if (u.pathname === '/api/most' && q.get('naif')) return `most_${q.get('naif')}`;
  if (u.pathname === '/api/gaia' && q.get('ra') && q.get('dec'))
    return `gaia_${(+q.get('ra')).toFixed(3)}_${(+q.get('dec')).toFixed(3)}_${q.get('radius')}`;
  return await sha1(u.pathname + u.search);
}
async function saved(u) {
  try {
    const r = await live(`data/apicache/${await keyOf(u)}.txt`);
    if (!r.ok) return null;
    window.__apiFallbackUsed = (window.__apiFallbackUsed || 0) + 1;
    return new Response(await r.text(), { status: 200, headers: { 'Content-Type': r.headers.get('Content-Type') || 'text/plain', 'X-From-Snapshot': '1' } });
  } catch { return null; }
}
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input && input.url;
  let u = null;
  try { u = new URL(url, location.href); } catch {}
  if (!u || u.origin !== location.origin || !u.pathname.startsWith('/api/')) return live(input, init);
  try {
    const r = await live(input, init);
    if (r.ok) return r;
    return (await saved(u)) || r;
  } catch (e) {
    const s = await saved(u); if (s) return s;
    throw e;
  }
};
