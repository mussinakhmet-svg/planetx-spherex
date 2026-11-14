// GET /api/resolve?name=Barnard's star
// Resolves an object name with the CDS Sesame service (SIMBAD) and returns
// { name, ra, dec, pmra, pmdec, plx, otype } — coordinates are ICRS at epoch J2000.
import { bad } from './_util.js';

export default async function handler(req, res) {
  const name = String((req.query || {}).name || '').trim();
  if (!name || name.length > 80 || /[<>{}\\]/.test(name)) return bad(res, 'bad name');
  const url = `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?${encodeURIComponent(name)}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const xml = await r.text();
    const tag = n => { const m = xml.match(new RegExp(`<${n}>([^<]*)</${n}>`)); return m ? m[1].trim() : null; };
    const f = n => { const v = tag(n); return v === null || v === '' ? null : Number(v); };
    const ra = f('jradeg'), dec = f('jdedeg');
    res.setHeader('Content-Type', 'application/json');
    if (ra === null || dec === null) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found', name })); }
    res.setHeader('Cache-Control', 'public, s-maxage=86400, max-age=3600');
    res.statusCode = 200;
    res.end(JSON.stringify({ name: tag('oname') || name, ra, dec, pmra: f('pmRA'), pmdec: f('pmDE'), plx: (xml.match(/<plx>\s*<v>([^<]*)<\/v>/) || [])[1] ? Number((xml.match(/<plx>\s*<v>([^<]*)<\/v>/) || [])[1]) : null, otype: tag('otype'), epoch: 2000.0, source: 'SIMBAD via CDS Sesame' }));
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 504;
    res.end(JSON.stringify({ error: 'name resolver unavailable', detail: String(e && e.message || e) }));
  } finally { clearTimeout(t); }
}
