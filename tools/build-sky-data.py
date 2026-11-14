#!/usr/bin/env python3
# Builds the compact sky-map data files in ../data from the d3-celestial data set
# (https://github.com/ofrohn/d3-celestial, BSD-3-Clause, (c) Olaf Frohn).
# Star data there come from the Hipparcos / Yale Bright Star catalogues; the Milky Way
# outline and constellation lines/boundaries are also from d3-celestial.
# Usage:  python3 tools/build-sky-data.py /path/to/d3-celestial/data
# Written with AI assistance (Claude), reviewed by team Sigma Boys.
import json, sys, os, math

src = sys.argv[1] if len(sys.argv) > 1 else 'd3-celestial/data'
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
L = lambda f: json.load(open(os.path.join(src, f), encoding='utf-8'))
ra = lambda lon: round(lon % 360, 3)

def stars(maxmag, minmag=-9):
    rows = []
    for f in L('stars.8.json')['features']:
        m = f['properties']['mag']
        if not (minmag < m <= maxmag): continue
        lon, lat = f['geometry']['coordinates']
        try: bv = round(float(f['properties']['bv']), 2)
        except Exception: bv = 0.6
        rows.append([ra(lon), round(lat, 3), round(m, 2), bv, f['id']])
    rows.sort(key=lambda r: r[2])
    return rows

def simplify(ring, tol=0.25):
    res = [ring[0]]
    for p in ring[1:]:
        q = res[-1]
        if abs(p[0] - q[0]) + abs(p[1] - q[1]) >= tol: res.append(p)
    return [[round(x, 2), round(y, 2)] for x, y in res]

names = L('starnames.json')
bright = stars(6.5)
named = {}
for r in bright:
    n = names.get(str(r[4]))
    if n and n.get('name') and r[2] < 3.5: named[r[4]] = n['name']

cons = []
for f in L('constellations.json')['features']:
    p = f['properties']; lon, lat = f['geometry']['coordinates']
    cons.append({'id': f['id'] if 'id' in f else p['desig'], 'name': p['name'], 'ru': p.get('ru', p['en']), 'ra': ra(lon), 'dec': round(lat, 2), 'rank': int(p.get('rank', 3))})
lines = {f['id']: [[[ra(x), round(y, 3)] for x, y in seg] for seg in f['geometry']['coordinates']] for f in L('constellations.lines.json')['features']}
bounds = {}
for f in L('constellations.bounds.json')['features']:
    g = f['geometry']; polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    bounds[f['id']] = [[[round(x, 3), round(y, 3)] for x, y in poly[0]] for poly in polys]
mw = {}
for f in L('mw.json')['features']:
    mw[f['id']] = [[simplify(ring) for ring in poly] for poly in f['geometry']['coordinates']]
messier = [{'id': f['id'], 'alt': f['properties'].get('alt', ''), 'type': f['properties']['type'], 'mag': f['properties']['mag'],
            'ra': ra(f['geometry']['coordinates'][0]), 'dec': round(f['geometry']['coordinates'][1], 3)} for f in L('messier.json')['features']]

sky = {'source': 'd3-celestial (BSD-3-Clause, Olaf Frohn); stars: Hipparcos', 'stars': [r[:4] for r in bright],
       'starIds': [r[4] for r in bright], 'names': named, 'cons': cons, 'lines': lines, 'bounds': bounds, 'mw': mw, 'messier': messier}
json.dump(sky, open(os.path.join(out, 'sky.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
faint = [r[:4] for r in stars(8.0, 6.5)]
json.dump({'stars': faint}, open(os.path.join(out, 'stars8.json'), 'w'), separators=(',', ':'))
print(len(bright), 'bright stars,', len(faint), 'faint stars,', len(named), 'names,', len(cons), 'constellations')
