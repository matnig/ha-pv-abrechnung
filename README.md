# PV Abrechnung – Home-Assistant-Add-on-Repository

Ein **Custom-Add-on-Repository** für Home Assistant mit dem Add-on **PV Abrechnung**:
zählerbasierte PV-Abrechnung (Anfangs-/Endstand) mit automatischem Tages-/Monats-/
Jahresbericht per Mail, robuster Störungs-/Zählertausch-Behandlung und virtuellen Zählern.

> **Hinweis:** Dies ist ein **Add-on**, kein HACS-Modul. HACS verwaltet Integrationen/
> Frontend, **keine Add-ons**. Add-ons werden über die Add-on-Store-Repositories des
> Supervisors installiert (siehe unten).

## Installation in Home Assistant

1. In Home Assistant: **Einstellungen → Add-ons → Add-on Store**.
2. Oben rechts das **⋮-Menü → Repositories**.
3. Diese Repo-URL einfügen und hinzufügen:
   ```
   https://github.com/matnig/ha-pv-abrechnung
   ```
4. Den Store neu laden – das Add-on **„PV Abrechnung"** erscheint. Installieren und starten.
5. Die Weboberfläche öffnet sich über die Seitenleiste (Ingress) zur Konfiguration
   (Zähler zuordnen, Tarife, Empfänger, SMTP).

Voraussetzung: Home Assistant OS bzw. Supervised (der Add-on-Store ist nur dort verfügbar).

## Inhalt

- [`pv_abrechnung/`](pv_abrechnung/) – das Add-on (siehe dessen
  [README](pv_abrechnung/README.md) für Architektur und Entwicklung).

## Lizenz

MIT
