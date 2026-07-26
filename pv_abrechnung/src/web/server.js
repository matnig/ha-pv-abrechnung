'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig } = require('../config');
const haClient = require('../ha/haClient');
const { loadSnapshots, saveSnapshots, openIncidents, applySwap } = require('../meter/meterService');
const { backfillVirtual, earliestCommonDate } = require('../virtual/virtual');
const { runReport, runPoll } = require('../engine');
const ledger = require('../billing/ledger');
const { getSeries } = require('../stats/stats');
const { verify, sendIncidentReport } = require('../mail/mailer');
const reviews = require('../review/reviews');
const { buildOverview } = require('../overview/overview');
const { readJson } = require('../store/store');
const { dayPeriod, weekPeriod, previousMonth, previousYear, previousDay, previousWeek, monthPeriod, yearPeriod } = require('../billing/periods');

// Angemeldeter Home-Assistant-Nutzer aus den Ingress-Headern (vom Supervisor gesetzt).
function haUser(req) {
  return {
    id: req.get('X-Remote-User-Id') || null,
    name: req.get('X-Remote-User-Display-Name') || req.get('X-Remote-User-Name') || null,
  };
}

function resolvePeriod(body = {}) {
  const now = new Date();
  switch (body.periodType) {
    case 'day':
      return body.date ? dayPeriod(new Date(body.date)) : previousDay(now);
    case 'week':
      return body.date ? weekPeriod(new Date(body.date)) : previousWeek(now);
    case 'month':
      return body.year != null && body.month != null ? monthPeriod(Number(body.year), Number(body.month)) : previousMonth(now);
    case 'year':
      return body.year != null ? yearPeriod(Number(body.year)) : previousYear(now);
    default:
      return previousMonth(now);
  }
}

function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/version', (req, res) => res.json({ version: process.env.APP_VERSION || 'dev' }));

  app.get('/api/config', (req, res) => res.json(loadConfig()));

  app.put('/api/config', (req, res) => {
    try {
      const merged = { ...loadConfig(), ...req.body };
      saveConfig(merged);
      res.json(merged);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/entities', async (req, res) => {
    try {
      res.json(await haClient.listEnergyEntities());
    } catch (err) {
      console.error('[api/entities]', err && err.message ? err.message : err);
      res.status(502).json({ error: 'Entitäten von HA konnten nicht geladen werden: ' + String(err.message || err) });
    }
  });

  // Akku-Ladestände (%) – eigene Liste, da ein Ladestand kein Energiezähler ist.
  app.get('/api/entities/battery', async (req, res) => {
    try {
      res.json(await haClient.listBatteryEntities());
    } catch (err) {
      console.error('[api/entities/battery]', err && err.message ? err.message : err);
      res.status(502).json({ error: 'Akku-Entitäten von HA konnten nicht geladen werden: ' + String(err.message || err) });
    }
  });

  app.get('/api/status', (req, res) => {
    const snap = loadSnapshots();
    const config = loadConfig();
    const now = Date.now();
    const day = now - 24 * 60 * 60 * 1000;
    const hour = now - 60 * 60 * 1000;
    // Alle KONFIGURIERTEN Zähler anzeigen (auch wenn noch nicht gepollt), plus virtuelle.
    const items = [
      ...(config.meters || []).map((m) => ({ key: m.entityId, name: m.name, virtual: false })),
      ...(config.virtualMeters || []).map((v) => ({ key: 'virtual:' + v.id, name: v.name, virtual: true })),
    ];
    const meters = items.map((it) => {
      const e = snap[it.key] || {};
      const outages = (e.outages || []).filter((t) => t >= day);
      return {
        entityId: it.key,
        name: it.name,
        isVirtual: it.virtual,
        polled: e.lastTs != null,
        lastEffective: e.lastEffective ?? null,
        lastTs: e.lastTs ?? null,
        unit: e.unit || 'kWh',
        outages24h: outages.length,
        lastOutage: outages.length ? outages[outages.length - 1] : null,
        recentAnomalies: (e.anomalies || []).filter((a) => (a.at || 0) >= hour).slice(-5),
      };
    });
    const batteries = snap._batteries || (snap._battery ? [snap._battery] : []);
    res.json({ at: now, meters, batteries, reports: readJson('reports.json', []).slice(-20).reverse() });
  });

  // Tages-Übersicht (Startseite): Status + stündliche Energie heute/gestern + Sonnenstunden.
  app.get('/api/overview', async (req, res) => {
    try {
      res.json(await buildOverview(loadConfig(), loadSnapshots(), haClient));
    } catch (err) {
      res.json({ error: String(err.message || err), series: {}, summary: {} });
    }
  });

  // Anlagenbewertung: Zustand, Erweiterungsvarianten, Wirtschaftlichkeit, Tarifhebel.
  // Läuft länger (Statistik-Abfragen + PVGIS), daher grosszügiger Timeout im Frontend.
  app.post('/api/assess', async (req, res) => {
    try {
      const body = req.body || {};
      const config = loadConfig();
      const out = await require('../assess/assess').runAssessment(config, haClient, {
        zielAmortisation: body.zielAmortisation != null ? Number(body.zielAmortisation) : config.zielAmortisation,
        months: body.months != null ? Number(body.months) : 12,
        annahmen: body.annahmen || undefined,
        skipPvgis: !!body.skipPvgis,
      });
      res.json(out);
    } catch (err) {
      console.error('[api/assess]', (err && err.stack) || err);
      res.status(500).json({ error: String((err && err.message) || err) });
    }
  });

  // Manueller Incident-Report-Export für einen frei wählbaren Zeitbereich (Datum + Uhrzeit).
  // Enthält ALLE Auffälligkeiten des Zeitraums und lässt den inkrementellen Versand unberührt
  // (reportedAt wird hier nie gesetzt).
  app.get('/api/incident-report/export.csv', (req, res) => {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return res.status(400).json({ error: 'Zeitbereich ungültig (from/to als Millisekunden, to > from)' });
    }
    const config = loadConfig();
    const user = haUser(req);
    const anomalies = reviews.listAnomaliesInRange(from, to);
    const csv = reviews.anomaliesCsv(anomalies, { anlagenName: config.anlagenName, from, to, by: user.name || user.id || '' });
    const name = `incident_report_${new Date(from).toISOString().slice(0, 16)}_${new Date(to).toISOString().slice(0, 16)}`.replace(/[:]/g, '-') + '.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    // BOM, damit Excel deutsche Umlaute korrekt liest
    res.send('\uFEFF' + csv);
  });

  app.post('/api/incident-report/export', async (req, res) => {
    try {
      const { from, to } = req.body || {};
      const f = Number(from);
      const t = Number(to);
      if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) {
        return res.status(400).json({ error: 'Zeitbereich ungültig' });
      }
      const config = loadConfig();
      const user = haUser(req);
      const sentBy = user.name || user.id || 'Unbekannt';
      const anomalies = reviews.listAnomaliesInRange(f, t);
      if (!anomalies.length) return res.status(400).json({ error: 'Im gewählten Zeitraum liegen keine Auffälligkeiten.' });
      const sentAt = Date.now();
      const fmtDe = (ms) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const rangeLabel = `${fmtDe(f)} – ${fmtDe(t)}`;
      const mail = await sendIncidentReport(config, { anomalies, sentBy, sentAt, rangeLabel, manual: true });
      const critical = anomalies.filter((a) => a.review && a.review.classification === 'kritisch').length;
      const recips = (config.alertRecipients && config.alertRecipients.length ? config.alertRecipients : config.recipients) || [];
      reviews.logIncidentReport({ at: sentAt, by: sentBy, byId: user.id || null, count: anomalies.length, critical, recipients: recips, manual: true, from: f, to: t, rangeLabel });
      res.json({ ok: true, mail, count: anomalies.length, critical, by: sentBy, rangeLabel });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Daten-Auffälligkeiten (Incident-Review): offene (aktive) und bereits bewertete (Archiv).
  app.get('/api/anomalies', (req, res) => {
    const all = reviews.listAnomalies();
    res.json({
      open: all.filter((a) => !a.review),
      archived: all.filter((a) => a.review),
      protocol: reviews.loadProtocol().slice(-20).reverse(),
    });
  });

  app.post('/api/anomalies/review', (req, res) => {
    const { id, note, classification } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id fehlt' });
    try {
      const user = haUser(req);
      const review = reviews.setReview(id, { note, classification, user });
      res.json({ ok: true, id, review });
    } catch (err) {
      // Bereits bewertet -> unveränderlich (409), sonst 400.
      res.status(err.code === 'ALREADY_REVIEWED' ? 409 : 400).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/incident-report/send', async (req, res) => {
    try {
      const config = loadConfig();
      const user = haUser(req);
      const sentBy = user.name || user.id || 'Unbekannt';
      // Nur bewertete Auffälligkeiten, die im letzten Versand NOCH NICHT dabei waren (inkrementell).
      const anomalies = reviews.listAnomalies().filter((a) => a.review && !a.review.reportedAt);
      if (!anomalies.length) return res.status(400).json({ error: 'Keine neuen bewerteten Auffälligkeiten seit dem letzten Versand.' });
      const sentAt = Date.now();
      const mail = await sendIncidentReport(config, { anomalies, sentBy, sentAt });
      // Erst nach erfolgreichem Versand als dokumentiert markieren.
      reviews.markReviewsReported(anomalies.map((a) => a.id), sentAt);
      const critical = anomalies.filter((a) => a.review && a.review.classification === 'kritisch').length;
      const recips = (config.alertRecipients && config.alertRecipients.length ? config.alertRecipients : config.recipients) || [];
      reviews.logIncidentReport({ at: sentAt, by: sentBy, byId: user.id || null, count: anomalies.length, critical, recipients: recips });
      res.json({ ok: true, mail, count: anomalies.length, critical, by: sentBy });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/poll', async (req, res) => {
    try {
      res.json(await runPoll());
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/incidents', (req, res) => res.json(openIncidents()));

  // Abrechnungs-Journal: Belege + Integritätsprüfung der Hash-Kette.
  app.get('/api/ledger', (req, res) => {
    const entries = ledger.load().map((e) => ({
      seq: e.seq,
      at: e.at,
      periodType: e.periodType,
      periodLabel: e.periodLabel,
      total: e.totals && e.totals.total,
      correction: !!e.correction,
      recipients: e.recipients || [],
      hash: e.hash,
    }));
    res.json({ verify: ledger.verify(), entries: entries.reverse() });
  });

  // Frühestes gemeinsames Statistik-Datum der Komponenten (für den Startdatum-Picker).
  app.get('/api/virtual/:id/range', async (req, res) => {
    try {
      const vm = (loadConfig().virtualMeters || []).find((v) => v.id === req.params.id);
      if (!vm) return res.status(404).json({ error: 'Virtueller Zähler nicht gefunden' });
      const earliest = await earliestCommonDate(vm.components, haClient, loadSnapshots());
      res.json({ earliest, latest: new Date().toISOString().slice(0, 10) });
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
  });

  // Rückwirkende Berechnung des virtuellen Zählers aus der HA-Statistik.
  app.post('/api/virtual/:id/backfill', async (req, res) => {
    try {
      const vm = (loadConfig().virtualMeters || []).find((v) => v.id === req.params.id);
      if (!vm) return res.status(404).json({ error: 'Virtueller Zähler nicht gefunden' });
      if (req.body && req.body.startDate) vm.startDate = req.body.startDate;
      const snap = loadSnapshots();
      const summary = await backfillVirtual(vm, haClient, snap);
      saveSnapshots(snap);
      res.json(summary);
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/incidents/:entityId/swap', (req, res) => {
    const r = applySwap(req.params.entityId);
    if (!r.swapped) return res.status(400).json({ error: r.error || 'Tausch nicht möglich' });
    res.json({ ok: true, oldFinal: r.oldFinal, newStart: r.newStart, effective: r.state.effective });
  });

  app.post('/api/stats', async (req, res) => {
    try {
      const { granularity, count } = req.body || {};
      const series = await getSeries(loadConfig(), { granularity, count, snapshots: loadSnapshots() });
      res.json(series);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/report/preview', async (req, res) => {
    try {
      const out = await runReport(resolvePeriod(req.body), { send: false, forceRecompute: !!(req.body && req.body.forceRecompute) });
      res.json({ subject: out.subject, html: out.html, billing: out.billing });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/report/send', async (req, res) => {
    try {
      const out = await runReport(resolvePeriod(req.body), { send: true, forceRecompute: !!(req.body && req.body.forceRecompute) });
      res.json({ subject: out.subject, mail: out.mail, total: out.billing.totals.total });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/smtp/test', async (req, res) => {
    try {
      await verify(loadConfig().smtp);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err.message || err) });
    }
  });

  // index.html immer frisch ausliefern und app.js mit Versions-Query cache-busten,
  // damit nach einem Update garantiert die neue Oberfläche geladen wird.
  const publicDir = path.join(__dirname, '..', '..', 'public');
  const version = process.env.APP_VERSION || 'dev';
  app.get(['/', '/index.html'], (req, res) => {
    let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    html = html.replace(/(src|href)="((?:app|style)[^"?]*)"/g, `$1="$2?v=${encodeURIComponent(version)}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('html').send(html);
  });
  app.use(express.static(publicDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  return app;
}

module.exports = { createServer, resolvePeriod };
