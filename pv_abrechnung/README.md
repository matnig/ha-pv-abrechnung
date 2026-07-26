# PV Abrechnung – Add-on (Technik & Entwicklung)

Auswertung und Abrechnung einer PV-Anlage aus den Zählerständen, die Home Assistant erfasst.
Die Bedienungsanleitung steht im [Repo-README](https://github.com/matnig/ha-pv-abrechnung);
diese Datei beschreibt Aufbau und Entwicklung.

> ⚠️ **Haftungsausschluss:** Nutzung auf eigenes Risiko, ohne Gewährleistung. Diese Software
> ist **keine eichrechtskonforme Abrechnungslösung** und ersetzt keine Rechts-, Steuer- oder
> Finanzberatung. Richtigkeit der Zählerstände und Beträge sowie Rechts- und
> Datenschutzkonformität liegen beim Nutzer. Vollständiger Haftungsausschluss im
> [Repo-README](https://github.com/matnig/ha-pv-abrechnung#haftungsausschluss--disclaimer).

## Prinzip

- Zwei Betriebsmodi (`config.betriebsmodus`):
  - `kundenlieferung` – Abrechnung **Anfangsstand → Endstand** je Zähler (Differenz × Preis).
  - `eigenverbrauch` – keine Abrechnung; ausgewiesen werden eingesparter Strombezug
    (selbst genutzte kWh × eigener Strompreis) und Einspeiseertrag.
- Zählerstände werden regelmäßig aus **HA-Entitäten** gelesen, **bereinigt** und als Tageswerte
  gespeichert. Die Bereinigung fängt reale Datenprobleme ab:
  - **Reset auf 0** (etwa nach einem Firmware-Update des Auslesegeräts) → Stand wird
    konserviert und monoton fortgeführt, statt einen Negativsprung zu erzeugen.
  - **Sensor meldet nichts mehr** → als *stale* markiert. Maßgeblich ist `last_reported`, nicht
    `last_updated`: ein stillstehender Zähler ist normal (nachts, Akku deckt die Last, oder die
    Anlage speist ein), ein schweigender Sensor nicht. Zählt zeitgleich ein anderer Zähler hoch,
    wird ohnehin kein Alarm ausgelöst.
  - **unavailable/unknown** → letzter guter Stand bleibt erhalten.
  - **Rausch-Rücksprung** und **unrealistischer Sprung** → geglättet bzw. gekennzeichnet.
  - Ein **Zählertausch** wird nie automatisch angenommen, sondern in der Oberfläche bestätigt.
- Für Periodenwerte wird die **HA-Langzeitstatistik** bevorzugt (reset-sicher, überlebt
  Ausfallzeiten). Verwendet wird dabei `state` mit erzwungener Monotonie, nicht `sum` – `sum`
  wird von HA bei 0-Aussetzern aufgebläht.
- Alle Auffälligkeiten landen im Protokoll und können in der Oberfläche bewertet werden.

## Architektur

| Modul | Aufgabe |
|---|---|
| `src/meter/meterProcessor.js` | **Herzstück**: Validierung/Bereinigung eines Zählerwerts (getestet) |
| `src/meter/meterService.js` | Polling aller Zähler → bereinigte Stände in `/data`, Störungs-Eskalation |
| `src/ha/haClient.js` | HA-Zugriff: States, Recorder-Statistics, Kernkonfiguration (Supervisor-Proxy) |
| `src/ha/statistics.js` | Langzeitstatistik als monotone Tagesstände |
| `src/virtual/virtual.js` | virtuelle Zähler inkl. rückwirkender Berechnung |
| `src/billing/` | Perioden-Logik, Abrechnung (kWh → €), Beleg-Journal mit Hash-Kette |
| `src/report/` | HTML-Mailbody, CSV, Verlaufsdiagramme (mail-taugliche Tabellen) |
| `src/review/reviews.js` | Bewertung der Auffälligkeiten, Protokollierung des HA-Benutzers, Export |
| `src/assess/` | Anlagenbewertung: Stundenprofil, Simulation, Wirtschaftlichkeit, Trend, PVGIS, EEG |
| `src/overview/overview.js` | Tagesübersicht (heute/gestern, Sonnenstunden) |
| `src/mail/mailer.js` | SMTP-Versand (nodemailer) |
| `src/scheduler/scheduler.js` | täglicher Lauf, entscheidet welche Berichte fällig sind |
| `src/web/` + `public/` | Oberfläche (Ingress) |

## Betrieb im Add-on

Der Zugriff auf Home Assistant läuft über den Supervisor (`homeassistant_api: true`) – ein
Long-Lived-Token ist nicht nötig. Der Token kommt je nach Supervisor-Version als
`SUPERVISOR_TOKEN` oder `HASSIO_TOKEN`; im Dockerfile ist `S6_KEEP_ENV=1` gesetzt, damit die
Variablen im Dienst ankommen.

Daten liegen im persistenten Add-on-Verzeichnis `/data`:

| Datei | Inhalt |
|---|---|
| `config.json` | Konfiguration aus der Oberfläche |
| `snapshots.json` | bereinigte Zählerstände, Auffälligkeiten, Akku-Ladestände |
| `ledger.json` | Beleg-Journal (Hash-Kette) |
| `reviews.json` | Bewertungen der Auffälligkeiten |
| `incident_protocol.json` | Protokoll der versendeten Incident-Reports |
| `reports.json` | Verlauf der erzeugten Berichte |
| `pvgis_cache.json` | zwischengespeicherte Standort-Sollwerte |

## Lokale Entwicklung

```bash
npm install
npm test                     # Validierung, Abrechnung, Berichte, Bewertung
HA_URL=http://<ha-host>:8123 HA_TOKEN=<long-lived-token> npm start
```

Ohne `SUPERVISOR_TOKEN` (also außerhalb des Add-ons) werden `HA_URL` und `HA_TOKEN` genutzt;
die Daten liegen dann in `./data/`. Mit `DATA_DIR` lässt sich ein anderes Verzeichnis wählen –
die Tests nutzen dafür jeweils ein temporäres Verzeichnis.

Die Tests laufen ohne Home Assistant und ohne Internet: HA-Zugriffe und der PVGIS-Abruf werden
über einfache Stubs eingespeist.

## Rollen & Vorzeichen

| Rolle | Kundenlieferung | Eigenverbrauch |
|---|---|---|
| `verbrauch` | Kosten (+) | Ersparnis |
| `netzbezug` | Kosten (+) | eigene Stromkosten |
| `einspeisung` | Gutschrift bzw. je nach Vergütungsempfänger | Ertrag |
| `erzeugung` | rein informativ | rein informativ |
| `lieferung` (virtuell) | Kosten (+) | Ersparnis |
| `grundgebuehr` | Pauschale pro Periode | entfällt |

## Lizenz

MIT – siehe [`LICENSE`](../LICENSE).
