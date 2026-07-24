'use strict';

const { readJson, writeJson } = require('./store/store');

// Vom Supervisor geschriebene Add-on-Optionen (nur simple Felder).
function options() {
  return readJson('options.json', {});
}

const DEFAULT_CONFIG = {
  meters: [
    // { id, name, entityId, role }
    // role: 'erzeugung' | 'einspeisung' | 'netzbezug' | 'verbrauch'
  ],
  // Virtuelle, fortlaufende Zähler als Linearkombination echter Zähler.
  // Beispiel „an Kunde geliefert" = Erzeugung − Einspeisung:
  //   { id, name, role:'lieferung', components:[{entityId:'sensor.pv', factor:1},{entityId:'sensor.feed', factor:-1}] }
  virtualMeters: [],
  tariffs: {
    verbrauch: 0.35, // €/kWh, an Partei verkaufter PV-/Reststrom
    netzbezug: 0.4, // €/kWh Netzbezug
    einspeisung: 0.08, // €/kWh Satz für die Einspeisemenge (nur Fall 2 relevant)
    grundgebuehr: 0, // € pauschal pro Abrechnungsperiode
    einspeisungAnBetreiber: true, // true: Betreiber bekommt Einspeisevergütung -> in Rechnung ignoriert
    einspeiseManagementJahr: 0, // €/Jahr Einspeisemanagement-Gebühr (nur Fall 2, anteilig abgezogen)
  },
  recipients: [], // Empfänger der Abrechnungs-Reports
  alertRecipients: [], // Empfänger der Störungs-/Untersuchungsmails (leer -> wie recipients)
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  schedule: { daily: false, monthly: true, yearly: true, hour: 6 },
  meterCfg: {
    resetToleranceKwh: 1,
    recoverToleranceKwh: 1,
    staleMinutes: 180,
    maxRateKwhPerHour: 100,
    investigateAfterMinutes: 10, // Abfall so lange offen -> "möglicher Fehler, wird untersucht"-Mail
    faultAfterMinutes: 120, // Abfall so lange offen -> "Störung"-Mail
  },
  // Periodenwerte primär aus HA-Long-Term-Statistics holen (reset-sicher, überlebt
  // Add-on-Downtime); bei false nur eigene Polling-Zählerstände nutzen.
  useStatistics: true,
};

function loadConfig() {
  const cfg = readJson('config.json', null);
  if (!cfg) {
    writeJson('config.json', DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  // fehlende Felder mit Defaults auffüllen (Vorwärtskompatibilität)
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    virtualMeters: cfg.virtualMeters || [],
    alertRecipients: cfg.alertRecipients || [],
    useStatistics: cfg.useStatistics !== false,
    tariffs: { ...DEFAULT_CONFIG.tariffs, ...(cfg.tariffs || {}) },
    smtp: { ...DEFAULT_CONFIG.smtp, ...(cfg.smtp || {}) },
    schedule: { ...DEFAULT_CONFIG.schedule, ...(cfg.schedule || {}) },
    meterCfg: { ...DEFAULT_CONFIG.meterCfg, ...(cfg.meterCfg || {}) },
  };
}

function saveConfig(cfg) {
  writeJson('config.json', cfg);
  return cfg;
}

function pollIntervalMinutes() {
  const o = options();
  return Number(o.poll_interval_minutes) || 10;
}

module.exports = { options, loadConfig, saveConfig, pollIntervalMinutes, DEFAULT_CONFIG };
