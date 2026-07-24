# Changelog

Alle nennenswerten Änderungen an diesem Add-on werden hier dokumentiert.

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
  Zählern mit kurzen 0-Aussetzern (z.B. Tasmota).
- **Zeitraum-Auswahl erweitert:** Vormonat, **Aktueller Monat**, Vorjahr, **Aktuelles Jahr**, Gestern –
  der Jahresbericht nutzt dasselbe Prinzip.
- Diagnose: „frühestes Datum ermitteln" protokolliert jetzt je Zähler die gefundenen Statistiktage.

## 0.1.13 – 2026-07-24

### Behoben (virtueller Zähler ergab fälschlich 0)
- Die rückwirkende Berechnung nutzte das HA-Statistikfeld `sum`. Bei Zählern mit 0-Aussetzern
  (z.B. Tasmota springt kurz auf 0 und zurück) bläht HA die `sum` auf – jeder Rücksprung wird als
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
- Erkennung und Bereinigung von Störungen: Sprünge auf 0 (z. B. Tasmota nach Update), hängende
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
