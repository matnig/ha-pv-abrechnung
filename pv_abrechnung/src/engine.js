'use strict';

const { loadConfig } = require('./config');
const { loadSnapshots, pollOnce, commitAlert } = require('./meter/meterService');
const { sendAlert } = require('./mail/mailer');
const { computeBilling } = require('./billing/billing');
const { resolvePeriodReadings } = require('./billing/resolver');
const ledger = require('./billing/ledger');
const haClient = require('./ha/haClient');
const { buildPeriodSeries } = require('./report/periodSeries');
const { attachReviews } = require('./review/reviews');
const { monthPeriod } = require('./billing/periods');
const { buildHtml, buildCsv, subject } = require('./report/report');
const { sendReport } = require('./mail/mailer');
const { readJson, writeJson } = require('./store/store');

function logReport(record) {
  const hist = readJson('reports.json', []);
  hist.push(record);
  writeJson('reports.json', hist.slice(-200));
}

/**
 * Erstellt (und versendet optional) einen Report für eine Periode.
 * @param {object} period  aus billing/periods
 * @param {{send?:boolean, config?:object}} [opts]
 */
// Rekonstruiert ein billing-Objekt aus einem eingefrorenen Journal-Beleg (keine Neuberechnung).
function ledgerToBilling(e) {
  return {
    period: { type: e.periodType, label: e.periodLabel, start: new Date(e.start), end: new Date(e.end) },
    generatedAt: e.at,
    lines: (e.lines || []).map((l) => ({ ...l, source: 'beleg', warnings: [] })),
    totals: e.totals,
    anomalies: e.anomalies || [], // im Beleg eingefrorene Auffälligkeiten inkl. Bewertung
    monthly: e.monthly || undefined,
  };
}

async function runReport(period, opts = {}) {
  const config = opts.config || loadConfig();

  // Bereits abgeschlossene Periode -> eingefrorenen Beleg verwenden (KEINE Neuberechnung aus der
  // ggf. veränderten Statistik). Nur mit forceRecompute=true wird bewusst neu gerechnet (Korrektur).
  const finalized = !opts.forceRecompute ? ledger.findFinalized(period.type, period.label) : null;
  let billing;
  if (finalized) {
    billing = ledgerToBilling(finalized);
    billing.finalized = { seq: finalized.seq, at: finalized.at, hash: finalized.hash, correction: false };
  } else {
    const snapshots = loadSnapshots();
    const resolved = await resolvePeriodReadings(config, snapshots, period);
    billing = computeBilling(config, resolved, period, snapshots);

    // Jahresbericht: Monatsübersicht aller bereits begonnenen Monate ergänzen.
    if (period.type === 'year') {
      const year = period.start.getFullYear();
      const now = Date.now();
      billing.monthly = [];
      for (let m = 0; m < 12; m++) {
        const mp = monthPeriod(year, m);
        if (mp.start.getTime() > now) break;
        const rr = await resolvePeriodReadings(config, snapshots, mp);
        const mb = computeBilling(config, rr, mp, snapshots);
        billing.monthly.push({ label: mp.label, incomplete: mp.end.getTime() > now, total: mb.totals.total, kwhByRole: mb.totals.kwhByRole, amountByRole: mb.totals.amountByRole });
      }
    }
  }

  billing.footer = (config.reportFooter || '').trim();
  billing.tariffs = config.tariffs || {};
  billing.showInfoStats = config.showInfoStats !== false;
  // Stammdaten: bei abgeschlossener Periode aus dem Beleg (eingefroren), sonst aus der Config.
  billing.stammdaten = finalized
    ? finalized.stammdaten || { anlagenName: '', betreiber: '', kunde: '' }
    : { anlagenName: config.anlagenName || '', betreiber: config.betreiber || '', kunde: config.kunde || '' };
  // Akkus: im Bericht nur die Info „wird überwacht" (Namen), kein Live-Ladestand.
  billing.batteries = finalized
    ? finalized.batteries || []
    : (config.batteries || []).map((b) => ({ name: b.name, entityId: b.entityId }));
  // Bewertungen (kritisch/unkritisch, Text, Prüfer) an die Auffälligkeiten anheften – fürs
  // Monatsprotokoll im Bericht. Bei abgeschlossenem Beleg sind sie bereits eingefroren.
  if (!finalized) billing.anomalies = attachReviews(billing.anomalies);

  // Verlaufs-Diagramme (wie in der Übersicht) für jeden Bericht: Tag->Stunden, Woche/Monat->Tage,
  // Jahr->Monate, jeweils mit Vorperiode als Vergleich. Beim eingefrorenen Beleg wird das
  // gespeicherte Diagramm verwendet, damit der Beleg unverändert reproduzierbar bleibt.
  if (finalized) {
    billing.chart = finalized.chart || null;
  } else {
    try {
      billing.chart = await buildPeriodSeries(config, period, opts.ha || haClient);
    } catch (err) {
      console.warn('[report] Diagrammdaten nicht verfügbar:', err.message || err);
      billing.chart = null;
    }
  }

  // Beim Versand einer noch nicht abgeschlossenen Periode: Beleg vorbereiten (Prüfsumme steht dann
  // schon in der Mail); nach erfolgreichem Versand wird er ins Journal geschrieben.
  let pendingEntry = null;
  if (opts.send && !finalized) {
    pendingEntry = ledger.buildEntry(billing, config, { correction: !!opts.forceRecompute, recipients: config.recipients });
    billing.finalized = { seq: pendingEntry.seq, at: pendingEntry.at, hash: pendingEntry.hash, correction: !!opts.forceRecompute };
  }

  const html = buildHtml(billing);
  const csv = buildCsv(billing);
  const subj = subject(billing);
  const csvName = `abrechnung_${period.type}_${period.label}`.replace(/[^\w.-]+/g, '_') + '.csv';

  const record = {
    at: Date.now(),
    periodType: period.type,
    periodLabel: period.label,
    total: billing.totals.total,
    anomalies: billing.anomalies.length,
    sent: false,
  };

  let mail = null;
  if (opts.send) {
    try {
      mail = await sendReport(config, { subject: subj, html, csv, csvName });
      record.sent = true;
      record.recipients = config.recipients;
      if (pendingEntry) {
        const committed = ledger.commit(pendingEntry); // erst nach erfolgreichem Versand einfrieren
        record.beleg = committed.seq;
      }
    } catch (err) {
      record.error = String(err.message || err);
      logReport(record);
      throw err;
    }
  }
  logReport(record);
  return { billing, html, csv, subject: subj, csvName, mail };
}

/**
 * Ein Poll-Durchlauf inkl. Versand fälliger Eskalations-Alarme (10-Min-Untersuchung,
 * 2-Std-Störung). Bei Sendefehler bleibt die Benachrichtigung offen und wird beim
 * nächsten Poll erneut versucht.
 */
async function runPoll(opts = {}) {
  const config = opts.config || loadConfig();
  const res = await pollOnce(config, opts);
  for (const alert of res.alerts) {
    try {
      await sendAlert(config, alert);
      commitAlert(alert.entityId, alert.kind, res.at);
    } catch (err) {
      console.error(`[poll] Alarm-Mail (${alert.kind}, ${alert.name}) fehlgeschlagen:`, err.message);
    }
  }
  return res;
}

module.exports = { runReport, runPoll, logReport };
