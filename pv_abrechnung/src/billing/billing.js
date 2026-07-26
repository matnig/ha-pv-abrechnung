'use strict';

const { round2 } = require('./resolver');

// Vorzeichen je Rolle: Verbrauch/Netzbezug/Lieferung = Kosten (+), Erzeugung = rein informativ.
// Einspeisung wird dynamisch behandelt (siehe unten), abhängig davon, wer die Vergütung bekommt.
const ROLE_SIGN = { verbrauch: 1, netzbezug: 1, lieferung: 1, einspeisung: 0, erzeugung: 0 };

// Jahresgebühr anteilig auf die Abrechnungsperiode umlegen.
function periodFactor(type) {
  if (type === 'year') return 1;
  if (type === 'day') return 1 / 365;
  return 1 / 12; // Monat (Standard)
}

/**
 * Reine Abrechnungsfunktion: nimmt bereits aufgelöste Periodenwerte (resolver)
 * und wendet Tarife an. Keine IO -> voll testbar.
 * @param {object} config    App-Konfiguration (tariffs, meters)
 * @param {object} resolved  { [meterId]: { anfang, ende, kwh, role, ... } } aus resolvePeriodReadings
 * @param {object} period    { type, label, start:Date, end:Date }
 * @param {object} [snapshots] für die Anomalie-Liste (optional)
 */
function computeBilling(config, resolved, period, snapshots = {}) {
  const tariffs = config.tariffs || {};
  // Eigenverbrauch: die Anlage wird selbst genutzt. Es entsteht keine Forderung gegen einen
  // Kunden – selbst genutzter Strom SPART Netzbezug (Wert = eigener Strompreis), die
  // Einspeisung ist eine Einnahme. Deshalb werden hier keine Beträge „berechnet", sondern
  // Ersparnis und Ertrag ausgewiesen.
  const eigenModus = config.betriebsmodus === 'eigenverbrauch';
  const eigenStrompreis = Number(tariffs.netzpreis || tariffs.netzbezug || 0);
  const lines = [];
  const kwhByRole = {};
  const amountByRole = {};

  const allMeters = [...(config.meters || []), ...(config.virtualMeters || [])];
  for (const meter of allMeters) {
    const r = resolved[meter.id] || {
      meterId: meter.id,
      name: meter.name,
      entityId: meter.entityId,
      role: meter.role,
      roleLabel: meter.role,
      anfang: null,
      ende: null,
      kwh: null,
      source: 'none',
      warnings: ['keine Daten'],
    };

    let sign = ROLE_SIGN[meter.role] ?? 0;
    let hinweis = null;
    let art = sign === 0 ? 'info' : 'kosten'; // kosten | ersparnis | ertrag | info
    let tariff;

    if (eigenModus) {
      // --- Eigenverbrauch: keine Rechnung, sondern Ersparnis/Ertrag ---
      if (meter.role === 'lieferung' || meter.role === 'verbrauch') {
        tariff = eigenStrompreis;
        art = 'ersparnis';
        hinweis = 'selbst genutzt – spart Strom vom Versorger';
      } else if (meter.role === 'einspeisung') {
        tariff = Number(tariffs.einspeisung || 0);
        art = 'ertrag';
        hinweis = 'ins Netz eingespeist – Einspeisevergütung';
      } else if (meter.role === 'netzbezug') {
        tariff = eigenStrompreis;
        art = 'kosten';
        hinweis = 'aus dem Netz bezogen – eigene Stromkosten';
      } else {
        tariff = 0;
        art = 'info';
      }
      sign = 1; // Beträge immer positiv ausweisen; die Bedeutung steckt in `art`
    } else {
      // --- Kundenlieferung: Abrechnung wie bisher ---
      if (meter.role === 'einspeisung') {
        if (tariffs.einspeisungAnBetreiber !== false) {
          // Fall 1: Anlagenbetreiber bekommt die Einspeisevergütung -> nicht in Kundenrechnung
          sign = 0;
          hinweis = 'Vergütung geht an Anlagenbetreiber – nicht berechnet';
          art = 'info';
        } else {
          // Fall 2: Kunde bekommt die Vergütung -> Einspeisemenge wird ihm berechnet (zahlt mehr)
          sign = 1;
          hinweis = 'Kunde erhält Vergütung – Einspeisemenge berechnet';
          art = 'kosten';
        }
      }
      tariff = sign === 0 ? 0 : Number(tariffs[meter.role] || 0);
    }

    const amount = r.kwh != null && sign !== 0 && tariff ? round2(sign * r.kwh * tariff) : 0;

    if (r.kwh != null) {
      kwhByRole[meter.role] = round2((kwhByRole[meter.role] || 0) + r.kwh);
      // In der Rechnungssumme dürfen nur echte Forderungen landen; im Eigenverbrauchsmodus
      // wird stattdessen unten nach Kategorien summiert.
      if (!eigenModus) amountByRole[meter.role] = round2((amountByRole[meter.role] || 0) + amount);
    }

    lines.push({ ...r, tariff, amount, hinweis, art });
  }

  const grundgebuehr = eigenModus ? 0 : Number(tariffs.grundgebuehr || 0);
  // Einspeisemanagement-Gebühr nur im Fall 2 (Kunde bekommt Vergütung), anteilig pro Periode,
  // dem Anlagenbetreiber abgezogen.
  let einspeiseManagement = 0;
  if (!eigenModus && tariffs.einspeisungAnBetreiber === false && Number(tariffs.einspeiseManagementJahr) > 0) {
    einspeiseManagement = round2(Number(tariffs.einspeiseManagementJahr) * periodFactor(period.type));
  }

  // Informative Statistik: Autarkiegrad (PV-Anteil am Verbrauch) und Ersparnis ggü. Netzstrom.
  const pvKwh = kwhByRole.lieferung || kwhByRole.verbrauch || 0; // selbst bzw. vom Kunden genutzter PV-Strom
  const netzKwh = kwhByRole.netzbezug || 0; // aus dem Netz bezogen (wenn PV nicht reicht)
  const gesamtKwh = round2(pvKwh + netzKwh);
  const autarkie = gesamtKwh > 0 ? Math.round((pvKwh / gesamtKwh) * 100) : null;
  const netzpreis = Number(tariffs.netzpreis || 0);
  const lieferpreis = Number(tariffs.lieferung || 0);

  let total;
  const eigen = {};
  if (eigenModus) {
    // Nutzen der Anlage im Zeitraum: eingesparter Strombezug + Einspeisevergütung.
    const sumArt = (a) => round2(lines.filter((l) => l.art === a).reduce((s, l) => s + (l.amount || 0), 0));
    eigen.ersparnisEigenverbrauch = sumArt('ersparnis');
    eigen.einspeiseErtrag = sumArt('ertrag');
    eigen.netzkosten = sumArt('kosten');
    eigen.eigenStrompreis = eigenStrompreis;
    total = round2(eigen.ersparnisEigenverbrauch + eigen.einspeiseErtrag);
  } else {
    total = round2(Object.values(amountByRole).reduce((s, v) => s + v, 0) + grundgebuehr - einspeiseManagement);
  }

  // Im Kundenmodus: Ersparnis = Kunde kauft PV-Strom (lieferpreis) statt Netzstrom (netzpreis).
  // Im Eigenverbrauch entspricht die Ersparnis dem vollen vermiedenen Bezug.
  const ersparnis = eigenModus
    ? eigen.ersparnisEigenverbrauch || 0
    : netzpreis > 0 && netzpreis > lieferpreis
      ? round2((netzpreis - lieferpreis) * pvKwh)
      : 0;
  const info = { pvKwh, netzKwh, gesamtKwh, autarkie, ersparnis, netzpreis, lieferpreis, modus: eigenModus ? 'eigenverbrauch' : 'kundenlieferung', ...eigen };

  // Anomalien im Zeitraum (aus den Polling-Snapshots)
  const startMs = period.start.getTime();
  const endMs = period.end.getTime();
  const anomalies = [];
  for (const meter of config.meters || []) {
    const snap = snapshots[meter.entityId];
    for (const an of (snap && snap.anomalies) || []) {
      if (an.at >= startMs && an.at < endMs) anomalies.push(an);
    }
  }

  return {
    period,
    generatedAt: Date.now(),
    lines,
    totals: { kwhByRole, amountByRole, grundgebuehr, einspeiseManagement, total, ...info },
    anomalies,
  };
}

module.exports = { computeBilling, ROLE_SIGN };
