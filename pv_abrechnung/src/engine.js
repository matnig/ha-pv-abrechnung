'use strict';

const { loadConfig } = require('./config');
const { loadSnapshots, pollOnce, commitAlert } = require('./meter/meterService');
const { sendAlert } = require('./mail/mailer');
const { computeBilling } = require('./billing/billing');
const { resolvePeriodReadings } = require('./billing/resolver');
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
async function runReport(period, opts = {}) {
  const config = opts.config || loadConfig();
  const snapshots = loadSnapshots();
  const resolved = await resolvePeriodReadings(config, snapshots, period);
  const billing = computeBilling(config, resolved, period, snapshots);
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
