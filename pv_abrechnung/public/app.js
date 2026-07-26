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
// Ein Akku-Ladestand ist ein Prozentwert, kein Energiezähler – deshalb eine eigene Liste.
let batteryEntities = [];
async function loadBatteryEntities() {
  const sel = $('bEntity');
  if (!sel) return;
  try {
    batteryEntities = await api('api/entities/battery');
    sel.innerHTML = batteryEntities.length
      ? batteryEntities.map((e) => `<option value="${esc(e.entityId)}">${esc(e.name)} (${esc(e.state)} ${esc(e.unit)})</option>`).join('')
      : '<option value="">– kein Ladestands-Sensor (%) in Home Assistant gefunden –</option>';
    const hint = $('bHint');
    if (hint) {
      hint.innerHTML = batteryEntities.length
        ? `${batteryEntities.length} Ladestands-Sensor(en) mit Einheit % gefunden.`
        : '<span style="color:#b45309">Kein Sensor mit Einheit % und Akku-Bezug gefunden. Der Ladestand muss in Home Assistant als Prozentwert vorliegen (Geräteklasse „battery" oder ein Name mit SoC/Ladezustand/Akku).</span>';
    }
  } catch (e) {
    sel.innerHTML = '<option value="">– Laden fehlgeschlagen –</option>';
    flash('Akku-Entitäten laden fehlgeschlagen: ' + e.message, false);
  }
}

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
  const ent = batteryEntities.find((e) => e.entityId === entityId);
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
  $('sDaily').value = String(!!s.daily); $('sWeekly').value = String(!!s.weekly); $('sMonthly').value = String(!!s.monthly);
  $('sYearly').value = String(!!s.yearly); $('sHour').value = s.hour;
  $('smtpHost').value = sm.host; $('smtpPort').value = sm.port; $('smtpSecure').value = String(!!sm.secure);
  $('smtpUser').value = sm.user; $('smtpPass').value = sm.pass; $('smtpFrom').value = sm.from;
  $('useStats').checked = config.useStatistics !== false;
  renderMeters();
  renderVMeters();
  renderDraftComponents();
  renderBatteries();
  applyModusVisibility();
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
    daily: $('sDaily').value === 'true', weekly: $('sWeekly').value === 'true',
    monthly: $('sMonthly').value === 'true',
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
// Betriebsmodus: bei Eigenverbrauch werden alle Einstellungen ausgeblendet, die nur für die
// Abrechnung gegenüber einem Kunden gebraucht werden (Kundendaten, Lieferpreis, Grundgebühr,
// Einspeisemanagement, Frage nach dem Vergütungsempfänger).
function isEigenModus() {
  return config && config.betriebsmodus === 'eigenverbrauch';
}

function applyModusVisibility() {
  const eigen = isEigenModus();
  document.querySelectorAll('[data-only="kunde"]').forEach((el) => {
    el.style.display = eigen ? 'none' : '';
  });
  document.querySelectorAll('[data-only="eigen"]').forEach((el) => {
    el.style.display = eigen ? '' : 'none';
  });
  document.querySelectorAll('[data-label-eigen]').forEach((el) => {
    const alt = el.getAttribute('data-label-eigen');
    const orig = el.getAttribute('data-label-kunde') || el.textContent;
    if (!el.getAttribute('data-label-kunde')) el.setAttribute('data-label-kunde', orig);
    el.textContent = eigen ? alt : el.getAttribute('data-label-kunde');
  });
  const badge = $('modusBadge');
  if (badge) {
    badge.textContent = eigen ? 'Modus: Eigenverbrauch (keine Kundenabrechnung)' : 'Modus: Lieferung an Kunde (mit Abrechnung)';
    badge.style.color = eigen ? '#166534' : '#2563eb';
  }
}

function renderWizard() {
  if (!config) return;
  config.tariffs = config.tariffs || {};
  const eigen = isEigenModus();
  const einsp = config.tariffs.einspeisungAnBetreiber !== false;
  const info = config.showInfoStats !== false;
  $('wizard').innerHTML =
    `<div style="margin:8px 0;padding-bottom:10px;border-bottom:1px solid var(--line)">
      <div><b>1. Wofür nutzt du die Anlage?</b></div>
      <div class="hint">Das ist die wichtigste Einstellung: sie bestimmt, ob abgerechnet wird und welche Felder du überhaupt brauchst.</div>
      <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
        ${wizBtn('Strom an einen Kunden liefern und abrechnen', !eigen, "wizModus('kundenlieferung')")}
        ${wizBtn('Anlage selbst nutzen (Eigenverbrauch)', eigen, "wizModus('eigenverbrauch')")}
      </div>
      <div class="hint" style="margin-top:6px">${
        eigen
          ? '<b>Eigenverbrauch:</b> Es wird niemandem etwas in Rechnung gestellt. Der Bericht zeigt, wie viel Strombezug du eingespart hast und was die Einspeisung gebracht hat. Kundendaten und Lieferpreis sind ausgeblendet.'
          : '<b>Lieferung an Kunde:</b> Aus Anfangs- und Endstand wird abgerechnet, der Bericht enthält den zu zahlenden Betrag und wird als Beleg im Journal eingefroren.'
      }</div>
    </div>
    <div style="margin:8px 0;padding-bottom:10px;border-bottom:1px solid var(--line)" data-only="kunde">
      <div><b>2. Bekommst DU (Anlagenbetreiber) die Einspeisevergütung vom Netzbetreiber?</b></div>
      <div class="hint">Ja = der überschüssige, ins Netz eingespeiste Strom ist deine Einnahme und taucht in der Kundenrechnung nicht auf. Nein = der Kunde bekommt die Vergütung, dann wird ihm die Einspeisemenge berechnet und dir die Einspeisemanagement-Gebühr abgezogen.</div>
      <div style="margin-top:6px;display:flex;gap:8px">${wizBtn('Ja', einsp, 'wizEinsp(true)')}${wizBtn('Nein', !einsp, 'wizEinsp(false)')}</div>
    </div>
    <div style="margin:8px 0;padding-bottom:10px;border-bottom:1px solid var(--line)">
      <div><b>${eigen ? '2' : '3'}. Soll der Bericht ${eigen ? 'Autarkiegrad und Ersparnis' : 'die Ersparnis des Kunden gegenüber Netzstrom'} zeigen?</b></div>
      <div class="hint">Ja = im Bericht erscheinen Autarkiegrad (PV-Anteil) und die Ersparnis. Dafür unten bei den Preisen den ${eigen ? '„eigenen Strompreis"' : '„Netzbetreiber-Strompreis"'} eintragen.</div>
      <div style="margin-top:6px;display:flex;gap:8px">${wizBtn('Ja', info, 'wizInfo(true)')}${wizBtn('Nein', !info, 'wizInfo(false)')}</div>
    </div>
    <div style="margin:8px 0">
      <div><b>${eigen ? '3' : '4'}. ${eigen ? 'Beziehst du auch Strom aus dem öffentlichen Netz?' : 'Zieht der Kunde auch Strom aus dem öffentlichen Netz (wenn die PV nicht reicht)?'}</b></div>
      <div class="hint">Wenn ja: oben unter „Zähler" den Netzbezugs-Zähler mit Rolle <b>„Netzbezug"</b> anlegen und bei den Preisen den Strompreis eintragen. Nur dann lassen sich Autarkiegrad und Ersparnis berechnen.</div>
    </div>
    <p class="mini">Nicht vergessen: unten <b>„Speichern"</b>.</p>`;
  applyModusVisibility();
}

async function wizModus(modus) {
  config.betriebsmodus = modus === 'eigenverbrauch' ? 'eigenverbrauch' : 'kundenlieferung';
  if (config.betriebsmodus === 'eigenverbrauch') {
    // Im Eigenverbrauch gibt es keinen fremden Vergütungsempfänger und keine Gebühren.
    config.tariffs = { ...(config.tariffs || {}), einspeisungAnBetreiber: true };
    if ($('tEinspBetreiber')) $('tEinspBetreiber').checked = true;
  }
  renderWizard();
  flash(
    config.betriebsmodus === 'eigenverbrauch'
      ? 'Eigenverbrauch eingestellt: keine Kundenabrechnung, nicht benötigte Felder sind ausgeblendet.'
      : 'Kundenlieferung eingestellt: Abrechnung mit Lieferpreis und Beleg-Journal.'
  );
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
let openAnomalies = [];
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
    openAnomalies = open;
    archivedAnomalies = d.archived || [];
    expUpdatePreview();
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
          .map((p) => `<li>${new Date(p.at).toLocaleString('de-DE')} – von ${esc(p.by)}: ${p.count} Auffälligkeiten (${p.critical} kritisch)${p.manual ? ` <span class="tag">manueller Export${p.rangeLabel ? ' · ' + esc(p.rangeLabel) : ''}</span>` : ''}</li>`)
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

// ---- Manueller Incident-Report-Export (Zeitraum mit Datum + Uhrzeit) ----
// datetime-local liefert lokale Zeit ohne Zone – new Date(value) interpretiert sie lokal,
// genau wie der Nutzer sie meint.
function expRangeMs() {
  const f = $('expFrom') && $('expFrom').value ? new Date($('expFrom').value).getTime() : NaN;
  const t = $('expTo') && $('expTo').value ? new Date($('expTo').value).getTime() : NaN;
  return Number.isFinite(f) && Number.isFinite(t) && t > f ? { from: f, to: t } : null;
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function expPreset(kind) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let from;
  let to = now;
  if (kind === 'today') from = startOfDay(now);
  else if (kind === 'yesterday') {
    from = new Date(startOfDay(now).getTime() - 86400000);
    to = startOfDay(now);
  } else if (kind === '7d') from = new Date(now.getTime() - 7 * 86400000);
  else if (kind === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (kind === 'prevmonth') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to = new Date(now.getFullYear(), now.getMonth(), 1);
  } else return;
  $('expFrom').value = toLocalInput(from);
  $('expTo').value = toLocalInput(to);
  expUpdatePreview();
}

function expUpdatePreview() {
  const el = $('expPreview');
  if (!el) return;
  const r = expRangeMs();
  if (!r) {
    el.textContent = 'Zeitraum wählen (Von/Bis oder Schnellauswahl).';
    return;
  }
  const all = [...openAnomalies, ...archivedAnomalies].filter((a) => a.at >= r.from && a.at <= r.to);
  const kritisch = all.filter((a) => a.review && a.review.classification === 'kritisch').length;
  const unbewertet = all.filter((a) => !a.review).length;
  el.innerHTML = all.length
    ? `Im gewählten Zeitraum: <b>${all.length}</b> Auffälligkeiten (${kritisch} kritisch, ${unbewertet} noch nicht bewertet).`
    : '<span style="color:#b45309">Im gewählten Zeitraum liegen keine Auffälligkeiten.</span>';
}

function exportIncidentCsv() {
  const r = expRangeMs();
  if (!r) return flash('Bitte einen gültigen Zeitraum wählen (Bis muss nach Von liegen).', false);
  // Relativer Link -> funktioniert auch hinter dem HA-Ingress-Pfad.
  window.location.href = `api/incident-report/export.csv?from=${r.from}&to=${r.to}`;
}

async function exportIncidentMail() {
  const r = expRangeMs();
  if (!r) return flash('Bitte einen gültigen Zeitraum wählen (Bis muss nach Von liegen).', false);
  if (!confirm('Incident-Report für den gewählten Zeitraum als Mail versenden? Enthalten sind ALLE Auffälligkeiten des Zeitraums; der normale inkrementelle Versand bleibt unberührt.')) return;
  try {
    const res = await api('api/incident-report/export', { method: 'POST', body: JSON.stringify(r) });
    flash(`Export versendet (${res.rangeLabel}): ${res.count} Auffälligkeiten (${res.critical} kritisch), von ${res.by}.`);
    loadAnomalies();
  } catch (e) {
    flash('Export fehlgeschlagen: ' + e.message, false);
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
    case 'prev_week':
      return { ...base, periodType: 'week' };
    case 'cur_week':
      return { ...base, periodType: 'week', date: now.toISOString().slice(0, 10) };
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
  else if (name === 'bewertung') fillAssessForm();
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

// Energie in der zur Größe passenden Einheit (Wh unter 1 kWh, MWh ab 1000 kWh).
function fmtEnergy(kwh, digits) {
  const v = Number(kwh);
  if (!Number.isFinite(v)) return '–';
  const abs = Math.abs(v);
  if (abs < 0.0005) return '0 kWh';
  if (abs < 1) return (v * 1000).toLocaleString('de-DE', { maximumFractionDigits: digits ?? 0 }) + ' Wh';
  if (abs >= 1000) return (v / 1000).toLocaleString('de-DE', { maximumFractionDigits: digits ?? 2 }) + ' MWh';
  return v.toLocaleString('de-DE', { maximumFractionDigits: digits ?? 2 }) + ' kWh';
}

// „Schöner" Achsenendwert (1/2/5-Schritte) für eine lesbare Skalierung.
function niceMax(x) {
  const v = Math.abs(Number(x) || 0);
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

// Eine Balkenreihe mit beschrifteter Y-Achse (Skalierung). Tooltip je Balken zeigt den Wert
// in der passenden Einheit (Wh/kWh/MWh).
function hourBars(arr, max, color, faded, rowLabel, tipLabels) {
  const bars = (arr || [])
    .map((v, i) => {
      const ht = Math.round((v / (max || 1)) * 88);
      const when = tipLabels ? tipLabels[i] : `${i}:00`;
      return `<div class="b" style="height:${Math.max(1, ht)}px;background:${color};opacity:${faded ? 0.35 : 0.9}" title="${esc(when)} – ${esc(fmtEnergy(v))}"></div>`;
    })
    .join('');
  const axis = `<div class="ov-yaxis"><span>${esc(fmtEnergy(max, 1))}</span><span>${esc(fmtEnergy(max / 2, 1))}</span><span>0</span></div>`;
  return `<div class="ov-row"><div class="ov-rowlabel">${esc(rowLabel || '')}</div>${axis}<div class="daychart">${bars}</div></div>`;
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
      const max = niceMax(Math.max(0.001, ...(s.today || []), ...(s.yesterday || [])));
      const tips = Array.from({ length: 24 }, (_, h) => `${h}:00–${h + 1}:00`);
      return `<div class="ov-role">
        <div class="ov-head"><b style="color:${m.color}">${m.label}</b>
          <span>heute <b>${esc(fmtEnergy(s.todaySum || 0))}</b> · gestern ${esc(fmtEnergy(s.ydaySum || 0))}</span></div>
        ${hourBars(s.today, max, m.color, false, 'heute', tips)}
        ${hourBars(s.yesterday, max, m.color, true, 'gestern', tips)}
        <div class="ov-axis" style="margin-left:96px"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
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

// ---- Anlagenbewertung ----
const eur = (n) => (n == null ? '–' : Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }));
const jahre = (n) => (n == null ? 'nie' : Number(n).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' Jahre');
const BEWERTUNG_FARBE = { gut: '#166534', auffällig: '#b45309', kritisch: '#b91c1c', unbekannt: '#6b7280', Hinweis: '#2563eb', warnung: '#b91c1c' };

function fillAssessForm() {
  const p = (config && config.plant) || {};
  const a = (config && config.assess) || {};
  if ($('asZiel')) $('asZiel').value = (config && config.zielAmortisation) || 10;
  if ($('asKwp')) $('asKwp').value = p.kwp ?? '';
  if ($('asBat')) $('asBat').value = p.batteryKwh ?? '';
  if ($('asFrei')) $('asFrei').value = p.freieFlaecheKwp ?? '';
  if ($('asInbetriebnahme')) $('asInbetriebnahme').value = p.inbetriebnahme ?? '';
  if ($('asWr')) $('asWr').value = p.wechselrichterKw ?? '';
  if ($('asWp')) $('asWp').checked = !!p.waermepumpe;
  if ($('asWallbox')) $('asWallbox').checked = !!p.wallbox;
  if ($('asNeigung')) $('asNeigung').value = p.neigung ?? 35;
  if ($('asAusrichtung')) $('asAusrichtung').value = p.ausrichtung || 'sued';
  if ($('asZins')) $('asZins').value = a.kalkulationszins ?? 3;
  if ($('asSteigerung')) $('asSteigerung').value = a.strompreissteigerung ?? 2;
  if ($('asKostenPv')) $('asKostenPv').value = a.kostenPvMarginalProKwp ?? 750;
  if ($('asKostenBat')) $('asKostenBat').value = a.kostenBatterieProKwh ?? 450;
}

async function runAssess() {
  const el = $('asResult');
  el.innerHTML = '<div class="card"><b>Bewertung läuft…</b><div class="mini">Stundenwerte werden aus der Home-Assistant-Statistik gelesen und durchgerechnet. Das dauert einige Sekunden.</div></div>';
  // Eingaben in die Konfiguration übernehmen, damit sie dauerhaft gelten
  const numOrNull = (id) => { const v = ($(id) || {}).value; return v === '' || v == null ? null : Number(v); };
  config.plant = {
    ...(config.plant || {}),
    kwp: numOrNull('asKwp'), batteryKwh: numOrNull('asBat'), freieFlaecheKwp: numOrNull('asFrei'),
    inbetriebnahme: ($('asInbetriebnahme').value || '').trim() || null,
    wechselrichterKw: numOrNull('asWr'),
    waermepumpe: $('asWp').checked,
    wallbox: $('asWallbox').checked,
    neigung: numOrNull('asNeigung') ?? 35, ausrichtung: $('asAusrichtung').value,
  };
  config.assess = {
    ...(config.assess || {}),
    kalkulationszins: numOrNull('asZins') ?? 3, strompreissteigerung: numOrNull('asSteigerung') ?? 2,
    kostenPvMarginalProKwp: numOrNull('asKostenPv') ?? 750, kostenBatterieProKwh: numOrNull('asKostenBat') ?? 450,
  };
  config.zielAmortisation = Number($('asZiel').value) || 10;
  try {
    await api('api/config', { method: 'PUT', body: JSON.stringify(config) });
    const r = await api('api/assess', {
      method: 'POST',
      body: JSON.stringify({ zielAmortisation: config.zielAmortisation, months: Number($('asMonths').value) || 12, annahmen: config.assess, skipPvgis: $('asSkipPvgis').checked }),
    });
    renderAssess(r);
  } catch (e) {
    el.innerHTML = `<div class="card"><b style="color:#b91c1c">Bewertung fehlgeschlagen</b><div class="mini">${esc(e.message)}</div></div>`;
  }
}

function renderAssess(r) {
  const el = $('asResult');
  if (!r.ok) {
    el.innerHTML = `<div class="card"><h2>Bewertung nicht möglich</h2><p>${esc(r.grund)}</p>
      ${r.coverage ? `<div class="mini">Gefundene Datenbasis: ${r.coverage.days || 0} Tage, ${r.coverage.hoursWithData || 0} Stunden mit Werten.</div>` : ''}</div>`;
    return;
  }
  const c = r.coverage;
  const ist = r.ist;
  const out = [];

  // Datenlage
  out.push(`<div class="card">
    <h2>Datengrundlage</h2>
    <span class="kpi">${c.days} Tage (${c.months} Monate)</span>
    <span class="kpi" style="color:${c.fullYear ? '#166534' : '#b45309'}">${c.fullYear ? 'vollständiges Jahr' : 'Hochrechnung × ' + c.yearFactor}</span>
    ${r.standort ? `<span class="kpi">Standort aus HA: ${esc(String(r.standort.lat))}, ${esc(String(r.standort.lon))}</span>` : ''}
    ${(r.warnings || []).map((w) => `<div class="hint" style="color:#b45309">⚠ ${esc(w)}</div>`).join('')}
  </div>`);

  // Fehlende Angaben
  if ((r.dataGaps || []).length) {
    out.push(`<div class="card" style="border-color:#f59e0b">
      <h2>⚠ Fehlende Angaben</h2>
      <p class="mini">Diese Werte fehlen für eine belastbare Rechnung. Solange sie fehlen, wird lieber nichts behauptet, als geraten.</p>
      <ul>${r.dataGaps.map((g) => `<li><b>${esc(g.was)}</b> – ${esc(g.warum)}</li>`).join('')}</ul>
    </div>`);
  }

  // Ist-Zustand
  const p = r.plant;
  const src = (x) => (x ? `<span class="tag">${x.source === 'config' ? 'eingetragen' : x.source === 'sensor' ? 'aus HA-Sensor' : 'geschätzt'}${x.via ? ': ' + esc(x.via) : ''}</span>` : '');
  out.push(`<div class="card">
    <h2>Ist-Zustand</h2>
    <div>
      <span class="kpi">Module: <b>${p.kwp ? p.kwp.value + ' kWp' : 'unbekannt'}</b></span>
      <span class="kpi">Speicher: <b>${p.batteryKwh ? p.batteryKwh.value + ' kWh' : p.hasBattery ? 'vorhanden, Größe unbekannt' : 'keiner'}</b></span>
      <span class="kpi">Eigenverbrauchsquote: <b>${ist.quoten.eigenverbrauchsquote ?? '–'}%</b></span>
      <span class="kpi">Autarkie des Kunden: <b>${ist.quoten.autarkie ?? '–'}%</b></span>
    </div>
    ${p.anlage ? `<div style="margin-top:4px">
      <span class="kpi">Inbetriebnahme ${esc(p.anlage.inbetriebnahme)} (${p.anlage.alterJahre} Jahre alt)</span>
      <span class="kpi" style="color:${p.anlage.eegRestJahre <= 3 ? '#b91c1c' : p.anlage.eegRestJahre <= 5 ? '#b45309' : '#166534'}">EEG-Vergütung bis Ende ${p.anlage.eegVerguetungBis} (${p.anlage.eegRestJahre} Jahre)</span>
      ${p.anlage.erwarteteDegradationProzent != null ? `<span class="kpi">altersübliche Degradation ≈ ${p.anlage.erwarteteDegradationProzent}%</span>` : ''}
    </div>` : ''}
    ${p.wechselrichterKw ? `<div class="mini" style="margin-top:2px">Wechselrichter: ${p.wechselrichterKw} kW (Zubau wird an dieser Grenze gedeckelt)</div>` : ''}
    ${(p.flexLasten || []).length ? `<div class="mini" style="margin-top:2px">Verschiebbare Lasten: ${p.flexLasten.map(esc).join(', ')}</div>` : ''}
    <div class="mini" style="margin-top:4px">${src(p.kwp)} ${src(p.batteryKwh)}</div>
    <table style="margin-top:10px"><tbody>
      <tr><td>Erzeugung</td><td class="num"><b>${esc(fmtEnergy(ist.jahr.erzeugung))}</b>/Jahr</td></tr>
      <tr><td>davon an den Kunden geliefert</td><td class="num">${esc(fmtEnergy(ist.jahr.eigenverbrauch))}</td></tr>
      <tr><td>davon ins Netz eingespeist</td><td class="num">${esc(fmtEnergy(ist.jahr.einspeisung))} <span class="tag">${ist.einspeisungAnteilProzent}% der Erzeugung</span></td></tr>
      <tr><td>Netzbezug des Kunden</td><td class="num">${esc(fmtEnergy(ist.jahr.netzbezug))}</td></tr>
      <tr><td><b>Erlös des Betreibers</b></td><td class="num"><b>${eur(ist.jahr.erloes)}</b>/Jahr</td></tr>
    </tbody></table>
    ${ist.soll ? `<div class="hint">Standort-Soll laut PVGIS: ${ist.soll.yearKwhPerKwp} kWh je kWp und Jahr (${esc(ist.soll.source)}).</div>` : ''}
  </div>`);

  // Gesundheit
  const h = r.health;
  out.push(`<div class="card">
    <h2>Zustand der Anlage: <span style="color:${BEWERTUNG_FARBE[h.gesamt] || '#6b7280'}">${esc(h.gesamt)}</span></h2>
    ${h.kennzahlen.spezifischerErtragJahr ? `<span class="kpi">${h.kennzahlen.spezifischerErtragJahr} kWh/kWp·Jahr</span>` : ''}
    ${h.kennzahlen.sollErfuellung ? `<span class="kpi" style="color:${h.kennzahlen.sollErfuellung >= 90 ? '#166534' : h.kennzahlen.sollErfuellung >= 75 ? '#b45309' : '#b91c1c'}">${h.kennzahlen.sollErfuellung}% des Standort-Solls</span>` : ''}
    ${h.kennzahlen.speicherVollzyklenJahr != null ? `<span class="kpi">${h.kennzahlen.speicherVollzyklenJahr} Speicher-Vollzyklen/Jahr</span>` : ''}
    ${h.kennzahlen.ausfallstundenKernzeit != null ? `<span class="kpi">${h.kennzahlen.ausfallstundenKernzeit}% Ausfallstunden (9–15 Uhr)</span>` : ''}
    <div style="margin-top:10px">${h.findings.map((f) => `<div style="border-left:3px solid ${BEWERTUNG_FARBE[f.bewertung] || '#6b7280'};padding:4px 10px;margin-bottom:8px">
      <b>${esc(f.thema)}</b> <span style="color:${BEWERTUNG_FARBE[f.bewertung] || '#6b7280'}">${esc(f.bewertung)}</span>
      <div class="mini" style="color:var(--text)">${esc(f.text)}</div>
      ${f.hinweis ? `<div class="hint" style="color:#b45309">${esc(f.hinweis)}</div>` : ''}
    </div>`).join('')}</div>
  </div>`);

  // Leistungsabfall über die Zeit
  const t = r.trend;
  if (t) {
    const schwerste = (t.befunde || []).reduce((w, b) => (b.schwere === 'kritisch' ? b : w.schwere === 'kritisch' ? w : b.schwere === 'auffällig' ? b : w), (t.befunde || [{}])[0]);
    out.push(`<div class="card"${schwerste && schwerste.schwere === 'kritisch' ? ' style="border-color:#b91c1c"' : schwerste && schwerste.schwere === 'auffällig' ? ' style="border-color:#f59e0b"' : ''}>
      <h2>Leistungsentwicklung</h2>
      ${!t.ok ? `<p class="mini">${esc(t.grund || 'nicht bewertbar')}</p>` : ''}
      ${(t.verfahren || []).map((v) => `<div class="tag">${/nicht möglich/.test(v) ? '⚠ ' : '✓ '}${esc(v)}</div>`).join('')}
      ${t.trend ? `<div style="margin-top:8px"><span class="kpi">früher ${t.trend.frueher}% des Erwartungswerts</span><span class="kpi">zuletzt ${t.trend.zuletzt}%</span><span class="kpi" style="color:${t.trend.aenderungProzentpunkte <= -10 ? '#b91c1c' : '#166534'}">${t.trend.aenderungProzentpunkte > 0 ? '+' : ''}${t.trend.aenderungProzentpunkte} Prozentpunkte</span></div>` : ''}
      <div style="margin-top:10px">${(t.befunde || []).map((b) => `<div style="border-left:3px solid ${BEWERTUNG_FARBE[b.schwere] || '#6b7280'};padding:4px 10px;margin-bottom:8px">
        <b>${b.art === 'leistungsabfall' ? 'Leistungsabfall erkannt' : b.art === 'trend' ? 'Nachlassende Leistung im Zeitverlauf' : b.art === 'beobachtung' ? 'Beobachtung' : 'Unauffällig'}</b>
        <span style="color:${BEWERTUNG_FARBE[b.schwere] || '#6b7280'}">${esc(b.schwere)}</span>${b.laufend ? ' <span class="tag" style="color:#b91c1c">hält aktuell an</span>' : ''}
        <div class="mini" style="color:var(--text)">${esc(b.text)}</div></div>`).join('')}</div>
      ${(t.monate || []).length ? `<div style="overflow-x:auto;margin-top:8px"><table>
        <thead><tr><th>Monat</th><th class="num">gemessen</th><th class="num">erwartet</th><th class="num">Quote</th><th class="num">Vorjahr</th></tr></thead>
        <tbody>${t.monate.map((m) => `<tr><td>${esc(String(m.key))}${m.abdeckung < 100 ? ` <span class="tag">${m.abdeckung}% erfasst</span>` : ''}</td>
          <td class="num">${esc(fmtEnergy(m.kwh))}</td>
          <td class="num">${m.erwartetKwh != null ? esc(fmtEnergy(m.erwartetKwh)) : '–'}</td>
          <td class="num" style="color:${m.quoteSoll == null ? '#6b7280' : m.quoteSoll >= 90 ? '#166534' : m.quoteSoll >= 80 ? '#b45309' : '#b91c1c'}">${m.quoteSoll != null ? m.quoteSoll + '%' : '–'}</td>
          <td class="num">${m.quoteVorjahr != null ? m.quoteVorjahr + '%' : '–'}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
      <div class="hint">Verglichen wird gegen das Klimamittel des Standorts (PVGIS) und – sofern die Historie reicht – gegen denselben Monat des Vorjahres. Ein einzelner schwacher Monat kann Wetter sein; gemeldet wird erst, wenn mehrere Monate in Folge unter dem Erwartungswert liegen.</div>
    </div>`);
  }

  // Empfehlung
  const e = r.empfehlung;
  out.push(`<div class="card" style="border-color:${e ? '#16a34a' : '#f59e0b'};border-width:2px">
    <h2>${e ? '✓ Empfehlung' : 'Keine Variante erreicht dein Ziel'}</h2>
    ${e
      ? `<div style="font-size:17px;font-weight:600">${esc(e.label)}</div>
         <div style="margin-top:6px">
           <span class="kpi">Investition <b>${eur(e.invest)}</b></span>
           <span class="kpi">Mehrerlös <b>${eur(e.wirkung.mehrErloesEuroJahr)}</b>/Jahr</span>
           <span class="kpi">amortisiert in <b>${jahre(e.kennzahlen.amortisationDynamisch)}</b></span>
           <span class="kpi">Gewinn über ${e.kennzahlen.laufzeit} Jahre <b>${eur(e.kennzahlen.npv)}</b></span>
         </div>
         <div class="hint">Bei einer Ziel-Amortisation von ${r.zielAmortisation} Jahren ist das die Variante mit dem höchsten Gesamtgewinn.</div>`
      : `<p>Mit den gewählten Annahmen amortisiert sich keine Erweiterung innerhalb von <b>${r.zielAmortisation} Jahren</b>.
         ${r.beste ? `Am besten schneidet noch <b>${esc(r.beste.label)}</b> ab (${eur(r.beste.invest)}, Amortisation ${jahre(r.beste.kennzahlen.amortisationDynamisch)}, Gesamtgewinn ${eur(r.beste.kennzahlen.npv)}).` : ''}</p>
         <div class="hint">Das ist ein ehrliches Ergebnis, kein Fehler: Wenn der zusätzliche Strom überwiegend eingespeist statt geliefert wird, bringt er nur die Einspeisevergütung – und die liegt weit unter dem Lieferpreis. Prüfe zuerst die Hebel ohne Investition unten.</div>`}
  </div>`);

  // Varianten
  out.push(`<div class="card">
    <h2>Alle geprüften Varianten</h2>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Variante</th><th class="num">Investition</th><th class="num">Mehrerlös/Jahr</th>
        <th class="num">mehr Lieferung</th><th class="num">mehr Einspeisung</th>
        <th class="num">Amortisation</th><th class="num">Gesamtgewinn</th><th class="num">Rendite</th></tr></thead>
      <tbody>${r.variants.map((v) => `<tr${v === e ? ' style="background:#f0fdf4;font-weight:600"' : ''}>
        <td>${esc(v.label)}${v.eegNeu ? `<div class="tag">Zubau vergütet mit ${(v.eegNeu.satzEffektiv * 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} ct/kWh</div>` : ''}</td>
        <td class="num">${eur(v.invest)}</td>
        <td class="num">${eur(v.wirkung.mehrErloesEuroJahr)}</td>
        <td class="num">${esc(fmtEnergy(v.wirkung.mehrEigenverbrauchKwhJahr))}</td>
        <td class="num">${esc(fmtEnergy(v.wirkung.mehrEinspeisungKwhJahr))}</td>
        <td class="num" style="color:${v.erreichtZiel ? '#166534' : '#6b7280'}">${jahre(v.kennzahlen.amortisationDynamisch)}</td>
        <td class="num" style="color:${v.kennzahlen.npv >= 0 ? '#166534' : '#b91c1c'}">${eur(v.kennzahlen.npv)}</td>
        <td class="num">${v.kennzahlen.irr != null ? v.kennzahlen.irr + '%' : '–'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="hint">„Amortisation" ist die dynamische Amortisation (mit Kalkulationszins ${r.annahmen.kalkulationszins}%, Strompreissteigerung ${r.annahmen.strompreissteigerung}%/Jahr und Alterung). „Gesamtgewinn" ist der Kapitalwert über die Laufzeit in heutigem Geld – inklusive Ersatz von Wechselrichter bzw. Batterie. Wo eine Ersatzinvestition anfällt, wird keine Rendite ausgewiesen, weil sie dann mathematisch nicht eindeutig ist.</div>
  </div>`);

  // Hebel
  if ((r.hebel || []).length) {
    out.push(`<div class="card">
      <h2>Hebel ohne Investition</h2>
      ${r.hebel.map((x) => `<div style="border-left:3px solid #2563eb;padding:4px 10px;margin-bottom:8px">
        <b>${esc(x.thema)}</b> <span class="tag">${esc(x.wirkung)}</span>
        <div class="mini" style="color:var(--text)">${esc(x.text)}</div></div>`).join('')}
    </div>`);
  }

  // Recht
  if ((r.rechtHinweise || []).length) {
    out.push(`<div class="card">
      <h2>Rechtliche Rahmenbedingungen</h2>
      <p class="mini">Hinweise zum Einordnen – keine Rechtsberatung. Vor einer Erweiterung mit Netzbetreiber und Steuerberater klären.</p>
      ${r.rechtHinweise.map((n) => `<div style="border-left:3px solid ${n.schwere === 'warnung' ? '#b91c1c' : '#6b7280'};padding:4px 10px;margin-bottom:8px">
        <b>${esc(n.thema)}</b>${n.schwere === 'warnung' ? ' <span style="color:#b91c1c">wichtig</span>' : ''}
        <div class="mini" style="color:var(--text)">${esc(n.text)}</div></div>`).join('')}
      <div class="hint">Einspeisevergütungssätze gültig bis ${esc(r.eegSaetze.gueltigBis)} · ${esc(r.eegSaetze.quelle)}</div>
    </div>`);
  }

  el.innerHTML = out.join('');
}

async function init() {
  loadVersion();
  try {
    config = await api('api/config');
    fillForm();
    await loadEntities();
    await loadBatteryEntities();
    await loadIncidents();
    await loadLedger();
    const startTab = (location.hash || '').replace('#', '') || 'overview';
    showTab(['overview', 'einstellungen', 'berichte', 'incident', 'abrechnung', 'bewertung'].includes(startTab) ? startTab : 'overview');
  } catch (e) {
    flash('Initialisierung fehlgeschlagen: ' + e.message, false);
  }
}
init();
