'use strict';

// Erkennung von nachlassender Leistung über die Zeit.
//
// Ein Ertragsrückgang ist aus den Rohzahlen kaum zu sehen, weil der Ertrag ohnehin stark mit der
// Jahreszeit schwankt: ein schwacher Juli liefert immer noch mehr als ein guter Februar. Deshalb
// wird gegen eine Referenz normiert – zwei Verfahren, die sich gegenseitig stützen:
//
//   1. Monats-Soll vom Standort (PVGIS-Monatswerte je kWp, Klimamittel). Das erkennt auch einen
//      langsamen, dauerhaften Rückgang (Verschmutzung, Alterung, zugewachsene Bäume, defekter
//      String), weil die Referenz von aussen kommt und nicht mit der Anlage altert.
//   2. Vergleich mit dem gleichen Monat des Vorjahres aus den eigenen Daten. Das braucht keine
//      Online-Daten, benötigt aber mehr als zwölf Monate Messhistorie.
//
// Wetter bleibt die grosse Unschärfe: ein einzelner trüber Monat kann 30% unter dem Klimamittel
// liegen, ohne dass etwas defekt ist. Darum wird ein Befund erst gemeldet, wenn MEHRERE Monate
// in Folge unter der Schwelle liegen – ein einzelner Ausreisser gilt nur als Beobachtung.

const round = (n, d = 1) => {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** Monatssummen der Erzeugung aus dem Stundenprofil (nur vollständig erfasste Monate). */
function monthlyGeneration(gen, startMs) {
  const buckets = new Map(); // 'YYYY-MM' -> { kwh, hours, tage:Set }
  for (let i = 0; i < gen.length; i++) {
    const d = new Date(startMs + i * 3600000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let b = buckets.get(key);
    if (!b) {
      b = { key, jahr: d.getFullYear(), monat: d.getMonth(), kwh: 0, hours: 0, tage: new Set() };
      buckets.set(key, b);
    }
    b.kwh += gen[i] || 0;
    b.hours++;
    b.tage.add(d.getDate());
  }
  const tageImMonat = (jahr, monat) => new Date(jahr, monat + 1, 0).getDate();
  return [...buckets.values()]
    .map((b) => ({
      key: b.key,
      jahr: b.jahr,
      monat: b.monat,
      kwh: round(b.kwh, 1),
      abdeckung: round((b.tage.size / tageImMonat(b.jahr, b.monat)) * 100, 0),
      vollstaendig: b.tage.size >= tageImMonat(b.jahr, b.monat) - 1,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

const MONAT_NAME = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/**
 * @param {object} o
 *   generation: number[]           Stundenwerte
 *   startMs: number                Start des Rasters
 *   kwp: number|null
 *   sollMonatlichKwhPerKwp?: number[]  PVGIS-Monatswerte je kWp (Index 0 = Januar)
 *   schwelleProzent?: number       ab wann ein Monat als schwach gilt (Standard 80%)
 *   minMonate?: number             wie viele schwache Monate in Folge einen Befund ergeben
 */
function detectPerformanceDrop(o = {}) {
  const gen = o.generation || [];
  const startMs = o.startMs;
  const kwp = Number(o.kwp) || null;
  const soll = o.sollMonatlichKwhPerKwp && o.sollMonatlichKwhPerKwp.length === 12 ? o.sollMonatlichKwhPerKwp : null;
  const schwelle = o.schwelleProzent != null ? o.schwelleProzent : 80;
  const minMonate = o.minMonate != null ? o.minMonate : 2;

  const result = { monate: [], befunde: [], verfahren: [], ok: true };
  if (!gen.length || startMs == null) {
    result.ok = false;
    result.grund = 'Keine Stundendaten vorhanden.';
    return result;
  }

  const monate = monthlyGeneration(gen, startMs).filter((m) => m.abdeckung >= 90);
  if (!monate.length) {
    result.ok = false;
    result.grund = 'Kein vollständig erfasster Monat vorhanden – für einen Vergleich sind mindestens ganze Monate nötig.';
    return result;
  }

  // --- Verfahren 1: gegen das Standort-Klimamittel (PVGIS) ---
  if (soll && kwp) {
    result.verfahren.push('Monatsvergleich mit dem Standort-Klimamittel (PVGIS)');
    for (const m of monate) {
      const erwartet = soll[m.monat] * kwp;
      m.erwartetKwh = round(erwartet, 0);
      m.quoteSoll = erwartet > 0 ? round((m.kwh / erwartet) * 100, 0) : null;
    }
  } else if (!kwp) {
    result.verfahren.push('Standortvergleich nicht möglich: Modulleistung (kWp) unbekannt');
  } else {
    result.verfahren.push('Standortvergleich nicht möglich: keine PVGIS-Monatswerte verfügbar (kein Internet?)');
  }

  // --- Verfahren 2: gegen denselben Monat im Vorjahr (eigene Daten) ---
  const byKey = new Map(monate.map((m) => [m.key, m]));
  let vorjahrVerfuegbar = false;
  for (const m of monate) {
    const vjKey = `${m.jahr - 1}-${String(m.monat + 1).padStart(2, '0')}`;
    const vj = byKey.get(vjKey);
    if (vj && vj.kwh > 0) {
      vorjahrVerfuegbar = true;
      m.vorjahrKwh = vj.kwh;
      m.quoteVorjahr = round((m.kwh / vj.kwh) * 100, 0);
    }
  }
  if (vorjahrVerfuegbar) result.verfahren.push('Vergleich mit dem gleichen Monat des Vorjahres');

  result.monate = monate;

  // --- Befunde: zusammenhängende schwache Phasen ---
  const schwach = (m) => (m.quoteSoll != null ? m.quoteSoll < schwelle : m.quoteVorjahr != null ? m.quoteVorjahr < schwelle : false);
  const bewertbar = monate.filter((m) => m.quoteSoll != null || m.quoteVorjahr != null);
  let lauf = [];
  const phasen = [];
  for (const m of bewertbar) {
    if (schwach(m)) lauf.push(m);
    else {
      if (lauf.length) phasen.push(lauf);
      lauf = [];
    }
  }
  if (lauf.length) phasen.push(lauf);

  for (const ph of phasen) {
    const quoten = ph.map((m) => m.quoteSoll ?? m.quoteVorjahr);
    const mittel = round(quoten.reduce((a, b) => a + b, 0) / quoten.length, 0);
    const labels = ph.map((m) => `${MONAT_NAME[m.monat]} ${m.jahr}`);
    const laufend = ph[ph.length - 1] === bewertbar[bewertbar.length - 1];
    if (ph.length >= minMonate) {
      result.befunde.push({
        art: 'leistungsabfall',
        schwere: mittel < 60 ? 'kritisch' : 'auffällig',
        monate: labels,
        mittlereQuote: mittel,
        laufend,
        text:
          `${ph.length} Monate in Folge unter dem Erwartungswert (${labels.join(', ')}), im Mittel nur ${mittel}%. ` +
          (laufend ? 'Der Rückgang hält bis zum aktuellen Monat an. ' : 'Danach hat sich der Ertrag wieder erholt. ') +
          'Typische Ursachen in dieser Reihenfolge prüfen: Verschmutzung der Module, neue Verschattung ' +
          '(gewachsene Bäume, Aufbauten), ausgefallener String oder Wechselrichter-Fehler, defekte Bypass-Dioden. ' +
          'Ein einzelner trüber Monat erklärt das nicht mehr.',
      });
    } else {
      result.befunde.push({
        art: 'beobachtung',
        schwere: 'Hinweis',
        monate: labels,
        mittlereQuote: mittel,
        laufend,
        text: `${labels.join(', ')} lag bei ${mittel}% des Erwartungswerts. Ein einzelner Monat kann wetterbedingt sein – wird beobachtet.`,
      });
    }
  }

  // --- Langfristiger Trend über alle bewertbaren Monate ---
  if (bewertbar.length >= 6) {
    const q = bewertbar.map((m) => m.quoteSoll ?? m.quoteVorjahr);
    const ersteHaelfte = q.slice(0, Math.floor(q.length / 2));
    const zweiteHaelfte = q.slice(Math.ceil(q.length / 2));
    const mw = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const diff = round(mw(zweiteHaelfte) - mw(ersteHaelfte), 0);
    result.trend = { aenderungProzentpunkte: diff, frueher: round(mw(ersteHaelfte), 0), zuletzt: round(mw(zweiteHaelfte), 0) };
    if (diff <= -10) {
      result.befunde.push({
        art: 'trend',
        schwere: diff <= -20 ? 'kritisch' : 'auffällig',
        text:
          `Über den Betrachtungszeitraum hat die Leistung nachgelassen: in der ersten Hälfte erreichte die Anlage ` +
          `${round(mw(ersteHaelfte), 0)}% des Erwartungswerts, in der zweiten nur noch ${round(mw(zweiteHaelfte), 0)}% ` +
          `(${diff} Prozentpunkte). Das spricht für eine fortschreitende Ursache – Verschmutzung oder Verschattung – ` +
          `und nicht für einen einmaligen Ausfall.`,
      });
    }
  }

  if (!result.befunde.length) {
    result.befunde.push({
      art: 'ok',
      schwere: 'gut',
      text: result.verfahren.some((v) => /nicht möglich/.test(v))
        ? 'Kein Leistungsabfall erkennbar – allerdings ist der Vergleich eingeschränkt (siehe Hinweise zur Datengrundlage).'
        : 'Kein Leistungsabfall erkennbar: die Monatserträge liegen im erwarteten Bereich.',
    });
  }
  return result;
}

module.exports = { detectPerformanceDrop, monthlyGeneration, MONAT_NAME };
