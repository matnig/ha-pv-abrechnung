'use strict';

const { fmt } = require('../billing/periods');
const { buildReportCharts } = require('./charts');

const eur = (n) => (n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const kwh = (n) => (n == null ? '–' : `${n.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh`);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ANOMALY_TEXT = {
  meter_swap: 'Zählertausch (manuell bestätigt) – virtueller Zähler läuft fort',
  technical_fault: 'STÖRUNG: Zählerabfall über 2 Std ohne Erholung – bitte prüfen',
  investigating: 'möglicher Zählerfehler – vom System untersucht',
  offline: 'Sensor ausgefallen – keine Daten (untersucht)',
  offline_fault: 'STÖRUNG: Sensor über 2 Std offline – bitte prüfen',
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
  const label = { day: 'Tagesbericht', week: 'Wochenbericht', month: 'Monatsbericht', year: 'Jahresbericht' }[p.type] || 'Bericht';
  const incomplete = p.end.getTime() > (billing.generatedAt || Date.now());
  const anlage = billing.stammdaten && billing.stammdaten.anlagenName ? ' ' + billing.stammdaten.anlagenName : '';
  return `PV-Abrechnung${anlage} – ${label} ${p.label}${incomplete ? ' (nicht abgeschlossen)' : ''}`;
}

function monthlyPrimaryKwh(m) {
  const k = m.kwhByRole || {};
  if (k.lieferung != null) return k.lieferung;
  if (k.verbrauch != null) return k.verbrauch;
  return Object.values(k).reduce((s, v) => s + v, 0);
}

function buildMonthlyBreakdown(billing) {
  const months = billing.monthly || [];
  if (!months.length) return '';
  const anyEuro = months.some((m) => Math.abs(m.total) > 0.005);
  const barVal = (m) => (anyEuro ? Math.abs(m.total) : monthlyPrimaryKwh(m));
  const max = Math.max(1, ...months.map(barVal));
  const rows = months
    .map((m) => {
      const w = Math.round((barVal(m) / max) * 100);
      return `<tr>
        <td style="padding:4px 8px">${esc(m.label)}${m.incomplete ? ' <span style="color:#dc2626;font-size:11px">(läuft)</span>' : ''}</td>
        <td style="padding:4px 8px;text-align:right">${kwh(monthlyPrimaryKwh(m))}</td>
        <td style="padding:4px 8px;text-align:right">${eur(m.total)}</td>
        <td style="padding:4px 8px;width:38%"><div style="background:#eef2ff;border-radius:3px"><div style="background:#2563eb;width:${w}%;height:12px;border-radius:3px"></div></div></td>
      </tr>`;
    })
    .join('');
  return `<h3 style="margin-top:24px">Monatsübersicht</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#f3f4f6;text-align:left"><th style="padding:4px 8px">Monat</th><th style="text-align:right">geliefert/Menge</th><th style="text-align:right">Summe</th><th>Verlauf (${anyEuro ? '€' : 'kWh'})</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildMeterChart(billing) {
  const lines = (billing.lines || []).filter((l) => l.kwh != null && l.kwh !== 0);
  if (!lines.length) return '';
  const max = Math.max(1, ...lines.map((l) => Math.abs(l.kwh)));
  const rows = lines
    .map((l) => {
      const w = Math.round((Math.abs(l.kwh) / max) * 100);
      return `<tr>
        <td style="padding:3px 8px;font-size:13px">${esc(l.name)}</td>
        <td style="padding:3px 8px;text-align:right;font-size:13px;white-space:nowrap">${kwh(l.kwh)}</td>
        <td style="padding:3px 8px;width:55%"><div style="background:#eef2ff;border-radius:3px"><div style="background:#2563eb;width:${w}%;height:14px;border-radius:3px"></div></div></td>
      </tr>`;
    })
    .join('');
  return `<h3 style="margin-top:20px">Mengen im Überblick</h3>
    <table style="border-collapse:collapse;width:100%">${rows}</table>`;
}

const priceStr = (v) => Number(v || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' €/kWh';

function buildInfoStats(billing) {
  if (!billing.showInfoStats) return '';
  const t = billing.totals;
  const parts = [];
  if (t.gesamtKwh > 0 && t.autarkie != null) {
    const pv = t.autarkie;
    const netz = 100 - pv;
    parts.push(`
      <div style="margin-top:8px">
        <div style="font-size:14px">Autarkiegrad: <b>${pv}%</b> des Verbrauchs kam aus der PV-Anlage.</div>
        <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;margin-top:6px;font-size:11px;color:#fff;table-layout:fixed">
          <tr>
            <td width="${pv}%" height="22" align="center" style="background:#16a34a;line-height:22px">${pv > 12 ? 'PV ' + pv + '%' : ''}</td>
            <td width="${netz}%" height="22" align="center" style="background:#9ca3af;line-height:22px">${netz > 12 ? 'Netz ' + netz + '%' : ''}</td>
          </tr>
        </table>
        <div style="font-size:12px;color:#555;margin-top:4px">Aus PV: ${kwh(t.pvKwh)} · Aus Netz: ${kwh(t.netzKwh)} · Gesamt: ${kwh(t.gesamtKwh)}</div>
      </div>`);
  }
  if (t.ersparnis > 0) {
    parts.push(`<div style="margin-top:10px;font-size:14px;color:#166534">💡 Ersparnis für den Kunden: <b>${eur(t.ersparnis)}</b> gegenüber Netzstrom
      (PV ${priceStr(t.lieferpreis)} statt Netz ${priceStr(t.netzpreis)} · ${kwh(t.pvKwh)}).</div>`);
  }
  if (billing.batteries && billing.batteries.length) {
    const names = billing.batteries.map((b) => esc(b.name || b.entityId)).join(', ');
    parts.push(`<div style="margin-top:10px;font-size:14px">🔋 Akku-Überwachung aktiv (${names}).
      <span style="color:#888;font-size:12px">Die Ladezustände werden laufend überwacht – das hilft, ruhige Zeiträume
      (Akku deckt die Last) von echten Zähler-Ausfällen zu unterscheiden. Auffälligkeiten sind unten protokolliert
      und im Dashboard kontrollierbar.</span></div>`);
  }
  return parts.length ? `<h3 style="margin-top:24px">Auswertung (informativ)</h3>${parts.join('')}` : '';
}

function buildPriceTransparency(billing) {
  const tf = billing.tariffs;
  if (!tf) return '';
  const rows = [['Preis Lieferung (PV an Kunde)', priceStr(tf.lieferung)]];
  if (Number(tf.netzbezug)) rows.push(['Preis Netzbezug', priceStr(tf.netzbezug)]);
  if (Number(tf.netzpreis)) rows.push(['Netzbetreiber-Strompreis (Vergleich)', priceStr(tf.netzpreis)]);
  if (Number(tf.grundgebuehr)) rows.push(['Grundgebühr', eur(Number(tf.grundgebuehr)) + ' / Periode']);
  const einsp =
    tf.einspeisungAnBetreiber !== false
      ? 'Die Einspeisevergütung für den ins Netz eingespeisten Strom erhält der Anlagenbetreiber (nicht in der Kundenrechnung).'
      : `Die Einspeisevergütung erhält der Kunde; die eingespeiste Menge wird ihm zum Satz ${priceStr(tf.einspeisung)} berechnet.`;
  const trs = rows.map(([k, v]) => `<tr><td style="padding:3px 8px;color:#555">${esc(k)}</td><td style="padding:3px 8px;text-align:right">${esc(v)}</td></tr>`).join('');
  return `<h3 style="margin-top:24px">Preise & Vergütung (Transparenz)</h3>
    <table style="border-collapse:collapse;font-size:13px">${trs}</table>
    <div style="font-size:13px;color:#555;margin-top:6px">${esc(einsp)}</div>`;
}

function buildHtml(billing) {
  const p = billing.period;
  const t = billing.totals;
  const sd = billing.stammdaten || {};
  const incomplete = p.end.getTime() > (billing.generatedAt || Date.now());
  const periodWord = { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr' }[p.type] || 'Zeitraum';
  const periodArticle = { day: 'der', week: 'die', month: 'der', year: 'das' }[p.type] || 'der';
  const incompleteBanner = incomplete
    ? `<div style="background:#fee2e2;border:2px solid #dc2626;border-radius:8px;padding:12px;margin:12px 0;text-align:center">
         <div style="color:#dc2626;font-size:22px;font-weight:800">⚠ ${periodWord} nicht abgeschlossen</div>
         <div style="color:#7f1d1d;font-size:13px;margin-top:4px">Vorläufige Werte, Stand ${fmt(new Date(billing.generatedAt))} – ${periodArticle} ${periodWord} läuft noch.</div>
       </div>`
    : '';
  const monthlyHtml = buildMonthlyBreakdown(billing);

  const rows = billing.lines
    .map((l) => {
      const warn = l.warnings.length
        ? `<div style="color:#b45309;font-size:12px">⚠ ${esc(l.warnings.join('; '))}</div>`
        : '';
      const src = l.source === 'statistics' ? 'HA-Statistik' : l.source === 'poll' ? 'Polling' : l.source === 'virtual' ? 'virtuell' : '–';
      return `<tr>
        <td>${esc(l.name)}<div style="color:#888;font-size:10px;word-break:break-all">${esc(l.entityId)} · Quelle: ${src}</div>${
          l.hinweis ? `<div style="color:#2563eb;font-size:11px">${esc(l.hinweis)}</div>` : ''
        }${warn}</td>
        <td>${esc(l.roleLabel)}</td>
        <td style="text-align:right">${kwh(l.anfang)}</td>
        <td style="text-align:right">${kwh(l.ende)}</td>
        <td style="text-align:right"><b>${kwh(l.kwh)}</b></td>
        <td style="text-align:right">${l.tariff ? l.tariff.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + '&nbsp;€/kWh' : '–'}</td>
        <td style="text-align:right;white-space:nowrap"><b>${l.tariff || l.amount ? eur(l.amount) : '–'}</b></td>
      </tr>`;
    })
    .join('');

  const anomalyRows = billing.anomalies.length
    ? `<h3 style="margin-top:24px">Daten-Auffälligkeiten – Protokoll (${billing.anomalies.length})</h3>
       <ul style="color:#555;font-size:13px">
       ${billing.anomalies
         .slice(-30)
         .map((a) => {
           const r = a.review;
           const cls = r
             ? r.classification === 'kritisch'
               ? ' <b style="color:#b91c1c">[kritisch]</b>'
               : ' <span style="color:#166534">[unkritisch]</span>'
             : ' <span style="color:#b45309">[nicht bewertet]</span>';
           const by = r
             ? `<div style="color:#777;font-size:11px">bewertet von ${esc(r.reviewedByName)} am ${new Date(r.reviewedAt).toLocaleString('de-DE')}${r.note ? ' · ' + esc(r.note) : ''}</div>`
             : '';
           return `<li>${new Date(a.at).toLocaleString('de-DE')} – ${esc(a.name || a.entityId || '')}: ${esc(ANOMALY_TEXT[a.type] || a.type)}${cls}${by}</li>`;
         })
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
    ${sd.anlagenName ? `<div style="font-size:15px;color:#333;margin-bottom:6px">Anlage: <b>${esc(sd.anlagenName)}</b></div>` : ''}
    ${incompleteBanner}
    ${banner}
    <div style="color:#666">${periodWord}: <b>${esc(p.label)}</b> &nbsp;(${fmt(p.start)} – ${fmt(
      new Date(p.end.getTime() - 1)
    )})${incomplete ? ' <span style="color:#dc2626;font-weight:600">· vorläufig, nicht abgeschlossen</span>' : ''}</div>
    ${
      sd.betreiber || sd.kunde
        ? `<table style="margin-top:12px;font-size:13px;border-collapse:collapse"><tr>
             <td style="vertical-align:top;padding-right:32px"><div style="color:#888">Betreiber</div>${esc(sd.betreiber).replace(/\n/g, '<br>') || '–'}</td>
             <td style="vertical-align:top"><div style="color:#888">Kunde</div>${esc(sd.kunde).replace(/\n/g, '<br>') || '–'}</td>
           </tr></table>`
        : ''
    }
    <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;margin-top:16px;font-size:13px;table-layout:fixed">
      <colgroup>
        <col style="width:25%" /><col style="width:12%" /><col style="width:12%" /><col style="width:12%" />
        <col style="width:12%" /><col style="width:14%" /><col style="width:13%" />
      </colgroup>
      <thead><tr style="background:#f3f4f6;text-align:left">
        <th style="padding:6px">Zähler</th><th>Rolle</th>
        <th style="text-align:right">Anfangsstand</th><th style="text-align:right">Endstand</th>
        <th style="text-align:right">Menge</th><th style="text-align:right">Tarif</th><th style="text-align:right">Betrag</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="padding:10px;color:#888">Keine Zähler konfiguriert.</td></tr>'}</tbody>
    </table>
    <table style="margin-top:16px;font-size:15px">
      ${t.grundgebuehr ? `<tr><td>Grundgebühr</td><td style="text-align:right;padding-left:24px">${eur(t.grundgebuehr)}</td></tr>` : ''}
      ${t.einspeiseManagement ? `<tr><td>Einspeisemanagement (anteilig, dem Betreiber abgezogen)</td><td style="text-align:right;padding-left:24px">−${eur(t.einspeiseManagement)}</td></tr>` : ''}
      <tr><td style="font-size:17px"><b>Summe</b></td><td style="text-align:right;padding-left:24px;font-size:17px"><b>${eur(
        t.total
      )}</b></td></tr>
    </table>
    ${buildMeterChart(billing)}
    ${buildReportCharts(billing.chart)}
    ${buildInfoStats(billing)}
    ${buildPriceTransparency(billing)}
    ${monthlyHtml}
    ${anomalyRows}
    ${
      billing.footer
        ? `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#444;font-size:13px;line-height:1.5">${esc(
            billing.footer
          ).replace(/\n/g, '<br>')}</div>`
        : ''
    }
    ${
      billing.finalized
        ? `<div style="margin-top:16px;font-size:12px;color:#555;border-top:1px solid #e5e7eb;padding-top:8px">
             <b>Beleg-Nr. ${billing.finalized.seq}${billing.finalized.correction ? ' (Korrektur)' : ''}</b> ·
             Prüfsumme ${esc(String(billing.finalized.hash).slice(0, 16))} · abgeschlossen am ${new Date(billing.finalized.at).toLocaleString('de-DE')}
             <div style="color:#888;margin-top:2px">Verbindlicher Beleg im manipulationssicheren Journal – die Werte werden nicht nachträglich aus der Statistik verändert.</div>
           </div>`
        : ''
    }
    <p style="color:#aaa;font-size:11px;margin-top:16px">Erstellt am ${new Date(
      billing.generatedAt
    ).toLocaleString('de-DE')} · Zählerstände sind bereinigte, monoton fortgeführte Werte.</p>
  </body></html>`;
}

function csvCell(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function buildCsv(billing) {
  const p = billing.period;
  const incomplete = p.end.getTime() > (billing.generatedAt || Date.now());
  const sd = billing.stammdaten || {};
  const out = [];
  if (sd.anlagenName) out.push(csvCell('Anlage') + ';' + csvCell(sd.anlagenName));
  if (sd.betreiber) out.push(csvCell('Betreiber') + ';' + csvCell(sd.betreiber.replace(/\n/g, ' ')));
  if (sd.kunde) out.push(csvCell('Kunde') + ';' + csvCell(sd.kunde.replace(/\n/g, ' ')));
  out.push(csvCell('Zeitraum') + ';' + csvCell(`${p.type} ${p.label}`));
  out.push(csvCell('Status') + ';' + csvCell(incomplete ? 'NICHT ABGESCHLOSSEN (vorläufig)' : 'abgeschlossen'));
  out.push('');

  const head = ['Zaehler', 'EntityId', 'Rolle', 'Anfangsstand_kWh', 'Endstand_kWh', 'Menge_kWh', 'Tarif_EUR_kWh', 'Betrag_EUR', 'Warnungen'];
  out.push(head.join(';'));
  for (const l of billing.lines) {
    out.push(
      [l.name, l.entityId, l.role, l.anfang ?? '', l.ende ?? '', l.kwh ?? '', l.tariff ?? '', l.amount ?? '', l.warnings.join(' | ')].map(csvCell).join(';')
    );
  }
  if (billing.totals.einspeiseManagement) out.push(`"Einspeisemanagement (anteilig)";;;;;;;"-${billing.totals.einspeiseManagement}";`);
  out.push(`"Summe";;;;;;;"${billing.totals.total}";`);

  const t = billing.totals;
  if (billing.showInfoStats && (t.autarkie != null || t.ersparnis)) {
    out.push('');
    out.push(csvCell('Auswertung'));
    if (t.autarkie != null) out.push([csvCell('Autarkiegrad_%'), csvCell(t.autarkie)].join(';'));
    out.push([csvCell('Aus_PV_kWh'), csvCell(t.pvKwh)].join(';'));
    out.push([csvCell('Aus_Netz_kWh'), csvCell(t.netzKwh)].join(';'));
    if (t.ersparnis) out.push([csvCell('Ersparnis_EUR'), csvCell(t.ersparnis)].join(';'));
  }

  // Jahresbericht: Monatsübersicht anhängen
  if (billing.monthly && billing.monthly.length) {
    out.push('');
    out.push(csvCell('Monatsübersicht'));
    out.push(['Monat', 'Status', 'Menge_kWh', 'Summe_EUR'].join(';'));
    for (const m of billing.monthly) {
      out.push([m.label, m.incomplete ? 'läuft' : 'abgeschlossen', monthlyPrimaryKwh(m), m.total].map(csvCell).join(';'));
    }
  }
  return out.join('\r\n');
}

module.exports = { buildHtml, buildCsv, subject, ANOMALY_TEXT };
