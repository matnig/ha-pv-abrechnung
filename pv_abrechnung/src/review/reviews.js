'use strict';

// Bewertung der Daten-Auffälligkeiten (Incident-Review).
//
// Auffälligkeiten (anomalies) werden je Zähler in den Snapshots protokolliert. Hier können sie
// im Dashboard kontrolliert, mit einem Text versehen und als „kritisch"/„unkritisch" eingestuft
// werden. Festgehalten wird zusätzlich, WELCHER Home-Assistant-Account die Bewertung WANN
// vorgenommen hat. Die Bewertungen fließen ins Monatsprotokoll (Bericht) und in die
// Dokumentations-Mail nach dem Absenden eines Incident-Reports.

const { readJson, writeJson } = require('../store/store');

const SNAP_FILE = 'snapshots.json';
const REVIEW_FILE = 'reviews.json';
const PROTO_FILE = 'incident_protocol.json';

// Stabile ID einer Auffälligkeit (überlebt das Neuschreiben der Snapshots).
function anomalyId(a) {
  return `${a.entityId || ''}#${a.at || 0}#${a.type || ''}`;
}

function loadReviews() {
  return readJson(REVIEW_FILE, {});
}
function saveReviews(r) {
  writeJson(REVIEW_FILE, r);
}

// Alle Auffälligkeiten aus den Snapshots einsammeln und mit ihrer Bewertung zusammenführen.
function listAnomalies(opts = {}) {
  const snap = opts.snapshots || readJson(SNAP_FILE, {});
  const reviews = loadReviews();
  const out = [];
  for (const [key, e] of Object.entries(snap)) {
    if (!e || !Array.isArray(e.anomalies)) continue; // _batteries/_battery etc. überspringen
    for (const a of e.anomalies) {
      const id = anomalyId({ ...a, entityId: a.entityId || key });
      out.push({
        id,
        entityId: a.entityId || key,
        name: a.name || key,
        type: a.type,
        at: a.at,
        from: a.from,
        oldFinal: a.oldFinal,
        newStart: a.newStart,
        text: a.text || null, // Bilanz-Meldungen bringen ihre eigene Erklärung mit
        detail: a.detail || null,
        review: reviews[id] || null,
      });
    }
  }
  out.sort((x, y) => (y.at || 0) - (x.at || 0));
  return out;
}

// Bewertung setzen. user = { id, name } aus den HA-Ingress-Headern.
// Einmal bewertete Auffälligkeiten sind UNVERÄNDERLICH (nachträglich nicht mehr änderbar) und
// wandern aus der aktiven Liste ins Archiv.
function setReview(id, { note, classification, user } = {}) {
  const reviews = loadReviews();
  if (reviews[id]) {
    const err = new Error('Diese Auffälligkeit wurde bereits bewertet und ist unveränderlich.');
    err.code = 'ALREADY_REVIEWED';
    throw err;
  }
  reviews[id] = {
    note: String(note || '').slice(0, 2000),
    classification: classification === 'kritisch' ? 'kritisch' : 'unkritisch',
    reviewedBy: (user && user.id) || null,
    reviewedByName: (user && user.name) || 'Unbekannt',
    reviewedAt: Date.now(),
  };
  saveReviews(reviews);
  return reviews[id];
}

// Bewertungen an eine Liste von Anomalien (z.B. aus computeBilling) anheften.
function attachReviews(anomalies) {
  const reviews = loadReviews();
  return (anomalies || []).map((a) => ({ ...a, id: anomalyId(a), review: reviews[anomalyId(a)] || null }));
}

// Auffälligkeiten eines Zeitbereichs (für den manuellen Export). Verändert NICHTS am
// inkrementellen Versand – bereits dokumentierte Einträge werden mitgeliefert und nur
// gekennzeichnet, reportedAt wird hier nie gesetzt.
function listAnomaliesInRange(fromMs, toMs, opts = {}) {
  const from = Number(fromMs);
  const to = Number(toMs);
  return listAnomalies(opts).filter((a) => {
    const t = Number(a.at) || 0;
    return (!Number.isFinite(from) || t >= from) && (!Number.isFinite(to) || t <= to);
  });
}

const ANOMALY_CSV_TEXT = {
  meter_swap: 'Zählertausch (manuell bestätigt)',
  technical_fault: 'STÖRUNG: Zählerabfall über 2 Std ohne Erholung',
  investigating: 'möglicher Zählerfehler – untersucht',
  offline: 'Sensor ausgefallen (untersucht)',
  offline_fault: 'STÖRUNG: Sensor über 2 Std offline',
  drop_detected: 'Zählerabfall erkannt',
  transient: 'kurzzeitige Störung (Wert kam zurück)',
  reset: 'Zähler-Reset (fortgeführt)',
  stale: 'Wert stand still (Sensor hängt/offline)',
  unavailable: 'Sensor nicht verfügbar',
  invalid: 'ungültiger Wert',
  jitter: 'kleiner Rückwärts-Sprung ignoriert',
  spike: 'unrealistischer Sprung nach oben',
  error: 'Lesefehler',
};

/** CSV-Export (Semikolon, deutsches Excel) der Auffälligkeiten inkl. Bewertung. */
function anomaliesCsv(anomalies, meta = {}) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const dt = (ms) => (ms ? new Date(ms).toLocaleString('de-DE') : '');
  const out = [];
  if (meta.anlagenName) out.push(cell('Anlage') + ';' + cell(meta.anlagenName));
  if (meta.from || meta.to) out.push(cell('Zeitraum') + ';' + cell(`${dt(meta.from)} – ${dt(meta.to)}`));
  out.push(cell('Exportiert am') + ';' + cell(dt(Date.now())) + (meta.by ? ';' + cell('von') + ';' + cell(meta.by) : ''));
  out.push('');
  out.push(['Zeit', 'Zaehler', 'EntityId', 'Typ', 'Beschreibung', 'Bewertung', 'Bewertungstext', 'Bewertet_von', 'Bewertet_am', 'Im_Report_dokumentiert_am'].join(';'));
  for (const a of anomalies || []) {
    const r = a.review || {};
    out.push(
      [
        dt(a.at),
        a.name || '',
        a.entityId || '',
        a.type || '',
        a.text || ANOMALY_CSV_TEXT[a.type] || a.type || '',
        r.classification || 'nicht bewertet',
        r.note || '',
        r.reviewedByName || '',
        r.reviewedAt ? dt(r.reviewedAt) : '',
        r.reportedAt ? dt(r.reportedAt) : '',
      ]
        .map(cell)
        .join(';')
    );
  }
  return out.join('\r\n');
}

// Markiert Bewertungen als „im Incident-Report dokumentiert" (mit Zeitstempel des Versands),
// damit der nächste Report nur noch NEUE (seit dem letzten Versand hinzugekommene) enthält.
function markReviewsReported(ids, at = Date.now()) {
  const reviews = loadReviews();
  for (const id of ids || []) {
    if (reviews[id]) reviews[id].reportedAt = at;
  }
  saveReviews(reviews);
}

/**
 * Entfernt UNBEWERTETE Auffälligkeiten einer Art aus den Snapshots. Gedacht für Einträge, die
 * durch eine überholte Prüfung entstanden sind (z.B. die früheren „Wert stand still"-Meldungen,
 * die bei Energiezählern zwangsläufig auftraten). Bereits bewertete Einträge bleiben
 * unangetastet – sie sind Teil der Dokumentation und unveränderlich.
 * @returns {{entfernt:number, behalten:number}}
 */
function purgeUnreviewed(types) {
  const arten = new Set(Array.isArray(types) ? types : [types]);
  const snap = readJson(SNAP_FILE, {});
  const reviews = loadReviews();
  let entfernt = 0;
  let behalten = 0;
  for (const [key, e] of Object.entries(snap)) {
    if (!e || !Array.isArray(e.anomalies)) continue;
    e.anomalies = e.anomalies.filter((a) => {
      if (!arten.has(a.type)) return true;
      const id = anomalyId({ ...a, entityId: a.entityId || key });
      if (reviews[id]) {
        behalten++;
        return true; // bewertete Einträge nie löschen
      }
      entfernt++;
      return false;
    });
  }
  if (entfernt) writeJson(SNAP_FILE, snap);
  return { entfernt, behalten };
}

// Protokoll der abgesendeten Incident-Reports (wer/wann/wie viele).
function logIncidentReport(entry) {
  const list = readJson(PROTO_FILE, []);
  list.push(entry);
  writeJson(PROTO_FILE, list.slice(-200));
  return entry;
}
function loadProtocol() {
  return readJson(PROTO_FILE, []);
}

module.exports = { anomalyId, loadReviews, listAnomalies, listAnomaliesInRange, anomaliesCsv, setReview, purgeUnreviewed, attachReviews, markReviewsReported, logIncidentReport, loadProtocol };
