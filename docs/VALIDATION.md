# Validation

Everything here was measured on real SPHEREx data (releases DR1 and QR3, read live from NASA/IPAC IRSA)
on 14 November 2026, with the same code that runs on the website. To repeat a test, open the link and wait
for the exposures to load.

## 1. Reading the data correctly

| Check | Result |
|---|---|
| Pixels read with HTTP Range requests from NASA's AWS copy vs. the official IRSA cutout service (58 × 59 px, 3,422 pixels) | Identical, maximum difference 0 |
| Our TAN-SIP sky→pixel transform, round trip pixel→sky→pixel | < 10⁻⁹ pixel |
| Target position from our transform vs. the cutout service's own WCS | Same pixel to 10⁻¹² |
| Wavelength lookup (`WCS-WAVE` table) | Detector 3 gives 1.64–2.43 µm, detector 6 gives 4.41–5.02 µm across the array, matching the published band edges |
| Data volume per exposure | ~0.5–1 MB instead of 62 MB; 1–4 s instead of ~27 s through the cutout service |

## 2. The five challenge targets

Catalogue predictions include proper motion and annual parallax (Sun position from the Astronomical Almanac
low-precision formula). Positions are measured as flux-weighted centroids in native detector pixels of every
exposure, then the median per survey pass is taken.

| Target | Link | Exposures used | Measured | Catalogue | Verdict |
|---|---|---|---|---|---|
| Barnard's Star | `?t=barnard` | 48 at 4.4–5.0 µm, 3 passes, Aug 2025 → Aug 2026 | 10.5″ in 0.99 yr, toward north (E −1.8″, N +10.3″) | 10.3″ (E −0.8″, N +10.3″) | Moves; agrees to 1.0″ (1/6 pixel). At 1.1–1.6 µm the core saturates and the difference grows to 2.1″, so the site uses 4.4–5.0 µm for this star. |
| Epsilon Indi B | `?t=epsindb` | 43 at 1.1–1.6 µm, 4 passes, Apr 2025 → Oct 2026 | 6.1″ in 1.39 yr; per pass (E, N): +1.2/−1.5, +3.9/−2.2, +4.9/−3.7″ | 6.4″; per pass +1.2/−1.4, +3.8/−2.4, +5.1/−3.8″ | Moves; every pass agrees within 0.2″ (1/30 pixel), including the yearly parallax wobble. The pair (about 2 AU apart) is not resolved by SPHEREx. |
| WISE 0855−0714 | `?t=w0855` | 45 at 4.4–5.0 µm | Invisible in single exposures, S/N ≈ 16 in stacked passes; 4.5″ in 0.44 yr | 4.4″ | Detected only thanks to stacking; moves as predicted. |
| RW Aurigae | `?t=rwaur` | 95 at 0.75–5.0 µm, 3 passes, Sep 2025 → Sep 2026 | Last vs first pass at matching wavelengths: ×1.55 ±12% at 0.75–1.1 µm, ×1.34 ±9% at 1.1–1.6 µm, ÷1.77 ±8% at 4.4–5.0 µm. Single points at 0.75 µm: 69 → 112 → 175 mJy | — | Varies, and in opposite directions: brighter in the near-IR, fainter in the mid-IR, over one year. |
| R Draconis | `?t=rdra` | 48 at 0.75–5.0 µm, 3 passes | Saturated core; halo brightness fell ÷2.4 at 1.6–2.4 µm (±7%), ÷2.4 at 4.4–5.0 µm | — | Varies, as expected for a Mira variable with a 246-day period. |

## 3. Controls

* **Calibration of each exposure.** Each exposure is re-aligned on up to 12 unsaturated field stars. The corrections
  found are small (typically 0.1–0.4″), which confirms the SPHEREx pipeline astrometry; the site applies them anyway.

* **Constant stars.** In the R Draconis field, the same variability test on two ordinary field stars gave
  ratios of 0.92–1.08 across wavelength ranges: no change. This sets the 8% systematic floor used by the site.
* **False alarms.** One field star showed a single-band change (÷1.5 at 4.4–5.0 µm). The site now requires a
  change in at least two wavelength ranges before it says "changed", and says "one range only" otherwise.
* **Cosmic rays.** A 443 mJy spike in a 0.5 mJy spectrum (WISE 0855) and a dropout at 4.85 µm (RW Aur) are flagged
  automatically as outliers and left out.

## 4. Limits

* Pixel 6.15″; PSF ≈ 7.4″ FWHM. Shifts below ~2″ are within the noise of one pass.
* Each exposure samples a position at one wavelength, so single-frame brightness changes mix colour and time.
  The variability test compares passes at matching wavelengths only.
* Single-exposure depth (about V ≈ 17 for stars, as measured by another 2026 team, github.com/mateibut/SPHEREx) is far too shallow for a Planet-Nine-like body.
