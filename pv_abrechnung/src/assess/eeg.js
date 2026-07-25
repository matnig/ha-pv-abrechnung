'use strict';

// EEG-Einspeisevergütung für einen ERWEITERUNGSTEIL.
//
// Zwei Punkte, die häufig falsch gerechnet werden:
//
// 1. Der neue Anlagenteil erhält den zum Zeitpunkt der Erweiterung gültigen Satz – NICHT den
//    (meist höheren) Satz der Bestandsanlage. Die Bestandsanlage behält ihren Satz über die
//    vollen 20 Jahre unverändert.
// 2. Die Vergütung ist kein Stufentarif, sondern wird anteilig über die Schwellen 10/40/100 kW
//    gewichtet (§ 48 EEG 2023). Ein 20-kWp-Teil bekommt also nicht durchgängig den 10-40-Satz,
//    sondern den Mischwert aus beiden Klassen.
//
// Anlagenzusammenfassung (§ 24 Abs. 1 EEG 2023): Nur wenn Alt- und Neuteil innerhalb von zwölf
// aufeinanderfolgenden Kalendermonaten in Betrieb gehen, werden sie für die Leistungsklasse
// zusammengefasst. Beim typischen Nachrüsten Jahre später ist der neue Teil eine eigene Anlage –
// dadurch kann er in eine GÜNSTIGERE (kleinere) Leistungsklasse fallen als die Gesamtanlage.
//
// Die Sätze sind mit Gültigkeitsdatum hinterlegt und bewusst nicht "für immer" hart kodiert:
// sie sinken halbjährlich um 1% (Stichtage 1. Februar / 1. August, § 49 EEG 2023).

// Stand 01.02.2026 – 31.07.2026 (Bundesnetzagentur). ct/kWh.
const TARIFFS = {
  gueltigVon: '2026-02-01',
  gueltigBis: '2026-07-31',
  degressionHalbjahr: 1.0, // % je Halbjahr
  ueberschuss: [
    { bisKw: 10, ct: 7.78 },
    { bisKw: 40, ct: 6.73 },
    { bisKw: 100, ct: 5.5 },
  ],
  voll: [
    { bisKw: 10, ct: 12.34 },
    { bisKw: 40, ct: 10.35 },
    { bisKw: 100, ct: 10.35 },
  ],
  quelle: 'Bundesnetzagentur, EEG-Vergütungssätze für Solaranlagen (Inbetriebnahme 02/2026–07/2026)',
};

const round = (n, d = 4) => {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
};

/**
 * Anteilig gewichteter Vergütungssatz (§ 48 EEG 2023) in €/kWh.
 * @param {number} kw      installierte Leistung des vergütungsrelevanten Anlagenteils
 * @param {'ueberschuss'|'voll'} art
 * @param {object} [tariffs]
 */
function weightedRate(kw, art = 'ueberschuss', tariffs = TARIFFS) {
  const leistung = Math.max(0, Number(kw) || 0);
  if (!leistung) return 0;
  const stufen = tariffs[art] || tariffs.ueberschuss;
  let rest = leistung;
  let untereGrenze = 0;
  let summe = 0;
  for (const s of stufen) {
    if (rest <= 0) break;
    const anteil = Math.min(rest, s.bisKw - untereGrenze);
    if (anteil > 0) {
      summe += anteil * s.ct;
      rest -= anteil;
    }
    untereGrenze = s.bisKw;
  }
  if (rest > 0) {
    // Über 100 kW gibt es keine Festvergütung (Direktvermarktungspflicht) -> mit 0 gewichten.
    summe += 0;
  }
  return round(summe / leistung / 100); // ct -> €/kWh
}

/**
 * Vergütungssatz für einen Erweiterungsteil, inklusive Abschlag für Stunden mit negativen
 * Börsenpreisen (§ 51 EEG / Solarspitzengesetz: für Anlagen ab 25.02.2025 entfällt die
 * Vergütung in solchen Viertelstunden – sie liegen fast ausschließlich mittags, treffen PV
 * also überproportional).
 *
 * @param {object} o
 *   addKwp: number                 Leistung des neuen Teils
 *   bestandKwp?: number            Leistung der Bestandsanlage
 *   zusammenfassen?: boolean       true, wenn Alt+Neu innerhalb 12 Monaten (§ 24 EEG)
 *   art?: 'ueberschuss'|'voll'
 *   negativpreisAbschlagProzent?: number
 */
function rateForExtension(o = {}) {
  const add = Math.max(0, Number(o.addKwp) || 0);
  const bestand = Math.max(0, Number(o.bestandKwp) || 0);
  const art = o.art === 'voll' ? 'voll' : 'ueberschuss';
  const abschlag = o.negativpreisAbschlagProzent != null ? o.negativpreisAbschlagProzent : art === 'voll' ? 15 : 8;

  let basis;
  let hinweis;
  if (o.zusammenfassen && bestand > 0) {
    // Zusammengefasst: der Mischsatz der Gesamtanlage gilt auch für den neuen Teil.
    basis = weightedRate(bestand + add, art);
    hinweis =
      `Alt- und Neuanlage werden zusammengefasst (Inbetriebnahme innerhalb von zwölf Monaten, § 24 EEG 2023): ` +
      `die Leistungsklasse richtet sich nach ${round(bestand + add, 1)} kWp.`;
  } else {
    // Eigenständige Anlage: nur die neue Leistung bestimmt die Klasse.
    basis = weightedRate(add, art);
    hinweis =
      `Der neue Anlagenteil gilt als eigene Anlage (Bestandsanlage älter als zwölf Monate): die ` +
      `Leistungsklasse richtet sich nur nach den ${round(add, 1)} kWp Zubau – das ist meist günstiger ` +
      `als der Mischsatz der Gesamtanlage. Die Bestandsanlage behält ihren bisherigen Satz unverändert.`;
  }
  const effektiv = round(basis * (1 - abschlag / 100));
  return {
    satzBasis: basis,
    satzEffektiv: effektiv,
    negativpreisAbschlagProzent: abschlag,
    art,
    hinweis,
    gueltigBis: TARIFFS.gueltigBis,
    quelle: TARIFFS.quelle,
  };
}

/** Rechtliche Hinweise, die eine Erweiterung betreffen (keine Rechtsberatung). */
function legalNotes(o = {}) {
  const bestand = Number(o.bestandKwp) || 0;
  const add = Number(o.addKwp) || 0;
  const gesamt = bestand + add;
  const notes = [];

  notes.push({
    thema: 'Vergütungssatz des Zubaus',
    text:
      `Der neue Anlagenteil erhält den bei Inbetriebnahme gültigen Satz (aktuell bis ${TARIFFS.gueltigBis}), ` +
      `nicht den Satz der Bestandsanlage. Die Sätze sinken halbjährlich um ${TARIFFS.degressionHalbjahr}% ` +
      `(Stichtage 1. Februar und 1. August).`,
  });
  notes.push({
    thema: 'Getrennte Messung',
    text: 'Alt- und Neuteil müssen getrennt gemessen werden können (in der Regel ein zusätzlicher Erzeugungszähler oder ein vom Netzbetreiber vorgegebenes Kaskadenmesskonzept). Diese Kosten gehören in die Investitionsrechnung.',
  });
  if (gesamt > 100 && bestand <= 100) {
    notes.push({
      thema: 'Schwelle 100 kW – Direktvermarktung',
      text: `Mit dem Zubau überschreitet die Anlage 100 kW (${round(gesamt, 1)} kWp). Ab dieser Schwelle entfällt die Festvergütung und es gilt die Pflicht zur Direktvermarktung. Das verändert die Vermarktung grundlegend – vorher vertraglich klären.`,
      schwere: 'warnung',
    });
  }
  notes.push({
    thema: 'Einspeisebegrenzung ohne intelligentes Messsystem',
    text: 'Für Anlagen, die ab dem 25.02.2025 in Betrieb gehen, ist die Einspeiseleistung ohne intelligentes Messsystem mit Steuerfunktion auf 60% der installierten Leistung begrenzt. Da eine Erweiterung als Neuinbetriebnahme gilt, kann das greifen; ob und auf welchen Anlagenteil, ist rechtlich nicht eindeutig geklärt. Bitte vorab beim Netzbetreiber bestätigen lassen – diese Berechnung unterstellt keine Begrenzung.',
    schwere: 'warnung',
  });
  notes.push({
    thema: 'Umsatzsteuer',
    text: 'Auf Lieferung und Installation von Modulen und Speichern gilt der Nullsteuersatz (§ 12 Abs. 3 UStG); eine Erweiterung wird dabei wie eine Neuanschaffung behandelt. Die hier genannten Preise sind daher als Endpreise zu verstehen. Bei Nicht-Wohngebäuden über 30 kWp ist eine Einzelfallprüfung nötig.',
  });
  notes.push({
    thema: 'Negative Börsenpreise',
    text: 'In Stunden mit negativem Börsenpreis entfällt die Einspeisevergütung. Diese Stunden liegen fast ausschließlich mittags und haben 2025 rund 573 Stunden erreicht (steigende Tendenz). Die Rechnung berücksichtigt das über einen pauschalen Abschlag auf die Einspeiseerlöse.',
  });
  return notes;
}

module.exports = { TARIFFS, weightedRate, rateForExtension, legalNotes };
