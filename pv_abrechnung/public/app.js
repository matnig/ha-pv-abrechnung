'use strict';

// Relative URLs -> funktioniert unter dem Ingress-Basispfad von Home Assistant.
let config = null;
let entities = [];

const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  return data;
};
function flash(text, ok = true) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'err');
  setTimeout(() => (m.className = 'msg'), 5000);
}

async function loadEntities() {
  try {
    entities = await api('api/entities');
    const opts = entities.map((e) => `<option value="${e.entityId}">${e.name} (${e.state} ${e.unit})</option>`).join('');
    $('mEntity').innerHTML = opts;
    $('vCompEntity').innerHTML = opts;
    if (config) { renderVMeters(); renderDraftComponents(); } // Namen jetzt auflösbar
  } catch (e) {
    flash('Entitäten laden fehlgeschlagen: ' + e.message, false);
  }
}

function renderMeters() {
  $('meters').innerHTML = (config.meters || []).length
    ? `<table><thead><tr><th>Name</th><th>Entität</th><th>Rolle</th><th></th></tr></thead><tbody>${config.meters
        .map(
          (m, i) =>
            `<tr><td>${m.name}</td><td class="tag">${m.entityId}${m.unit ? ' · ' + m.unit : ''}</td><td>${m.role}</td>
             <td><button class="danger" onclick="delMeter(${i})">×</button></td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="mini">Noch keine Zähler.</p>';
}

function addMeter() {
  const entityId = $('mEntity').value;
  if (!entityId) return flash('Keine Entität gewählt', false);
  const ent = entities.find((e) => e.entityId === entityId);
  config.meters = config.meters || [];
  config.meters.push({ id: 'm' + Date.now(), name: $('mName').value || entityId, entityId, role: $('mRole').value, unit: ent ? ent.unit : '' });
  $('mName').value = '';
  renderMeters();
}
function delMeter(i) {
  config.meters.splice(i, 1);
  renderMeters();
}

// ---- Virtuelle Zähler ----
let draftComponents = [];
const entityName = (id) => (entities.find((e) => e.entityId === id) || {}).name || id;
const formulaText = (comps) =>
  (comps || []).map((c) => `${c.factor < 0 ? '−' : '+'} ${entityName(c.entityId)}`).join(' ').replace(/^\+ /, '');

function renderVMeters() {
  config.virtualMeters = config.virtualMeters || [];
  $('vmeters').innerHTML = config.virtualMeters.length
    ? `<table><thead><tr><th>Name</th><th>Formel</th><th>Rolle</th><th></th></tr></thead><tbody>${config.virtualMeters
        .map((v, i) => `<tr><td>${v.name}</td><td class="tag">${formulaText(v.components)}</td><td>${v.role}</td>
          <td><button class="danger" onclick="delVMeter(${i})">×</button></td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="mini">Noch keine virtuellen Zähler.</p>';
}

function renderDraftComponents() {
  $('vComponents').innerHTML = draftComponents.length
    ? draftComponents
        .map((c, i) => `<div class="tag" style="padding:2px 0">${c.factor < 0 ? '−' : '+'} ${entityName(c.entityId)} <a href="#" onclick="rmComponent(${i});return false">entfernen</a></div>`)
        .join('')
    : '<div class="mini">Noch keine Komponenten – Zähler wählen und „+ Komponente".</div>';
}

function addComponent() {
  const entityId = $('vCompEntity').value;
  if (!entityId) return;
  draftComponents.push({ entityId, factor: +$('vCompFactor').value });
  renderDraftComponents();
}
function rmComponent(i) {
  draftComponents.splice(i, 1);
  renderDraftComponents();
}

function addVirtual() {
  if (!draftComponents.length) return flash('Mindestens eine Komponente hinzufügen', false);
  config.virtualMeters = config.virtualMeters || [];
  config.virtualMeters.push({ id: 'v' + Date.now(), name: $('vName').value || 'Virtueller Zähler', role: $('vRole').value, components: draftComponents.slice() });
  draftComponents = [];
  $('vName').value = '';
  renderDraftComponents();
  renderVMeters();
  flash('Virtueller Zähler angelegt – nicht vergessen zu speichern.');
}
function delVMeter(i) {
  config.virtualMeters.splice(i, 1);
  renderVMeters();
}

function presetDelivered() {
  const pv = (config.meters || []).find((m) => m.role === 'erzeugung');
  const feed = (config.meters || []).find((m) => m.role === 'einspeisung');
  if (!pv || !feed) return flash('Dafür braucht es je einen Zähler mit Rolle „PV-Erzeugung" und „Einspeisung".', false);
  $('vName').value = 'An Kunde geliefert';
  $('vRole').value = 'lieferung';
  draftComponents = [{ entityId: pv.entityId, factor: 1 }, { entityId: feed.entityId, factor: -1 }];
  renderDraftComponents();
  flash('Vorlage gesetzt: Erzeugung − Einspeisung. Mit „+ Virt. Zähler anlegen" bestätigen.');
}

function fillForm() {
  const t = config.tariffs, s = config.schedule, sm = config.smtp;
  $('tVerbrauch').value = t.verbrauch; $('tNetzbezug').value = t.netzbezug;
  $('tEinspeisung').value = t.einspeisung; $('tGrund').value = t.grundgebuehr;
  $('tLieferung').value = t.lieferung ?? 0;
  $('recipients').value = (config.recipients || []).join(', ');
  $('alertRecipients').value = (config.alertRecipients || []).join(', ');
  $('sDaily').value = String(!!s.daily); $('sMonthly').value = String(!!s.monthly);
  $('sYearly').value = String(!!s.yearly); $('sHour').value = s.hour;
  $('smtpHost').value = sm.host; $('smtpPort').value = sm.port; $('smtpSecure').value = String(!!sm.secure);
  $('smtpUser').value = sm.user; $('smtpPass').value = sm.pass; $('smtpFrom').value = sm.from;
  $('useStats').checked = config.useStatistics !== false;
  renderMeters();
  renderVMeters();
  renderDraftComponents();
}

function collectForm() {
  config.tariffs = {
    verbrauch: +$('tVerbrauch').value, netzbezug: +$('tNetzbezug').value,
    einspeisung: +$('tEinspeisung').value, grundgebuehr: +$('tGrund').value,
    lieferung: +$('tLieferung').value,
  };
  config.recipients = $('recipients').value.split(',').map((x) => x.trim()).filter(Boolean);
  config.alertRecipients = $('alertRecipients').value.split(',').map((x) => x.trim()).filter(Boolean);
  config.schedule = {
    daily: $('sDaily').value === 'true', monthly: $('sMonthly').value === 'true',
    yearly: $('sYearly').value === 'true', hour: +$('sHour').value,
  };
  config.smtp = {
    host: $('smtpHost').value, port: +$('smtpPort').value, secure: $('smtpSecure').value === 'true',
    user: $('smtpUser').value, pass: $('smtpPass').value, from: $('smtpFrom').value,
  };
  config.useStatistics = $('useStats').checked;
}

const fmtEur = (n) => (n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const fmtKwh = (n) => (n == null ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 1 }));

async function loadStats() {
  await saveConfig(); // Auflösung/Datenquelle übernehmen
  try {
    const s = await api('api/stats', {
      method: 'POST',
      body: JSON.stringify({ granularity: $('statGran').value, count: +$('statCount').value }),
    });
    renderStats(s);
  } catch (e) {
    flash('Statistik fehlgeschlagen: ' + e.message, false);
  }
}

function renderStats(s) {
  // Balken: €-Netto je Periode (rot = Gutschrift/negativ)
  const max = Math.max(1, ...s.periods.map((p) => Math.abs(p.euro || 0)));
  const step = Math.max(1, Math.ceil(s.periods.length / 12)); // max ~12 Labels, sonst Überlappung
  $('statChart').innerHTML =
    '<div class="bars" style="margin-bottom:24px">' +
    s.periods
      .map((p, i) => {
        const h = Math.round((Math.abs(p.euro || 0) / max) * 110);
        const label = i % step === 0 || i === s.periods.length - 1 ? `<span>${p.label}</span>` : '';
        return `<div class="bar ${p.euro < 0 ? 'neg' : ''}" style="height:${h}px" title="${p.label}: ${fmtEur(p.euro)}">${label}</div>`;
      })
      .join('') +
    '</div><div class="mini" style="text-align:right">Balken = €-Netto je Periode (rot = Gutschrift)</div>';

  const head =
    '<tr><th>Periode</th>' +
    s.meters.map((m) => `<th class="num">${m.name}<div class="tag">kWh · ${m.source === 'statistics' ? 'HA' : 'Poll'}</div></th>`).join('') +
    '<th class="num">€ netto</th></tr>';
  const rows = s.periods
    .map(
      (p) =>
        `<tr><td>${p.label}</td>${s.meters.map((m) => `<td class="num">${fmtKwh(p.byMeter[m.id])}</td>`).join('')}<td class="num">${fmtEur(p.euro)}</td></tr>`
    )
    .join('');
  const sumEur = s.periods.reduce((a, p) => a + (p.euro || 0), 0);
  const foot =
    `<tr style="font-weight:600;border-top:2px solid var(--line)"><td>Σ</td>` +
    s.meters.map((m) => `<td class="num">${fmtKwh(s.totalsByMeter[m.id])}</td>`).join('') +
    `<td class="num">${fmtEur(sumEur)}</td></tr>`;
  $('statTable').innerHTML = `<table><thead>${head}</thead><tbody>${rows}${foot}</tbody></table>`;
}

async function saveConfig() {
  collectForm();
  try {
    config = await api('api/config', { method: 'PUT', body: JSON.stringify(config) });
    fillForm();
    flash('Gespeichert.');
  } catch (e) {
    flash('Speichern fehlgeschlagen: ' + e.message, false);
  }
}

async function testSmtp() {
  await saveConfig();
  try {
    await api('api/smtp/test', { method: 'POST' });
    flash('SMTP-Verbindung ok.');
  } catch (e) {
    flash('SMTP-Test fehlgeschlagen: ' + e.message, false);
  }
}

async function pollNow() {
  try {
    const r = await api('api/poll', { method: 'POST' });
    flash(`Gelesen: ${r.meters.length} Zähler.` + (r.alerts?.length ? ` ${r.alerts.length} Alarm-Mail(s).` : ''));
    loadStatus();
    loadIncidents();
  } catch (e) {
    flash('Lesen fehlgeschlagen: ' + e.message, false);
  }
}

async function loadIncidents() {
  try {
    const inc = await api('api/incidents');
    const card = $('incidentCard');
    if (!inc.length) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    $('incidents').innerHTML =
      `<table><thead><tr><th>Zähler</th><th>seit</th><th>alter Endstand</th><th>aktuell</th><th>Status</th><th></th></tr></thead><tbody>${inc
        .map((i) => {
          const status = i.notifiedFault ? '🔴 Störung (>2h)' : i.notifiedInvestigating ? '🟠 wird untersucht' : '🟡 erkannt';
          return `<tr><td>${i.name || i.entityId}</td><td>${new Date(i.since).toLocaleString('de-DE')}</td>
            <td class="num">${i.oldFinal ?? '–'}</td><td class="num">${i.current ?? '–'}</td><td>${status}</td>
            <td><button onclick="confirmSwap('${i.entityId}','${(i.name || i.entityId).replace(/'/g, '')}')">Zählertausch bestätigen</button></td></tr>`;
        })
        .join('')}</tbody></table>`;
  } catch (e) {
    /* still */
  }
}

async function confirmSwap(entityId, name) {
  if (!confirm(`Zählertausch für „${name}" bestätigen? Der alte Endstand wird konserviert, der Zähler läuft fortlaufend weiter.`)) return;
  try {
    const r = await api('api/incidents/' + encodeURIComponent(entityId) + '/swap', { method: 'POST' });
    flash(`Zählertausch bestätigt: alter Endstand ${r.oldFinal}, neuer Start ${r.newStart}. Läuft fort bei ${r.effective}.`);
    loadIncidents();
    loadStatus();
  } catch (e) {
    flash('Tausch fehlgeschlagen: ' + e.message, false);
  }
}

async function preview() {
  try {
    const r = await api('api/report/preview', { method: 'POST', body: JSON.stringify({ periodType: $('pType').value }) });
    $('previewWrap').style.display = 'block';
    $('preview').srcdoc = r.html;
  } catch (e) {
    flash('Vorschau fehlgeschlagen: ' + e.message, false);
  }
}

async function sendNow() {
  if (!confirm('Bericht jetzt an die Empfänger versenden?')) return;
  try {
    const r = await api('api/report/send', { method: 'POST', body: JSON.stringify({ periodType: $('pType').value }) });
    flash(`Versendet (${r.subject}), Summe ${r.total} €.`);
    loadStatus();
  } catch (e) {
    flash('Versand fehlgeschlagen: ' + e.message, false);
  }
}

async function loadStatus() {
  try {
    const s = await api('api/status');
    const meters = s.meters
      .map((m) => `<tr><td>${m.entityId}</td><td>${m.lastEffective ?? '–'}</td><td>${m.days} Tage</td>
        <td>${m.recentAnomalies.map((a) => a.type).join(', ') || '✓'}</td></tr>`)
      .join('');
    const reports = s.reports
      .map((r) => `<li>${new Date(r.at).toLocaleString('de-DE')} – ${r.periodType} ${r.periodLabel}: ${r.total} € ${r.sent ? '✉️' : ''} ${r.error ? '⚠ ' + r.error : ''}</li>`)
      .join('');
    $('status').innerHTML =
      `<table><thead><tr><th>Zähler</th><th>Stand</th><th>Historie</th><th>Auffälligkeiten</th></tr></thead><tbody>${meters}</tbody></table>` +
      (reports ? `<h3 style="font-size:13px">Letzte Berichte</h3><ul>${reports}</ul>` : '');
  } catch (e) {
    $('status').textContent = 'Status nicht verfügbar: ' + e.message;
  }
}

async function init() {
  try {
    config = await api('api/config');
    fillForm();
    await loadEntities();
    await loadStatus();
    await loadIncidents();
  } catch (e) {
    flash('Initialisierung fehlgeschlagen: ' + e.message, false);
  }
}
init();
