# PV Abrechnung – Home-Assistant-Add-on

Ein **Custom-Add-on-Repository** für Home Assistant mit dem Add-on **PV Abrechnung**:
zählerbasierte PV-Abrechnung (Anfangs-/Endstand) mit automatischem Tages-/Monats-/
Jahresbericht per Mail, robuster Störungs-/Zählertausch-Behandlung und virtuellen Zählern.

> ⚠️ **Wichtig:** Bitte vor dem Einsatz den [Haftungsausschluss](#haftungsausschluss--disclaimer)
> am Ende lesen. Die Software erstellt Abrechnungen, ist aber **keine eichrechtskonforme
> Abrechnungslösung** und ersetzt keine Rechts-/Steuerberatung.

> **Hinweis zu HACS:** Dies ist ein **Add-on**, kein HACS-Modul. HACS verwaltet
> Integrationen/Frontend, **keine Add-ons**. Add-ons werden über den Add-on-Store des
> Supervisors installiert (siehe unten). Setzt **Home Assistant OS** oder **Supervised** voraus.

---

## Funktionen

- **Zähler-Abrechnung** nach Anfangsstand → Endstand (Differenz × Tarif) je Zeitraum.
- **Robuste Zählerwerte**: erkennt Störungen (Tasmota-0-Sprünge, hängende Sensoren, „unavailable")
  und hält den Stand stabil.
- **Zählertausch**: manuell in der Oberfläche bestätigen – der (virtuelle) Zähler läuft nahtlos weiter.
- **Störungs-Eskalation per Mail**: nach 10 Min „möglicher Fehler wird untersucht", nach 2 Std „Störung".
- **Virtuelle Zähler**: Rechen-Zähler aus echten Zählern, z. B. *an Kunde geliefert = Erzeugung − Einspeisung*.
- **Berichte per Mail**: täglich / monatlich / jährlich, automatisch (HTML + CSV-Anhang).
- **Statistik-Direktansicht**: Tages-/Monatsverlauf je Zähler direkt in der Oberfläche.
- **Robuste Datenquelle**: bevorzugt HA-Langzeitstatistik (reset-sicher, überlebt Ausfallzeiten),
  fällt sonst auf eigenes Polling zurück.

---

## Installation

1. In Home Assistant: **Einstellungen → Add-ons → Add-on Store**.
2. Oben rechts das **⋮-Menü → Repositories**.
3. Diese Repo-URL einfügen und hinzufügen:
   ```
   https://github.com/matnig/ha-pv-abrechnung
   ```
4. Store neu laden – das Add-on **„PV Abrechnung"** erscheint. **Installieren** und **Starten**.
   (Beim ersten Start baut HA den Container – das dauert je nach Hardware einige Minuten.)
5. Die Weboberfläche öffnet sich über die **Seitenleiste** (Ingress).

---

## Bedienungsanleitung

Alles wird über die Weboberfläche des Add-ons konfiguriert. Nach jeder Änderung **„Speichern"** klicken.

### 1. Zähler zuordnen
Unter **Zähler** eine Home-Assistant-Entität (kWh-Sensor) wählen, benennen und eine **Rolle** vergeben:

| Rolle | Bedeutung | Abrechnung |
|---|---|---|
| **Verbrauch (Partei)** | Zähler einer Miet-/Abnehmerpartei | Kosten (+) |
| **Netzbezug** | aus dem öffentlichen Netz bezogene kWh | Kosten (+) |
| **Einspeisung** | ins Netz eingespeiste kWh | Gutschrift (−) |
| **PV-Erzeugung** | von der Anlage produzierte kWh | nur Information |
| **Lieferung an Kunde** | nur für virtuelle Zähler (s. u.) | Kosten (+) |

Es werden nur Entitäten mit Energie-Einheit (Wh/kWh) angeboten.

### 2. Virtuelle Zähler (optional)
Fortlaufende Rechen-Zähler aus echten Zählern. Beispiel **„an Kunde geliefert = Erzeugung − Einspeisung"**:
- Karte **Virtuelle Zähler** → Button **„Vorlage: Erzeugung − Einspeisung"** → **„+ Virt. Zähler anlegen"**.
- Oder manuell: Name + Rolle wählen, Komponenten (echter Zähler × Faktor +1/−1) hinzufügen.
- Virtuelle Zähler laufen über Störungen und Zählertausch hinweg **stetig** weiter.

### 3. Tarife
Preise je kWh eintragen (Verbrauch, Netzbezug, Einspeisung, Lieferung) sowie eine optionale
**Grundgebühr** pro Abrechnungszeitraum.

### 4. Empfänger & SMTP
- **Empfänger Reports**: wer die Abrechnungen bekommt (z. B. der Kunde).
- **Empfänger Störungs-/Untersuchungsmails**: technische Warnungen – i. d. R. an dich als Betreuer
  (leer = wie Report-Empfänger).
- **SMTP**: Host, Port, SSL/STARTTLS, Benutzer, Passwort, Absender. Mit **„SMTP testen"** prüfen.

### 5. Zeitpläne
Täglich / monatlich / jährlich ein- oder ausschalten und die **Versand-Uhrzeit** setzen. Ein täglicher
Lauf verschickt automatisch die fälligen Berichte (Monatsbericht am 1., Jahresbericht am 1. Januar).

### 6. Statistik (Direktansicht)
Auflösung (Tage/Monate) und Anzahl wählen, **„Anzeigen"** – Verlauf je Zähler plus €-Netto je Periode,
ohne Mailversand. Schalter **„HA-Statistik bevorzugen"** = reset-sichere Langzeitdaten nutzen.

### 7. Störungen & Zählertausch
Fällt ein Zähler ab, erscheint die Karte **„Offene Störungen / Zählertausch"**:
- Das System hält den Stand und untersucht, ob es nur eine kurzzeitige Störung ist.
- **Nach 10 Min**: Mail „möglicher Fehler – wird untersucht". **Nach 2 Std**: Mail „Störung".
- War es ein **Zählertausch**, hier **„Zählertausch bestätigen"** – der alte Endstand wird konserviert,
  der (virtuelle) Zähler läuft fortlaufend weiter. Andernfalls liegt ein technischer Fehler vor.

### Berichte prüfen/senden
Unter **Bericht** Zeitraum wählen → **„Vorschau"** oder **„Jetzt versenden"**.

---

## Daten & Datenschutz

- Alle Einstellungen und Zählerstände liegen lokal im Add-on-Verzeichnis (`/data`) – nichts verlässt
  deine Home-Assistant-Installation außer den von dir konfigurierten E-Mails.
- Verbrauchsdaten sind personenbeziehbar. Für die **DSGVO-konforme** Verarbeitung und den Mailversand
  an Dritte bist **du als Betreiber** verantwortlich.

## Updates

Bei neuen Versionen: im Add-on **„Rebuild"** bzw. Update ausführen. Deine Konfiguration und
Zählerstände in `/data` bleiben erhalten.

## Entwicklung

Add-on-Code liegt in [`pv_abrechnung/`](pv_abrechnung/) (siehe dessen
[README](pv_abrechnung/README.md)). Tests: `cd pv_abrechnung && npm test`.

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
- **Nicht eichrechtskonform.** Diese Software ist **keine geeichte/eichrechtskonforme
  Messeinrichtung oder Abrechnungslösung**. Für rechtskonforme Energieabrechnung gelten in
  Deutschland u. a. Mess- und Eichrecht sowie das Messstellenbetriebsgesetz – deren Einhaltung
  liegt allein beim Nutzer.
- **Keine Rechts-, Steuer- oder Energieberatung.** Für die Zulässigkeit der Abrechnung
  (z. B. EEG, Mieterstrom, steuerliche Behandlung) ist der Nutzer selbst verantwortlich.
- **Datenschutz (DSGVO):** Die Verarbeitung personenbezogener Verbrauchsdaten und der Mailversand
  liegen in der Verantwortung des Betreibers.
- **Keine Zusicherung** für Verfügbarkeit, fehlerfreien Betrieb oder den (Nicht-)Versand von E-Mails.

Mit der Nutzung erkennst du diesen Haftungsausschluss an. Es gilt die MIT-Lizenz (siehe unten).

## Lizenz

MIT – siehe [`pv_abrechnung/package.json`](pv_abrechnung/package.json). Die Software wird ohne
Gewährleistung und ohne Haftung im gesetzlich zulässigen Umfang bereitgestellt.
