'use strict';

// Manipulationssicheres Abrechnungs-Journal (append-only, Hash-Kette).
//
// Ziel: Ein einmal versendeter Bericht ist ein verbindlicher Beleg. Seine Werte werden hier
// eingefroren gespeichert und NICHT mehr aus der (nachträglich änderbaren) HA-Statistik neu
// berechnet. Jeder Beleg enthält eine Prüfsumme (SHA-256), die den vorherigen Beleg einbezieht
// (Hash-Kette). Wird ein alter Beleg nachträglich verändert, passt seine Prüfsumme bzw. die des
// Folgebelegs nicht mehr -> Manipulation ist erkennbar (siehe verify()).

const crypto = require('crypto');
const { readJson, writeJson } = require('../store/store');

const FILE = 'ledger.json';

function load() {
  return readJson(FILE, []);
}

// Deterministische, hash-relevante Felder (ohne das hash-Feld selbst).
function contentOf(e) {
  return JSON.stringify({
    seq: e.seq,
    at: e.at,
    periodType: e.periodType,
    periodLabel: e.periodLabel,
    start: e.start,
    end: e.end,
    lines: e.lines,
    totals: e.totals,
    tariffs: e.tariffs,
    recipients: e.recipients,
    correction: e.correction,
    monthly: e.monthly || null,
    prevHash: e.prevHash,
  });
}

function hashEntry(e) {
  return crypto.createHash('sha256').update(contentOf(e)).digest('hex');
}

/**
 * Erstellt den Beleg (inkl. Prüfsumme) OHNE ihn zu speichern – so kann die Prüfsumme schon in
 * die zu versendende Mail, und erst nach erfolgreichem Versand wird commit() aufgerufen.
 * @param {object} meta { correction?:boolean, recipients?:string[] }
 */
function buildEntry(billing, config, meta = {}) {
  const ledger = load();
  const prev = ledger[ledger.length - 1];
  const entry = {
    seq: ledger.length + 1,
    at: Date.now(),
    periodType: billing.period.type,
    periodLabel: billing.period.label,
    start: new Date(billing.period.start).toISOString(),
    end: new Date(billing.period.end).toISOString(),
    lines: (billing.lines || []).map((l) => ({
      name: l.name,
      entityId: l.entityId,
      role: l.role,
      roleLabel: l.roleLabel,
      anfang: l.anfang,
      ende: l.ende,
      kwh: l.kwh,
      tariff: l.tariff,
      amount: l.amount,
      hinweis: l.hinweis || null,
    })),
    totals: billing.totals,
    tariffs: config.tariffs || {},
    recipients: meta.recipients || config.recipients || [],
    correction: !!meta.correction,
    monthly: billing.monthly || null,
    prevHash: prev ? prev.hash : '0',
  };
  entry.hash = hashEntry(entry);
  return entry;
}

// Beleg tatsächlich ins Journal schreiben (nach erfolgreichem Versand). Sichert die Kette:
// falls sich das Journal seit buildEntry geändert hat, prevHash/seq/hash neu setzen.
function commit(entry) {
  const ledger = load();
  const prev = ledger[ledger.length - 1];
  const fixed = { ...entry, seq: ledger.length + 1, prevHash: prev ? prev.hash : '0' };
  fixed.hash = hashEntry(fixed);
  ledger.push(fixed);
  writeJson(FILE, ledger);
  return fixed;
}

function appendReport(billing, config, meta = {}) {
  return commit(buildEntry(billing, config, meta));
}

// Letzter (nicht als Korrektur markierter) Beleg für einen Zeitraum, falls vorhanden.
function findFinalized(periodType, periodLabel) {
  return load()
    .filter((e) => e.periodType === periodType && e.periodLabel === periodLabel && !e.correction)
    .pop();
}

// Integrität der Hash-Kette prüfen.
function verify() {
  const ledger = load();
  let prevHash = '0';
  for (const e of ledger) {
    if (e.prevHash !== prevHash) return { ok: false, count: ledger.length, brokenAt: e.seq, reason: 'Kette unterbrochen (Beleg fehlt/umsortiert)' };
    if (hashEntry(e) !== e.hash) return { ok: false, count: ledger.length, brokenAt: e.seq, reason: 'Beleginhalt nachträglich verändert' };
    prevHash = e.hash;
  }
  return { ok: true, count: ledger.length };
}

module.exports = { buildEntry, commit, appendReport, findFinalized, verify, load, hashEntry };
