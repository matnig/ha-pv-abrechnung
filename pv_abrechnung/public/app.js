'use strict';

// Relative URLs -> funktioniert unter dem Ingress-Basispfad von Home Assistant.
let config = null;
let entities = [];

const $ = (id) => document.getElementById(id);
// HTML-Escaping für alle in innerHTML eingesetzten Fremd-/Konfig-Strings (HA-Entitätsnamen,
// -Zustände, Zähler-/Berichts-Bezeichnungen). Schützt vor XSS über manipulierte Entitätsnamen.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    const opts = entities.map((e) => `<option value="${esc(e.entityId)}">${esc(e.name)} (${esc(e.state)} ${esc(e.unit)})</option>`).join('');
    $('mEntity').innerHTML = opts;
    $('vCompEntity').innerHTML = opts;
    if ($('bEntity')) $('bEntity').innerHTML = opts;
    if (config) { renderVMeters(); renderDraftComponents(); renderBatteries(); } // Namen jetzt auflösbar
  } catch (e) {
    flash('Entitäten laden fehlgeschlagen: ' + e.message, false);
  }
}

function renderMeters() {
  $('meters').innerHTML = (config.meters || []).length
    ? `<table><thead><tr><th>Name</th><th>Entität</th><th>Rolle</th><th></th></tr></thead><tbody>${config.meters
        .map(
          (m, i) =>
            `<tr><td>${esc(m.name)}</td><td class="tag">${esc(m.entityId)}${m.unit ? ' · ' + esc(m.unit) : ''}</td><td>${esc(m.role)}</td>
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

// ---- Akkus (nur Status/Fehlalarm-Erkennung, nicht im Bericht als Wert) ----
function renderBatteries() {
  const el = $('batteries');
  if (!el) return;
  const list = config.batteries || [];
  el.innerHTML = list.length
    ? `<table><thead><tr><th>Name</th><th>Entität</th><th></th></tr></thead><tbody>${list
        .map((b, i) => `<tr><td>${esc(b.name || '')}</td><td class="tag">${esc(b.entityId)}</td><td><button class="danger" onclick="delBattery(${i})">×</button></td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="mini">Noch keine Akkus.</p>';
}
function addBattery() {
  const entityId = $('bEntity').value;
  if (!entityId) return flash('Keine Akku-Entität gewählt', false);
  const ent = entities.find((e) => e.entityId === entityId);
  config.batteries = config.batteries || [];
  config.batteries.push({ id: 'bat' + Date.now(), name: $('bName').value || (ent ? ent.name : entityId), entityId });
  $('bName').value = '';
  renderBatteries();
}
function delBattery(i) {
  config.batteries.splice(i, 1);
  renderBatteries();
}

// ---- Virtuelle Zähler ----
let draftComponents = [];
const entityName = (id) => (entities.find((e) => e.entityId === id) || {}).name || id;
const formulaText = (comps) =>
  (comps || []).map((c) => `${c.factor < 0 ? '−' : '+'} ${esc(entityName(c.entityId))}`).join(' ').replace(/^\+ /, '');

function renderVMeters() {
  config.virtualMeters = config.virtualMeters || [];
  $('vmeters').innerHTML = config.virtualMeters.length
    ? `<table><thead><tr><th>Name</th><th>Formel</th><th>Startdatum</th><th>Rückwirkend</th><th></th></tr></thead><tbody>${config.virtualMeters
        .map(
          (v, i) => `<tr>
            <td>${esc(v.name)}<div class="tag">${esc(v.role)}</div></td>
            <td class="tag">${formulaText(v.components)}</td>
            <td><input type="date" value="${v.startDate || ''}" onchange="setVmStart(${i}, this.value)" style="max-width:150px" />
                <div class="mini"><a href="#" onclick="vmRange(${i});return false">frühestes Datum ermitteln</a></div></td>
            <td><button class="sec" onclick="vmBackfill(${i})">berechnen</button></td>
            <td><button class="danger" onclick="delVMeter(${i})">×</button></td>
          </tr>`
        )
        .join('')}</tbody></table>
      <p class="mini">Rückwirkend berechnen holt die Werte beider Zähler aus der HA-Statistik ab dem Startdatum und rechnet den virtuellen Zähler nach (nie negativ).</p>`
    : '<p class="mini">Noch keine virtuellen Zähler.</p>';
}

function setVmStart(i, val) {
  config.virtualMeters[i].startDate = val || undefined;
}

async function vmRange(i) {
  const vm = config.virtualMeters[i];
  await saveConfig();
  try {
    const r = await api('api/virtual/' + encodeURIComponent(vm.id) + '/range');
    if (!r.earliest) return flash('Keine Statistik für die Komponenten gefunden.', false);
    vm.startDate = r.earliest;
    renderVMeters();
    flash('Frühestes gemeinsames Datum: ' + r.earliest + ' – als Startdatum gesetzt.');
  } catch (e) {
    flash('Zeitraum ermitteln fehlgeschlagen: ' + e.message, false);
  }
}

async function vmBackfill(i) {
  const vm = config.virtualMeters[i];
  await saveConfig();
  try {
    const r = await api('api/virtual/' + encodeURIComponent(vm.id) + '/backfill', { method: 'POST', body: JSON.stringify({ startDate: vm.startDate }) });
    const det = (r.components || []).map((c) => `${entityName(c.entityId)} (${c.factor > 0 ? '+' : ''}${c.factor}): Δ ${c.delta} kWh`).join(' · ');
    flash(`Berechnet ab ${r.startDate} (${r.days} Tage). Stand: ${r.currentStand} kWh. — ${det}`);
    $('vmeters').insertAdjacentHTML(
      'afterend',
      `<div class="hint" id="vmDetail" style="margin-top:6px">Aufschlüsselung ${esc(vm.name)}: ${esc(det)}. „geliefert" = Summe der faktorisierten Zuwächse, bei 0 gedeckelt.</div>`
    );
    const old = document.querySelectorAll('#vmDetail');
    if (old.length > 1) old[0].remove();
    loadStatus();
  } catch (e) {
    flash('Rückwirkende Berechnung fehlgeschlagen: ' + e.message, false);
  }
}

function renderDraftComponents() {
  $('vComponents').innerHTML = draftComponents.length
    ? draftComponents
        .map((c, i) => `<div class="tag" style="padding:2px 0">${c.factor < 0 ? '−' : '+'} ${esc(entityName(c.entityId))} <a href="#" onclick="rmComponent(${i});return false">entfernen</a></div>`)
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
  $('tEinspBetreiber').checked = t.einspeisungAnBetreiber !== false;
  $('tEinspMgmt').value = t.einspeiseManagementJahr ?? 0;
  $('tNetzpreis').value = t.netzpreis ?? 0;
  renderWizard();
  $('recipients').value = (config.recipients || []).join(', ');
  $('alertRecipients').value = (config.alertRecipients || []).join(', ');
  $('reportFooter').value = config.reportFooter || '';
  $('anlagenName').value = config.anlagenName || '';
  $('betreiber').value = config.betreiber || '';
  $('kunde').value = config.kunde || '';
  $('sDaily').value = String(!!s.daily); $('sMonthly').value = String(!!s.monthly);
  $('sYearly').value = String(!!s.yearly); $('sHour').value = s.hour;
  $('smtpHost').value = sm.host; $('smtpPort').value = sm.port; $('smtpSecure').value = String(!!sm.secure);
  $('smtpUser').value = sm.user; $('smtpPass').value = sm.pass; $('smtpFrom').value = sm.from;
  $('useStats').checked = config.useStatistics !== false;
  renderMeters();
  renderVMeters();
  renderDraftComponents();
  renderBatteries();
}

function collectForm() {
  config.tariffs = {
    verbrauch: +$('tVerbrauch').value, netzbezug: +$('tNetzbezug').value,
    einspeisung: +$('tEinspeisung').value, grundgebuehr: +$('tGrund').value,
    lieferung: +$('tLieferung').value,
    einspeisungAnBetreiber: $('tEinspBetreiber').checked,
    einspeiseManagementJahr: +$('tEinspMgmt').value,
    netzpreis: +$('tNetzpreis').value,
  };
  config.recipients = $('recipients').value.split(',').map((x) => x.trim()).filter(Boolean);
  config.alertRecipients = $('alertRecipients').value.split(',').map((x) => x.trim()).filter(Boolean);
  config.reportFooter = $('reportFooter').value;
  config.anlagenName = $('anlagenName').value;
  config.betreiber = $('betreiber').value;
  config.kunde = $('kunde').value;
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

// ---- Einrichtungshilfe (Ja/Nein-Wizard) ----
function wizBtn(label, active, onclick) {
  return `<button class="${active ? '' : 'sec'}" style="min-width:64px" onclick="${onclick}">${label}</button>`;
}
function renderWizard() {
  if (!config) return;
  config.tariffs = config.tariffs || {};
  const einsp = config.tariffs.einspeisungAnBetreiber !== false;
  const info = config.showInfoStats !== false;
  $('wizard').innerHTML =
    `<div style="margin:8px 0;padding-bottom:10px;border-bottom:1px solid var(--line)">
      <div><b>1. Bekommst DU (Anlagenbetreiber) die Einspeisevergütung vom Netzbetreiber?</b></div>
      <div class="hint">Ja = der überschüssige, ins Netz eingespeiste Strom ist deine Einnahme und taucht in der Kundenrechnung nicht auf. Nein = der Kunde bekommt die Vergütung, dann wird ihm die Einspeisemenge berechnet und dir die Einspeisemanagement-Gebühr abgezogen.</div>
      <div style="margin-top:6px;display:flex;gap:8px">${wizBtn('Ja', einsp, 'wizEinsp(true)')}${wizBtn('Nein', !einsp, 'wizEinsp(false)')}</div>
    </div>
    <div style="margin:8px 0;padding-bottom:10px;border-bottom:1px solid var(--line)">
      <div><b>2. Soll der Bericht die Ersparnis des Kunden gegenüber Netzstrom zeigen?</b></div>
      <div class="hint">Ja = im Bericht erscheinen Autarkiegrad (PV-Anteil) und die Ersparnis. Dafür unten bei den Tarifen den „Netzbetreiber-Strompreis" eintragen.</div>
      <div style="margin-top:6px;display:flex;gap:8px">${wizBtn('Ja', info, 'wizInfo(true)')}${wizBtn('Nein', !info, 'wizInfo(false)')}</div>
    </div>
    <div style="margin:8px 0">
      <div><b>3. Zieht der Kunde auch Strom aus dem öffentlichen Netz (wenn die PV nicht reicht)?</b></div>
      <div class="hint">Wenn ja: oben unter „Zähler" den Netzbezugs-Zähler mit Rolle <b>„Netzbezug"</b> anlegen und bei den Tarifen den Netzbezug-Preis eintragen. Nur dann lassen sich Autarkiegrad und Ersparnis berechnen.</div>
    </div>
    <p class="mini">Nicht vergessen: unten <b>„Speichern"</b>.</p>`;
}
function wizEinsp(v) {
  config.tariffs = config.tariffs || {};
  config.tariffs.einspeisungAnBetreiber = v;
  $('tEinspBetreiber').checked = v;
  renderWizard();
  flash(v ? 'Eingestellt: du bekommst die Einspeisevergütung (nicht auf der Kundenrechnung).' : 'Eingestellt: der Kunde bekommt die Vergütung (wird ihm berechnet).');
}
function wizInfo(v) {
  config.showInfoStats = v;
  renderWizard();
  flash(v ? 'Auswertung (Autarkie/Ersparnis) wird im Bericht angezeigt.' : 'Auswertung ausgeblendet.');
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
        const label = i % step === 0 || i === s.periods.length - 1 ? `<span>${esc(p.label)}</span>` : '';
        return `<div class="bar ${p.euro < 0 ? 'neg' : ''}" style="height:${h}px" title="${esc(p.label)}: ${fmtEur(p.euro)}">${label}</div>`;
      })
      .join('') +
    '</div><div class="mini" style="text-align:right">Balken = €-Netto je Periode (rot = Gutschrift)</div>';

  const head =
    '<tr><th>Periode</th>' +
    s.meters.map((m) => `<th class="num">${esc(m.name)}<div class="tag">kWh · ${m.source === 'statistics' ? 'HA' : 'Poll'}</div></th>`).join('') +
    '<th class="num">€ netto</th></tr>';
  const rows = s.periods
    .map(
      (p) =>
        `<tr><td>${esc(p.label)}</td>${s.meters.map((m) => `<td class="num">${fmtKwh(p.byMeter[m.id])}</td>`).join('')}<td class="num">${fmtEur(p.euro)}</td></tr>`
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
    loadAnomalies();
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
          return `<tr><td>${esc(i.name || i.entityId)}</td><td>${new Date(i.since).toLocaleString('de-DE')}</td>
            <td class="num">${i.oldFinal ?? '–'}</td><td class="num">${i.current ?? '–'}</td><td>${status}</td>
            <td><button onclick="confirmSwap('${i.entityId}','${(i.name || i.entityId).replace(/'/g, '')}')">Zählertausch bestätigen</button></td></tr>`;
        })
        .join('')}</tbody></table>`;
  } catch (e) {
    /* still */
  }
}

// ---- Daten-Auffälligkeiten kontrollieren ----
const ANOMALY_LABEL = {
  meter_swap: 'Zählertausch (manuell bestätigt)', technical_fault: 'STÖRUNG: Abfall >2h ohne Erholung',
  investigating: 'möglicher Zählerfehler (untersucht)', offline: 'Sensor ausgefallen (untersucht)',
  offline_fault: 'STÖRUNG: Sensor >2h offline', reset: 'Zähler-Reset (fortgeführt)',
  stale: 'Wert stand still', unavailable: 'Sensor nicht verfügbar', spike: 'unrealistischer Sprung',
  jitter: 'kleiner Rückwärts-Sprung', transient: 'kurzzeitige Störung (Wert kam zurück)', error: 'Lesefehler',
};

let archivedAnomalies = [];
function anomalyBadge(r) {
  return r
    ? r.classification === 'kritisch'
      ? '<span style="color:#b91c1c;font-weight:600">● kritisch</span>'
      : '<span style="color:#166534;font-weight:600">● unkritisch</span>'
    : '<span style="color:#b45309">● nicht bewertet</span>';
}

async function loadAnomalies() {
  try {
    const d = await api('api/anomalies');
    const open = d.open || [];
    archivedAnomalies = d.archived || [];
    // Aktive (noch nicht bewertete) Auffälligkeiten – mit Bewertungs-Buttons.
    $('anomalies').innerHTML = open.length
      ? open
          .map((a) => {
            return `<div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <div><b>${esc(a.name || a.entityId)}</b> – ${esc(ANOMALY_LABEL[a.type] || a.type)}
                  <span class="tag">${new Date(a.at).toLocaleString('de-DE')}</span></div>
                <div>${anomalyBadge(null)}</div>
              </div>
              <div class="row" style="margin-top:6px">
                <div style="flex:2"><input id="note_${esc(a.id)}" placeholder="Bewertungstext…" /></div>
                <div style="max-width:150px"><button class="sec" onclick="reviewAnomaly('${encodeURIComponent(a.id)}','unkritisch')">unkritisch</button></div>
                <div style="max-width:150px"><button class="danger" onclick="reviewAnomaly('${encodeURIComponent(a.id)}','kritisch')">kritisch</button></div>
              </div>
              <div class="hint">Nach dem Bewerten unveränderlich – der Eintrag wandert ins Archiv.</div></div>`;
          })
          .join('')
      : '<p style="color:#16a34a">✓ Keine offenen Auffälligkeiten.</p>';

    // Archiv (bereits bewertet) neu rendern, falls gerade eingeblendet.
    if ($('anomaliesArchive').style.display !== 'none') renderArchive();

    const proto = d.protocol || [];
    $('incidentProtocol').innerHTML = proto.length
      ? '<b>Abgesendete Incident-Reports:</b><ul>' + proto
          .map((p) => `<li>${new Date(p.at).toLocaleString('de-DE')} – von ${esc(p.by)}: ${p.count} Auffälligkeiten (${p.critical} kritisch)</li>`)
          .join('') + '</ul>'
      : '';
  } catch (e) {
    $('anomalies').textContent = 'Auffälligkeiten nicht ladbar: ' + e.message;
  }
}

async function reviewAnomaly(encId, classification) {
  const id = decodeURIComponent(encId);
  const note = ($('note_' + id) || {}).value || '';
  try {
    await api('api/anomalies/review', { method: 'POST', body: JSON.stringify({ id, note, classification }) });
    flash(`Als „${classification}" bewertet.`);
    loadAnomalies();
  } catch (e) {
    flash('Bewertung fehlgeschlagen: ' + e.message, false);
  }
}

async function sendIncidentReport() {
  if (!confirm('Incident-Report jetzt absenden? Es werden nur die seit dem letzten Versand neu bewerteten Auffälligkeiten dokumentiert.')) return;
  try {
    const r = await api('api/incident-report/send', { method: 'POST', body: JSON.stringify({}) });
    flash(`Incident-Report versendet: ${r.count} neue Auffälligkeiten (${r.critical} kritisch), abgesendet von ${r.by}.`);
    loadAnomalies();
  } catch (e) {
    flash('Incident-Report fehlgeschlagen: ' + e.message, false);
  }
}

function renderArchive() {
  const el = $('anomaliesArchive');
  el.innerHTML = archivedAnomalies.length
    ? '<b>Bearbeitete Auffälligkeiten (unveränderlich):</b>' + archivedAnomalies
        .map((a) => {
          const r = a.review;
          return `<div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-top:8px;background:#fafafa">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
              <div><b>${esc(a.name || a.entityId)}</b> – ${esc(ANOMALY_LABEL[a.type] || a.type)}
                <span class="tag">${new Date(a.at).toLocaleString('de-DE')}</span></div>
              <div>${anomalyBadge(r)} ${r.reportedAt ? '<span class="tag">✉ dokumentiert</span>' : '<span class="tag" style="color:#b45309">noch nicht dokumentiert</span>'}</div>
            </div>
            <div class="tag">bewertet von ${esc(r.reviewedByName)} am ${new Date(r.reviewedAt).toLocaleString('de-DE')}${r.note ? ' · ' + esc(r.note) : ''}${r.reportedAt ? ' · im Report vom ' + new Date(r.reportedAt).toLocaleString('de-DE') : ''}</div>
          </div>`;
        })
        .join('')
    : '<p class="mini">Noch keine bearbeiteten Auffälligkeiten.</p>';
}

function toggleArchive() {
  const el = $('anomaliesArchive');
  if (el.style.display === 'none') {
    renderArchive();
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
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

function periodBody() {
  const now = new Date();
  const force = $('forceRecompute') && $('forceRecompute').checked;
  const base = { forceRecompute: force };
  switch ($('pType').value) {
    case 'cur_month':
      return { ...base, periodType: 'month', year: now.getFullYear(), month: now.getMonth() };
    case 'prev_year':
      return { ...base, periodType: 'year' };
    case 'cur_year':
      return { ...base, periodType: 'year', year: now.getFullYear() };
    case 'yesterday':
      return { ...base, periodType: 'day' };
    case 'prev_month':
    default:
      return { ...base, periodType: 'month' };
  }
}

async function preview() {
  try {
    const r = await api('api/report/preview', { method: 'POST', body: JSON.stringify(periodBody()) });
    $('previewWrap').style.display = 'block';
    $('preview').srcdoc = r.html;
  } catch (e) {
    flash('Vorschau fehlgeschlagen: ' + e.message, false);
  }
}

async function sendNow() {
  if (!confirm('Bericht jetzt an die Empfänger versenden?')) return;
  try {
    const r = await api('api/report/send', { method: 'POST', body: JSON.stringify(periodBody()) });
    flash(`Versendet (${r.subject}), Summe ${r.total} €.`);
    loadStatus();
    loadLedger();
  } catch (e) {
    flash('Versand fehlgeschlagen: ' + e.message, false);
  }
}

function agoText(ts, nowRef) {
  if (!ts) return '–';
  const min = Math.round(((nowRef || Date.now()) - ts) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `vor ${h} h` : `vor ${Math.floor(h / 24)} Tagen`;
}

async function loadStatus() {
  try {
    const s = await api('api/status');
    const meters = s.meters
      .map((m) => {
        const val = m.lastEffective != null
          ? m.lastEffective.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' ' + esc(m.unit || 'kWh')
          : m.polled ? '–' : '<span style="color:#999">noch nicht gelesen</span>';
        const out = !m.polled
          ? '<span style="color:#999">–</span>'
          : m.outages24h > 0
            ? `<span style="color:#dc2626">${m.outages24h}× (zuletzt ${agoText(m.lastOutage, s.at)})</span>`
            : '<span style="color:#16a34a">0 ✓</span>';
        return `<tr><td>${m.isVirtual ? '∑ ' : ''}${esc(m.name)}<div class="tag">${esc(m.entityId)}</div></td><td class="num"><b>${val}</b></td><td>${m.polled ? agoText(m.lastTs, s.at) : '–'}</td><td>${out}</td></tr>`;
      })
      .join('');
    const reports = s.reports
      .map((r) => `<li>${new Date(r.at).toLocaleString('de-DE')} – ${esc(r.periodType)} ${esc(r.periodLabel)}: ${r.total} € ${r.sent ? '✉️' : ''} ${r.error ? '⚠ ' + esc(r.error) : ''}</li>`)
      .join('');
    const bat = (s.batteries || []).length
      ? '<div style="margin:8px 0;font-size:14px">🔋 ' + s.batteries
          .map((b) => `${esc(b.name || b.entityId)}: <b>${b.value != null ? b.value + esc(b.unit || '%') : '–'}</b> <span class="tag">(${agoText(b.ts, s.at)})</span>`)
          .join(' · ') + '</div>'
      : '';
    $('status').innerHTML =
      bat +
      `<table><thead><tr><th>Zähler</th><th class="num">Live-Wert</th><th>zuletzt gelesen</th><th>Ausfälle (24h)</th></tr></thead><tbody>${meters}</tbody></table>` +
      (reports ? `<h3 style="font-size:13px">Letzte Berichte</h3><ul>${reports}</ul>` : '');
  } catch (e) {
    $('status').textContent = 'Status nicht verfügbar: ' + e.message;
  }
}

async function loadVersion() {
  try {
    const v = await api('api/version');
    $('ver').textContent = 'v' + v.version;
  } catch {
    /* egal */
  }
}

async function loadLedger() {
  try {
    const d = await api('api/ledger');
    const v = d.verify.ok
      ? `<span style="color:#16a34a">✓ Journal unversehrt (${d.verify.count} Belege)</span>`
      : `<span style="color:#dc2626">⚠ Manipulation erkannt bei Beleg #${d.verify.brokenAt}: ${d.verify.reason}</span>`;
    const rows = d.entries
      .map((e) => `<tr><td>#${e.seq}${e.correction ? ' (Korr.)' : ''}</td><td>${new Date(e.at).toLocaleString('de-DE')}</td><td>${e.periodType} ${e.periodLabel}</td><td class="num">${fmtEur(e.total)}</td><td class="tag">${(e.hash || '').slice(0, 12)}</td></tr>`)
      .join('');
    $('ledger').innerHTML =
      `<div style="margin-bottom:8px">${v}</div>` +
      (rows
        ? `<table><thead><tr><th>Beleg</th><th>erstellt</th><th>Zeitraum</th><th class="num">Summe</th><th>Prüfsumme</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<span class="mini">Noch keine Belege – beim Versand eines Berichts wird hier ein Beleg eingetragen.</span>');
  } catch (e) {
    $('ledger').textContent = 'Journal nicht verfügbar: ' + e.message;
  }
}

// ---- Tab-Navigation ----
function showTab(name) {
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'overview') loadOverview();
  else if (name === 'incident') loadAnomalies();
  else if (name === 'abrechnung') loadLedger();
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
  window.scrollTo(0, 0);
}

// ---- Übersicht: Status + stündliche Energie heute/gestern + Sonnenstunden ----
const ROLE_META = {
  erzeugung: { label: 'PV-Erzeugung', color: '#16a34a' },
  verbrauch: { label: 'Verbrauch', color: '#2563eb' },
  netzbezug: { label: 'Netzbezug', color: '#f59e0b' },
  einspeisung: { label: 'Einspeisung', color: '#0d9488' },
};

function hourBars(arr, max, color, faded) {
  return '<div class="daychart">' + (arr || [])
    .map((v, h) => {
      const ht = Math.round((v / (max || 1)) * 88);
      return `<div class="b" style="height:${Math.max(1, ht)}px;background:${color};opacity:${faded ? 0.35 : 0.9}" title="${h}:00 – ${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh"></div>`;
    })
    .join('') + '</div>';
}

function renderDayChart(o) {
  const roles = o.roles || [];
  if (!roles.length) {
    $('overviewChart').innerHTML = '<p class="mini">Keine Zähler mit Rolle Erzeugung/Verbrauch/Netz konfiguriert – unter „Einstellungen → Zähler" zuordnen.</p>';
    return;
  }
  const sun = o.sunHours || {};
  const sunKpi = sun.today != null
    ? `<span class="kpi">☀️ Sonnenstunden heute: <b>${sun.today}</b> · gestern: <b>${sun.yesterday}</b></span>`
    : '';
  const blocks = roles
    .map((role) => {
      const s = o.series[role] || {};
      const m = ROLE_META[role] || { label: role, color: '#6b7280' };
      const max = Math.max(0.001, ...(s.today || []), ...(s.yesterday || []));
      return `<div class="ov-role">
        <div class="ov-head"><b style="color:${m.color}">${m.label}</b>
          <span>heute <b>${(s.todaySum || 0).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh</b> · gestern ${(s.ydaySum || 0).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh</span></div>
        ${hourBars(s.today, max, m.color, false)}
        ${hourBars(s.yesterday, max, m.color, true)}
        <div class="ov-axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
      </div>`;
    })
    .join('');
  $('overviewChart').innerHTML =
    `<div style="margin-bottom:8px">${sunKpi}</div>${blocks}` +
    '<p class="mini">Kräftige Balken = heute, blasse = gestern (je Rolle gleich skaliert).</p>' +
    (o.haError ? `<p class="mini" style="color:#b45309">Hinweis: HA-Statistik aktuell nicht abrufbar (${esc(o.haError)}).</p>` : '');
}

async function loadOverview() {
  try {
    const o = await api('api/overview');
    const s = o.summary || {};
    const bat = (s.batteries || []).length
      ? ' · 🔋 ' + s.batteries.map((b) => `${esc(b.name || b.entityId)}: <b>${b.value != null ? b.value + esc(b.unit || '%') : '–'}</b>`).join(', ')
      : '';
    $('overviewSummary').innerHTML =
      `<span class="kpi">${s.meters || 0} Zähler · ${s.virtual || 0} virtuelle</span>` +
      `<span class="kpi" style="color:${s.openIncidents ? '#b91c1c' : '#166534'}">Offene Störungen: <b>${s.openIncidents || 0}</b></span>` +
      `<span class="kpi" style="color:${s.anomaliesOpen ? '#b45309' : '#166534'}">Offene Auffälligkeiten: <b>${s.anomaliesOpen || 0}</b></span>` +
      bat;
    renderDayChart(o);
    loadStatus();
  } catch (e) {
    $('overviewChart').textContent = 'Übersicht nicht ladbar: ' + e.message;
  }
}

async function init() {
  loadVersion();
  try {
    config = await api('api/config');
    fillForm();
    await loadEntities();
    await loadIncidents();
    await loadLedger();
    const startTab = (location.hash || '').replace('#', '') || 'overview';
    showTab(['overview', 'einstellungen', 'berichte', 'incident', 'abrechnung'].includes(startTab) ? startTab : 'overview');
  } catch (e) {
    flash('Initialisierung fehlgeschlagen: ' + e.message, false);
  }
}
init();
