// GET /api/gaia?ra=..&dec=..&radius=..   (radius in degrees, max 0.25)
// Relays a cone search to the ESA Gaia Archive (Gaia DR3) and returns CSV:
// source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag   (reference epoch 2016.0)
import { num, relay, bad } from './_util.js';

export default async function handler(req, res) {
  const q = req.query || {};
  const ra = num(q.ra, 0, 360), dec = num(q.dec, -90, 90), radius = num(q.radius ?? 0.06, 0, 0.25);
  if (ra === null || dec === null || radius === null) return bad(res, 'bad parameters');
  const adql = `SELECT TOP 500 source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag FROM gaiadr3.gaia_source ` +
    `WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${radius})) ORDER BY phot_g_mean_mag ASC`;
  const url = `https://gea.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(adql)}`;
  return relay(res, url, { type: 'text/csv; charset=utf-8', cache: 86400, timeout: 30000 });
}
