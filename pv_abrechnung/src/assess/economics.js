'use strict';

// Wirtschaftlichkeitsrechnung für Erweiterungen.
//
// Bewusst mehrere Kennzahlen, weil die einfache Amortisation ("Investition / Jahresgewinn")
// Zinsen, Preissteigerung und Alterung ignoriert:
//   - statische Amortisation  : schnell verständlich, für den Vergleich untereinander
//   - dynamische Amortisation : mit Kalkulationszins, Strompreissteigerung und Degradation
//   - Kapitalwert (NPV)       : Gesamtgewinn über die Laufzeit in heutigem Geld
//   - Rendite (IRR)           : Verzinsung des eingesetzten Kapitals
//   - Stromgestehungskosten   : was die selbst erzeugte kWh über die Laufzeit kostet
//
// Häufiger Fehler, den dieses Modul vermeidet: Einen Speicher über die Einspeisevergütung zu
// rechnen. Ein Speicher verdient nichts an der Einspeisung – er verwandelt Einspeisung in
// Kundenlieferung (bzw. vermiedenen Netzbezug). Genau diese Differenz wird hier bewertet.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round = (n, d = 3) => {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
};

// Annahmen mit Quelle/Begründung – alle im UI überschreibbar.
// Durchgängig NOMINAL gerechnet (nominaler Zins + nominale Preissteigerung). Reale und nominale
// Größen dürfen nicht gemischt werden – das ist der häufigste Fehler in solchen Rechnungen.
const DEFAULTS = {
  kalkulationszins: 3.0, // %/Jahr nominal (Fraunhofer ISE: WACC 5,0% gewerblich, 4% Kleinanlagen)
  strompreissteigerung: 2.0, // %/Jahr nominal (historisch 3,8% CAGR, aber von Umlage-Einmaleffekten geprägt)
  degradationPv: 0.4, // %/Jahr Modulalterung (ISE-Messung 0,15%, Rechenwert 0,25%, Garantie 0,5%)
  degradationBatterie: 1.5, // %/Jahr Kapazitätsverlust
  betriebskostenPvProKwp: 26, // €/kWp/Jahr (Fraunhofer ISE 2024: 26 €/kW·a bis 30 kWp, 21,5 darüber)
  betriebskostenBatterieProzent: 0.5, // %/Jahr der Investition
  laufzeitPv: 25, // Jahre Betrachtung
  laufzeitBatterie: 15, // ISE-Rechenwert, danach Ersatz
  kostenPvProKwp: 1300, // €/kWp Neuanlage ≤30 kWp (ISE-Spanne 1.000–2.000)
  kostenPvMarginalProKwp: 750, // €/kWp reiner Zubau auf bestehendem Dach (Module/Unterbau/DC)
  kostenBatterieProKwh: 450, // €/kWh nutzbar, fertig installiert (ISE 500–1.000, Markt ab ~315)
  batterieNachruestFaktor: 15, // % Zuschlag beim Nachrüsten in eine bestehende Anlage
  batterieRoundTrip: 85, // % Round-Trip AC-AC (HTW-Messung 83,9%; Bestwerte bis 97%)
  batterieNutzkapazitaetFaktor: 90, // % der Nennkapazität sind nutzbar
  batterieStandbyWatt: 8, // W Dauerverbrauch der Speicherelektronik (HTW: 4–64 W)
  wrErsatzJahr: 15, // Wechselrichter-Tausch
  wrErsatzProKw: 190, // €/kW
  batterieErsatzProzent: 45, // % der Erstinvestition (ISE 40–50%)
  negativpreisAbschlag: 8, // % Erlösminderung durch Stunden mit negativem Börsenpreis
};

/** Investitionskosten mit Größenstaffelung (kleine Erweiterungen sind je kWp teurer). */
function pvInvest(addKwp, perKwp, fixKosten = 0) {
  const kwp = Math.max(0, Number(addKwp) || 0);
  if (!kwp) return 0;
  const base = Number(perKwp) || DEFAULTS.kostenPvProKwp;
  // Kleinanlagen-Zuschlag: unter 5 kWp deutlich höherer Preis je kWp (Fixanteile wie
  // Gerüst, Anfahrt, Anmeldung verteilen sich auf weniger Leistung).
  const factor = kwp < 3 ? 1.35 : kwp < 5 ? 1.2 : kwp < 10 ? 1.05 : kwp > 30 ? 0.9 : 1;
  return round2(kwp * base * factor + (Number(fixKosten) || 0));
}

/**
 * @param {boolean} [nachruesten]  true = Einbau in eine bestehende Anlage (Zuschlag 10-20%)
 */
function batteryInvest(addKwh, perKwh, fixKosten = 0, nachruesten = false) {
  const kwh = Math.max(0, Number(addKwh) || 0);
  if (!kwh) return 0;
  const base = Number(perKwh) || DEFAULTS.kostenBatterieProKwh;
  const factor = kwh < 5 ? 1.25 : kwh < 10 ? 1.1 : kwh > 30 ? 0.85 : 1;
  const nach = nachruesten ? 1 + DEFAULTS.batterieNachruestFaktor / 100 : 1;
  return round2(kwh * base * factor * nach + (Number(fixKosten) || 0));
}

/**
 * Cashflow-Reihe und Kennzahlen.
 * @param {object} o
 *   invest: number             Investition (€, Jahr 0)
 *   jahresErloesJahr1: number  zusätzlicher Erlös/Ersparnis im ersten Jahr (€)
 *   laufzeit: number           Jahre
 *   zins: number               %/Jahr
 *   preissteigerung: number    %/Jahr auf die Erlöse
 *   degradation: number        %/Jahr Leistungsverlust
 *   betriebskosten: number     €/Jahr (absolut)
 *   ertragKwhJahr1?: number    für die Stromgestehungskosten
 *   ersatz?: Array<{jahr:number, kosten:number, was:string}>  Ersatzinvestitionen (WR/Batterie)
 */
function evaluate(o) {
  const invest = Number(o.invest) || 0;
  const laufzeit = Math.max(1, Math.round(Number(o.laufzeit) || 20));
  const i = (Number(o.zins) || 0) / 100;
  const g = (Number(o.preissteigerung) || 0) / 100;
  const deg = (Number(o.degradation) || 0) / 100;
  const opex = Number(o.betriebskosten) || 0;
  const e1 = Number(o.jahresErloesJahr1) || 0;

  // Statische Amortisation: Investition / Überschuss des ersten Jahres. Bewusst OHNE Zins,
  // Preissteigerung und Alterung – sonst wäre es keine statische Kennzahl mehr. Sie darf auch
  // über der Laufzeit liegen; `amortisiertInnerhalbLaufzeit` sagt, ob sie erreicht wird.
  const ueberschussJahr1 = e1 - opex;
  const amortStatisch = ueberschussJahr1 > 0 ? round(invest / ueberschussJahr1, 2) : null;

  const flows = [];
  let kumuliert = -invest;
  let kumuliertDiskontiert = -invest;
  let npv = -invest;
  let amortDynamisch = null;
  let ertragDiskontiert = 0;
  let kostenDiskontiert = invest;

  const ersatzListe = (o.ersatz || []).filter((e) => e && e.jahr > 0 && e.jahr <= laufzeit && e.kosten > 0);
  for (let t = 1; t <= laufzeit; t++) {
    const preisFaktor = Math.pow(1 + g, t - 1);
    const degFaktor = Math.pow(1 - deg, t - 1);
    const erloes = e1 * preisFaktor * degFaktor;
    // Ersatzinvestitionen (Wechselrichter, Batterie) fallen in einzelnen Jahren an und werden
    // häufig vergessen – ohne sie sieht jede Rechnung zu gut aus.
    const ersatz = ersatzListe.filter((e) => e.jahr === t).reduce((s, e) => s + e.kosten, 0);
    const cf = erloes - opex - ersatz;
    const disk = cf / Math.pow(1 + i, t);
    kumuliert += cf;
    const vorherDisk = kumuliertDiskontiert;
    kumuliertDiskontiert += disk;
    npv += disk;
    if (amortDynamisch == null && kumuliertDiskontiert >= 0 && disk > 0) {
      amortDynamisch = round(t - 1 + Math.min(1, Math.abs(vorherDisk) / disk), 2);
    }
    if (o.ertragKwhJahr1) {
      ertragDiskontiert += (Number(o.ertragKwhJahr1) * degFaktor) / Math.pow(1 + i, t);
      kostenDiskontiert += opex / Math.pow(1 + i, t);
    }
    flows.push({ jahr: t, erloes: round2(erloes), betriebskosten: round2(opex), ersatz: round2(ersatz), cashflow: round2(cf), kumuliert: round2(kumuliert), diskontiert: round2(disk) });
  }

  return {
    invest: round2(invest),
    jahresErloesJahr1: round2(e1),
    betriebskostenJahr: round2(opex),
    laufzeit,
    amortisationStatisch: amortStatisch,
    amortisationDynamisch: amortDynamisch,
    amortisiertInnerhalbLaufzeit: amortStatisch != null && amortStatisch <= laufzeit,
    npv: round2(npv),
    // Bei Ersatzinvestitionen wechselt der Cashflow mehrfach das Vorzeichen – dann ist der
    // interne Zinsfuß nicht eindeutig und wird bewusst nicht ausgewiesen (nur der Kapitalwert).
    irr: ersatzListe.length ? null : irr(invest, e1, opex, laufzeit, g, deg),
    irrHinweis: ersatzListe.length ? 'Wegen der Ersatzinvestition ist der interne Zinsfuß nicht eindeutig – maßgeblich ist der Kapitalwert.' : null,
    ersatzinvestitionen: ersatzListe.map((e) => ({ ...e })),
    lcoe: ertragDiskontiert > 0 ? round(kostenDiskontiert / ertragDiskontiert, 4) : null,
    gesamtueberschuss: round2(kumuliert),
    flows,
  };
}

/** Interner Zinsfuß per Bisektion (robuster als Newton bei unregelmäßigen Reihen). */
function irr(invest, e1, opex, laufzeit, g, deg) {
  if (!invest || !e1) return null;
  const npvAt = (rate) => {
    let v = -invest;
    for (let t = 1; t <= laufzeit; t++) {
      const cf = e1 * Math.pow(1 + g, t - 1) * Math.pow(1 - deg, t - 1) - opex;
      v += cf / Math.pow(1 + rate, t);
    }
    return v;
  };
  let lo = -0.9;
  let hi = 1.0;
  if (npvAt(lo) < 0) return null; // selbst bei -90% negativ -> keine Lösung
  if (npvAt(hi) > 0) return null; // über 100% -> unrealistisch, nicht ausweisen
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (npvAt(mid) > 0) lo = mid;
    else hi = mid;
  }
  return round(((lo + hi) / 2) * 100, 2);
}

/**
 * Größensuche: kleinste/größte Variante, die eine Ziel-Amortisation einhält.
 * @param {Array<{label:string, kennzahlen:object}>} variants  bewertete Varianten
 * @param {number} zielJahre
 */
function bestForTarget(variants, zielJahre, key = 'amortisationDynamisch') {
  const ok = (variants || []).filter((v) => {
    const a = v.kennzahlen && v.kennzahlen[key];
    return a != null && a <= zielJahre;
  });
  if (!ok.length) return null;
  // Unter den Varianten, die das Ziel halten: die mit dem höchsten Kapitalwert.
  return ok.reduce((b, v) => (v.kennzahlen.npv > b.kennzahlen.npv ? v : b), ok[0]);
}

module.exports = { DEFAULTS, evaluate, irr, pvInvest, batteryInvest, bestForTarget };
