# Changelog

Alle nennenswerten Änderungen an diesem Add-on werden hier dokumentiert.

## 0.5.0 – 2026-07-26

### Betriebsmodus: Eigenverbrauch oder Kundenlieferung
- Erste Frage der Einrichtungshilfe: **„Strom an einen Kunden liefern und abrechnen"** oder
  **„Anlage selbst nutzen (Eigenverbrauch)"**.
- Im Eigenverbrauch wird **nichts in Rechnung gestellt**. Der Bericht weist stattdessen den
  eingesparten Strombezug (selbst genutzte kWh × eigener Strompreis) und den Einspeiseertrag
  aus, zusammengefasst als **„Nutzen der Anlage im Zeitraum"**; die verbleibenden Netzkosten
  stehen als Vergleich daneben. Betreff wird „PV-Anlagenbericht", Kundendaten werden nicht
  gedruckt.
- Ausgeblendet werden alle Felder, die nur die Kundenabrechnung betreffen: Kundendaten,
  Lieferpreis, Verbrauchspreis, Grundgebühr, Einspeisemanagement und die Frage nach dem
  Empfänger der Einspeisevergütung. Der „Netzbetreiber-Strompreis" heißt hier
  **„Eigener Strompreis"** und ist der zentrale Wert.
- Die Anlagenbewertung bewertet eine selbst genutzte kWh mit dem eigenen Strompreis
  (vermiedener Bezug); die kundenspezifischen Hebel entfallen.
- Bestandskonfigurationen bleiben im Abrechnungsmodus (Standard).

### Behoben: Akku-Auswahl zeigte nur Energiezähler
- Ein Akku-Ladestand ist ein **Prozentwert**, das Auswahlfeld wurde aber mit der
  Energie-Entitätsliste (Wh/kWh/MWh) gefüllt – es konnte also gar kein passender Sensor
  erscheinen.
- Neu: eigene Liste mit Sensoren der Einheit **%** und Geräteklasse „battery" bzw. einem Namen
  mit SoC/Ladezustand/Akku/Speicher. Energiezähler und fremde Prozentwerte (z. B. Luftfeuchte)
  sind ausgeschlossen. Findet sich kein Sensor, erklärt die Oberfläche, was benötigt wird.

## 0.4.2 – 2026-07-25

### Incident-Report: manueller Export über einen Zeitraum
- Neuer Bereich mit **Datum- und Uhrzeit-Auswahl** samt Schnellwahl (Heute, Gestern,
  Letzte 7 Tage, Dieser Monat, Letzter Monat) und Live-Vorschau, wie viele Auffälligkeiten im
  gewählten Zeitraum liegen.
- Export als **CSV-Download** (Semikolon, UTF-8 mit BOM für Excel; enthält Bewertung, Prüfer,
  Bewertungszeit und Report-Dokumentation) oder als **Mail**.
- Der manuelle Export enthält **alle** Auffälligkeiten des Zeitraums und markiert nichts als
  versendet – der automatische Versand bleibt weiterhin rein inkrementell.
- Manuelle Exporte erscheinen im Protokoll mit Kennzeichnung und Zeitraum.

## 0.4.1 – 2026-07-25

### Anlagendaten vollständig in der Oberfläche eingebbar – und wirksam
- **Inbetriebnahme** (Jahr oder Jahr-Monat): berechnet Anlagenalter, altersübliche Degradation
  und die Restlaufzeit der 20-jährigen EEG-Vergütung. Läuft sie in fünf Jahren oder weniger
  aus, erscheint ein Planungshinweis.
- **Wechselrichter-Nennleistung**: deckelt die Erzeugung jeder Zubau-Variante stundengenau; die
  dadurch verlorene Energie wird je Variante ausgewiesen.
- **Freier Platz für Zubau (kWp)**: begrenzt die vorgeschlagenen Varianten; die maximale
  Dachbelegung wird als eigene Variante ergänzt.
- **Wärmepumpe / Wallbox**: erzeugt den Hebel „Lastverschiebung" – wirkt wie ein Speicher, aber
  ohne Investition, und wird ausdrücklich vor einer Speicher-Investition empfohlen.

## 0.4.0 – 2026-07-25

### Neuer Bereich „Bewertung"
Bewertet die Anlage auf Grundlage der **echten Stundendaten** aus der Langzeitstatistik – keine
Faustformeln, keine Standardlastprofile.

- **Grenzbetrachtung statt Durchschnitt**: Jede Variante wird stündlich über ein Jahr simuliert
  und gegen den Ist-Zustand differenziert. Eine zusätzliche kWh wird dort verbucht, wo sie real
  landet – beim Verbraucher (voller Preis) oder im Netz (Einspeisevergütung).
- **Zustand der Anlage**: spezifischer Ertrag gegen den Standort-Sollwert (PVGIS der
  EU-Kommission, Koordinaten automatisch aus Home Assistant), Verschattungsmuster, mögliche
  Wechselrichter-Begrenzung, ertragslose Tage, Speichernutzung.
- **Leistungsentwicklung**: erkennt nachlassende Leistung über die Zeit – gegen das
  Klimamittel des Standorts und gegen denselben Monat des Vorjahres. Ein einzelner schwacher
  Monat gilt als Wetter; gemeldet wird erst bei mehreren Monaten in Folge. Schleichende
  Rückgänge werden als Trend ausgewiesen.
- **Erweiterungen**: Modul- und Speicherzubau in Stufen und Kombinationen, mit Investition,
  Mehrerlös, Amortisation (statisch und dynamisch), Kapitalwert und Rendite. Eine gewünschte
  Amortisationszeit kann vorgegeben werden.
- **Ersatzinvestitionen** (Wechselrichter, Batterie) sind eingerechnet; wo sie anfallen, wird
  keine Rendite ausgewiesen, weil sie dann mathematisch nicht eindeutig ist.
- **Vergütung des Zubaus** mit dem heute gültigen Satz statt dem der Bestandsanlage, anteilig
  gewichtet über die Leistungsklassen, mit Abschlag für Stunden mit negativem Börsenpreis.
- **Hebel ohne Investition** und **rechtliche Hinweise** (getrennte Messung, Schwellen,
  Umsatzsteuer).
- Fehlende Angaben werden ausdrücklich benannt statt geschätzt.

## 0.3.1 – 2026-07-25

### Behoben: Diagramme im Bericht waren unsichtbar
- **Rendering**: Die Balken waren als verschachtelte Tabellen mit Höhenattributen auf leeren
  Zellen gebaut – solche Zellen werden von Mail-Programmen auf Höhe 0 reduziert. Jetzt feste
  Pixelhöhen; `opacity` (von Outlook ignoriert) ersetzt durch echte, aufgehellte Farben.
- **Werte**: Bei einem Rücksprung auf 0 wurde der Bezugswert mitgesenkt, wodurch der nächste
  echte Wert als riesiger Zuwachs zählte. Ein einziger solcher Ausreißer skalierte die Achse so,
  dass alle echten Werte nur ein Pixel hoch waren. Jetzt wird der Stand gehalten – die
  Diagramm-Summen stimmen wieder mit den Abrechnungsmengen überein, auch die Sonnenstunden.
- Zählertabelle im Bericht lief rechts über (abgeschnittene Beträge) – jetzt feste Spaltenbreiten.

## 0.3.0 – 2026-07-25

### Verlaufsdiagramme in allen Berichten
- Jede Bericht-Mail enthält den Verlauf je Rolle mit Vergleich zur Vorperiode: Tag → Stunden,
  Woche → Wochentage, Monat → Tage, Jahr → Monate, dazu die Sonnenstunden.
- Beschriftete Y-Achse mit lesbaren Stufen und automatischer Einheit (Wh / kWh / MWh).
- Bewusst nur Tabellen und Inline-Styles, damit die Diagramme auch in restriktiven
  Mail-Programmen sichtbar sind.
- Die Diagrammdaten werden im Beleg eingefroren, damit versendete Berichte reproduzierbar bleiben.

### Wochenberichte
- Kalenderwoche (Montag bis Sonntag) mit Wochennummer, Versand montags für die Vorwoche,
  Auswahl „Vorwoche/Aktuelle Woche" und ein eigener Schalter im Zeitplan.

### Behoben: Fehlalarm „Zähler steht still"
- Ursache: Home Assistant setzt `last_updated` nur bei einer **Wertänderung**. Ein Zähler, der
  still steht, weil die Anlage einspeist, sah damit wie ein Sensorausfall aus.
- Jetzt ist `last_reported` maßgeblich – das wird bei jedem Melden gesetzt, auch bei
  unverändertem Wert. Zusätzlich wird kein Alarm ausgelöst, wenn zeitgleich ein anderer Zähler
  hochzählt. Und ein Stillstand wird pro Phase nur einmal gemeldet statt bei jedem Abruf.

## 0.2.1 – 2026-07-25

### Incident-Report versendet nur Neues
- Beim Absenden werden nur die bewerteten Auffälligkeiten dokumentiert, die in der letzten Mail
  noch nicht dabei waren. Die Markierung erfolgt erst **nach** erfolgreichem Versand – schlägt
  er fehl, sind die Einträge beim nächsten Versuch wieder dabei.
- Das Archiv zeigt je Eintrag, ob und wann er dokumentiert wurde.

## 0.2.0 – 2026-07-25

### Oberfläche in Bereiche gegliedert
- Neue Navigation: **Übersicht, Einstellungen, Berichte, Incident Report, Abrechnung**.
- **Übersicht als Startseite**: Statuszeile (Zähler, offene Störungen, unbewertete
  Auffälligkeiten, Akku-Ladestände) und ein Diagramm „Heute & gestern" mit stündlicher Energie
  je Rolle, Sonnenstunden, beschrifteter Achse und Werten in passender Einheit beim Überfahren
  mit der Maus.

### Auffälligkeiten sind nach der Bewertung unveränderlich
- Einmal bewertet, lässt sich ein Eintrag nicht mehr ändern; er wandert in ein Archiv, das über
  einen Knopf eingeblendet wird.

## 0.1.29 – 2026-07-25

### Akkus als eigener Abschnitt
- Der Akku-Ladestand ist aus den Stammdaten in einen eigenen Abschnitt unter „Zähler" gewandert.
  **Mehrere Akkus** sind möglich, Auswahl aus einer Liste. Alte Einzel-Einstellungen werden
  automatisch übernommen.
- Im Bericht erscheint nur der Hinweis, dass die Akkus überwacht werden – kein Momentanwert mehr.

### Auffälligkeiten kontrollieren und dokumentieren
- Jede Auffälligkeit kann mit einem Text versehen und als **kritisch** oder **unkritisch**
  eingestuft werden. Festgehalten wird, welcher Home-Assistant-Benutzer die Bewertung wann
  vorgenommen hat.
- Die Bewertungen erscheinen im Berichtsprotokoll und werden im Beleg eingefroren.
- „Incident-Report absenden" verschickt eine Dokumentations-Mail über die bewerteten
  Auffälligkeiten.

## 0.1.28 – 2026-07-25

### Sicherheitshärtung
- **Cross-Site-Scripting in der Oberfläche behoben**: Namen und Zustände aus Home Assistant
  wurden ungeprüft in die Seite geschrieben. Jetzt werden alle fremden Werte maskiert.
- Auch die Störungsmails maskieren den Zählernamen.
- **Abhängigkeiten aktualisiert**: nodemailer auf 9.x (behebt Schwachstellen bei
  Header-Verarbeitung und Zertifikatsprüfung), node-cron auf 4.x. Ergebnis: keine bekannten
  Schwachstellen mehr.

## 0.1.27 – 2026-07-24

### Akku-Ladestand + Ausfall-Benachrichtigung
- **Akku-Ladestand (%)** optional konfigurierbar (Sensor-Feld): erscheint im **Status** und im
  **Bericht** und **hilft, Fehlalarme zu erkennen** (Akku deckt Last → flache Zähler sind normal).
  Wird im Beleg mit eingefroren.
- **Sensor-Ausfall löst jetzt eine Mail aus** (10 Min „möglicher Fehler", 2 Std „Störung") – analog
  zum Zählerabfall. Bisher gab es bei „Sensor nicht verfügbar / HA nicht erreichbar" KEINE Mail,
  nur einen Eintrag im Bericht/Status. Das war die fehlende Benachrichtigung.

## 0.1.26 – 2026-07-24

### Behoben: Fehlalarm „Wert stand still"
- Ein gleichbleibender Zählerstand ist bei Energiezählern normal (nachts / Akku deckt die Last →
  kein Netzbezug/keine Einspeisung). Die „hängt/offline"-Erkennung basiert jetzt auf HAs
  `last_updated` (Gerät meldet nichts mehr), nicht mehr auf einem unveränderten Wert. Damit keine
  falschen „stale"-Auffälligkeiten mehr bei flachen Zählern.

## 0.1.25 – 2026-07-24

- Phantom-Bump (Store-Cache-Workaround). Inhaltlich identisch mit 0.1.24 (Stammdaten).

## 0.1.24 – 2026-07-24

### Stammdaten
- Neue Felder **Anlagenname, Betreiber, Kunde** (UI-Karte „Stammdaten", Betreiber/Kunde mehrzeilig).
- Erscheinen im **Bericht-Kopf**, im **Betreff** (Anlagenname) und in der **CSV**.
- Werden im Beleg **mit eingefroren** (bleiben also auf einer abgeschlossenen Rechnung erhalten).

## 0.1.23 – 2026-07-24

- Test-Bump zur Bestätigung der Store-Cache-Verzögerung im Supervisor (HA zeigt „neueste Version"
  konstant eine Stufe zurück). Inhaltlich identisch mit 0.1.22.

## 0.1.22 – 2026-07-24

### Abrechnungs-Integrität (manipulationssicher)
- **Einfrieren beim Versand:** Ein versendeter Bericht wird als **Beleg** mit allen Werten
  gespeichert und danach **nicht mehr aus der (änderbaren) HA-Statistik neu berechnet**. Wer die
  Statistik-Summen nachträglich anpasst, ändert an einer abgeschlossenen Abrechnung nichts.
- **Hash-Kette:** Jeder Beleg trägt eine SHA-256-Prüfsumme, die den vorherigen Beleg einbezieht.
  Wird ein alter Beleg verändert, bricht die Kette – im **Rechnungsjournal** (neu) wird das
  angezeigt (grün „unversehrt" / rot „Manipulation erkannt").
- Beleg-Nr. und Prüfsumme stehen in jeder Bericht-Mail.
- **Korrektur bewusst möglich:** Option „Neu berechnen (Korrektur)" erstellt einen separaten,
  gekennzeichneten Korrektur-Beleg (der Originalbeleg bleibt erhalten).

## 0.1.21 – 2026-07-24

- **Netzbezug (und alle echten Zähler) rückwirkend korrekt**: Der Einheiten-Faktor (kWh/Wh/MWh)
  wird bei Bedarf direkt aus HA geholt, auch für frisch angelegte Zähler, die noch nie gepollt
  wurden. So stimmen Autarkiegrad und Ersparnis von Anfang an (kein 1000×-Fehler bei Wh-Zählern).

## 0.1.20 – 2026-07-24

### Auswertung, Transparenz & Einrichtungshilfe
- **Informative Auswertung im Bericht** (wenn Netzbezug vorhanden): **Autarkiegrad** (PV- vs.
  Netz-Anteil, mit Balken) und **Ersparnis für den Kunden** gegenüber Netzstrom (falls
  Netzbetreiber-Strompreis eingetragen).
- **Preise & Vergütung (Transparenz)** in jeder Mail: die eingetragenen Preise und der Hinweis,
  **wer die Einspeisevergütung bekommt** (Betreiber oder Kunde).
- Neues Tarif-Feld **Netzbetreiber-Strompreis €/kWh** (für die Ersparnis-Anzeige).
- **Einrichtungshilfe (Ja/Nein-Wizard)** ganz oben: einfache Fragen setzen die passenden
  Einstellungen automatisch.
- **Status zeigt jetzt alle konfigurierten Zähler** (auch neu angelegte vor dem ersten Abruf:
  „noch nicht gelesen").

## 0.1.19 – 2026-07-24

- **Grafik in jeder Bericht-Mail:** „Mengen im Überblick" mit Balken je Zähler (E-Mail-robust, kein Bild/SVG).
- **Fußzeile / Impressum** je Bericht: frei ausfüllbares Textfeld in der UI (z.B. „Ein Service von … ·
  bei Fragen auf diese Mail antworten"). Bleibt in `/data`, nicht im öffentlichen Code.
- **Deutsche Formatierung behoben:** `icu-data-full` im Image – Datum (24.07.2026 statt 07/24/2026),
  Monatsnamen (Juli statt June) und Währung erscheinen jetzt korrekt auf Deutsch.
- Grammatik: „das Jahr läuft noch" (statt „der Jahr").

## 0.1.18 – 2026-07-24

### Status aussagekräftiger
- Zeigt jetzt je Zähler den **Live-Wert** (aktueller Stand + Einheit), **„zuletzt gelesen"** (wie
  aktuell) und die **Anzahl Ausfälle in den letzten 24 h** (HA nicht erreichbar oder Sensor
  unavailable), inkl. Zeitpunkt des letzten Ausfalls. 0 Ausfälle = grünes „✓".

## 0.1.17 – 2026-07-24

- **Status zeigt nur noch aktuelle Auffälligkeiten (letzte Stunde).** Alte „error/unavailable"-Einträge
  aus der Zeit vor dem 0.1.16-Fix bleiben nicht mehr dauerhaft stehen – gesunde Zähler zeigen „✓".
- Erster Poll nach Start früher (6 s), damit bei häufigen Neustarts überhaupt ein Abruf läuft.

## 0.1.16 – 2026-07-24

### Behoben: Zähler fälschlich „unavailable"
- Direkt nach einem Add-on-(Neu)Start ist die HA-API kurz mit **502** nicht erreichbar. Das wurde
  fälschlich als „Zähler unavailable" gewertet. Jetzt gilt: **HA nicht erreichbar ≠ Sensor unavailable** –
  der letzte Stand bleibt erhalten, der Zähler wird übersprungen (nur Log), keine Auffälligkeit.
- `getState` **wiederholt** transiente Fehler (502/503/504/Netzwerk); 401/404 werfen sofort.
- Erster Poll/Selbsttest nach Start **verzögert** (HA-Core braucht nach Neustart einen Moment).

## 0.1.15 – 2026-07-24

### Einspeisevergütung: zwei Fälle konfigurierbar
- Neue Option **„Anlagenbetreiber erhält die Einspeisevergütung vom Netz"** (Tarife):
  - **Fall 1 (angehakt):** Einspeisung wird in der Kundenrechnung ignoriert (nur Info).
  - **Fall 2 (nicht angehakt):** Dem Kunden wird die Einspeisemenge mit dem Einspeisung-€/kWh-Satz
    berechnet (er zahlt mehr); zusätzlich wird die **Einspeisemanagement-Gebühr** (neu, €/Jahr)
    anteilig pro Periode dem Betreiber abgezogen.
- Ausführliche Erklärtexte an allen Feldern.

### Berichte
- **„… nicht abgeschlossen"**: Wird ein Bericht für den laufenden Monat/Jahr/Tag erzeugt, steht
  im Betreff, groß in **roter Schrift** oben und im CSV-Status ein deutlicher Hinweis samt Datum.
- **Jahresbericht mit Monatsübersicht:** alle bereits begonnenen Monate mit Menge, Summe und
  **Balken-Verlauf** (auch in der CSV).

## 0.1.14 – 2026-07-24

### Bericht: frühester Stand + Jahresbericht + glitch-sicher
- **Rumpf-Perioden abrechenbar:** Fehlt der Zählerstand am Perioden-Anfang (Zähler/Statistik
  beginnt erst mitten im Zeitraum), wird der **früheste verfügbare Stand** als Anfangsstand
  genutzt (mit Hinweis „Anfangsstand ab erstem verfügbaren Datum …"). Gilt für echte UND virtuelle Zähler.
- **Bericht-Statistik glitch-sicher:** Auch der Bericht nutzt jetzt den monotonen Zählerstand
  (`state`) statt der bei 0-Aussetzern aufgeblähten `sum` – die Mengen stimmen jetzt auch bei
  Zählern mit kurzen 0-Aussetzern.
- **Zeitraum-Auswahl erweitert:** Vormonat, **Aktueller Monat**, Vorjahr, **Aktuelles Jahr**, Gestern –
  der Jahresbericht nutzt dasselbe Prinzip.
- Diagnose: „frühestes Datum ermitteln" protokolliert jetzt je Zähler die gefundenen Statistiktage.

## 0.1.13 – 2026-07-24

### Behoben (virtueller Zähler ergab fälschlich 0)
- Die rückwirkende Berechnung nutzte das HA-Statistikfeld `sum`. Bei Zählern mit 0-Aussetzern
  (ein Zähler springt kurz auf 0 und zurück) bläht HA die `sum` auf – jeder Rücksprung wird als
  neuer Verbrauch addiert. Dadurch wurde der virtuelle Zähler massiv negativ und auf 0 gedeckelt.
- Jetzt wird der echte **Zählerstand (`state`)** verwendet, mit **erzwungener Monotonie** (transiente
  0-/Rückwärts-Glitches werden abgefangen). Ergebnis stimmt jetzt (geliefert = Δ-Erzeugung − Δ-Einspeisung).

## 0.1.12 – 2026-07-24

- **Aufschlüsselung bei „berechnen":** zeigt jetzt je Komponente den tatsächlichen Zuwachs (Δ kWh)
  im Zeitraum. Damit ist sofort erkennbar, warum ein virtueller Zähler ggf. 0 ergibt (z.B. wenn der
  als „Erzeugung" gewählte Sensor in Wahrheit die Netzeinspeisung misst).

## 0.1.11 – 2026-07-24

### Behoben (Browser-Cache)
- **Keine veraltete Oberfläche mehr nach Updates.** `index.html` wird ohne Cache ausgeliefert und
  `app.js` bekommt eine Versions-Query (`app.js?v=<version>`) – dadurch lädt der Browser nach
  jedem Update garantiert die neue Oberfläche, ohne manuelles hartes Neuladen. Statische Dateien
  werden mit `Cache-Control: no-cache` (immer revalidieren) ausgeliefert.

## 0.1.10 – 2026-07-24

- **Versionsnummer wird oben rechts in der Oberfläche angezeigt** – so ist sofort erkennbar,
  welche Version tatsächlich läuft (hilft, „Add-on aktualisiert?" von „Browser-Cache" zu trennen).

## 0.1.9 – 2026-07-24

### Virtuelle Zähler: nie negativ + rückwirkende Berechnung
- **Virtueller Zählerstand kann nicht mehr negativ werden.** Ursache war, dass echte Zähler
  unterschiedliche Nullpunkte haben (z.B. Einspeisezähler zählt länger als der PV-Zähler); die
  absolute Differenz war dadurch negativ. Jetzt zählt der virtuelle Zähler ab einem **Startdatum**
  als Summe der faktorisierten Zuwächse (bei 0 gedeckelt).
- **Startdatum je virtuellem Zähler einstellbar**, inkl. „frühestes Datum ermitteln" (frühestes
  Datum, ab dem beide Zähler Statistikdaten haben).
- **Rückwirkende Berechnung** aus der HA-Langzeitstatistik: „berechnen" holt die Werte beider
  Zähler ab dem Startdatum und rechnet den virtuellen Verlauf nach.

## 0.1.8 – 2026-07-24

### Behoben (die eigentliche Ursache des 401)
- **`SUPERVISOR_TOKEN` fehlte komplett in der Add-on-Umgebung** – Ursache: Die HA-Base nutzt
  s6-overlay (`/init` als Entrypoint), das die Umgebung zurücksetzt; ein direktes `CMD`
  bekommt die Container-Variablen nicht. Fix: **`S6_KEEP_ENV=1`** im Dockerfile reicht die
  Umgebung (inkl. Token) an den Node-Prozess durch. Damit funktioniert der HA-API-Zugriff.

## 0.1.7 – 2026-07-24

- Reiner Versions-Bump wegen der Store-Cache-Verzögerung im Supervisor. Inhaltlich identisch mit
  0.1.6 (Token-Fix `SUPERVISOR_TOKEN`/`HASSIO_TOKEN` + Diagnose).

## 0.1.6 – 2026-07-24

### Behoben
- **401 Unauthorized beim HA-Zugriff / leere Entitätenliste:** Der Add-on-Token wird jetzt sowohl
  als `SUPERVISOR_TOKEN` (neu) als auch als `HASSIO_TOKEN` (älterer Supervisor) erkannt. Vorher
  fiel das Add-on ohne Token auf die externe HA-URL zurück → 401.
- Selbsttest zeigt jetzt, welche Token-/Env-Variablen tatsächlich vorhanden sind.

## 0.1.5 – 2026-07-24

### Diagnose
- **HA-API-Selbsttest beim Start:** Das Add-on prüft direkt beim Start die Verbindung zur
  Home-Assistant-API und schreibt das Ergebnis ins Protokoll (Token vorhanden? Wie viele
  Energie-Entitäten gefunden? bzw. der konkrete Fehler). Damit ist die Ursache eines leeren
  Entitäten-Menüs sofort im „Protokoll"-Tab sichtbar.

## 0.1.4 – 2026-07-24

### Behoben
- **Aussagekräftige Fehlermeldung** beim Laden der Entitätenliste (vorher leer): HA-Aufrufe haben
  jetzt einen **Timeout** (statt bei Problemen hängen zu bleiben und einen leeren 502 zu erzeugen),
  die Fehlermeldung enthält jetzt den HTTP-Status, und der Fehler wird ins Add-on-Log geschrieben.

## 0.1.3 – 2026-07-24

- Versions-Bump, damit Home Assistant das Update sicher anbietet. Inhaltlich identisch mit 0.1.2
  (Wh/MWh-Unterstützung + kWh-Normalisierung, robustere Entitätenliste).

## 0.1.2 – 2026-07-24

### Geändert / Behoben
- **Wh und MWh werden unterstützt.** Die Entitätenliste akzeptiert jetzt Wh, kWh und MWh
  (sowie Entitäten mit `device_class: energy`). Alle Werte werden intern auf **kWh normalisiert**,
  damit Abrechnung und Statistik unabhängig von der Sensor-Einheit stimmen.
- Entitätenliste robuster: klarere Fehlermeldung bei HA-Problemen, Schutz vor unerwarteten Antworten.
- Zähler-Einheit wird in der Zählerliste angezeigt.

## 0.1.1 – 2026-07-24

### Behoben
- **Build-Fehler „npm: not found"**: Die HA-Base-Images bringen kein Node mit; Node.js + npm
  werden jetzt im Dockerfile per `apk` installiert. Die (bei aktuellen Supervisor-Versionen
  deprecatete und für Docker-Hub-Images ungültige) `build.yaml` wurde entfernt.

## 0.1.0 – 2026-07-24

Erste Version.

### Abrechnung
- Zählerbasierte Abrechnung nach **Anfangsstand → Endstand** (Differenz × Tarif) je Zeitraum.
- Rollen: Verbrauch, Netzbezug, Einspeisung (Gutschrift), PV-Erzeugung (Info), Lieferung an Kunde.
- Konfigurierbare Tarife (€/kWh) und Grundgebühr pro Periode.

### Robuste Zählerwerte
- Erkennung und Bereinigung von Störungen: Sprünge auf 0 (z. B. nach einem Firmware-Update des Auslesegeräts), hängende
  Sensoren („stale"), „unavailable"/„unknown", Mess-Jitter und unrealistische Sprünge.
- Fortlaufender, stabiler Zählerstand („effective").

### Störungen & Zählertausch
- Zählerabfall öffnet eine Störung (Stand wird gehalten).
- Eskalation per Mail: nach 10 Min „möglicher Fehler – wird untersucht", nach 2 Std „Störung".
- **Zählertausch** wird manuell in der Oberfläche bestätigt; der (virtuelle) Zähler läuft nahtlos weiter.
- Getrennte Empfänger für Störungs-/Untersuchungsmails.

### Virtuelle Zähler
- Fortlaufende Rechen-Zähler als Linearkombination echter Zähler (z. B. *Erzeugung − Einspeisung*).

### Berichte
- Automatische Tages-/Monats-/Jahresberichte per Mail (HTML + CSV-Anhang), konfigurierbare Uhrzeit.
- Vorschau und manueller Versand in der Oberfläche.

### Statistik
- Direktansicht der Tages-/Monatsverläufe je Zähler inkl. €-Netto, ohne Mailversand.

### Datenquelle
- Bevorzugt HA-Langzeitstatistik (reset-sicher, überlebt Ausfallzeiten), Fallback auf eigenes Polling.
