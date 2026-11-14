// GET /api/sia?collection=spherex_dr1&ra=..&dec=..&radius=..
// Relays a Simple Image Access (SIA2) query to NASA/IPAC IRSA and returns its CSV.
import { num, relay, bad } from './_util.js';

export default async function handler(req, res) {
  const q = req.query || {};
  const collection = String(q.collection || '');
  const ra = num(q.ra, 0, 360), dec = num(q.dec, -90, 90), radius = num(q.radius ?? 0.002, 0, 0.5);
  if (!/^spherex_[a-z0-9_]{1,40}$/.test(collection) || ra === null || dec === null || radius === null) return bad(res, 'bad parameters');
  const url = `https://irsa.ipac.caltech.edu/SIA?COLLECTION=${collection}&POS=circle+${ra}+${dec}+${radius}&RESPONSEFORMAT=CSV`;
  return relay(res, url, { type: 'text/csv; charset=utf-8', cache: 1800, timeout: 40000 });
}
