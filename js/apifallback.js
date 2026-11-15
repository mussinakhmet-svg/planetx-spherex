// apifallback.js — keeps the site working when an upstream archive (NASA/IPAC IRSA, ESA Gaia, JPL) is down.
// Every /api/... answer the site needs for the built-in examples, missions and Pluto was saved once from the
// real archives into data/apicache/<sha1 of "path?query">.txt. If a live /api call fails, we serve that saved copy.
// Live answers are always tried first; the saved copy is only a safety net. Pixels still come from NASA's cloud.
const live = window.fetch.bind(window);
async function sha1(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function saved(u) {
  try {
    const r = await live(`data/apicache/${await sha1(u.pathname + u.search)}.txt`);
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
