# TODO & Roadmap für ChAIPi (Chrome AI Pipe)

Dieses Dokument erfasst den aktuellen Umsetzungsstatus, durchgeführte Härtungsmaßnahmen, Architektur-Entscheidungen und die priorisierten Zukunftsaufgaben für **ChAIPi**.

---

## 1. Abgeschlossene Meilensteine

- [x] **Zero-Dependency CLI-Bridge-Architektur (`bin/chaipi.mjs`):**
  Vollständige Anbindung von Google Chromes Prompt API über das native Chrome DevTools Protocol (CDP) und Node.js 22 built-in WebSockets ohne externe npm-Abhängigkeiten wie Puppeteer oder Playwright.
- [x] **Unix-Pipe & Stdin-Integration:**
  Unterstützung von Stdin-Pipes (`cat datei | chaipi "Prompt"`), automatisches Erkennen von TTY vs. Pipe und strukturierte Datenkapselung in `<input_data>`-Blöcken.
- [x] **Sicherer WICG-Ausführungskontext:**
  Dynamische Generierung einer lokalen `chaipi-runtime.html` im Profilverzeichnis, um die WICG Prompt API (`LanguageModel` / `window.ai`) in einem sicheren Origin-Kontext (`file://`) zuverlässig zu instanziieren.
- [x] **Live-Systemdiagnose (`--check`):**
  Schnellabfrage von Modellverfügbarkeit (`available`, `readily`, `downloadable`, `no`), API-Spezifikation (`standard` vs. `legacy`) und WebGPU-Hardwareerkennung (`navigator.gpu`) als maschinenlesbares JSON.
- [x] **Ausführlicher Verbose- & Telemetrie-Modus (`-V, --verbose`):**
  Echtzeit-Debugging auf `stderr`, ohne den Unix-Pipe-Datenstrom auf `stdout` zu kontaminieren; Erfassung von Browser-Console-Logs und CDP-Events.
- [x] **Live-Modell-Download-Monitor:**
  Abfangen der WICG-Events `downloadprogress` und Fortschrittsberechnung für Chrome Gemini Nano mit gedrosselter Prozentanzeige auf `stderr`.
- [x] **Beseitigung des `ENOENT`-Profilordner-Fehlers:**
  Automatisches rekursives Anlegen des Profilverzeichnisses (`mkdirSync(..., { recursive: true })`) vor dem Schreiben der Laufzeitdateien.
- [x] **Beseitigung der Component-Updater-Blockade:**
  Entfernung von `--disable-background-networking`, wodurch Chrome den internen Component Updater (`CrxUpdateService`) für Gemini Nano im Headless-Modus korrekt ansprechen kann.
- [x] **Persistenter Profil-Cache als Standard:**
  Standardmäßige Speicherung im Benutzer-Cache `~/.cache/chaipi/profile`, um wiederholte 4-GB-Modell-Downloads bei jedem CLI-Aufruf zu vermeiden; `--temp-profile` als opt-in Sandbox.
- [x] **Automatisches Seeding bestehender Modelle:**
  Erkennung vorhandener Chrome-Installationen (`~/.config/google-chrome/OptGuideOnDeviceModel/` mit 4.27 GB `weights.bin`) und automatisches Symlinken sowie Registrieren in `Local State`. Reduziert die Initialisierungszeit von Minuten auf ~1.4 Sekunden bei 0 Byte Netzwerklast.
- [x] **Natives Node.js Test-Harness (`tests/test_chaipi.js`):**
  Automatisierte Testsuite mit `node:test` und `node:assert/strict` zur Verifikation von CLI-Flags, Hilfe, Version, Diagnose-JSON, Stdin-Pipes und Stderr-Isolation.

---

## 2. Dringende Härtungs- & Sicherheits-Meilensteine (Audit-Ergebnisse)

- [x] **Dynamische Cross-Platform Browser-Erkennung (`findChromeExecutable`):**
  - Beseitigung des fest verdrahteten `/usr/bin/google-chrome-stable`-Pfads.
  - Priorisierte Auflösung über `CHROME_BIN` / `CHROME_PATH` Umgebungsvariablen.
  - Automatische Suche nach `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser` sowie Standardpfaden für Linux, macOS (`/Applications/Google Chrome.app`) und Windows.
  - Klare Fehlermeldung bei fehlendem Browser.
- [x] **Data-Boundary Schutz gegen Indirect Prompt Injection:**
  - Maskierung von schließenden `</input_data>`-Tags im Eingabestrom (`replace(/<\/input_data>/gi, '&lt;/input_data&gt;')`), um Ausbrüche aus der Sicherheitskapselung zu unterbinden.
  - Expliziter Sicherheits-Hinweis vor dem Datenblock, dass Inhalte strikt als passive Nutzlast zu behandeln sind.
- [x] **SIGPIPE-Handling für Unix-Pipelines:**
  - Sauberes Beenden bei vorzeitigem Schließen der Downstream-Pipe (z. B. bei `chaipi ... | head -n 1`).
- [x] **Kontextfenster-Budgetierung & Token-Guard:**
  - Warnung auf `stderr` bei Überlänge (> 25.000 Zeichen), um Kontext-Overflows bei Gemini Nano vorab transparent zu machen.
- [x] **Graceful Process-Shutdown via CDP (`Browser.close`):**
  - Vor dem Senden von `SIGTERM` an die OS-Prozess-ID wird der CDP-Befehl `Browser.close` über den WebSocket abgesetzt.
  - Verhindert verwaiste Headless-Zygote-, Crashpad- oder Renderer-Prozesse bei abruptem Programmabbruch.
- [x] **JSON-Output-Konsistenz (`--json`):**
  - Einheitliches Schema bei `--json` für strukturierte Rückgaben (`{ success: true, data: ... }` bzw. `{ success: false, error: ... }`).

---

## 3. Erweiterte Funktions- & UX-Roadmap (Priorisiert)

### Priorität 1: Streaming & Prompt-Steuerung
- [x] **Echtzeit-Streaming (`--stream`):**
  - Anbindung von `session.promptStreaming()` via CDP-Event-Bridge.
  - Inkrementelle Token-Ausgabe direkt auf `stdout` für minimale wahrgenommene Latenz im Terminal.
- [x] **Prompt-Parameter konfigurierbar machen:**
  - `--system` / `-s`: Benutzerdefinierter System-Prompt bei der Session-Erstellung (unterstützt sowohl `initialPrompts: [{ role: 'system', ... }]` als auch `systemPrompt`).
  - `--temperature` / `-t`: Steuerung der Kreativität (0.0 für deterministische Extraktion, 1.0 für kreative Texte).
  - `--top-k`: Begrenzung des Token-Pools.

### Priorität 2: Performance & Latenz (Daemon-Modus)
- [x] **Daemon / Background Worker Mode (`--daemon` / `chaipi daemon`):**
  - Persistente, warme Chrome-Instanz im Hintergrund mit automatischer Lebenszyklusverwaltung (`start`, `stop`, `status`, `run`).
  - Ultra-schnelle IPC-Kommunikation über Unix Domain Socket (`~/.cache/chaipi/chaipi.sock`).
  - Paralleler Request-Queueing-Mechanismus zur Vermeidung von Konflikten bei gleichzeitigen Shell-Aufrufen.
  - Bereinigung verwaister `SingletonLock`-Symlinks zur robusten Wiederherstellung nach Abstürzen oder Signalabbrüchen.
  - Reduziert die Ausführungszeit von ~1.5 Sekunden (Chrome-Kaltstart) auf **unter 300 ms** für hochfrequente Shell-Pipes und Skripte.
  - Nahtloser Fallback auf Standalone-Ausführung bei inaktivem Daemon oder mit `--no-daemon`.

### Priorität 3: Paketierung & Distribution
- [x] **Arch Linux / CachyOS PKGBUILD:**
  - Saubere Integration in die lokale Paketverwaltung (`pacman`/`makepkg`) zur Vermeidung von unversionierten globalen Symlinks.
  - Bereitstellung in `dist/archlinux/PKGBUILD` inklusive modularer `lib/`-Struktur.
- [x] **NPM Global Package Readiness:**
  - Saubere Whitelist via `"files"` in `package.json` (`bin/`, `lib/`, `README.md`, `LICENSE`).
  - Tarball-Größe bei nur 16.5 kB mit 0 externen Abhängigkeiten.
  - Verifiziert via `npm pack --dry-run`.

### Priorität 4: Architektur-Refactoring & Härtung
- [x] **Zero-Dependency Modularisierung:**
  - Aufteilung des 1.350-Zeilen-Monolithen in dedizierte Module: `lib/constants.js`, `lib/security.js`, `lib/chrome.js`, `lib/cdp.js`, `lib/bridge.js`, `lib/daemon.js`, `lib/client.js`.
  - Schlanker CLI-Orchestrator in `bin/chaipi.mjs` (~220 Zeilen).
  - Schnelle Unit-Tests in `tests/test_units.js` (Laufzeit < 10 ms).
- [x] **Auto-Idle-Timeout für Hintergrund-Daemon:**
  - Automatisches Beenden des Daemons nach 15 Minuten Inaktivität (`DEFAULT_IDLE_TIMEOUT_MS`), um System-RAM zu schonen.
  - Timer-Reset bei jedem eingehenden Pipe-Request.

### Priorität 5: WebGPU Engine-Erweiterung
- [ ] **WebGPU Fallback Engine:**
  - Integration einer leichtgewichtigen OnnxRuntime-Web- oder Transformers.js-Laufzeit auf der existierenden WebGPU-Runtime-Seite für Systeme ohne Gemini Nano Support.
