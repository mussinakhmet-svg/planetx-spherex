// Shared helpers for the tiny same-origin proxies (Vercel serverless functions).
// They exist only because the upstream archives do not send CORS headers.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

export const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

export async function relay(res, url, { type = 'text/plain; charset=utf-8', cache = 3600, timeout = 25000, headers } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'planetx-spherex (NASA Space Apps 2026)', ...(headers || {}) } });
    const body = await r.text();
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', r.ok ? `public, s-maxage=${cache}, max-age=${Math.min(cache, 600)}` : 'no-store');
    res.statusCode = r.ok ? 200 : 502;
    res.end(body);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 504;
    res.end(JSON.stringify({ error: 'upstream request failed', detail: String(e && e.message || e) }));
  } finally { clearTimeout(t); }
}

export function bad(res, msg) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 400;
  res.end(JSON.stringify({ error: msg }));
}
