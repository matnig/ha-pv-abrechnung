'use strict';

// Plausibilitätsprüfung der Energiebilanz.
//
// Statt einen stillstehenden Zähler zu melden (das ist bei Energiezählern der Normalfall –
// nachts erzeugt die PV nichts, bei geladenem Akku ruht der Netzbezug), wird geprüft, ob die
// gemessenen Größen ZUEINANDER passen. Physikalisch gilt für jedes Zeitintervall:
//
//     Erzeugung + Netzbezug + Akku-Entladung  =  Verbrauch + Einspeisung + Akku-Ladung
//
// Die Akku-Energie kommt aus der Ladestandsänderung und der eingetragenen Kapazität:
//     Akku-Energie [kWh] = ΔLadestand [%] / 100 × nutzbare Kapazität [kWh]
//
// Widersprüche in dieser Bilanz sind echte Hinweise auf einen defekten oder hängenden Sensor –
// im Unterschied zu einem ruhenden Zähler. Geprüft wird bewusst mit großzügigen Toleranzen und
// Mindestmengen, damit Messrauschen, unterschiedliche Abfragezeitpunkte und Wandlungsverluste
// keine Meldung auslösen.

const round = (n, d = 3) => {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
};

const DEFAULTS = {
  minKwh: 0.3, // Mengen darunter werden ignoriert (Rauschen, Rundung)
  toleranzProzent: 25, // erlaubte Abweichung in der Gesamtbilanz
  toleranzKwh: 0.5, // absolute Mindesttoleranz
  akkuVerlustProzent: 15, // Lade-/Entladeverluste, die in der Bilanz fehlen dürfen
};

/**
 * Prüft ein Zeitintervall.
 * @param {object} d Zuwächse im Intervall (kWh, jeweils >= 0) und Akku-Angaben:
 *   erzeugung, einspeisung, netzbezug, verbrauch (verbrauch optional/null)
 *   akkuKwh: positive Zahl = geladen, negative = entladen (null = unbekannt)
 *   akkuSocProzent: aktueller Ladestand (für die Aussage „Akku voll")
 *   dauerMinuten: Länge des Intervalls
 *   akkuImPvZaehler: true, wenn der Erzeugungszähler die Akku-Entladung mitzählt
 *     (typisch für Hybrid-Wechselrichter, die am AC-Ausgang gemessen werden). Dann steckt die
 *     Entladung bereits in `erzeugung` und darf nicht zusätzlich als Quelle gerechnet werden;
 *     die Ladung läuft umgekehrt DC-seitig und erscheint gar nicht im Zähler.
 * @param {object} [cfg]
 * @returns {Array<{type:string, text:string, detail:object}>}
 */
function checkBalance(d, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const f = [];
  const gen = Math.max(0, Number(d.erzeugung) || 0);
  const feed = Math.max(0, Number(d.einspeisung) || 0);
  const grid = Math.max(0, Number(d.netzbezug) || 0);
  const con = d.verbrauch == null ? null : Math.max(0, Number(d.verbrauch) || 0);
  const akku = d.akkuKwh == null ? null : Number(d.akkuKwh) || 0;
  const soc = d.akkuSocProzent == null ? null : Number(d.akkuSocProzent);
  const hybrid = d.akkuImPvZaehler === true;
  // Bei Hybrid-Messung ist die Akku-Energie im Erzeugungswert bereits verrechnet und darf in der
  // Bilanz nicht doppelt auftauchen.
  const laden = !hybrid && akku != null && akku > 0 ? akku : 0;
  const entladen = !hybrid && akku != null && akku < 0 ? -akku : 0;

  // --- A) Einspeisung ohne Quelle -------------------------------------------------------
  // Ins Netz kann nur gehen, was die PV erzeugt oder der Akku abgibt.
  if (feed > c.minKwh) {
    const quelle = gen + entladen;
    if (quelle < feed * 0.5 && feed - quelle > c.toleranzKwh) {
      f.push({
        type: 'bilanz_einspeisung_ohne_quelle',
        text:
          `Es wurden ${round(feed, 2)} kWh eingespeist, obwohl im selben Zeitraum nur ` +
          `${round(quelle, 2)} kWh zur Verfügung standen (Erzeugung ${round(gen, 2)} kWh` +
          (hybrid ? ' – Akku-Entladung darin enthalten' : akku != null ? `, Akku-Entladung ${round(entladen, 2)} kWh` : ', Akku unbekannt') +
          `). Eingespeist werden kann nur, was erzeugt oder aus dem Akku entnommen wird – ` +
          `ein Zähler liefert hier offenbar falsche Werte.`,
        detail: { feed: round(feed, 3), gen: round(gen, 3), entladen: round(entladen, 3) },
      });
    }
  }

  // --- B) Erzeugte Energie verschwindet -------------------------------------------------
  // Was erzeugt wird, muss verbraucht, eingespeist oder gespeichert werden.
  if (gen > c.minKwh) {
    const senken = feed + laden + (con != null ? con : 0);
    if (con != null) {
      if (senken < gen * 0.5 && gen - senken > c.toleranzKwh) {
        f.push({
          type: 'bilanz_erzeugung_verschwindet',
          text:
            `Die Anlage erzeugte ${round(gen, 2)} kWh, es sind aber nur ${round(senken, 2)} kWh ` +
            `wiederzufinden (Verbrauch ${round(con, 2)}, Einspeisung ${round(feed, 2)}, ` +
            `Akku-Ladung ${round(laden, 2)} kWh). Die Differenz deutet auf einen hängenden oder ` +
            `falsch skalierten Zähler hin.`,
          detail: { gen: round(gen, 3), feed: round(feed, 3), laden: round(laden, 3), con: round(con, 3) },
        });
      }
    }
    // OHNE Verbrauchszähler ist hier bewusst KEINE Prüfung möglich: der Verbrauch ist dann die
    // unbekannte Größe, die jede Konstellation erklärt. Erzeugung und Netzbezug gleichzeitig
    // sind der Normalfall, sobald die Erzeugung den Bedarf nicht deckt (morgens, abends,
    // bewölkt). Eine Regel „PV läuft, trotzdem Netzbezug" erzeugte an echten Messdaten
    // ausschließlich Fehlalarme und wurde deshalb entfernt.
  }

  // --- C) Akku lädt ohne Quelle ---------------------------------------------------------
  // Nur prüfbar, wenn der Erzeugungszähler die Akku-Energie NICHT mitzählt: bei Hybrid-Messung
  // am AC-Ausgang wird der Akku DC-seitig geladen und taucht im Zähler nicht auf.
  if (!hybrid && laden > c.minKwh && gen + grid < laden * 0.5 && laden - (gen + grid) > c.toleranzKwh) {
    f.push({
      type: 'bilanz_akku_ohne_quelle',
      text:
        `Der Akku nahm ${round(laden, 2)} kWh auf, obwohl im selben Zeitraum nur ` +
        `${round(gen + grid, 2)} kWh verfügbar waren (Erzeugung ${round(gen, 2)}, Netzbezug ` +
        `${round(grid, 2)} kWh). Entweder ist die eingetragene Akkukapazität zu groß oder ein ` +
        `Zähler liefert falsche Werte.`,
      detail: { laden: round(laden, 3), gen: round(gen, 3), grid: round(grid, 3) },
    });
  }

  // --- D) Voller Akku, Erzeugung, aber keine Einspeisung --------------------------------
  // Ist der Akku voll und wird mehr erzeugt als gebraucht, MUSS eingespeist werden.
  // Mit Verbrauchszähler exakt prüfbar. Ohne ihn könnte ein hoher Verbrauch die fehlende
  // Einspeisung erklären – dann wird erst ab einer Erzeugung gemeldet, die ein üblicher
  // Verbrauch nicht mehr aufnehmen kann (`grosseErzeugung`), und nur wenn zeitgleich auch
  // kein Netzbezug lief (sonst deckt die Erzeugung offensichtlich nur den Eigenbedarf).
  const grosseErzeugung = gen >= Math.max(3, c.minKwh * 10);
  if (soc != null && soc >= 97 && gen > c.minKwh && laden < c.minKwh && feed < c.minKwh &&
      (con != null ? gen - con > c.toleranzKwh : grosseErzeugung && grid < c.minKwh)) {
    f.push({
      type: 'bilanz_kein_export_bei_vollem_akku',
      text:
        `Der Akku ist voll (${round(soc, 0)} %) und die Anlage erzeugte ${round(gen, 2)} kWh, es ` +
        `wurde aber nichts eingespeist. Bei vollem Speicher muss der Überschuss ins Netz gehen – ` +
        `vermutlich hängt der Einspeisezähler oder die Anlage regelt ab.`,
      detail: { soc: round(soc, 1), gen: round(gen, 3), feed: round(feed, 3) },
    });
  }

  // --- E) Gleichzeitig beziehen und einspeisen ------------------------------------------
  if (grid > c.minKwh && feed > c.minKwh && Math.min(grid, feed) > c.toleranzKwh) {
    f.push({
      type: 'bilanz_bezug_und_einspeisung',
      text:
        `Im selben Zeitraum wurden ${round(grid, 2)} kWh bezogen UND ${round(feed, 2)} kWh ` +
        `eingespeist. Kurzzeitig ist das möglich (wechselnde Last), dauerhaft deutet es auf ein ` +
        `falsches Zählerkonzept oder verwechselte Zähler hin.`,
      detail: { grid: round(grid, 3), feed: round(feed, 3) },
    });
  }

  // --- F) Gesamtbilanz (nur mit Verbrauchszähler und bekannter Akku-Energie) -------------
  if (con != null && (akku != null || hybrid)) {
    const zufluss = gen + grid + entladen;
    const abfluss = con + feed + laden;
    const diff = zufluss - abfluss;
    // Verluste dürfen fehlen (Akku-Wirkungsgrad), deshalb asymmetrische Toleranz.
    const erlaubt = Math.max(c.toleranzKwh, (zufluss * c.toleranzProzent) / 100, ((laden + entladen) * c.akkuVerlustProzent) / 100);
    if (Math.abs(diff) > erlaubt) {
      f.push({
        type: 'bilanz_stimmt_nicht',
        text:
          `Die Energiebilanz geht nicht auf: zugeflossen ${round(zufluss, 2)} kWh (Erzeugung ` +
          `${round(gen, 2)}, Netzbezug ${round(grid, 2)}, Akku-Entladung ${round(entladen, 2)}), ` +
          `abgeflossen ${round(abfluss, 2)} kWh (Verbrauch ${round(con, 2)}, Einspeisung ` +
          `${round(feed, 2)}, Akku-Ladung ${round(laden, 2)}) – Differenz ${round(diff, 2)} kWh ` +
          `bei erlaubten ${round(erlaubt, 2)} kWh. Ein Zähler oder die Akkukapazität passt nicht.`,
        detail: { zufluss: round(zufluss, 3), abfluss: round(abfluss, 3), diff: round(diff, 3), erlaubt: round(erlaubt, 3) },
      });
    }
  }

  return f;
}

module.exports = { checkBalance, DEFAULTS };
