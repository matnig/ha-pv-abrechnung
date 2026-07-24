'use strict';

const { fmt } = require('../billing/periods');

const eur = (n) => (n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const kwh = (n) => (n == null ? '–' : `${n.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh`);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ANOMALY_TEXT = {
  meter_swap: 'Zählertausch (manuell bestätigt) – virtueller Zähler läuft fort',
  technical_fault: 'STÖRUNG: Zählerabfall über 2 Std ohne Erholung – bitte prüfen',
  investigating: 'möglicher Zählerfehler – vom System untersucht',
  drop_detected: 'Zählerabfall erkannt – Untersuchung läuft',
  transient: 'kurzzeitige Störung (Wert kam zurück) – kein Zählertausch',
  reset: 'Zähler-Reset (z.B. Gerät auf 0) – Stand automatisch fortgeführt',
  stale: 'Wert stand still (Sensor hängt/offline)',
  unavailable: 'Sensor nicht verfügbar',
  invalid: 'ungültiger Wert',
  jitter: 'kleiner Rückwärts-Sprung ignoriert',
  spike: 'unrealistischer Sprung nach oben',
  error: 'Lesefehler',
};

function subject(billing) {
  const p = billing.period;
  const label = { day: 'Tagesbericht', month: 'Monatsbericht', year: 'Jahresbericht' }[p.type] || 'Bericht';
  return `PV-Abrechnung – ${label} ${p.label}`;
}

function buildHtml(billing) {
  const p = billing.period;
  const t = billing.totals;

  const rows = billing.lines
    .map((l) => {
      const warn = l.warnings.length
        ? `<div style="color:#b45309;font-size:12px">⚠ ${esc(l.warnings.join('; '))}</div>`
        : '';
      const src = l.source === 'statistics' ? 'HA-Statistik' : l.source === 'poll' ? 'Polling' : l.source === 'virtual' ? 'virtuell' : '–';
      return `<tr>
        <td>${esc(l.name)}<div style="color:#888;font-size:11px">${esc(l.entityId)} · Quelle: ${src}</div>${warn}</td>
        <td>${esc(l.roleLabel)}</td>
        <td style="text-align:right">${kwh(l.anfang)}</td>
        <td style="text-align:right">${kwh(l.ende)}</td>
        <td style="text-align:right"><b>${kwh(l.kwh)}</b></td>
        <td style="text-align:right">${l.tariff ? l.tariff.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' €/kWh' : '–'}</td>
        <td style="text-align:right">${l.tariff || l.amount ? eur(l.amount) : '–'}</td>
      </tr>`;
    })
    .join('');

  const anomalyRows = billing.anomalies.length
    ? `<h3 style="margin-top:24px">Daten-Auffälligkeiten (${billing.anomalies.length})</h3>
       <ul style="color:#555;font-size:13px">
       ${billing.anomalies
         .slice(-30)
         .map(
           (a) =>
             `<li>${new Date(a.at).toLocaleString('de-DE')} – ${esc(a.name || a.entityId || '')}: ${esc(
               ANOMALY_TEXT[a.type] || a.type
             )}</li>`
         )
         .join('')}
       </ul>`
    : '<p style="color:#16a34a;font-size:13px">✓ Keine Daten-Auffälligkeiten im Zeitraum.</p>';

  const swaps = billing.anomalies.filter((a) => a.type === 'meter_swap');
  const faults = billing.anomalies.filter((a) => a.type === 'technical_fault');
  const banner =
    (swaps.length
      ? `<div style="background:#fef9c3;border:1px solid #eab308;border-radius:8px;padding:10px 12px;margin:12px 0">
          <b>Zählertausch bestätigt</b> (${swaps.length}) – der virtuelle Zähler läuft ohne Unterbrechung fort.
          ${swaps.map((a) => `<div style="font-size:12px;color:#713f12">${esc(a.name || a.entityId || '')}: alter Endstand ${kwh(a.oldFinal)} → neuer Start ${kwh(a.newStart)}</div>`).join('')}
        </div>`
      : '') +
    (faults.length
      ? `<div style="background:#fee2e2;border:1px solid #ef4444;border-radius:8px;padding:10px 12px;margin:12px 0">
          <b>⚠ Technischer Fehler</b> (${faults.length}) – Zählerabfall ohne erkennbaren Zählertausch. Bitte prüfen.
          ${faults.map((a) => `<div style="font-size:12px;color:#7f1d1d">${esc(a.name || a.entityId || '')}: fiel von ${kwh(a.from)}, kein neuer Zähler zählt hoch</div>`).join('')}
        </div>`
      : '');

  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;color:#222;max-width:820px">
    <h2 style="margin-bottom:2px">PV-Abrechnung</h2>
    ${banner}
    <div style="color:#666">${{ day: 'Tag', month: 'Monat', year: 'Jahr' }[p.type] || 'Zeitraum'}: <b>${esc(
      p.label
    )}</b> &nbsp;(${fmt(p.start)} – ${fmt(new Date(p.end.getTime() - 1))})</div>
    <table style="border-collapse:collapse;width:100%;margin-top:16px;font-size:14px">
      <thead><tr style="background:#f3f4f6;text-align:left">
        <th style="padding:6px">Zähler</th><th>Rolle</th>
        <th style="text-align:right">Anfangsstand</th><th style="text-align:right">Endstand</th>
        <th style="text-align:right">Menge</th><th style="text-align:right">Tarif</th><th style="text-align:right">Betrag</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="padding:10px;color:#888">Keine Zähler konfiguriert.</td></tr>'}</tbody>
    </table>
    <table style="margin-top:16px;font-size:15px">
      ${t.grundgebuehr ? `<tr><td>Grundgebühr</td><td style="text-align:right;padding-left:24px">${eur(t.grundgebuehr)}</td></tr>` : ''}
      <tr><td style="font-size:17px"><b>Summe</b></td><td style="text-align:right;padding-left:24px;font-size:17px"><b>${eur(
        t.total
      )}</b></td></tr>
    </table>
    ${anomalyRows}
    <p style="color:#aaa;font-size:11px;margin-top:24px">Erstellt am ${new Date(
      billing.generatedAt
    ).toLocaleString('de-DE')} · Zählerstände sind bereinigte, monoton fortgeführte Werte.</p>
  </body></html>`;
}

function buildCsv(billing) {
  const head = ['Zaehler', 'EntityId', 'Rolle', 'Anfangsstand_kWh', 'Endstand_kWh', 'Menge_kWh', 'Tarif_EUR_kWh', 'Betrag_EUR', 'Warnungen'];
  const rows = billing.lines.map((l) =>
    [l.name, l.entityId, l.role, l.anfang ?? '', l.ende ?? '', l.kwh ?? '', l.tariff ?? '', l.amount ?? '', l.warnings.join(' | ')]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(';')
  );
  rows.push('');
  rows.push(`"Summe";;;;;;;"${billing.totals.total}";`);
  return [head.join(';'), ...rows].join('\r\n');
}

module.exports = { buildHtml, buildCsv, subject };
