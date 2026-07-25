'use strict';

// Stündliche Simulation von Erweiterungen auf dem echten Messprofil.
//
// Grundgedanke: Jede Stunde wird die Energiebilanz nachgerechnet. Zusätzliche PV-Leistung
// skaliert die gemessene Erzeugungskurve (gleiche Ausrichtung) bzw. eine PVGIS-Kurve (andere
// Ausrichtung). Ein Speicher wird als Energiebilanz mit Wirkungsgrad und Kapazitätsgrenze
// mitgeführt: Überschuss lädt, Bedarf entlädt.
//
// WICHTIG für das Geschäftsmodell des Betreibers: Eine zusätzlich erzeugte kWh ist nicht
// gleich viel wert. Sie bringt
//   - den Lieferpreis (z.B. 0,22 €/kWh), wenn der KUNDE sie in derselben Stunde braucht,
//   - nur die Einspeisevergütung (z.B. 0,08 €/kWh), wenn sie ins Netz geht.
// Ein Speicher verschiebt Energie aus der zweiten in die erste Kategorie – genau das macht
// ihn wirtschaftlich, nicht die Einspeisung.

const round = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const sum = (a) => round((a || []).reduce((x, y) => x + y, 0));

/**
 * Bilanz einer Variante über alle Stunden.
 * @param {object} p
 *   generation: number[]   Erzeugung je Stunde (kWh)
 *   consumption: number[]  Verbrauch je Stunde (kWh)
 *   batteryKwh?: number    nutzbare Kapazität (0 = kein Speicher)
 *   roundTrip?: number     Round-Trip-Wirkungsgrad (0..1), Standard 0,90
 *   maxChargeKw?: number   Ladeleistungsgrenze (kW), Standard: Kapazität/2 (C-Rate 0,5)
 *   dod?: number           nutzbarer Anteil, falls Kapazität als Brutto angegeben (Standard 1 = netto)
 *   standbyWatt?: number   Dauerverbrauch der Speicherelektronik (nur wenn Speicher vorhanden)
 */
function simulate(p) {
  const gen = p.generation || [];
  const con = p.consumption || [];
  const n = Math.min(gen.length, con.length);
  const cap = Math.max(0, Number(p.batteryKwh) || 0) * (p.dod != null ? p.dod : 1);
  const rt = p.roundTrip != null ? p.roundTrip : 0.9;
  const etaIn = Math.sqrt(rt); // Verluste je Richtung gleich verteilt
  const etaOut = Math.sqrt(rt);
  const maxCh = p.maxChargeKw != null ? p.maxChargeKw : cap / 2;
  const maxDis = p.maxDischargeKw != null ? p.maxDischargeKw : cap / 2;

  let soc = 0; // gespeicherte Energie (kWh)
  let eigen = 0; // direkt genutzte PV
  let feed = 0; // Einspeisung
  let grid = 0; // Netzbezug
  let charged = 0;
  let discharged = 0;
  let curtailedIn = 0; // Überschuss, den der Speicher nicht aufnehmen konnte (geht ins Netz)
  let fullCycles = 0;

  // Standby der Speicherelektronik: läuft rund um die Uhr und ist bilanzrelevant
  // (bei 64 W sind das über 500 kWh im Jahr). Wird dem Verbrauch zugeschlagen.
  const standbyKwhPerHour = cap > 0 ? (Number(p.standbyWatt) || 0) / 1000 : 0;
  let standbySumme = 0;

  for (let i = 0; i < n; i++) {
    const g = gen[i] || 0;
    const c = (con[i] || 0) + standbyKwhPerHour;
    standbySumme += standbyKwhPerHour;
    const direct = Math.min(g, c);
    eigen += direct;
    let surplus = g - direct;
    let deficit = c - direct;

    if (cap > 0) {
      // Laden mit Überschuss
      if (surplus > 0) {
        const room = (cap - soc) / etaIn; // wie viel Eingangsenergie noch Platz hat
        const take = Math.min(surplus, room, maxCh);
        if (take > 0) {
          soc += take * etaIn;
          charged += take;
          surplus -= take;
        }
      }
      // Entladen für Restbedarf
      if (deficit > 0 && soc > 0) {
        const avail = soc * etaOut;
        const give = Math.min(deficit, avail, maxDis);
        if (give > 0) {
          soc -= give / etaOut;
          discharged += give;
          deficit -= give;
        }
      }
    }
    if (surplus > 0) {
      feed += surplus;
      if (cap > 0) curtailedIn += surplus;
    }
    if (deficit > 0) grid += deficit;
  }

  if (cap > 0) fullCycles = round(charged / cap);

  return {
    generation: sum(gen.slice(0, n)),
    consumption: sum(con.slice(0, n)),
    direktverbrauch: round(eigen),
    speicherentladung: round(discharged),
    eigenverbrauch: round(eigen + discharged), // vom Kunden genutzte PV-Energie
    einspeisung: round(feed),
    netzbezug: round(grid),
    speicherladung: round(charged),
    speicherverluste: round(charged - discharged),
    speicherStandby: round(standbySumme),
    ungenutzterUeberschuss: round(curtailedIn),
    vollzyklen: fullCycles,
    endSoc: round(soc),
  };
}

/**
 * Erzeugungskurve für zusätzliche kWp. Standard: gemessene Kurve linear skalieren (gleiche
 * Ausrichtung/Standort, deshalb sehr belastbar). Mit `shape` kann eine andere Kurve (z.B. aus
 * PVGIS für eine andere Dachseite) als Form vorgegeben werden.
 * @param {number[]} baseGeneration  gemessene Erzeugung je Stunde
 * @param {number} baseKwp           installierte Leistung, die diese Kurve erzeugt hat
 * @param {number} addKwp            zusätzliche Leistung
 * @param {number[]} [shape]         alternative Stundenform je kWp (gleiche Länge)
 */
function scaleGeneration(baseGeneration, baseKwp, addKwp, shape) {
  const add = Math.max(0, Number(addKwp) || 0);
  if (!add) return (baseGeneration || []).slice();
  if (shape && shape.length === (baseGeneration || []).length) {
    return baseGeneration.map((v, i) => round(v + (shape[i] || 0) * add));
  }
  if (!baseKwp || baseKwp <= 0) return (baseGeneration || []).slice();
  const f = 1 + add / baseKwp;
  return (baseGeneration || []).map((v) => round(v * f));
}

/**
 * Geldwert einer Bilanz aus Betreibersicht.
 * @param {object} bal    Ergebnis aus simulate()
 * @param {object} prices { lieferung, einspeisung, netzbezug, einspeisungAnBetreiber }
 *
 * einspeisungAnBetreiber = true  -> Betreiber erhält die Einspeisevergütung selbst.
 * einspeisungAnBetreiber = false -> die Vergütung geht an den Kunden; dann bringt eingespeiste
 *                                  Energie dem Betreiber keinen Erlös.
 */
function revenue(bal, prices = {}) {
  const lief = Number(prices.lieferung) || 0;
  const eeg = Number(prices.einspeisung) || 0;
  const netz = Number(prices.netzbezug) || 0;
  const anBetreiber = prices.einspeisungAnBetreiber !== false;

  const erloesLieferung = round(bal.eigenverbrauch * lief);
  const erloesEinspeisung = anBetreiber ? round(bal.einspeisung * eeg) : 0;
  // Netzbezug zahlt der Kunde (Weiterberechnung) – für den Betreiber neutral, aber als
  // Kundennutzen ausgewiesen (Ersparnis-Argument).
  const kundenkostenNetz = round(bal.netzbezug * netz);
  return {
    erloesLieferung,
    erloesEinspeisung,
    erloesGesamt: round(erloesLieferung + erloesEinspeisung),
    kundenkostenNetz,
    kundenkostenGesamt: round(erloesLieferung + kundenkostenNetz),
  };
}

module.exports = { simulate, scaleGeneration, revenue };
