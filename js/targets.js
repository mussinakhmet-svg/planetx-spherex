// targets.js — the five test targets named in the challenge statement, with catalogue astrometry.
// Positions are ICRS at the stated epoch; proper motions in mas/yr (pmra includes cos dec);
// parallax in mas. Sources are cited per target. The viewer itself tests them: the predicted
// position is drawn on the real images, so a wrong value shows up as a visible offset.
// Code written with AI assistance (Claude), reviewed and tested by team Sigma Boys.

export const TARGETS = [
  {
    id: 'barnard', name: "Barnard's Star", kind: 'mover',
    ra: 269.44850252, dec: 4.73942088, epoch: 2016.0, pmra: -801.551, pmdec: 10362.394, plx: 546.976,
    source: 'Gaia DR3 4472832130942575872',
    band: 6, fov: 6,   // at 4.4–5.0 µm the star is not saturated, so its position is measured best
    note: { en: 'Fastest proper motion of any star: 10.4″ per year, about 1.7 SPHEREx pixels.', ru: 'Самое быстрое собственное движение среди звёзд: 10,4″ в год, около 1,7 пикселя SPHEREx.', kk: 'Жұлдыздар арасындағы ең жылдам меншікті қозғалыс: жылына 10,4″, шамамен 1,7 SPHEREx пикселі.' },
  },
  {
    id: 'epsindb', name: 'Epsilon Indi B', kind: 'mover',
    ra: 331.04383, dec: -56.78269, epoch: 2000.0, pmra: 3960, pmdec: -2540, plx: 274.8,
    source: 'SIMBAD (eps Ind Ba/Bb), Scholz et al. 2003; proper motion of the eps Indi system',
    band: 2, fov: 9,
    note: { en: 'Two brown dwarfs orbiting the star Epsilon Indi, drifting 4.7″ per year.', ru: 'Два коричневых карлика у звезды Эпсилон Индейца, смещаются на 4,7″ в год.', kk: 'Эпсилон Үндіс жұлдызының жанындағы екі қоңыр ергежейлі, жылына 4,7″ жылжиды.' },
  },
  {
    id: 'w0855', name: 'WISE 0855−0714', kind: 'mover',
    ra: 133.795129, dec: -7.245147, epoch: 2010.5, pmra: -8123.7, pmdec: 673.2, plx: 439.0,
    source: 'Position from the challenge statement (WISE epoch); motion from Kirkpatrick et al. 2021',
    band: 6, fov: 9,
    note: { en: 'The coldest known brown dwarf (about 250 K). Very faint: visible, if at all, only near 4.5–5 µm.', ru: 'Самый холодный известный коричневый карлик (около 250 К). Очень слабый: виден разве что около 4,5–5 мкм.', kk: 'Белгілі ең суық қоңыр ергежейлі (шамамен 250 К). Өте әлсіз: тек 4,5–5 мкм маңында ғана көрінуі мүмкін.' },
  },
  {
    id: 'rwaur', name: 'RW Aurigae', kind: 'variable',
    ra: 76.95642, dec: 30.40142, epoch: 2000.0, pmra: 0, pmdec: 0, plx: 6.1,
    source: 'SIMBAD',
    band: 0, fov: 6,
    note: { en: 'A young T Tauri star that dims unpredictably when dust crosses in front of it.', ru: 'Молодая звезда типа T Тельца, непредсказуемо тускнеет, когда её закрывает пыль.', kk: 'T Торпақ типті жас жұлдыз, шаң бүркегенде күтпеген жерден солғындайды.' },
  },
  {
    id: 'rdra', name: 'R Draconis', kind: 'variable',
    ra: 248.16763, dec: 66.75497, epoch: 2000.0, pmra: 0, pmdec: 0, plx: 1.3,
    source: 'SIMBAD',
    band: 0, fov: 6,
    note: { en: 'A Mira-type giant that pulses with a period of about 246 days.', ru: 'Гигант типа Миры, пульсирует с периодом около 246 дней.', kk: 'Мира типті алып жұлдыз, шамамен 246 күндік периодпен соғады.' },
  },
];

export const targetById = id => TARGETS.find(t => t.id === id);
