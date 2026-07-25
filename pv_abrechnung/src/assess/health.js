'use strict';

// Zustandsbewertung der bestehenden Anlage – die Grundlage jeder Erweiterungsentscheidung.
// Wer eine schwache Anlage erweitert, vervielfacht das Problem statt es zu lösen.
//
// Geprüft wird:
//   - spezifischer Ertrag (kWh/kWp) gegen das Standort-Soll aus PVGIS
//   - Ertragsverlauf über den Tag: Einbrüche zur Mittagszeit deuten auf Verschattung,
//     abgeschnittene Spitzen auf eine Begrenzung des Wechselrichters
//   - Ausfallstunden (Erzeugung 0 in Stunden, in denen sie erwartbar wäre)
//   - Speicher: Vollzyklen pro Jahr und ob er überhaupt ausgenutzt wird

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
};

const NOTE = {
  ok: 'gut',
  fair: 'auffällig',
  bad: 'kritisch',
};

/**
 * @param {object} o
 *   profile: Ergebnis aus buildHourlyProfile
 *   kwp: number|null
 *   sollKwhPerKwp: number|null   Jahressoll je kWp (PVGIS)
 *   batteryKwh: number|null
 *   batterySim?: object          simulate()-Ergebnis des Ist-Zustands (für Zyklen)
 */
function assessHealth(o = {}) {
  const prof = o.profile || {};
  const cov = prof.coverage || {};
  const gen = (prof.series && prof.series.erzeugung) || [];
  const findings = [];
  const result = { findings, kennzahlen: {} };

  // --- Spezifischer Ertrag gegen Standort-Soll ---
  const erzeugung = (prof.totals && prof.totals.erzeugung) || 0;
  if (o.kwp && erzeugung > 0 && cov.days > 0) {
    const perKwpMeasured = erzeugung / o.kwp;
    const perKwpYear = round(perKwpMeasured * (365 / cov.days), 0);
    result.kennzahlen.spezifischerErtragJahr = perKwpYear;
    if (o.sollKwhPerKwp) {
      const quote = round((perKwpYear / o.sollKwhPerKwp) * 100, 0);
      result.kennzahlen.sollErfuellung = quote;
      result.kennzahlen.sollKwhPerKwp = o.sollKwhPerKwp;
      const level = quote >= 90 ? 'ok' : quote >= 75 ? 'fair' : 'bad';
      findings.push({
        thema: 'Spezifischer Ertrag',
        bewertung: NOTE[level],
        text:
          `Die Anlage erzeugt hochgerechnet ${perKwpYear} kWh je kWp und Jahr. Für den Standort und die ` +
          `angenommene Ausrichtung erwartet PVGIS ${o.sollKwhPerKwp} kWh/kWp (${quote}% erreicht).` +
          (level === 'ok'
            ? ' Das ist normal.'
            : level === 'fair'
              ? ' Das ist merklich unter dem Erwartungswert – mögliche Ursachen: Verschattung, Verschmutzung, ungünstigere Ausrichtung/Neigung als angenommen, einzelne Stringausfälle.'
              : ' Das ist deutlich zu wenig. Vor einer Erweiterung sollte die Ursache geklärt werden (Verschattung, defekte Strings/Module, Wechselrichterfehler).'),
        hinweis: cov.fullYear ? null : `Achtung: Hochrechnung aus nur ${cov.days} Tagen Daten – saisonal verzerrt.`,
      });
    } else {
      findings.push({
        thema: 'Spezifischer Ertrag',
        bewertung: 'unbekannt',
        text: `Die Anlage erzeugt hochgerechnet ${perKwpYear} kWh je kWp und Jahr. Zum Vergleich fehlt das Standort-Soll (PVGIS nicht erreichbar oder Standort unbekannt).`,
      });
    }
  } else if (!o.kwp) {
    findings.push({ thema: 'Spezifischer Ertrag', bewertung: 'unbekannt', text: 'Ohne die Modulleistung (kWp) lässt sich der Ertrag nicht bewerten.' });
  }

  // --- Tagesform: Verschattung / Begrenzung ---
  // Die Tageszeit MUSS aus dem Zeitstempel bestimmt werden: der Array-Index beginnt beim
  // Profilstart, nicht um Mitternacht (und das Raster ist UTC-basiert, die Anlage lebt aber in
  // lokaler Zeit). Mit `i % 24` läge die Mittagsspitze irgendwo.
  const startMs = cov.startMs;
  const hourOf = (i) => (startMs != null ? new Date(startMs + i * 3600000).getHours() : i % 24);
  if (gen.length >= 24 * 30) {
    const byHour = new Array(24).fill(0);
    const cnt = new Array(24).fill(0);
    for (let i = 0; i < gen.length; i++) {
      const h = hourOf(i);
      byHour[h] += gen[i] || 0;
      cnt[h]++;
    }
    const avg = byHour.map((v, h) => (cnt[h] ? v / cnt[h] : 0));
    result.kennzahlen.tagesprofil = avg.map((v) => round(v, 3));
    const peak = Math.max(...avg);
    const noon = avg.slice(11, 15);
    const noonAvg = noon.reduce((a, b) => a + b, 0) / noon.length;
    if (peak > 0 && noonAvg < peak * 0.75) {
      findings.push({
        thema: 'Tagesverlauf',
        bewertung: NOTE.fair,
        text: `Um die Mittagszeit liegt der Durchschnittsertrag unter dem Tagesmaximum (${round((noonAvg / peak) * 100, 0)}% davon). Das deutet auf Verschattung in den Mittagsstunden oder eine ungewöhnliche Ausrichtung hin.`,
      });
    }
    // Abgeschnittene Spitzen erkennen: entscheidend ist ein PLATEAU – viele Stunden mit
    // praktisch identischem Höchstwert. Bei einer natürlichen Glockenkurve gibt es das nicht,
    // bei einer Wechselrichter- oder Einspeisebegrenzung an jedem sonnigen Tag.
    const maxHour = Math.max(0, ...gen);
    const plateau = gen.filter((v) => v >= maxHour * 0.995).length;
    if (o.kwp && maxHour > 0 && plateau >= 50) {
      findings.push({
        thema: 'Leistungsbegrenzung',
        bewertung: 'Hinweis',
        text:
          `In ${plateau} Stunden lag die Erzeugung bei praktisch demselben Höchstwert von ${round(maxHour, 2)} kWh/h. ` +
          `Ein solches Plateau entsteht nicht durch Wetter, sondern durch eine Begrenzung – meist der Wechselrichter ` +
          `oder eine Einspeisebegrenzung. Zusätzliche Module bringen dann weniger als erwartet, solange der ` +
          `Wechselrichter nicht mitwächst; diese Berechnung unterstellt keine Begrenzung.`,
      });
    }
  }

  // --- Ausfalltage ---
  // Bewertet werden ganze Tage ohne jeden Ertrag, nicht einzelne Stunden: einzelne ertragslose
  // Stunden sind im Winter normal (dichte Bewölkung), ein kompletter Tag ohne Erzeugung deutet
  // dagegen auf einen Anlagenstillstand oder eine Lücke in der Messung hin.
  if (gen.length >= 24 * 14) {
    // Nach echten Kalendertagen gruppieren (nicht in 24er-Blöcken ab Profilstart).
    const perDay = new Map();
    for (let i = 0; i < gen.length; i++) {
      const key = startMs != null ? new Date(startMs + i * 3600000).toDateString() : String(Math.floor(i / 24));
      perDay.set(key, (perDay.get(key) || 0) + (gen[i] || 0));
    }
    // Erster/letzter Tag sind meist unvollständig -> nicht bewerten.
    const keys = [...perDay.keys()];
    const inner = keys.slice(1, -1);
    const tage = inner.length || keys.length;
    let leer = 0;
    for (const k of inner) if ((perDay.get(k) || 0) <= 0.05) leer++;
    const quote = round((leer / tage) * 100, 1);
    result.kennzahlen.ausfalltageProzent = quote;
    result.kennzahlen.ausfalltage = leer;
    if (leer > 0 && quote > 2) {
      findings.push({
        thema: 'Ausfalltage / Messlücken',
        bewertung: quote > 10 ? NOTE.bad : NOTE.fair,
        text:
          `An ${leer} von ${tage} Tagen (${quote}%) wurde überhaupt keine Erzeugung gemessen. Das ist entweder ein ` +
          `Anlagenstillstand oder eine Lücke in der Messung – beides verfälscht die Abrechnung und diese Bewertung. ` +
          `Bitte im Auffälligkeiten-Protokoll prüfen, ob dort passende Einträge stehen.`,
      });
    }
  }

  // --- Speicher ---
  if (o.batteryKwh && o.batterySim) {
    const zyklen = o.batterySim.vollzyklen || 0;
    const perYear = cov.days > 0 ? round(zyklen * (365 / cov.days), 0) : null;
    result.kennzahlen.speicherVollzyklenJahr = perYear;
    if (perYear != null) {
      const level = perYear >= 200 ? 'ok' : perYear >= 100 ? 'fair' : 'bad';
      findings.push({
        thema: 'Speichernutzung',
        bewertung: NOTE[level],
        text:
          `Der Speicher erreicht hochgerechnet ${perYear} Vollzyklen pro Jahr.` +
          (level === 'ok'
            ? ' Das ist eine gute Ausnutzung.'
            : level === 'fair'
              ? ' Das ist mäßig – der Speicher ist für das Verbrauchsprofil eher groß, oder er wird nicht optimal geladen.'
              : ' Das ist sehr wenig. Ein zusätzlicher Speicher wäre hier kaum sinnvoll; eher prüfen, warum der vorhandene nicht genutzt wird.'),
      });
    }
    if (o.batterySim.ungenutzterUeberschuss > 0 && o.batterySim.einspeisung > 0) {
      findings.push({
        thema: 'Ungenutzter Überschuss',
        bewertung: 'Hinweis',
        text: `${round(o.batterySim.ungenutzterUeberschuss, 0)} kWh Überschuss konnten nicht gespeichert werden (Speicher voll oder Ladeleistung begrenzt) und gingen ins Netz. Das ist das Potenzial, das ein größerer Speicher heben könnte.`,
      });
    }
  }

  // --- Datenlage ---
  if (!cov.fullYear) {
    findings.push({
      thema: 'Datenlage',
      bewertung: NOTE.fair,
      text: `Es liegen ${cov.days} Tage (${cov.months} Monate) Messdaten vor. Für eine Jahresaussage werden alle Jahreszeiten benötigt; bis dahin sind alle Hochrechnungen mit Unsicherheit behaftet – besonders, wenn nur Sommer- oder nur Wintermonate enthalten sind.`,
    });
  }
  if ((cov.missingRoles || []).length) {
    findings.push({
      thema: 'Fehlende Zähler',
      bewertung: NOTE.bad,
      text: `Für eine vollständige Bewertung fehlen Zähler mit der Rolle: ${cov.missingRoles.join(', ')}. Ohne diese Werte können Eigenverbrauch und damit die Wirtschaftlichkeit nicht sauber berechnet werden.`,
    });
  }

  const bad = findings.filter((f) => f.bewertung === NOTE.bad).length;
  const fair = findings.filter((f) => f.bewertung === NOTE.fair).length;
  result.gesamt = bad ? 'kritisch' : fair ? 'auffällig' : 'gut';
  return result;
}

module.exports = { assessHealth };
