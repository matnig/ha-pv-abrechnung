# PV Abrechnung – Home-Assistant-Add-on

Zählerbasierte Abrechnung von PV-Anlagen direkt aus Home Assistant, mit
automatischem **Tages-/Monats-/Jahresbericht per Mail**. Gedacht für den
Energiemanager, der mehrere fremde HA-Installationen betreut: pro HA-Instanz
installieren, alles über die Web-UI in der Seitenleiste konfigurieren.

## Prinzip

- Abrechnung = **Anfangsstand → Endstand** je Zähler (Differenz × Tarif), keine PDF-Rechnung.
- Zählerstände werden regelmäßig aus **HA-Entitäten** gelesen, **bereinigt** und als
  Tageswerte gespeichert. Die Bereinigung fängt reale Datenprobleme ab:
  - **Reset auf 0** (z.B. Tasmota nach Firmware-Update) → Stand wird konserviert und
    monoton fortgeführt, statt einen riesigen Negativ-Sprung zu erzeugen.
  - **Stehender Wert** (Sensor hängt/offline) → als *stale* markiert.
  - **unavailable/unknown** → letzter guter Stand bleibt erhalten.
  - **Rausch-Rücksprung** / **unrealistischer Sprung** → geglättet bzw. geflaggt.
  Alle Auffälligkeiten erscheinen im Report.

## Architektur

| Modul | Aufgabe |
|---|---|
| `src/meter/meterProcessor.js` | **Herzstück**: Validierung/Bereinigung eines Zählerwerts (getestet) |
| `src/meter/meterService.js` | Polling aller Zähler → bereinigte Tages-Zählerstände in `/data` |
| `src/ha/haClient.js` | HA-Zugriff: States + Recorder-Statistics (Supervisor-Proxy) |
| `src/billing/` | Perioden-Logik + Billing (kWh → €) |
| `src/report/report.js` | HTML-Mailbody + CSV-Anhang |
| `src/mail/mailer.js` | SMTP-Versand (nodemailer) |
| `src/scheduler/scheduler.js` | täglicher Cron-Lauf, entscheidet welche Berichte fällig sind |
| `src/web/` + `public/` | Konfigurations-UI (Ingress) |

## Installation als Add-on

1. Ordner in ein lokales Add-on-Repo legen: `/addons/pv_abrechnung/` (Samba/SSH-Add-on).
2. **Einstellungen → Add-ons → Add-on Store → ⋮ → Repositories** neu laden.
3. „PV Abrechnung" installieren, starten. Web-UI erscheint in der Seitenleiste.

Das Add-on greift über den Supervisor (`homeassistant_api: true`) auf die HA-API zu —
kein Long-Lived-Token nötig.

## Bedienung

In der Web-UI: Zähler-Entitäten zuordnen (Rolle: Verbrauch / Netzbezug / Einspeisung /
PV-Erzeugung), Tarife setzen, Empfänger + SMTP eintragen, Zeitpläne aktivieren.
„Vorschau" zeigt den Bericht, „Jetzt versenden" testet den Mailversand.

## Lokale Entwicklung

```bash
npm install
npm test                     # Validierungs- und Billing-Tests
HA_URL=http://<ha>:8123 HA_TOKEN=<long-lived-token> npm start
```

Ohne `SUPERVISOR_TOKEN` (also außerhalb des Add-ons) werden `HA_URL` + `HA_TOKEN` genutzt.
Daten liegen dann in `./data/`.

## Rollen & Vorzeichen

- `verbrauch`, `netzbezug` → Kosten (+)
- `einspeisung` → Gutschrift (−)
- `erzeugung` → rein informativ (kWh, kein Geldbetrag)
- `grundgebuehr` → Pauschale pro Periode
