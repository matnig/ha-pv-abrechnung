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
    ? `<table><thead><tr><th>Name</th><th>Formel</th><th>Startdatum</th><th>Rückwirkend</th><th></th></tr></thead><tbody>${config.virtualMeters
        .map(
          (v, i) => `<tr>
            <td>${v.name}<div class="tag">${v.role}</div></td>
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
      `<div class="hint" id="vmDetail" style="margin-top:6px">Aufschlüsselung ${vm.name}: ${det}. „geliefert" = Summe der faktorisierten Zuwächse, bei 0 gedeckelt.</div>`
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
  $('tEinspBetreiber').checked = t.einspeisungAnBetreiber !== false;
  $('tEinspMgmt').value = t.einspeiseManagementJahr ?? 0;
  $('tNetzpreis').value = t.netzpreis ?? 0;
  renderWizard();
  $('recipients').value = (config.recipients || []).join(', ');
  $('alertRecipients').value = (config.alertRecipients || []).join(', ');
  $('reportFooter').value = config.reportFooter || '';
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
    einspeisungAnBetreiber: $('tEinspBetreiber').checked,
    einspeiseManagementJahr: +$('tEinspMgmt').value,
    netzpreis: +$('tNetzpreis').value,
  };
  config.recipients = $('recipients').value.split(',').map((x) => x.trim()).filter(Boolean);
  config.alertRecipients = $('alertRecipients').value.split(',').map((x) => x.trim()).filter(Boolean);
  config.reportFooter = $('reportFooter').value;
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
          ? m.lastEffective.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' ' + (m.unit || 'kWh')
          : m.polled ? '–' : '<span style="color:#999">noch nicht gelesen</span>';
        const out = !m.polled
          ? '<span style="color:#999">–</span>'
          : m.outages24h > 0
            ? `<span style="color:#dc2626">${m.outages24h}× (zuletzt ${agoText(m.lastOutage, s.at)})</span>`
            : '<span style="color:#16a34a">0 ✓</span>';
        return `<tr><td>${m.isVirtual ? '∑ ' : ''}${m.name}<div class="tag">${m.entityId}</div></td><td class="num"><b>${val}</b></td><td>${m.polled ? agoText(m.lastTs, s.at) : '–'}</td><td>${out}</td></tr>`;
      })
      .join('');
    const reports = s.reports
      .map((r) => `<li>${new Date(r.at).toLocaleString('de-DE')} – ${r.periodType} ${r.periodLabel}: ${r.total} € ${r.sent ? '✉️' : ''} ${r.error ? '⚠ ' + r.error : ''}</li>`)
      .join('');
    $('status').innerHTML =
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

async function init() {
  loadVersion();
  try {
    config = await api('api/config');
    fillForm();
    await loadEntities();
    await loadStatus();
    await loadIncidents();
    await loadLedger();
  } catch (e) {
    flash('Initialisierung fehlgeschlagen: ' + e.message, false);
  }
}
init();
