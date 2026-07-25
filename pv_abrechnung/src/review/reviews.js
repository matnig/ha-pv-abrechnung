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

// Markiert Bewertungen als „im Incident-Report dokumentiert" (mit Zeitstempel des Versands),
// damit der nächste Report nur noch NEUE (seit dem letzten Versand hinzugekommene) enthält.
function markReviewsReported(ids, at = Date.now()) {
  const reviews = loadReviews();
  for (const id of ids || []) {
    if (reviews[id]) reviews[id].reportedAt = at;
  }
  saveReviews(reviews);
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

module.exports = { anomalyId, loadReviews, listAnomalies, setReview, attachReviews, markReviewsReported, logIncidentReport, loadProtocol };
