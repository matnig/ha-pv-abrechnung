'use strict';

const nodemailer = require('nodemailer');

function makeTransport(smtp) {
  if (!smtp || !smtp.host) throw new Error('SMTP nicht konfiguriert (host fehlt)');
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: !!smtp.secure, // true = 465/SSL, false = STARTTLS
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
}

async function verify(smtp) {
  const tx = makeTransport(smtp);
  await tx.verify();
  return true;
}

async function sendReport(config, { subject, html, csv, csvName }) {
  const smtp = config.smtp || {};
  const recipients = (config.recipients || []).filter(Boolean);
  if (!recipients.length) throw new Error('Keine Empfänger konfiguriert');

  const tx = makeTransport(smtp);
  const info = await tx.sendMail({
    from: smtp.from || smtp.user,
    to: recipients.join(', '),
    subject,
    html,
    attachments: csv ? [{ filename: csvName || 'abrechnung.csv', content: csv, contentType: 'text/csv; charset=utf-8' }] : [],
  });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

function alertContent(alert) {
  const when = new Date(alert.since).toLocaleString('de-DE');
  const who = alert.name || alert.entityId;
  if (alert.kind === 'offline_investigating') {
    return {
      subject: `PV-Abrechnung – Sensor ausgefallen: ${who}`,
      html: `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
        <h2>Sensor liefert keine Daten</h2>
        <p>Der Zähler <b>${who}</b> ist seit ${when} nicht verfügbar (Sensor „unavailable" bzw. Home Assistant nicht erreichbar).
        Bitte prüfen, ob Gerät/Bridge online ist. Abrechnungsdaten für diesen Zeitraum können fehlen.</p></div>`,
    };
  }
  if (alert.kind === 'offline_fault') {
    return {
      subject: `PV-Abrechnung – STÖRUNG (Sensor offline): ${who}`,
      html: `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
        <h2 style="color:#b91c1c">Störung: Sensor seit über ${Math.round((alert.ageMin || 0) / 60)} h offline</h2>
        <p>Der Zähler <b>${who}</b> liefert seit ${when} keine Daten mehr und hat sich nicht erholt. Bitte dringend prüfen.</p></div>`,
    };
  }
  if (alert.kind === 'investigating') {
    return {
      subject: `PV-Abrechnung – möglicher Zählerfehler: ${who}`,
      html: `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
        <h2>Möglicher Zählerfehler erkannt</h2>
        <p>Am Zähler <b>${who}</b> wurde seit ${when} ein Abfall festgestellt
        (von ${alert.oldFinal} auf ${alert.current}). Das System <b>untersucht</b> gerade,
        ob es sich nur um eine kurzzeitige Störung handelt.</p>
        <p>Falls tatsächlich ein <b>Zählertausch</b> stattgefunden hat, bestätigen Sie ihn
        bitte in der Oberfläche – dann läuft der (virtuelle) Zähler nahtlos weiter.</p></div>`,
    };
  }
  return {
    subject: `PV-Abrechnung – STÖRUNG: ${who}`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;color:#222">
      <h2 style="color:#b91c1c">Störung: Zählerfehler seit über ${Math.round((alert.ageMin || 0) / 60)} h</h2>
      <p>Der Zähler <b>${who}</b> ist seit ${when} auffällig (Abfall von ${alert.oldFinal} auf ${alert.current})
      und hat sich nicht erholt. Bitte prüfen.</p>
      <p>War es ein <b>Zählertausch</b>, bitte in der Oberfläche bestätigen.</p></div>`,
  };
}

async function sendAlert(config, alert) {
  const smtp = config.smtp || {};
  const recipients = ((config.alertRecipients && config.alertRecipients.length ? config.alertRecipients : config.recipients) || []).filter(Boolean);
  if (!recipients.length) throw new Error('Keine (Alarm-)Empfänger konfiguriert');
  const { subject, html } = alertContent(alert);
  const tx = makeTransport(smtp);
  const info = await tx.sendMail({ from: smtp.from || smtp.user, to: recipients.join(', '), subject, html });
  return { messageId: info.messageId, accepted: info.accepted };
}

module.exports = { sendReport, sendAlert, verify, makeTransport };
