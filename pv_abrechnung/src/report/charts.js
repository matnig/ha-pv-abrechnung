'use strict';

// Gemeinsame Diagramm-Bausteine für Bericht (E-Mail) und Oberfläche.
//
// E-Mail-taugliches Rendering: nur Tabellen + Inline-Styles, keine SVG/Flexbox/JS – das
// überleben auch Outlook & Co. Jedes Diagramm hat eine beschriftete Y-Achse (Skalierung)
// und passt die Einheit (Wh / kWh / MWh) an die Größe der Werte an.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Energie in der zur Größe passenden Einheit (Wh unter 1 kWh, MWh ab 1000 kWh). */
function fmtEnergy(kwh, maxDigits) {
  const v = Number(kwh);
  if (!Number.isFinite(v)) return '–';
  const abs = Math.abs(v);
  if (abs < 0.0005) return '0 kWh';
  if (abs < 1) return `${(v * 1000).toLocaleString('de-DE', { maximumFractionDigits: maxDigits ?? 0 })} Wh`;
  if (abs >= 1000) return `${(v / 1000).toLocaleString('de-DE', { maximumFractionDigits: maxDigits ?? 2 })} MWh`;
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: maxDigits ?? 2 })} kWh`;
}

/** Einheit + Teiler für die Y-Achse, abgeleitet vom Maximum der Reihe. */
function axisUnit(maxKwh) {
  const m = Math.abs(Number(maxKwh) || 0);
  if (m > 0 && m < 1) return { unit: 'Wh', div: 0.001 };
  if (m >= 1000) return { unit: 'MWh', div: 1000 };
  return { unit: 'kWh', div: 1 };
}

// Hellere Variante einer Farbe (mit Weiß gemischt). Wird für die Vorperiode-Balken genutzt –
// `opacity` unterstützen Mail-Clients wie Outlook nicht, eine echte Farbe schon.
function fade(hex, amount = 0.62) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// „Schöner" Achsenendwert (1/2/5-Schritte), damit die Skalierung lesbare Stufen hat.
function niceMax(v) {
  const x = Math.abs(Number(v) || 0);
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const pow = Math.pow(10, exp);
  const frac = x / pow;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * Balkendiagramm als E-Mail-taugliche Tabelle.
 * @param {object} o
 *   labels: string[]                 Achsenbeschriftung je Bucket
 *   current: number[]                Werte (kWh) der aktuellen Periode
 *   previous?: number[]              Vergleichswerte (kWh) der Vorperiode (blasse Balken)
 *   color?: string
 *   height?: number                  Zeichenhöhe in px
 *   labelEvery?: number              nur jedes n-te Label zeigen
 */
function barChartHtml(o = {}) {
  const cur = o.current || [];
  const prev = o.previous || null;
  const color = o.color || '#2563eb';
  const h = o.height || 110;
  const labels = o.labels || [];
  const max = niceMax(Math.max(0, ...cur.map(Math.abs), ...(prev || []).map(Math.abs)));
  const { unit, div } = axisUnit(max);
  const every = o.labelEvery || Math.max(1, Math.ceil(cur.length / 12));
  const axisVal = (f) => (max / div) * f;
  const axisFmt = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: max / div < 10 ? 1 : 0 });

  // Y-Achse: drei Stufen (max / halb / 0) über die Zeichenhöhe verteilt.
  const yAxis =
    `<td rowspan="2" width="46" valign="top" style="padding:0 4px 0 0">
       <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
         <tr><td height="${Math.round(h / 2)}" align="right" valign="top" style="font-size:9px;color:#888;line-height:1">${axisFmt(axisVal(1))}</td></tr>
         <tr><td height="${Math.round(h / 2)}" align="right" valign="top" style="font-size:9px;color:#888;line-height:1">${axisFmt(axisVal(0.5))}</td></tr>
         <tr><td align="right" valign="top" style="font-size:9px;color:#888;line-height:1">0 ${esc(unit)}</td></tr>
       </table>
     </td>`;

  // Ein Balken = leeres <div> mit fester Pixelhöhe in einer unten ausgerichteten Zelle.
  // Bewusst KEINE height-Attribute auf verschachtelten <td>: leere Zellen werden von
  // Mail-Clients auf 0 kollabiert – die Balken wären dann unsichtbar.
  const bar = (val, faded) => {
    const px = Math.max(1, Math.round((Math.abs(val || 0) / max) * h));
    const bg = faded ? fade(color) : color;
    return `<div style="height:${px}px;background:${bg};font-size:0;line-height:0">&nbsp;</div>`;
  };

  const barCell = (v, i) => {
    if (!prev) {
      return `<td valign="bottom" height="${h}" style="padding:0 1px;vertical-align:bottom">${bar(v, false)}</td>`;
    }
    return `<td valign="bottom" height="${h}" style="padding:0 1px;vertical-align:bottom">
        <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;table-layout:fixed"><tr>
          <td valign="bottom" style="vertical-align:bottom;padding:0 1px 0 0">${bar(v, false)}</td>
          <td valign="bottom" style="vertical-align:bottom;padding:0 0 0 1px">${bar(prev[i], true)}</td>
        </tr></table>
      </td>`;
  };

  const bars = cur.map(barCell).join('');
  const axisLabels = labels
    .map((l, i) => `<td align="center" style="font-size:9px;color:#888;padding-top:3px">${i % every === 0 || i === labels.length - 1 ? esc(l) : ''}</td>`)
    .join('');

  return `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;table-layout:fixed">
      <tr>${yAxis}${bars}</tr>
      <tr>${axisLabels}</tr>
    </table>`;
}

/**
 * Kompletter Diagramm-Block für den Bericht: je Rolle ein Diagramm mit Summen und Vergleich.
 * @param {object} chart  aus buildPeriodSeries(): { granularity, labels, periodLabel, comparisonLabel, series }
 */
const ROLE_META = {
  erzeugung: { label: 'PV-Erzeugung', color: '#16a34a' },
  verbrauch: { label: 'Verbrauch', color: '#2563eb' },
  netzbezug: { label: 'Netzbezug', color: '#f59e0b' },
  einspeisung: { label: 'Einspeisung', color: '#0d9488' },
  lieferung: { label: 'An Kunde geliefert', color: '#7c3aed' },
};

function buildReportCharts(chart) {
  if (!chart || !chart.series || !Object.keys(chart.series).length) return '';
  const granLabel = { hour: 'je Stunde', day: 'je Tag', month: 'je Monat' }[chart.granularity] || '';
  const blocks = Object.keys(chart.series)
    .map((role) => {
      const s = chart.series[role];
      const m = ROLE_META[role] || { label: role, color: '#6b7280' };
      return `<div style="margin:14px 0 20px">
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin-bottom:4px">
          <tr>
            <td style="font-size:13px;font-weight:700;color:${m.color}">${esc(s.name || m.label)}</td>
            <td align="right" style="font-size:12px;color:#444">${esc(chart.periodLabel)}: <b>${fmtEnergy(s.sum)}</b>${
              s.prevSum != null ? ` &nbsp;·&nbsp; ${esc(chart.comparisonLabel)}: ${fmtEnergy(s.prevSum)}` : ''
            }</td>
          </tr>
        </table>
        ${barChartHtml({ labels: chart.labels, current: s.values, previous: s.prevValues, color: m.color })}
      </div>`;
    })
    .join('');

  const sun = chart.sunHours;
  const sunLine =
    sun && sun.current != null
      ? `<div style="font-size:13px;margin:6px 0 2px">☀️ Sonnenstunden: <b>${sun.current}</b>${
          sun.previous != null ? ` (${esc(chart.comparisonLabel)}: ${sun.previous})` : ''
        } <span style="color:#888;font-size:11px">– Stunden mit nennenswerter PV-Erzeugung</span></div>`
      : '';

  return `<h3 style="margin-top:24px">Verlauf ${esc(granLabel)}</h3>
    ${sunLine}
    <div style="font-size:11px;color:#888;margin-bottom:2px">Kräftige Balken = ${esc(chart.periodLabel)}${
      chart.hasPrev ? `, blasse = ${esc(chart.comparisonLabel)}` : ''
    }. Y-Achse mit Skalierung je Diagramm.</div>
    ${blocks}`;
}

module.exports = { fmtEnergy, axisUnit, niceMax, fade, barChartHtml, buildReportCharts, ROLE_META };
