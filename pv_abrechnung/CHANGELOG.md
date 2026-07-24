# Changelog

Alle nennenswerten Änderungen an diesem Add-on werden hier dokumentiert.

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
