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
const { verify } = require('../mail/mailer');
const { readJson } = require('../store/store');
const { dayPeriod, previousMonth, previousYear, previousDay, monthPeriod, yearPeriod } = require('../billing/periods');

function resolvePeriod(body = {}) {
  const now = new Date();
  switch (body.periodType) {
    case 'day':
      return body.date ? dayPeriod(new Date(body.date)) : previousDay(now);
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
    res.json({ at: now, meters, reports: readJson('reports.json', []).slice(-20).reverse() });
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
