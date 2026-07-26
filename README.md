# PV Abrechnung – Home-Assistant-Add-on

Ein **Custom-Add-on-Repository** für Home Assistant mit dem Add-on **PV Abrechnung**:
Auswertung und Abrechnung einer Photovoltaik-Anlage auf Basis der Zählerstände, die Home
Assistant ohnehin erfasst – mit automatischen Berichten per E-Mail, einem Protokoll für
Zählerstörungen und einer Wirtschaftlichkeitsbewertung der Anlage.

Das Add-on eignet sich für zwei Situationen, die in der Einrichtung mit einem Klick
umgeschaltet werden:

- **Lieferung an einen Kunden** – der erzeugte Strom wird an eine Mietpartei, einen Mieter
  oder einen anderen Abnehmer geliefert und periodisch abgerechnet.
- **Eigenverbrauch** – die Anlage wird selbst genutzt. Es wird nichts abgerechnet; der
  Bericht zeigt stattdessen den eingesparten Strombezug und den Einspeiseertrag.

> ⚠️ **Wichtig:** Bitte vor dem Einsatz den [Haftungsausschluss](#haftungsausschluss--disclaimer)
> am Ende lesen. Die Software erstellt Abrechnungen, ist aber **keine eichrechtskonforme
> Abrechnungslösung** und ersetzt keine Rechts-, Steuer- oder Finanzberatung.

> **Hinweis zu HACS:** Dies ist ein **Add-on**, kein HACS-Modul. HACS verwaltet
> Integrationen und Frontend-Erweiterungen, **keine Add-ons**. Add-ons werden über den
> Add-on-Store des Supervisors installiert (siehe unten) und setzen **Home Assistant OS**
> oder **Supervised** voraus.

---

## Funktionen

Die Oberfläche ist in sechs Bereiche gegliedert.

### Übersicht

- Statuszeile mit Anzahl der Zähler, offenen Störungen, unbewerteten Auffälligkeiten und den
  Ladezuständen der konfigurierten Akkus.
- Diagramm **„Heute & gestern"**: stündliche Energie je Rolle (Erzeugung, Verbrauch,
  Netzbezug, Einspeisung) im direkten Vergleich, mit beschrifteter Y-Achse. Der Wert jedes
  Balkens erscheint beim Überfahren mit der Maus in passender Einheit (Wh, kWh oder MWh).
- **Sonnenstunden** heute und gestern, abgeleitet aus den Stunden mit nennenswertem Ertrag.
- Live-Werte aller Zähler mit Zeitpunkt der letzten Messung und Ausfällen der letzten 24 Stunden.

### Einstellungen

- **Schnelleinrichtung**: wenige Fragen, die die passenden Einstellungen setzen. Die erste
  Frage ist der **Betriebsmodus** (Kundenlieferung oder Eigenverbrauch). Im
  Eigenverbrauchsmodus werden alle Felder ausgeblendet, die nur für eine Kundenabrechnung
  gebraucht werden – Kundendaten, Lieferpreis, Grundgebühr und die Frage nach dem Empfänger
  der Einspeisevergütung.
- **Stammdaten**: Anlagenname, Betreiber und – im Abrechnungsmodus – der Kunde. Erscheinen in
  Betreff, Bericht und CSV.
- **Zähler**: Zuordnung von Home-Assistant-Entitäten zu Rollen.
- **Virtuelle Zähler**: fortlaufende Rechenzähler aus echten Zählern, etwa
  *selbst genutzt / an Kunde geliefert = Erzeugung − Einspeisung*. Sie laufen über Störungen
  und Zählertausch hinweg stetig weiter.
- **Akkus**: beliebig viele Ladestandssensoren (%). Sie erscheinen im Dashboard und helfen,
  Fehlalarme einzuordnen – steht ein Zähler still, während der Akku die Last deckt, ist das
  kein Ausfall. Im Bericht steht nur, dass die Akkus überwacht werden, kein Momentanwert.
- **Preise**, **Empfänger**, **SMTP** und **Zeitpläne**.

### Berichte

- Statistik-Direktansicht: Tages- oder Monatsverlauf je Zähler in der Oberfläche, ohne Mailversand.
- Berichte für **Tag, Woche, Monat und Jahr** – als Vorschau oder direkt per Mail (HTML mit
  CSV-Anhang). Jede Mail enthält Verlaufsdiagramme mit Vergleich zur Vorperiode
  (Tag → Stunden, Woche → Wochentage, Monat → Tage, Jahr → Monate) und eine beschriftete
  Y-Achse. Die Diagramme sind bewusst nur aus Tabellen aufgebaut und damit auch in
  restriktiven Mail-Programmen sichtbar.
- Automatischer Versand: Tagesbericht täglich, Wochenbericht montags, Monatsbericht am 1.,
  Jahresbericht am 1. Januar – jeweils für die abgeschlossene Vorperiode, zur eingestellten Uhrzeit.
- Laufende Zeiträume werden im Bericht deutlich als **„nicht abgeschlossen"** gekennzeichnet.

### Incident Report

- **Robuste Zählervalidierung**: Ein Energiezähler darf physikalisch nie fallen. Kurzzeitige
  Sprünge auf 0 (etwa nach einem Firmware-Update des Auslesegeräts), hängende Sensoren und
  „unavailable" werden erkannt; der Zählerstand wird stabil gehalten statt verfälscht.
- Ein stillstehender Zähler wird **nicht** als Ausfall gemeldet, solange der Sensor selbst
  noch Werte meldet oder ein anderer Zähler zeitgleich hochzählt – das vermeidet Fehlalarme,
  wenn zum Beispiel der Netzbezug ruht, weil die Anlage einspeist.
- **Störungs-Eskalation per Mail**: nach 10 Minuten „möglicher Fehler – wird untersucht",
  nach 2 Stunden „Störung". Gleiches gilt für ausgefallene Sensoren.
- **Zählertausch** wird nie automatisch angenommen, sondern in der Oberfläche bestätigt. Der
  alte Endstand wird konserviert, der virtuelle Zähler läuft nahtlos weiter.
- **Auffälligkeiten kontrollieren**: Jede erkannte Auffälligkeit kann mit einem Text versehen
  und als **kritisch** oder **unkritisch** eingestuft werden. Festgehalten wird, welcher
  Home-Assistant-Benutzer die Bewertung wann vorgenommen hat. Eine Bewertung ist danach
  unveränderlich und wandert in ein Archiv.
- **Versand**: Der Knopf „Incident-Report absenden" verschickt nur die Auffälligkeiten, die
  seit der letzten Mail neu bewertet wurden. Zusätzlich lässt sich ein **Zeitraum frei wählen**
  (Datum und Uhrzeit, mit Schnellauswahl) und als CSV herunterladen oder als Mail versenden;
  dieser manuelle Export enthält alle Auffälligkeiten des Zeitraums.

### Abrechnung

- **Beleg-Journal**: Jeder versendete Bericht wird als Beleg mit Prüfsumme gespeichert, wobei
  jede Prüfsumme die vorherige einbezieht (Hash-Kette). Ein einmal versendeter Bericht wird
  nicht mehr neu aus der Statistik berechnet – nachträgliche Änderungen an den
  Statistikdaten bleiben also wirkungslos. Wird ein alter Beleg verändert, bricht die Kette
  und die Oberfläche zeigt das an.
- Eine bewusste Neuberechnung ist als **Korrekturbeleg** möglich und wird als solcher gekennzeichnet.

### Bewertung

Bewertet die Anlage auf Grundlage der **echten Stundendaten** aus der
Home-Assistant-Langzeitstatistik.

- **Zustand**: spezifischer Ertrag (kWh je kWp) im Vergleich zum Standort-Sollwert, Hinweise auf
  Verschattung, eine mögliche Wechselrichter-Begrenzung, ertragslose Tage und die Ausnutzung
  eines vorhandenen Speichers.
- **Leistungsentwicklung**: erkennt, wenn die Anlage über einen längeren Zeitraum weniger
  leistet als erwartet – normiert gegen das Klimamittel des Standorts und, wenn genügend
  Historie vorliegt, gegen denselben Monat des Vorjahres. Ein einzelner schwacher Monat gilt
  als Wetter; gemeldet wird erst bei mehreren Monaten in Folge. Schleichende Rückgänge werden
  zusätzlich als Trend ausgewiesen.
- **Erweiterungen**: Modul- und Speicherzubau in mehreren Stufen sowie Kombinationen, jeweils
  stündlich über ein Jahr simuliert. Ausgewiesen werden Investition, Mehrerlös,
  Amortisationszeit, Kapitalwert und Rendite. Eine gewünschte Amortisationszeit lässt sich
  vorgeben; das Add-on nennt die beste Variante, die sie einhält – oder sagt ausdrücklich,
  dass keine sie einhält.
- **Hebel ohne Investition**: etwa Lastverschiebung bei vorhandener Wärmepumpe oder Wallbox,
  Preis-Sensitivität, hoher Einspeiseanteil.
- **Rechtlicher Rahmen** als Hinweise: Vergütungssatz für einen Zubau, getrennte Messung,
  Schwellen wie die Direktvermarktungspflicht, Umsatzsteuer.
- Fehlende Angaben werden ausdrücklich benannt, statt sie zu schätzen.

---

## Installation

1. In Home Assistant: **Einstellungen → Add-ons → Add-on-Store**.
2. Oben rechts das **⋮-Menü → Repositories**.
3. Diese Repository-URL hinzufügen:
   ```
   https://github.com/matnig/ha-pv-abrechnung
   ```
4. Store neu laden – das Add-on **„PV Abrechnung"** erscheint. **Installieren** und **Starten**.
   Beim ersten Start baut Home Assistant den Container; das dauert je nach Hardware einige Minuten.
5. Die Weboberfläche öffnet sich über die **Seitenleiste** (Ingress). Eine Portfreigabe ist nicht
   nötig – die Anmeldung übernimmt Home Assistant.

---

## Erste Schritte

Alles wird in der Weboberfläche eingestellt. Nach Änderungen **„Speichern"** klicken.

### 1. Betriebsmodus wählen

Im Bereich **Einstellungen** ganz oben in der Schnelleinrichtung: Kundenlieferung oder
Eigenverbrauch. Diese Wahl bestimmt, welche Felder überhaupt angezeigt werden und wie der
Bericht aussieht.

### 2. Zähler zuordnen

Eine Home-Assistant-Entität wählen, benennen und eine **Rolle** vergeben. Angeboten werden nur
Entitäten mit Energie-Einheit (Wh, kWh oder MWh).

| Rolle | Bedeutung | Bei Kundenlieferung | Bei Eigenverbrauch |
|---|---|---|---|
| **Verbrauch** | Zähler eines Abnehmers bzw. der eigene Verbrauch | Kosten für den Kunden | Ersparnis |
| **Netzbezug** | aus dem öffentlichen Netz bezogene kWh | Kosten für den Kunden | eigene Stromkosten |
| **Einspeisung** | ins Netz eingespeiste kWh | je nach Vergütungsempfänger | Ertrag |
| **PV-Erzeugung** | von der Anlage erzeugte kWh | nur Information | nur Information |
| **Lieferung / selbst genutzt** | nur für virtuelle Zähler | Kosten für den Kunden | Ersparnis |

### 3. Virtuellen Zähler anlegen (empfohlen)

Die meisten Anlagen messen Erzeugung und Einspeisung, aber nicht direkt die genutzte Energie.
Dafür gibt es in der Karte **Virtuelle Zähler** die Vorlage **„Erzeugung − Einspeisung"** –
ein Klick, dann anlegen. Der Zähler kann rückwirkend aus der Langzeitstatistik berechnet werden
und wird nie negativ.

### 4. Preise eintragen

- **Kundenlieferung**: Lieferpreis je kWh, Netzbezugspreis, optional Grundgebühr,
  Einspeisesatz und – für die Ersparnis-Anzeige – der Vergleichspreis des Netzbetreibers.
- **Eigenverbrauch**: nur der **eigene Strompreis** (womit jede selbst genutzte kWh bewertet
  wird) und die **Einspeisevergütung**.

### 5. Akkus eintragen (optional)

Ladestandssensoren mit Einheit **%** hinzufügen. Sie dienen der Einordnung von Auffälligkeiten
und der Bewertung, nicht der Abrechnung.

### 6. Mailversand einrichten

Empfänger für Berichte und – getrennt davon – für Störungsmeldungen eintragen, dann SMTP-Server,
Port, Verschlüsselung, Benutzer, Passwort und Absender. Mit **„SMTP testen"** prüfen, bevor der
erste Bericht fällig wird.

### 7. Zeitpläne setzen

Tages-, Wochen-, Monats- und Jahresbericht einzeln ein- oder ausschalten und die Versand-Uhrzeit
festlegen.

---

## Voraussetzungen

- Home Assistant **OS** oder **Supervised** (Add-on-Unterstützung erforderlich).
- Mindestens ein Energiezähler als Entität mit Einheit Wh, kWh oder MWh. Je nach Auswertung
  sinnvoll: Erzeugung, Einspeisung und Netzbezug.
- Aktive **Langzeitstatistik** (Recorder) – sie ist die reset-sichere Datenquelle und überlebt
  Ausfallzeiten des Add-ons. Je länger die Historie, desto belastbarer die Bewertung.
- Ein **SMTP-Zugang** für den Mailversand.
- Optional: **Internetzugang** für den Standort-Sollertrag (PVGIS der EU-Kommission). Ohne
  Internet läuft alles weiter, nur der Soll-Ist-Vergleich entfällt.

---

## Daten und Datenschutz

- Alle Einstellungen, Zählerstände, Bewertungen und Belege liegen lokal im
  Add-on-Verzeichnis (`/data`) der eigenen Home-Assistant-Installation.
- Nach außen gehen ausschließlich die selbst konfigurierten E-Mails und – falls aktiviert – der
  Abruf des Standort-Sollertrags bei PVGIS, bei dem nur die Koordinaten übertragen werden.
- Verbrauchsdaten sind personenbeziehbar. Für die datenschutzkonforme Verarbeitung und den
  Mailversand an Dritte ist der Betreiber der Installation verantwortlich.

## Updates

Bei neuen Versionen im Add-on **Update** bzw. **Rebuild** ausführen. Konfiguration und
Zählerstände in `/data` bleiben erhalten. Zeigt die Oberfläche nach einem Update noch alte
Inhalte, hilft ein erzwungenes Neuladen im Browser (Strg+Umschalt+R).

## Entwicklung

Der Add-on-Code liegt in [`pv_abrechnung/`](pv_abrechnung/). Tests:

```
cd pv_abrechnung && npm test
```

Fehlerberichte und Verbesserungsvorschläge gern als GitHub-Issue.

---

## Haftungsausschluss / Disclaimer

Diese Software wird **„wie besehen" (as is)** und **ohne jegliche Gewährleistung** bereitgestellt –
weder ausdrücklich noch stillschweigend, einschließlich, aber nicht beschränkt auf Gewährleistung
der Marktgängigkeit, Eignung für einen bestimmten Zweck und Nichtverletzung von Rechten.

**Die Nutzung erfolgt ausschließlich auf eigenes Risiko.** Der Autor bzw. Betreiber dieses
Repositories übernimmt **keinerlei Haftung** für direkte oder indirekte Schäden, Datenverlust,
entgangene Einnahmen, fehlerhafte Berechnungen oder Folgeschäden, die aus der Nutzung dieser
Software entstehen.

Insbesondere gilt:

- **Keine Gewähr für die Richtigkeit** der ausgelesenen Zählerstände, Berechnungen oder
  Abrechnungsbeträge. Ergebnisse sind vor Verwendung eigenverantwortlich zu prüfen.
- **Nicht eichrechtskonform.** Diese Software ist **keine geeichte oder eichrechtskonforme
  Messeinrichtung und keine eichrechtskonforme Abrechnungslösung**. Für eine rechtskonforme
  Energieabrechnung gelten in Deutschland unter anderem Mess- und Eichrecht sowie das
  Messstellenbetriebsgesetz; deren Einhaltung liegt allein beim Nutzer.
- **Keine Rechts-, Steuer-, Energie- oder Finanzberatung.** Das gilt ausdrücklich auch für die
  Anlagenbewertung: Investitionsvorschläge, Amortisations- und Renditeangaben sind Hilfsmittel
  für eigene Überlegungen und beruhen auf Annahmen, die im Einzelfall abweichen. Vergütungs-
  und Rechtsfragen (etwa EEG, Anlagenzusammenfassung, Direktvermarktung, Umsatzsteuer) sind vor
  einer Investition mit Netzbetreiber und Steuerberater zu klären.
- **Datenschutz:** Die Verarbeitung personenbezogener Verbrauchsdaten und der Mailversand liegen
  in der Verantwortung des Betreibers.
- **Keine Zusicherung** für Verfügbarkeit, fehlerfreien Betrieb oder den Versand von E-Mails.

Mit der Nutzung wird dieser Haftungsausschluss anerkannt. Es gilt die MIT-Lizenz.

## Lizenz

MIT – siehe [`LICENSE`](LICENSE). Die Software wird ohne Gewährleistung und ohne Haftung im
gesetzlich zulässigen Umfang bereitgestellt.
