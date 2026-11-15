// GET /api/gaia?ra=..&dec=..&radius=..   (radius in degrees, max 0.25)
// Cone search in Gaia DR3, returned as CSV:
// source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag   (reference epoch 2016.0)
// Tries the ESA Gaia Archive first; if it is down, asks the same Gaia DR3 table at CDS VizieR (I/355/gaiadr3).
import { num, bad, getText } from './_util.js';

export default async function handler(req, res) {
  const q = req.query || {};
  const ra = num(q.ra, 0, 360), dec = num(q.dec, -90, 90), radius = num(q.radius ?? 0.06, 0, 0.25);
  if (ra === null || dec === null || radius === null) return bad(res, 'bad parameters');
  const esa = `SELECT TOP 500 source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag FROM gaiadr3.gaia_source ` +
    `WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${radius})) ORDER BY phot_g_mean_mag ASC`;
  const viz = `SELECT TOP 500 Source AS source_id, RA_ICRS AS ra, DE_ICRS AS dec, pmRA AS pmra, pmDE AS pmdec, Plx AS parallax, Gmag AS phot_g_mean_mag ` +
    `FROM "I/355/gaiadr3" WHERE 1=CONTAINS(POINT('ICRS',RA_ICRS,DE_ICRS),CIRCLE('ICRS',${ra},${dec},${radius})) ORDER BY Gmag ASC`;
  const tries = [
    ['ESA Gaia Archive', `https://gea.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(esa)}`, 12000],
    ['CDS VizieR', `https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(viz)}`, 25000],
  ];
  let last = null;
  for (const [name, url, timeout] of tries) {
    const r = await getText(url, timeout);
    if (r.ok && /source_id/i.test(r.body.slice(0, 200))) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('X-Gaia-Source', name);
      res.setHeader('Cache-Control', 'public, s-maxage=86400, max-age=600, stale-while-revalidate=604800');
      res.statusCode = 200;
      // VizieR may quote the header names; normalise them
      return res.end(r.body.replace(/^.*\n/, m => m.replace(/"/g, '')));
    }
    last = `${name}: ${r.status} ${r.body.slice(0, 120)}`;
  }
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 504;
  res.end(JSON.stringify({ error: 'upstream request failed', detail: last }));
}
