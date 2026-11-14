# SPHEREx Blink — blink the infrared sky

**NASA Space Apps Challenge 2026 · Challenge: _Planet X and SPHEREx_ · Team Sigma Boys (Almaty, Kazakhstan)**
Akhmet, Ali, Sergazy, Dimash

> **Live site:** https://planetx-spherex.vercel.app · **Demo slides:** [docs/slides.pdf](docs/slides.pdf)

Pluto was found in 1930 by blinking two photographs of the same sky and noticing one dot that moved.
SPHEREx now photographs the whole sky in 102 infrared colours every six months — more than a billion
objects, far too many for anyone to check by hand. **SPHEREx Blink** lets anyone type a sky position and
watch the real SPHEREx images of that spot change over time, so moving and changing objects give
themselves away.

## Our idea (in our own words)

_Team: write 2–3 sentences here about what you built and for whom._

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
| **Three languages** | English (default), Kazakh, Russian. |

## How it works

1. `api/sia.js` asks NASA/IPAC IRSA (Simple Image Access v2) which exposures cover the position.
2. The browser reads **only the bytes it needs** from each 62 MB SPHEREx file in NASA's public AWS copy (`nasa-irsa-spherex`), using HTTP Range requests: the header, the wavelength table and a strip of rows. A typical exposure costs ~0.5 MB instead of 62 MB, and loads in 1–4 s instead of ~27 s through the cutout service.
3. `js/wcs.js` applies each exposure's own TAN-SIP sky calibration; `js/spherex.js` re-projects onto a north-up grid at half the native pixel (3.075″), looks up the wavelength at the target from the `WCS-WAVE` table, fills saturated star cores, and measures centroids in native pixels.
4. Stacks use a 3σ-clipped mean; photometry is aperture photometry with a local sky annulus.

The serverless functions in `api/` only relay requests to IRSA, SIMBAD (CDS) and the ESA Gaia archive, because those services do not send CORS headers. All image processing runs in the browser.

## Results on the challenge targets

See **[docs/VALIDATION.md](docs/VALIDATION.md)** for numbers, method and limits. In short:

| Target | Result |
|---|---|
| Barnard's Star | Measured 10.5″ of motion in 0.99 yr; catalogue predicts 10.3″ (difference 1/6 pixel). |
| Epsilon Indi B | Measured 6.1″ in 1.39 yr; catalogue predicts 6.4″. Each of four passes agrees within 0.2″, parallax wobble included. |
| WISE 0855−0714 | Detected in stacked 4.4–5.0 µm passes (S/N ≈ 16); measured 4.5″ in 0.44 yr, catalogue 4.4″. |
| RW Aurigae | Within a year it became 1.55× brighter at 0.75–1.1 µm and 1.77× fainter at 4.4–5.0 µm. |
| R Draconis | Saturated core; halo comparison shows ~2.4× fading at 1.6–2.4 µm between passes. Constant field stars agree to 0–8%. |

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

## Data, tools and references

* **SPHEREx Level-2 spectral images** (data releases DR1 and QR3), NASA/JPL-Caltech/IPAC, served by the NASA/IPAC Infrared Science Archive (IRSA): https://irsa.ipac.caltech.edu/Missions/spherex.html — public AWS copy: https://registry.opendata.aws/spherex-qr/
* IRSA SPHEREx documentation and tutorial notebooks: https://caltech-ipac.github.io/spherex-archive-documentation/ , https://caltech-ipac.github.io/irsa-tutorials/spherex/
* **ESA Gaia DR3** (Gaia Collaboration 2023), via the ESA Gaia Archive: https://gea.esac.esa.int/archive/
* **SIMBAD** and the **Sesame** name resolver, CDS Strasbourg: https://simbad.cds.unistra.fr/
* WiseView (Backyard Worlds) as inspiration for the blink interface: http://byw.tools/wiseview
* Target astrometry: Gaia DR3 (Barnard's Star); Kirkpatrick et al. 2021 (WISE 0855−0714); SIMBAD (others).
* Sun position for parallax: low-precision formula from the Astronomical Almanac.
* Fonts: Unbounded and Golos Text (SIL Open Font License), via Google Fonts.
* No third-party code libraries are used.

This project is not affiliated with or endorsed by NASA.

## License

MIT
