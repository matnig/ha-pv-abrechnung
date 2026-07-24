# Changelog

Alle nennenswerten Änderungen an diesem Add-on werden hier dokumentiert.

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
