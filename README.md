# InfraBlink — blink the infrared sky

**NASA Space Apps Challenge 2026 · Challenge: _Planet X and SPHEREx_ · Team Sigma Boys (Almaty, Kazakhstan)**
Akhmet, Ali, Sergazy, Dimash

> **Live site:** https://planetx-spherex.vercel.app · **Video lessons:** https://www.youtube.com/@InfraBlink · **Code:** this repository (MIT)

Pluto was found in 1930 by blinking two photographs of the same sky and noticing one dot that moved.
SPHEREx now photographs the whole sky in 102 infrared colours every six months — more than a billion
objects, far too many for anyone to check by hand. **InfraBlink** lets anyone type a sky position and
watch the real SPHEREx images of that spot change over time, so moving and changing objects give
themselves away. It then asks the honest question of the challenge: *could SPHEREx find Planet X?*

## In one minute (for judges)

1. **See a star move.** Open https://planetx-spherex.vercel.app/?t=barnard → tab *Difference*: Barnard's Star leaves a blue (then) / orange (now) pair. The *Did it move?* panel measures 10.5″ in one year; the catalogue predicts 10.3″.
2. **Follow Pluto.** Tab *Track an object* → *Find it in SPHEREx*: NASA's archive lists 230 SPHEREx exposures of Pluto; we find it 1.5″ (a quarter of a pixel) from the JPL prediction.
3. **Planet X, honestly.** Tab *Could SPHEREx see Planet X?*: a typical Planet Nine is 12.6× (2.8 mag) too faint for one SPHEREx pass. Tab *Injection test*: fake movers hidden in the real images are recovered down to AB 18.8 (theory 18.9) with 0.3% false alarms.
4. **Teach it.** Tabs *Practice* (missions with automatic answer checking) and *Classroom* (video lessons, 45-minute lesson plans) — in English, Kazakh and Russian.

| Result | Value |
|---|---|
| Barnard's Star motion, measured vs catalogue | 10.5″ vs 10.3″ in 0.99 yr |
| WISE 0855−0714 (invisible in one exposure) | found by stacking; 4.5″ vs 4.4″ |
| Pluto, SPHEREx vs JPL Horizons | median offset 1.5″ (¼ pixel) |
| Typical Planet Nine (6.2 M⊕, 500 AU) | 12.6× too faint for one pass → not detectable |
| Injection test, 50% completeness | AB 18.77 (predicted 18.93), false alarms 0.3% |
| Data read per field | ~30 MB instead of ~3 GB of full files |

## What it does

| Feature | How it works |
|---|---|
| **Any sky position** | Degrees, sexagesimal (`17h57m48s +04°41′36″`) or an object name (resolved by SIMBAD). |
| **The five challenge targets** | One click: Barnard's Star, Epsilon Indi B, WISE 0855−0714, RW Aurigae, R Draconis. |
| **Every exposure, in time order** | Each exposure is re-projected north-up onto one grid to a fraction of a pixel, then played as an animation. |
| **Survey passes, stacked** | Exposures from one pass (SPHEREx maps the sky every ~6 months) are averaged; faint objects rise out of the noise. |
| **Difference images** | One pass minus another: everything that stayed put disappears, a mover becomes a blue–orange pair. |
| **"Did it move?"** | Click a source: its position is measured in every exposure (each exposure re-aligned on field stars) and compared between passes, with the catalogue prediction (proper motion + parallax) beside it. |
| **Spectrum on the fly** | Each exposure sees a source at a different wavelength (0.75–5 µm), so its exposures line up into a spectrum, one colour per pass. |
| **"Did it change?"** | Passes are compared at matching wavelengths; a change counts only if it is larger than the measured scatter in at least two wavelength ranges. Saturated stars are compared through their halo. |
| **Data quality shown** | Pipeline QA flags, astrometry quality, aurora / airglow / satellite-streak warnings, detector pixel, source file link. |
| **Easy data updates** | Searches the current IRSA releases (`spherex_dr1`, `spherex_qr3`) live. New weekly data appear automatically; a new release name is one line in `js/spherex.js` or `?collections=` in the URL. |
| **Shareable, embeddable URLs** | `?ra=269.452&dec=4.693&fov=6&band=2`, `?t=barnard`, `?name=Vega`. |
| **Gaia DR3 overlay** | ESA Gaia stars, moved to each exposure's date. |
| **Save PNG / GIF** | With the data credit burned in. |
| **Sky map tab** | An interactive map of the whole sky (stars, constellations, Milky Way, RA/Dec grid, ecliptic, galactic plane, Messier objects). Drag, scroll or pinch to zoom, search by name or coordinates, click any spot. |
| **SPHEREx coverage on the map** | For the picked spot the map draws the real footprint of every SPHEREx exposure within 0.5°, coloured by date. Filter by detector band, pick a survey pass, drag a date range on the weekly histogram, or press *Play the survey* to watch the passes build up. Click a footprint for its date, band and ID, then *Blink this spot*. |
| **Could SPHEREx see Planet X?** | Sliders for mass (1–20 M⊕), distance (200–1000 AU), albedo and internal heat. Computes radius (Chen & Kipping 2017), equilibrium and effective temperature (Linder & Mordasini 2016), reflected sunlight plus Planck thermal emission over 0.75–5 µm, and compares the AB magnitude with the published SPHEREx 5σ depth (Crill et al. 2025). Shows DETECTABLE / NOT DETECTABLE, yearly parallax in arcsec and SPHEREx pixels, and every formula under *How we calculated this*. For the nominal Planet Nine the answer is honestly: not detectable, 2.8 mag (12.6×) too faint in one pass. |
| **Injection test: does our method work?** | Plants fake moving point sources (Gaussian with the PSF width measured from field stars) into the real stacked SPHEREx passes of the loaded field, runs the site's own search (late − early difference, matched filter on both lobes of the dipole, 5σ each) and reports FOUND / NOT FOUND. A completeness grid (brightness × shift, 20+ trials per cell) and curve show how faint and how slow a mover can be before we miss it; the same detector on empty sky gives the false-alarm rate. |
| **Where could Planet X be? (sky map layers)** | A probability glow for Planet Nine's position, made by sampling 60 000 orbits from the Brown & Batygin (2021) fit (a, q, i, Ω, ϖ) and placing the planet at a random time on each; its nominal orbit as a dashed line; and today's positions of 12 extreme TNOs (Sedna, 2012 VP113, Leleākūhonua and others) from JPL Small-Body Database elements propagated with Kepler motion. Every assumption is listed under *How we calculated this*; click anywhere and *Blink this spot*. |
| **Spectral fingerprint** | Builds the 0.75–5 µm spectrum of the selected source from every exposure, binned into ~100 SPHEREx-like channels. Photometry is forced PSF fitting of the source together with all Gaia DR3 neighbours within 40″ (SPHEREx pixels are 6″, so neighbours otherwise leak in); saturated cores are measured from the halo, calibrated on field stars in the same exposure. A χ² fit to six schematic templates (G star, M dwarf, cold methane brown dwarf, galaxy, asteroid, cold methane planet) gives "Most likely: … (p %)". |
| **Track a solar-system object** | Pick Pluto (or Makemake, Haumea, Eris, Sedna, Vesta, or type any asteroid/comet). IRSA's Moving Object Search Tool (MOST, ephemerides from JPL Horizons) lists every SPHEREx exposure that caught it; each exposure is cut out around the predicted position so the body stays put while stars stream past. A per-pass median of these cut-outs ("shift-and-stack along the orbit") removes the stars. We report the offset from the JPL prediction and the detection S/N, and plot the body's path with its parallax loops. |
| **Practice missions** | Student missions on real fields (find the fastest star, the invisible brown dwarf, the brown-dwarf pair, the star that changed). The field opens without naming the target; the student clicks a source and the site checks it against the true position at the exposure dates. Teachers copy ready mission links or build their own from any field and send one link to the class. |
| **Classroom** | Ten video lessons (six for students, four for teachers) and lesson plans (goals, 45-minute steps, a matching class mission). Videos are on the team's YouTube channel https://www.youtube.com/@InfraBlink and play inside the site; add one by putting its YouTube ID into `data/lessons.json`. |
| **Share what you found** | Every view is a link: the Blink viewer link includes the field, band and the source you clicked (`&pick=ra,dec`); the sky map has *Copy link* with its view and picked spot; missions are links too. |
| **Three languages** | English (default), Kazakh, Russian. |

## How it works

1. `api/sia.js` asks NASA/IPAC IRSA (Simple Image Access v2) which exposures cover the position.
2. The browser reads **only the bytes it needs** from each 62 MB SPHEREx file in NASA's public AWS copy (`nasa-irsa-spherex`), using HTTP Range requests: the header, the wavelength table and a strip of rows. A typical exposure costs ~0.5 MB instead of 62 MB, and loads in 1–4 s instead of ~27 s through the cutout service.
3. `js/wcs.js` applies each exposure's own TAN-SIP sky calibration; `js/spherex.js` re-projects onto a north-up grid at half the native pixel (3.075″), looks up the wavelength at the target from the `WCS-WAVE` table, fills saturated star cores, and measures centroids in native pixels.
4. Stacks use a 3σ-clipped mean; photometry is aperture photometry with a local sky annulus.

The serverless functions in `api/` only relay requests to IRSA, SIMBAD (CDS), JPL and Gaia DR3 (ESA Gaia Archive, or the same table at CDS VizieR when ESA is down), because those services do not send CORS headers. All image processing runs in the browser.

**Works when an archive is down.** Public archives sometimes go offline for hours. For the built-in examples, missions and Pluto, `data/apicache/` holds a saved copy of every archive answer the site needs (`js/apifallback.js` uses it only when the live request fails). The pixels themselves always come live from NASA's public cloud copy.

## Results on the challenge targets

See **[docs/VALIDATION.md](docs/VALIDATION.md)** for numbers, method and limits. In short:

| Target | Result |
|---|---|
| Barnard's Star | Measured 10.5″ of motion in 0.99 yr; catalogue predicts 10.3″ (difference 1/6 pixel). |
| Epsilon Indi B | Measured 6.1″ in 1.39 yr; catalogue predicts 6.4″. Each of four passes agrees within 0.2″, parallax wobble included. |
| WISE 0855−0714 | Detected in stacked 4.4–5.0 µm passes (S/N ≈ 16); measured 4.5″ in 0.44 yr, catalogue 4.4″. |
| RW Aurigae | Within a year it became 1.55× brighter at 0.75–1.1 µm and 1.77× fainter at 4.4–5.0 µm. |
| R Draconis | Saturated core; halo comparison shows ~2.4× fading at 1.6–2.4 µm between passes. Constant field stars agree to 0–8%. |
| Pluto | IRSA MOST lists 230 SPHEREx exposures; found in 25 of 38 read, median 1.5″ from the JPL Horizons prediction. |
| Injection test (Barnard field) | PSF 12.2″; 50% completeness at AB 18.77 vs 18.93 predicted from the published depth; false alarms 0.3%. |

## Honest limits

* One SPHEREx pixel is 6.15″. Shifts under ~⅓ pixel are measured, not seen by eye.
* Each exposure sees a spot at a single wavelength; brightness differences between single frames are partly colour. Compare stacked passes.
* A Planet-Nine-like body is several magnitudes fainter than a single exposure can detect. The tool demonstrates the method on known movers; it does not claim a discovery.

## Run it locally

Requires Node.js 20+, no other dependencies:

```
node dev.mjs
# open http://localhost:5173
```

Deploy: import the repository into Vercel (no build step, no settings needed).

## Use of AI

The team chose the challenge, defined the idea, the features and the scientific checks, and tested every result.
The code (JavaScript, HTML, CSS) and the interface text were written with the help of an AI assistant
(Claude, by Anthropic); each source file says so in its header. The images shown are real SPHEREx data, not AI-generated.
The 3D planet in the background is drawn by our own shader code, not generated by an image model.
The video lessons use our own screen recordings of the site and real SPHEREx data; the narration is an AI-generated voice
(Kokoro text-to-speech), and the scripts were drafted with Claude and checked by the team. No team member under 18 appears or is heard in any video.

## Data, tools and references

* **SPHEREx Level-2 spectral images** (data releases DR1 and QR3), NASA/JPL-Caltech/IPAC, served by the NASA/IPAC Infrared Science Archive (IRSA): https://irsa.ipac.caltech.edu/Missions/spherex.html — public AWS copy: https://registry.opendata.aws/spherex-qr/
* IRSA SPHEREx documentation and tutorial notebooks: https://caltech-ipac.github.io/spherex-archive-documentation/ , https://caltech-ipac.github.io/irsa-tutorials/spherex/
* **ESA Gaia DR3** (Gaia Collaboration 2023), via the ESA Gaia Archive: https://gea.esac.esa.int/archive/ , with CDS VizieR (catalogue I/355/gaiadr3) as a fallback: https://vizier.cds.unistra.fr/
* **SIMBAD** and the **Sesame** name resolver, CDS Strasbourg: https://simbad.cds.unistra.fr/
* WiseView (Backyard Worlds) as inspiration for the blink interface: http://byw.tools/wiseview
* Target astrometry: Gaia DR3 (Barnard's Star); Kirkpatrick et al. 2021 (WISE 0855−0714); SIMBAD (others).
* Sun position for parallax: low-precision formula from the Astronomical Almanac.
* Fonts: Unbounded and Golos Text (SIL Open Font License), via Google Fonts.
* **Sky map background:** star positions, magnitudes and colours from the Hipparcos catalogue, the Milky Way outline, constellation lines and boundaries, and Messier objects, all from the **d3-celestial** data set by Olaf Frohn (BSD-3-Clause): https://github.com/ofrohn/d3-celestial — converted to `data/sky.json` and `data/stars8.json` by `tools/build-sky-data.py`. Only the data are used, not the d3-celestial code.
* **Planet X physics:** Brown, M. E. & Batygin, K. 2021, *The Orbit of Planet Nine*, AJ 162, 219 (arXiv:2108.09868); Linder, E. F. & Mordasini, C. 2016, *Evolution and magnitudes of candidate Planet Nine*, A&A 589, A134 (arXiv:1602.07465); Chen, J. & Kipping, D. 2017, *Probabilistic Forecasting of the Masses and Radii of Other Worlds*, ApJ 834, 17 (arXiv:1603.08614).
* **Moving Object Search Tool (MOST)**, NASA/IPAC IRSA, https://irsa.ipac.caltech.edu/applications/MOST/ (proxied by `api/most.js`), with ephemerides from **JPL Horizons**.
* **Extreme TNO orbits:** JPL Small-Body Database API, https://ssd-api.jpl.nasa.gov/doc/sbdb.html (proxied by `api/sbdb.js`).
* **SPHEREx sensitivity:** Crill, B. P. et al. 2025, *The SPHEREx Sky Simulator*, ApJS 281, 10 (arXiv:2505.24856): 5σ point-source depth AB 18.5–19 (0.75–3.8 µm) and 16.6–18 (3.8–5 µm) per spectral channel.
* Equatorial-to-galactic rotation: J2000 matrix from the Hipparcos catalogue introduction (ESA 1997).
* Video narration: Kokoro-82M text-to-speech model (Apache-2.0), https://huggingface.co/hexgrad/Kokoro-82M ; videos assembled with FFmpeg.
* No third-party code libraries are used on the site.

This project is not affiliated with or endorsed by NASA.

## License

MIT
