'use strict';

// Schützt das Add-on-Manifest. Ein Syntaxfehler hier ist besonders tückisch: der Supervisor
// kann das Add-on dann nicht mehr einlesen, es erscheint KEIN Update mehr im Store – und zwar
// ohne sichtbare Fehlermeldung in der Oberfläche. Genau das ist einmal passiert, weil eine
// unquotierte Beschreibung einen Doppelpunkt mit Leerzeichen enthielt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..');

let yaml = null;
try {
  yaml = require('js-yaml');
} catch {
  /* js-yaml ist optional – ohne es greift nur die Zeichenprüfung unten */
}

/** Findet unquotierte Werte, die ": " enthalten – in YAML ein Syntaxfehler. */
function findUnquotedColonValues(text) {
  const bad = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line) || !line.trim()) return;
    const m = /^([A-Za-z_][\w-]*):\s+(.*)$/.exec(line);
    if (!m) return;
    const value = m[2].trim();
    if (!value || value.startsWith('#')) return;
    const quoted = /^["'].*["']$/.test(value);
    // "key: http://..." ist erlaubt (Doppelpunkt ohne folgendes Leerzeichen)
    if (!quoted && /:\s/.test(value)) bad.push({ line: i + 1, key: m[1], value });
  });
  return bad;
}

test('config.yaml ist gültiges YAML', () => {
  const file = path.join(ROOT, 'config.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const unquoted = findUnquotedColonValues(text);
  assert.deepStrictEqual(
    unquoted,
    [],
    'Werte mit ": " müssen in Anführungszeichen stehen, sonst bricht YAML: ' + JSON.stringify(unquoted)
  );
  if (yaml) assert.doesNotThrow(() => yaml.load(text), 'config.yaml muss parsebar sein');
});

test('config.yaml enthält die Pflichtfelder des Add-ons', () => {
  if (!yaml) return; // ohne Parser nicht prüfbar
  const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
  assert.ok(cfg && typeof cfg === 'object', 'Manifest muss ein Objekt sein');
  for (const key of ['name', 'version', 'slug', 'description', 'arch']) {
    assert.ok(cfg[key], `Pflichtfeld fehlt: ${key}`);
  }
  assert.match(String(cfg.version), /^\d+\.\d+\.\d+$/, 'Version muss die Form X.Y.Z haben');
  assert.ok(Array.isArray(cfg.arch) && cfg.arch.length, 'arch muss eine nicht-leere Liste sein');
  // Ingress-Betrieb: kein Port nach außen, Authentifizierung über Home Assistant
  assert.strictEqual(cfg.ingress, true, 'Add-on läuft über Ingress');
  assert.ok(cfg.ingress_port, 'ingress_port muss gesetzt sein');
  assert.strictEqual(cfg.ports, undefined, 'kein Port-Mapping – sonst wäre die Oberfläche ungeschützt erreichbar');
  assert.strictEqual(cfg.homeassistant_api, true, 'Zugriff auf die HA-API wird benötigt');
});

test('repository.yaml ist gültiges YAML und vollständig', () => {
  const file = path.join(REPO_ROOT, 'repository.yaml');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  assert.deepStrictEqual(findUnquotedColonValues(text), [], 'unquotierte Werte mit ": " in repository.yaml');
  if (yaml) {
    const repo = yaml.load(text);
    assert.ok(repo.name, 'repository.yaml braucht einen Namen');
    assert.ok(repo.url, 'repository.yaml braucht eine URL');
  }
});

test('Version im Manifest entspricht dem neuesten CHANGELOG-Eintrag', () => {
  if (!yaml) return;
  const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const first = (changelog.match(/^##\s+(\d+\.\d+\.\d+)/m) || [])[1];
  assert.ok(first, 'CHANGELOG enthält keinen Versionseintrag');
  assert.strictEqual(
    first,
    String(cfg.version),
    `CHANGELOG (${first}) und config.yaml (${cfg.version}) müssen dieselbe Version nennen – ` +
      'Home Assistant zeigt den CHANGELOG-Text beim Update an.'
  );
});
