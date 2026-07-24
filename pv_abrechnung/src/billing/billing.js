'use strict';

const { round2 } = require('./resolver');

// Vorzeichen je Rolle: Verbrauch/Netzbezug = Kosten (+), Einspeisung = Gutschrift (−),
// Erzeugung = rein informativ (kein Geldbetrag).
const ROLE_SIGN = { verbrauch: 1, netzbezug: 1, lieferung: 1, einspeisung: -1, erzeugung: 0 };

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

    const sign = ROLE_SIGN[meter.role] ?? 0;
    const tariff = sign === 0 ? 0 : Number(tariffs[meter.role] || 0);
    const amount = r.kwh != null && sign !== 0 ? round2(sign * r.kwh * tariff) : 0;

    if (r.kwh != null) {
      kwhByRole[meter.role] = round2((kwhByRole[meter.role] || 0) + r.kwh);
      amountByRole[meter.role] = round2((amountByRole[meter.role] || 0) + amount);
    }

    lines.push({ ...r, tariff, amount });
  }

  const grundgebuehr = Number(tariffs.grundgebuehr || 0);
  const total = round2(Object.values(amountByRole).reduce((s, v) => s + v, 0) + grundgebuehr);

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
    totals: { kwhByRole, amountByRole, grundgebuehr, total },
    anomalies,
  };
}

module.exports = { computeBilling, ROLE_SIGN };
