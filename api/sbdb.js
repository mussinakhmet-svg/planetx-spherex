// GET /api/sbdb
// Osculating orbital elements of the extreme trans-Neptunian objects whose clustered orbits
// motivate Planet Nine, from the JPL Small-Body Database (SBDB) API. The browser propagates
// them to today's date and draws them on the sky map. The object list is fixed here on purpose.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.

const OBJECTS = ['Sedna', '2012 VP113', '2015 TG387', '2004 VN112', '2010 GB174', '2013 SY99',
  '2014 SR349', '2015 RX245', '2007 TG422', '2013 RF98', '2013 FT28', '2015 BP519'];

async function one(sstr, signal) {
  const r = await fetch(`https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(sstr)}`, { signal, headers: { 'User-Agent': 'planetx-spherex (NASA Space Apps 2026)' } });
  if (!r.ok) throw new Error(`SBDB ${r.status}`);
  const j = await r.json();
  const el = Object.fromEntries((j.orbit && j.orbit.elements || []).map(e => [e.name, Number(e.value)]));
  if (!Number.isFinite(el.a) || !Number.isFinite(el.ma)) throw new Error('no elements');
  return { query: sstr, name: j.object && j.object.fullname ? j.object.fullname.trim() : sstr,
    epoch: Number(j.orbit.epoch), a: el.a, e: el.e, q: el.q, i: el.i, om: el.om, w: el.w, ma: el.ma, n: el.n };
}

export default async function handler(req, res) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const out = await Promise.all(OBJECTS.map(s => one(s, ac.signal).catch(e => ({ query: s, error: String(e.message || e) }))));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=86400, max-age=3600');
    res.statusCode = 200;
    res.end(JSON.stringify({ source: 'JPL Small-Body Database API (ssd-api.jpl.nasa.gov)', objects: out }));
  } catch (e) {
    res.setHeader('Content-Type', 'application/json'); res.statusCode = 504;
    res.end(JSON.stringify({ error: 'JPL SBDB unavailable', detail: String(e && e.message || e) }));
  } finally { clearTimeout(timer); }
}
