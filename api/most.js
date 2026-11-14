// GET /api/most?naif=999&begin=2025-05-01&end=2026-12-31      (NAIF ID, e.g. 999 = Pluto)
// GET /api/most?name=Bamberga&begin=...&end=...               (asteroid / comet name or number)
// Relays NASA/IPAC IRSA's Moving Object Search Tool (MOST): it computes the object's ephemeris (JPL
// Horizons) and returns every SPHEREx exposure that covered it, with the predicted position in each.
// Code written with AI assistance (Claude), reviewed by team Sigma Boys.
import { relay, bad } from './_util.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  const q = req.query || {};
  const begin = String(q.begin || '2025-05-01'), end = String(q.end || new Date().toISOString().slice(0, 10));
  if (!DATE.test(begin) || !DATE.test(end)) return bad(res, 'bad dates');
  const p = new URLSearchParams({ catalog: 'spherex', output_mode: 'Brief', obs_begin: begin.replace(/-/g, ' '), obs_end: end.replace(/-/g, ' ') });
  if (q.naif !== undefined) {
    if (!/^-?\d{1,9}$/.test(String(q.naif))) return bad(res, 'bad NAIF ID');
    p.set('input_type', 'naifid_input'); p.set('obj_naifid', String(q.naif));
  } else {
    const name = String(q.name || '').trim();
    if (!name || name.length > 40 || !/^[\w\s\-/().:'+]+$/.test(name)) return bad(res, 'bad object name');
    p.set('input_type', 'name_input'); p.set('obj_name', name);
  }
  const url = `https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?${p.toString().replace(/%20/g, '+')}`;
  return relay(res, url, { type: 'text/plain; charset=utf-8', cache: 21600, timeout: 55000 });
}
