# PV Abrechnung – Dokumentation

> ⚠️ **Haftungsausschluss:** Nutzung auf eigenes Risiko, ohne Gewährleistung. Diese Software
> ist **keine eichrechtskonforme Abrechnungslösung** und ersetzt keine Rechts-/Steuerberatung.
> Richtigkeit der Zählerstände und Beträge sowie Rechts-/DSGVO-Konformität liegen beim Nutzer.
> Vollständiger Haftungsausschluss im
> [Repo-README](https://github.com/matnig/ha-pv-abrechnung#haftungsausschluss--disclaimer).

Alles wird über die Weboberfläche des Add-ons (Seitenleiste, Ingress) konfiguriert.
**Nach jeder Änderung „Speichern" klicken.**

## Erste Schritte

1. Add-on installieren und starten (beim ersten Start baut HA den Container – dauert etwas).
2. Weboberfläche über die Seitenleiste öffnen.
3. Zähler zuordnen → Tarife setzen → Empfänger + SMTP eintragen → Zeitpläne aktivieren.
4. Mit **„Vorschau"** einen Bericht prüfen, mit **„SMTP testen"** den Mailversand.

## 1. Zähler zuordnen

Unter **Zähler** eine Home-Assistant-Entität (kWh-Sensor) wählen, benennen und eine **Rolle** vergeben:

| Rolle | Bedeutung | Abrechnung |
|---|---|---|
| **Verbrauch (Partei)** | Zähler einer Miet-/Abnehmerpartei | Kosten (+) |
| **Netzbezug** | aus dem öffentlichen Netz bezogene kWh | Kosten (+) |
| **Einspeisung** | ins Netz eingespeiste kWh | Gutschrift (−) |
| **PV-Erzeugung** | von der Anlage produzierte kWh | nur Information |
| **Lieferung an Kunde** | nur für virtuelle Zähler (s. u.) | Kosten (+) |

Es werden nur Entitäten mit Energie-Einheit (Wh/kWh) angeboten. Mit „neu laden" aktualisieren.

## 2. Virtuelle Zähler (optional)

Fortlaufende Rechen-Zähler aus echten Zählern. Beispiel **„an Kunde geliefert = Erzeugung − Einspeisung"**:

- Karte **Virtuelle Zähler** → **„Vorlage: Erzeugung − Einspeisung"** → **„+ Virt. Zähler anlegen"**.
- Oder manuell: Name + Rolle wählen, Komponenten (echter Zähler × Faktor +1/−1) hinzufügen.
- Virtuelle Zähler laufen über Störungen und Zählertausch hinweg **stetig** weiter, weil sie auf
  den bereinigten Ständen der echten Zähler aufbauen.

## 3. Tarife

Preise je kWh (Verbrauch, Netzbezug, Einspeisung, Lieferung) und eine optionale **Grundgebühr**
pro Abrechnungszeitraum. Verbrauch/Netzbezug/Lieferung = Kosten, Einspeisung = Gutschrift.

## 4. Empfänger & SMTP

- **Empfänger Reports** – wer die Abrechnungen bekommt (z. B. der Kunde).
- **Empfänger Störungs-/Untersuchungsmails** – technische Warnungen, i. d. R. an dich als Betreuer
  (leer = wie Report-Empfänger).
- **SMTP** – Host, Port, SSL (465) oder STARTTLS, Benutzer, Passwort, Absender. Mit **„SMTP testen"** prüfen.

## 5. Zeitpläne

Täglich / monatlich / jährlich ein- oder ausschalten und die **Versand-Uhrzeit** setzen.
Ein täglicher Lauf verschickt die fälligen Berichte automatisch (Monatsbericht am 1. des Monats,
Jahresbericht am 1. Januar – jeweils für die abgeschlossene Periode).

## 6. Statistik (Direktansicht)

Auflösung (Tage/Monate) und Anzahl wählen, **„Anzeigen"**: Verlauf je Zähler plus €-Netto je
Periode – ohne Mailversand. Der Schalter **„HA-Statistik bevorzugen"** nutzt die reset-sichere
Langzeitstatistik von Home Assistant (überlebt auch Ausfallzeiten des Add-ons).

## 7. Störungen & Zählertausch

Fällt ein Zähler ab, erscheint die Karte **„Offene Störungen / Zählertausch"**:

- Das System hält den Stand und untersucht, ob es nur eine kurzzeitige Störung ist
  (dann verschwindet die Störung von selbst, sobald der Wert zurückkommt).
- **Nach 10 Min**: Mail „möglicher Fehler – wird untersucht". **Nach 2 Std**: Mail „Störung".
- War es ein **Zählertausch**: **„Zählertausch bestätigen"** klicken – der alte Endstand wird
  konserviert, der (virtuelle) Zähler läuft fortlaufend weiter. Andernfalls liegt ein
  technischer Fehler vor, der geprüft werden sollte.

## Berichte prüfen und senden

Unter **Bericht** Zeitraum wählen → **„Vorschau"** (Anzeige) oder **„Jetzt versenden"** (Mail).
Der Status-Bereich zeigt die letzten Berichte und Auffälligkeiten je Zähler.

## Add-on-Optionen

In der Add-on-Konfiguration (Registerkarte „Konfiguration") lässt sich das **Poll-Intervall**
(`poll_interval_minutes`, Standard 10) einstellen. Alle weiteren Einstellungen erfolgen in der
Weboberfläche und werden im Add-on-Verzeichnis (`/data`) gespeichert.

## Daten

Alle Einstellungen und Zählerstände liegen lokal im Add-on (`/data`) und bleiben bei Updates
erhalten. Es verlässt nichts deine Installation außer den von dir konfigurierten E-Mails.
Für die DSGVO-konforme Verarbeitung und den Mailversand an Dritte bist du selbst verantwortlich.
