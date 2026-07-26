'use strict';

// Gesamtbewertung der Anlage: Zustand, Erweiterungsvarianten, Tarifhebel, Empfehlung.
//
// Ablauf:
//   1. Stündliches Messprofil laden (echte Daten, glitch-sicher)
//   2. Stammdaten bestimmen (Config > HA-Sensoren > Schätzung; Fehlendes wird benannt)
//   3. Ist-Zustand simulieren und mit dem Standort-Soll (PVGIS) vergleichen
//   4. Varianten simulieren: mehr PV, mehr Speicher, Kombinationen
//   5. Jede Variante wirtschaftlich bewerten und gegen die Ziel-Amortisation prüfen
//   6. Hebel ohne Investition prüfen (Preise, Vertrag)
//
// Grundsatz: Was nicht aus Daten belegbar ist, wird als fehlend ausgewiesen – nicht geraten.

const { buildHourlyProfile, shares } = require('./loadProfile');
const { detectPlant } = require('./discovery');
const { simulate, scaleGeneration, revenue } = require('./simulate');
const { evaluate, pvInvest, batteryInvest, bestForTarget, DEFAULTS } = require('./economics');
const { assessHealth } = require('./health');
const { detectPerformanceDrop } = require('./trend');
const eeg = require('./eeg');
const pvgis = require('./pvgis');

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** Stufen für den Zubau, an die Anlagengröße angepasst und ggf. durch die Dachfläche begrenzt. */
function pvSteps(kwp, maxKwp) {
  let base = !kwp ? [5, 10, 20] : [0.25, 0.5, 1.0, 1.5].map((f) => Math.round(kwp * f * 2) / 2);
  const limit = Number(maxKwp);
  if (Number.isFinite(limit) && limit > 0) {
    base = base.filter((v) => v <= limit);
    // Die maximale Belegung ist immer eine interessante Variante.
    if (!base.includes(limit)) base.push(limit);
  }
  return [...new Set(base.filter((v) => v >= 1))].sort((a, b) => a - b);
}
function batterySteps(existing, verbrauchJahr) {
  // Orientierung: 1 kWh Speicher je 1000 kWh Jahresverbrauch ist eine gängige Hausnummer;
  // Stufen darum herum, plus kleinere/größere Varianten.
  const ref = verbrauchJahr ? Math.max(5, Math.round(verbrauchJahr / 1000)) : 10;
  const set = [ref * 0.5, ref, ref * 1.5, ref * 2].map((v) => Math.round(v));
  return [...new Set(set.filter((v) => v >= 3))];
}

/**
 * @param {object} config
 * @param {object} ha        haClient
 * @param {object} [opts]    { months, zielAmortisation, annahmen:{}, now, skipPvgis }
 */
async function runAssessment(config, ha, opts = {}) {
  const annahmen = { ...DEFAULTS, ...(config.assess || {}), ...(opts.annahmen || {}) };
  const zielJahre = Number(opts.zielAmortisation ?? annahmen.zielAmortisation ?? 10);
  const warnings = [];
  const dataGaps = [];

  // --- 1. Messprofil ---
  const profile = await buildHourlyProfile(config, ha, { months: opts.months || 12, now: opts.now });
  const cov = profile.coverage;
  if (!cov.hours || cov.ratio < 0.2) {
    return {
      ok: false,
      grund:
        'Es liegen zu wenige Messdaten vor, um die Anlage zu bewerten. Benötigt werden Zählerstände über mehrere Wochen ' +
        'in der Home-Assistant-Langzeitstatistik (mindestens Erzeugung und Netzbezug/Einspeisung).',
      coverage: cov,
    };
  }
  if (!cov.fullYear) {
    warnings.push(
      `Die Datenbasis umfasst ${cov.days} Tage (${cov.months} Monate). Alle Jahreswerte sind Hochrechnungen ` +
        `(Faktor ${cov.yearFactor}); je weniger Jahreszeiten enthalten sind, desto unsicherer.`
    );
  }
  if ((cov.missingRoles || []).length) {
    dataGaps.push({ was: `Zähler mit Rolle: ${cov.missingRoles.join(', ')}`, warum: 'Ohne diese Zähler ist der Eigenverbrauch nicht exakt bestimmbar.' });
  }
  if (cov.derivedConsumption) {
    warnings.push('Der Kundenverbrauch wird rechnerisch aus Erzeugung − Einspeisung + Netzbezug bestimmt (kein eigener Verbrauchszähler konfiguriert).');
  }

  // --- 2. Stammdaten ---
  let states = [];
  try {
    states = await ha.listAllStates();
  } catch (e) {
    warnings.push('HA-Entitäten konnten nicht gelesen werden – Stammdaten nur aus Konfiguration/Schätzung: ' + ((e && e.message) || e));
  }
  const socPairs = []; // (Ausbau möglich: Ladehübe aus SoC-Historie; hier bewusst leer statt geraten)
  const plant = detectPlant(config, states, { generationHourlyKwh: profile.series.erzeugung, socPairs });
  for (const m of plant.missing) dataGaps.push({ was: m.label, warum: m.why, feld: m.field });

  const kwp = plant.kwp ? plant.kwp.value : null;
  const batteryKwh = plant.batteryKwh ? plant.batteryKwh.value : 0;
  const rt = (Number(annahmen.batterieRoundTrip) || 90) / 100;

  // --- 3. Ist-Zustand ---
  const gen = profile.series.erzeugung;
  const con = profile.series.verbrauch;
  const istSim = simulate({ generation: gen, consumption: con, batteryKwh, roundTrip: rt, standbyWatt: batteryKwh ? annahmen.batterieStandbyWatt : 0 });
  // Im Eigenverbrauchsmodus ist eine selbst genutzte kWh den eigenen Strompreis wert
  // (vermiedener Bezug) – es gibt keinen Lieferpreis.
  const eigenModus = config.betriebsmodus === 'eigenverbrauch';
  const tf = config.tariffs || {};
  const preise = {
    lieferung: eigenModus ? Number(tf.netzpreis || tf.netzbezug) || 0 : Number(tf.lieferung) || 0,
    einspeisung: Number(tf.einspeisung) || 0,
    netzbezug: Number(tf.netzbezug || tf.netzpreis) || 0,
    einspeisungAnBetreiber: eigenModus ? true : tf.einspeisungAnBetreiber !== false,
  };
  if (!preise.lieferung) {
    dataGaps.push(
      eigenModus
        ? { was: 'Eigener Strompreis (€/kWh)', warum: 'Ohne ihn ist nicht berechenbar, was eine selbst genutzte kWh wert ist (vermiedener Strombezug).', feld: 'tariffs.netzpreis' }
        : { was: 'Lieferpreis (€/kWh) für den an den Kunden gelieferten Strom', warum: 'Ohne Lieferpreis kann der wirtschaftliche Nutzen zusätzlicher PV-Energie nicht berechnet werden.', feld: 'tariffs.lieferung' }
    );
  }
  const istErloes = revenue(istSim, preise);
  const yf = cov.yearFactor || 1;

  // Standort-Soll (PVGIS)
  let soll = null;
  let standort = null;
  if (!opts.skipPvgis) {
    try {
      const haCfg = await ha.getHaConfig();
      standort = { lat: haCfg.latitude, lon: haCfg.longitude, quelle: 'Home Assistant' };
      const p = config.plant || {};
      soll = await pvgis.yieldPerKwp({
        lat: haCfg.latitude,
        lon: haCfg.longitude,
        angle: p.neigung != null ? p.neigung : 35,
        aspect: p.ausrichtung != null ? pvgis.aspectFromDirection(p.ausrichtung) : 0,
        fetchImpl: opts.pvgisFetch,
      });
    } catch (e) {
      warnings.push('Standort-Sollertrag (PVGIS) nicht verfügbar: ' + ((e && e.message) || e) + ' – der Soll-Ist-Vergleich entfällt.');
    }
  }

  // --- Leistungsabfall über die Zeit ---
  // Normiert gegen das Standort-Klimamittel (PVGIS-Monatswerte) und – wenn genug Historie
  // vorhanden ist – gegen den gleichen Monat des Vorjahres.
  const trend = detectPerformanceDrop({
    generation: gen,
    startMs: cov.startMs,
    kwp,
    sollMonatlichKwhPerKwp: soll ? soll.monthlyKwhPerKwp : null,
  });
  if (trend.ok && !(trend.monate || []).some((m) => m.quoteVorjahr != null)) {
    warnings.push(
      'Für den Vorjahresvergleich fehlt Historie: mit mehr als zwölf Monaten Messdaten kann das System einen ' +
        'Leistungsabfall zusätzlich unabhängig vom Wetter erkennen (gleicher Monat im Vorjahr). ' +
        'Dafür bei „Datenbasis" 24 Monate wählen, sobald die Statistik so weit zurückreicht.'
    );
  }

  // --- Gesundheit ---
  const health = assessHealth({
    profile,
    kwp,
    sollKwhPerKwp: soll ? soll.yearKwhPerKwp : null,
    batteryKwh,
    batterySim: batteryKwh ? istSim : null,
  });

  // --- 4./5. Varianten ---
  const verbrauchJahr = round(profile.totals.verbrauch * yf, 0);
  const variants = [];
  // AC-Nennleistung des Wechselrichters: mehr als das kann in keiner Stunde eingespeist bzw.
  // genutzt werden. Ohne diese Deckelung würde ein Zubau ohne WR-Tausch überschätzt.
  const wrKw = Number((config.plant || {}).wechselrichterKw) || null;
  const clipStats = { variants: {} };
  const mkVariant = (label, art, addKwp, addKwh, shape) => {
    let g = addKwp ? scaleGeneration(gen, kwp, addKwp, shape) : gen;
    if (addKwp && wrKw) {
      let verloren = 0;
      g = g.map((v) => {
        if (v > wrKw) {
          verloren += v - wrKw;
          return wrKw;
        }
        return v;
      });
      if (verloren > 0.5) clipStats.variants[label] = round(verloren * yf, 0);
    }
    const neueKapazitaet = batteryKwh + (addKwh || 0);
    const sim = simulate({
      generation: g,
      consumption: con,
      batteryKwh: neueKapazitaet,
      roundTrip: rt,
      dod: addKwh ? (annahmen.batterieNutzkapazitaetFaktor || 100) / 100 : 1,
      standbyWatt: neueKapazitaet ? annahmen.batterieStandbyWatt : 0,
    });

    // Der ZUBAU erhält den heute gültigen EEG-Satz, nicht den der Bestandsanlage. Deshalb wird
    // die zusätzliche Einspeisung separat mit dem aktuellen Satz bewertet, der Bestand behält
    // seinen Satz. Ohne diese Trennung wird der Nutzen einer Erweiterung überschätzt.
    const eegNeu = addKwp ? eeg.rateForExtension({ addKwp, bestandKwp: kwp, zusammenfassen: false, negativpreisAbschlagProzent: annahmen.negativpreisAbschlag }) : null;
    const erlBestandspreise = revenue(sim, preise);
    let deltaJahr;
    if (eegNeu) {
      // Lieferung zum Lieferpreis; die zusätzliche Einspeisung zum NEUEN Satz, die bisherige
      // Einspeisung weiter zum Bestandssatz.
      const dEigen = sim.eigenverbrauch - istSim.eigenverbrauch;
      const dEinsp = sim.einspeisung - istSim.einspeisung;
      const einspSatzNeu = preise.einspeisungAnBetreiber ? eegNeu.satzEffektiv : 0;
      deltaJahr = round((dEigen * preise.lieferung + dEinsp * einspSatzNeu) * yf, 2);
    } else {
      deltaJahr = round((erlBestandspreise.erloesGesamt - istErloes.erloesGesamt) * yf, 2);
    }

    // Zubau auf bestehendem Dach = Grenzkosten (Module/Unterbau), nicht Neuanlagenpreis.
    const investPv = addKwp ? pvInvest(addKwp, annahmen.kostenPvMarginalProKwp) : 0;
    const investBat = addKwh ? batteryInvest(addKwh, annahmen.kostenBatterieProKwh, 0, true) : 0;
    const invest = round(investPv + investBat, 2);
    // Laufzeit/Alterung nach Schwerpunkt der Investition
    const batAnteil = invest > 0 ? investBat / invest : 0;
    const laufzeit = Math.round(batAnteil * annahmen.laufzeitBatterie + (1 - batAnteil) * annahmen.laufzeitPv);
    const degradation = round(batAnteil * annahmen.degradationBatterie + (1 - batAnteil) * annahmen.degradationPv, 2);
    // Betriebskosten: PV leistungsbezogen (ISE: 26 €/kWp·a), Speicher anteilig der Investition.
    const opex = round((addKwp || 0) * (annahmen.betriebskostenPvProKwp || 0) + (investBat * annahmen.betriebskostenBatterieProzent) / 100, 2);
    // Ersatzinvestitionen: Wechselrichter und Batterie halten nicht die ganze Laufzeit.
    const ersatz = [];
    if (addKwp && annahmen.wrErsatzJahr < laufzeit) {
      ersatz.push({ jahr: annahmen.wrErsatzJahr, kosten: round(addKwp * annahmen.wrErsatzProKw, 2), was: 'Wechselrichter-Ersatz' });
    }
    if (addKwh && annahmen.laufzeitBatterie < laufzeit) {
      ersatz.push({ jahr: annahmen.laufzeitBatterie, kosten: round((investBat * annahmen.batterieErsatzProzent) / 100, 2), was: 'Batterie-Ersatz' });
    }
    const mehrErzeugung = round((sim.generation - istSim.generation) * yf, 0);
    const kennzahlen = evaluate({
      invest,
      jahresErloesJahr1: deltaJahr,
      laufzeit,
      zins: annahmen.kalkulationszins,
      preissteigerung: annahmen.strompreissteigerung,
      degradation,
      betriebskosten: opex,
      ersatz,
      ertragKwhJahr1: mehrErzeugung || round((sim.eigenverbrauch - istSim.eigenverbrauch) * yf, 0),
    });
    variants.push({
      label,
      art,
      addKwp: addKwp || 0,
      addKwh: addKwh || 0,
      invest,
      investAufteilung: { pv: investPv, speicher: investBat },
      eegNeu,
      bilanz: sim,
      wirkung: {
        mehrErzeugungKwhJahr: mehrErzeugung,
        mehrEigenverbrauchKwhJahr: round((sim.eigenverbrauch - istSim.eigenverbrauch) * yf, 0),
        wenigerNetzbezugKwhJahr: round((istSim.netzbezug - sim.netzbezug) * yf, 0),
        mehrEinspeisungKwhJahr: round((sim.einspeisung - istSim.einspeisung) * yf, 0),
        mehrErloesEuroJahr: deltaJahr,
      },
      kennzahlen,
      erreichtZiel: kennzahlen.amortisationDynamisch != null && kennzahlen.amortisationDynamisch <= zielJahre,
    });
  };

  const canScalePv = !!kwp;
  if (canScalePv) {
    const maxZubau = (config.plant || {}).freieFlaecheKwp;
    const steps = pvSteps(kwp, maxZubau);
    if (!steps.length && Number(maxZubau) > 0) {
      warnings.push(`Der angegebene freie Platz (${maxZubau} kWp) ist kleiner als die kleinste sinnvolle Zubaustufe – es werden keine PV-Varianten gerechnet.`);
    }
    for (const add of steps) mkVariant(`+${add} kWp Module${Number(maxZubau) === add ? ' (maximale Dachbelegung)' : ''}`, 'pv', add, 0);
  } else {
    dataGaps.push({ was: 'Modulleistung (kWp)', warum: 'Ohne kWp kann eine PV-Erweiterung nicht hochgerechnet werden.', feld: 'kwp' });
  }
  for (const add of batterySteps(batteryKwh, verbrauchJahr)) mkVariant(`+${add} kWh Speicher`, 'battery', 0, add);
  if (canScalePv) {
    const comboSteps = pvSteps(kwp, (config.plant || {}).freieFlaecheKwp);
    const pv = comboSteps[1] || comboSteps[0];
    const bat = batterySteps(batteryKwh, verbrauchJahr)[1] || batterySteps(batteryKwh, verbrauchJahr)[0];
    if (pv && bat) mkVariant(`+${pv} kWp Module und +${bat} kWh Speicher`, 'combo', pv, bat);
  }

  // Wechselrichter-Deckelung transparent machen: verlorene Energie je Variante.
  const clipped = Object.entries(clipStats.variants);
  if (clipped.length) {
    warnings.push(
      `Der Wechselrichter (${wrKw} kW) begrenzt den Zubau: ` +
        clipped.map(([l, kwh]) => `bei „${l}" gehen dadurch rund ${kwh} kWh/Jahr verloren`).join(', ') +
        '. Die Varianten sind bereits mit dieser Deckelung gerechnet; ein größerer Wechselrichter würde entsprechend mehr bringen.'
    );
  }

  const empfehlung = bestForTarget(variants, zielJahre);
  const beste = variants.length
    ? variants.reduce((b, v) => (v.kennzahlen.npv > b.kennzahlen.npv ? v : b), variants[0])
    : null;

  // --- 6. Hebel ohne Investition ---
  const hebel = [];
  const einspeisungAnteil = istSim.generation > 0 ? round((istSim.einspeisung / istSim.generation) * 100, 0) : 0;
  if (!eigenModus && preise.lieferung && preise.einspeisung && preise.lieferung < preise.einspeisung) {
    hebel.push({
      thema: 'Lieferpreis unter Einspeisevergütung',
      text: `Der Lieferpreis (${preise.lieferung} €/kWh) liegt unter der Einspeisevergütung (${preise.einspeisung} €/kWh). Jede an den Kunden gelieferte kWh bringt damit weniger als die Einspeisung – wirtschaftlich wäre die Einspeisung. Das ist meist ein Zeichen für einen zu niedrig angesetzten Lieferpreis.`,
      wirkung: 'sofort, ohne Investition',
    });
  }
  if (einspeisungAnteil >= 50) {
    hebel.push({
      thema: 'Hoher Einspeiseanteil',
      text:
        `${einspeisungAnteil}% der Erzeugung gehen ins Netz und bringen nur ${preise.einspeisung || 0} €/kWh statt ${preise.lieferung || 0} €/kWh. ` +
        `Jede kWh, die stattdessen ${eigenModus ? 'selbst verbraucht' : 'beim Kunden'} wird, bringt ${round((preise.lieferung || 0) - (preise.einspeisung || 0), 3)} €/kWh mehr – ` +
        `Ansatzpunkte: Speicher, Lastverschiebung (Wärmepumpe/Wallbox/Maschinen tagsüber)${eigenModus ? '' : ', zusätzliche Abnehmer'}.`,
      wirkung: 'Grundlage der Speicher-Bewertung',
    });
  }
  if (preise.lieferung && !eigenModus) {
    const plus1ct = round(istSim.eigenverbrauch * yf * 0.01, 0);
    const guenstigste = variants.length ? variants.reduce((b, v) => (v.invest < b.invest ? v : b), variants[0]) : null;
    hebel.push({
      thema: 'Preis-Sensitivität',
      text:
        `1 ct/kWh mehr Lieferpreis bringt bei der aktuellen Liefermenge rund ${plus1ct} € pro Jahr – ohne jede Investition.` +
        (guenstigste
          ? ` Zum Vergleich: die günstigste geprüfte Erweiterung („${guenstigste.label}") kostet ${round(guenstigste.invest, 0)} € und bringt ${round(guenstigste.wirkung.mehrErloesEuroJahr, 0)} € pro Jahr.`
          : ''),
      wirkung: 'sofort, ohne Investition',
    });
  }
  if (kwp && kwp >= 90) {
    hebel.push({
      thema: 'Schwelle 100 kWp',
      text: `Die Anlage liegt bei ${kwp} kWp. Ab 100 kWp installierter Leistung entfällt die feste Einspeisevergütung und es gilt die Pflicht zur Direktvermarktung. Eine Erweiterung über diese Schwelle verändert die Vergütung der GESAMTEN Anlage – vor einer Erweiterung unbedingt rechtlich/vertraglich prüfen.`,
      wirkung: 'Warnung',
    });
  }
  // Verschiebbare Lasten beim Kunden: Wärmepumpe/Wallbox können gezielt in die
  // Überschussstunden gelegt werden – gleicher Effekt wie ein Speicher, aber ohne Investition.
  const flexLasten = [];
  if ((config.plant || {}).waermepumpe) flexLasten.push('Wärmepumpe');
  if ((config.plant || {}).wallbox) flexLasten.push('Wallbox');
  if (flexLasten.length && istSim.einspeisung > 0 && preise.lieferung > preise.einspeisung) {
    const diffCt = round((preise.lieferung - (preise.einspeisungAnBetreiber ? preise.einspeisung : 0)) * 100, 1);
    hebel.push({
      thema: `Lastverschiebung: ${flexLasten.join(' und ')} vorhanden`,
      text:
        `Der Kunde hat ${flexLasten.join(' und ')} – also verschiebbare Last. Jede kWh, die davon in die ` +
        `Überschussstunden (mittags) verlegt wird, wird vom Betreiber geliefert statt eingespeist und bringt ` +
        `${diffCt} ct/kWh mehr – ohne jede Investition. In Home Assistant lässt sich das automatisieren ` +
        `(z.B. Wärmepumpe/Wallbox bei PV-Überschuss freigeben). Das ist der gleiche Effekt wie ein Speicher ` +
        `und sollte VOR einer Speicher-Investition ausgeschöpft werden.`,
      wirkung: 'sofort, ohne Investition',
    });
  }
  if (istSim.ungenutzterUeberschuss > 0 && batteryKwh > 0) {
    hebel.push({
      thema: 'Speicher läuft voll',
      text: `${round(istSim.ungenutzterUeberschuss * yf, 0)} kWh/Jahr Überschuss passen nicht in den Speicher. Das ist genau die Menge, die ein größerer Speicher zusätzlich verwerten könnte.`,
      wirkung: 'Grundlage der Speicher-Dimensionierung',
    });
  }

  // Anlagenalter und Restlaufzeit der EEG-Vergütung der Bestandsanlage.
  // Die Vergütung läuft 20 volle Kalenderjahre ab Inbetriebnahme (plus Inbetriebnahmejahr).
  let anlage = null;
  const ibRaw = (config.plant || {}).inbetriebnahme;
  if (ibRaw) {
    const m = /^(\d{4})(?:-(\d{1,2}))?$/.exec(String(ibRaw).trim());
    if (m) {
      const ibJahr = Number(m[1]);
      const jetzt = new Date(opts.now || Date.now());
      const alterJahre = round(jetzt.getFullYear() - ibJahr + (jetzt.getMonth() + 1 - (m[2] ? Number(m[2]) : 6)) / 12, 1);
      // Vergütung: 20 volle Kalenderjahre zusätzlich zum (Rest-)Inbetriebnahmejahr,
      // d.h. sie endet am 31.12. von Inbetriebnahmejahr + 20.
      const eegBis = ibJahr + 20;
      const eegRest = Math.max(0, eegBis - jetzt.getFullYear());
      anlage = { inbetriebnahme: String(ibRaw), alterJahre, eegVerguetungBis: eegBis, eegRestJahre: eegRest };
      if (alterJahre > 0 && alterJahre <= 40) {
        const erwarteterVerlust = round(alterJahre * annahmen.degradationPv, 1);
        anlage.erwarteteDegradationProzent = erwarteterVerlust;
      }
      if (eegRest === 0) {
        hebel.push({
          thema: 'EEG-Vergütung der Bestandsanlage ausgelaufen',
          text: `Die Anlage ist von ${ibJahr}; die 20-jährige EEG-Vergütung ist abgelaufen. Für eingespeisten Strom gibt es nur noch den Marktwert bzw. eine Auffanglösung – umso wichtiger, möglichst viel direkt an den Kunden zu liefern (Speicher, Lastverschiebung).`,
          wirkung: 'Warnung',
        });
      } else if (eegRest <= 5) {
        hebel.push({
          thema: 'EEG-Vergütung läuft aus',
          text: `Die Bestandsanlage (Inbetriebnahme ${ibJahr}) erhält ihre Einspeisevergütung nur noch bis Ende ${anlage.eegVerguetungBis} (${eegRest} Jahre). Danach zählt praktisch nur noch die Lieferung an den Kunden – das spricht eher für einen Speicher als für reine Modul-Erweiterung, und die Wirtschaftlichkeitsrechnung der Einspeiseerlöse ist nur für die Restlaufzeit belastbar.`,
          wirkung: 'Planungshinweis',
        });
      }
    } else {
      warnings.push(`Inbetriebnahme „${ibRaw}" nicht lesbar – bitte als Jahr (z.B. 2019) oder Jahr-Monat (2019-06) angeben.`);
    }
  } else {
    dataGaps.push({ was: 'Inbetriebnahmejahr der Anlage', warum: 'Ohne das Jahr sind Restlaufzeit der EEG-Vergütung und Alterseinordnung nicht bestimmbar.', feld: 'plant.inbetriebnahme' });
  }

  // Rechtliche Rahmenbedingungen der Erweiterung (Hinweise, keine Rechtsberatung).
  const rechtHinweise = eeg.legalNotes({ bestandKwp: kwp, addKwp: empfehlung ? empfehlung.addKwp : beste ? beste.addKwp : 0 });

  return {
    ok: true,
    zielAmortisation: zielJahre,
    betriebsmodus: eigenModus ? 'eigenverbrauch' : 'kundenlieferung',
    annahmen,
    eegSaetze: { gueltigBis: eeg.TARIFFS.gueltigBis, quelle: eeg.TARIFFS.quelle },
    rechtHinweise,
    coverage: cov,
    standort,
    plant: {
      kwp: plant.kwp,
      batteryKwh: plant.batteryKwh,
      hasBattery: plant.hasBattery,
      candidates: plant.candidates,
      notes: plant.notes,
      wechselrichterKw: wrKw,
      freieFlaecheKwp: Number((config.plant || {}).freieFlaecheKwp) || null,
      flexLasten,
      anlage,
    },
    ist: {
      bilanz: istSim,
      jahr: {
        erzeugung: round(profile.totals.erzeugung * yf, 0),
        verbrauch: verbrauchJahr,
        eigenverbrauch: round(istSim.eigenverbrauch * yf, 0),
        einspeisung: round(istSim.einspeisung * yf, 0),
        netzbezug: round(istSim.netzbezug * yf, 0),
        erloes: round(istErloes.erloesGesamt * yf, 2),
      },
      quoten: shares({ ...profile.totals, eigenverbrauch: istSim.eigenverbrauch }),
      einspeisungAnteilProzent: einspeisungAnteil,
      soll,
    },
    health,
    trend,
    variants,
    empfehlung,
    beste,
    hebel,
    warnings,
    dataGaps,
  };
}

module.exports = { runAssessment, pvSteps, batterySteps };
