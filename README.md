# ChAIPi (Chrome AI Pipe)

> **Zero-Dependency Chrome AI Pipe & Token Guard for the Terminal**  
> Harness Google Chrome's built-in on-device AI (Gemini Nano & WebGPU) directly from your shell pipelines via native Chrome DevTools Protocol (CDP).

---

## 💡 What is ChAIPi?

**ChAIPi** (**Ch**rome **AI** **Pi**pe) bridges the gap between modern browser-native AI and the Unix terminal.

Modern AI agents and developers often burn thousands of expensive cloud tokens just to filter compiler logs, summarize web scrapes, or extract JSON keys. **ChAIPi** acts as a local **Pre-Flight Sentinel and Token Guard**: It processes high-volume raw data on your local hardware using Chrome's built-in Gemini Nano or WebGPU—costing **0 API tokens** and preventing 429 rate-limit quota spikes.

### Key Highlights

- ⚡ **Zero External Dependencies:** Built strictly on Node.js 22 built-ins (`fetch`, `WebSocket`, `child_process`). No Puppeteer, no Playwright, no bloated `node_modules`.
- 🚰 **Native Unix Pipe Integration:** Seamlessly chains with `cat`, `grep`, `tail`, and `curl`:
  ```bash
  cat /var/log/syslog | chaipi "Finde die 3 kritischsten Kernel-Fehler"
  ```
- 🛡️ **Token Guard & Quota-Schutz:** Filters gigabyte-sized logs down to concise summaries *before* feeding them to paid cloud LLMs (Gemini Flash, Claude, GPT-4).
- 🌐 **Modern WICG Standard:** Uses the global WICG `LanguageModel` specification introduced in Chrome 153+ with backward compatibility for `window.ai`.
- 🔒 **Data Boundary Protection:** Piped inputs are automatically sanitized and encapsulated in `<input_data>` tags to prevent prompt injection.

---

## 🚀 Quickstart

### Voraussetzungen
- **Node.js:** v22.0.0 oder neuer (für native WebSocket-Unterstützung).
- **Google Chrome:** Version 128+ mit aktivierten On-Device Flags:
  - `chrome://flags/#prompt-api-for-gemini-nano` -> **Enabled**
  - `chrome://flags/#optimization-guide-on-device-model` -> **Enabled BypassPerfRequirement**

### Installation

```bash
git clone https://github.com/Meik1982/chaipi.git
cd chaipi
npm test
ln -s "$(pwd)/bin/chaipi.mjs" ~/.local/bin/chaipi
```

---

## 🛠️ CLI Verwendung

### 1. Systemdiagnose & Status-Check
Prüft, ob Chrome die Prompt API und WebGPU bereitstellt:
```bash
chaipi --check
```
Beispiel-Ausgabe:
```json
{
  "name": "ChAIPi",
  "version": "0.1.0",
  "apiType": "standard",
  "availability": "readily",
  "webGpu": true
}
```

### 2. Direkter Prompt
```bash
chaipi "Erstelle einen kurzen 2-Zeiler über lokale Datensicherheit"
```

### 3. Unix-Pipes (Das Herzstück)
```bash
# Log-Filterung
dmesg | chaipi "Finde Speicher- oder Hardwarefehler"

# JSON-Extraktion
echo 'Server redis-01 (192.168.1.10) port 6379 active' | chaipi "Extrahiere JSON mit keys host, ip, port"

# Strukturierte JSON-Rückgabe für Scripts
cat data.txt | chaipi --json "Extrahiere Metriken"
```

---

## 🚀 Daemon-Modus (Sub-200ms Latenz)

Normalerweise startet `chaipi` für jede Ausführung einen schlanken Headless-Chrome-Prozess (~1,4 s Kaltstart). Für hochfrequente Shell-Pipes, Skripte oder interaktive Nutzung kann ein **warmer Hintergrund-Daemon** gestartet werden:

```bash
# Daemon im Hintergrund starten (hält Chrome warm bereit):
chaipi daemon start

# Status abfragen (PID, Uptime, Modellverfügbarkeit):
chaipi daemon status

# Beliebige Befehle und Pipes ausführen (reagieren nun in < 200-300 ms!):
chaipi "Sag hallo"
cat /var/log/syslog | chaipi "Finde kritische Fehler"

# Daemon beenden:
chaipi daemon stop
```

*Hinweis:* Wenn der Daemon läuft, verbindet sich `chaipi` automatisch transparent über den Unix Domain Socket `~/.cache/chaipi/chaipi.sock`. Läuft der Daemon nicht, greift ohne Unterbrechung der Standalone-Modus. Mit `--no-daemon` kann die Standalone-Ausführung jederzeit erzwungen werden.

---

## 📊 Token-Tracking & Quota-Statistiken

ChAIPi misst Tokens nativ über Chromes WICG-API (`session.measureContextUsage()` und `session.contextUsage`):

```bash
# Token-Metriken bei Inferenz auf stderr ausgeben (stdout bleibt pipe-sauber):
chaipi --stats "Schreibe ein kurzes Haiku"
# Ausgabe auf stderr:
# [chaipi stats] Prompt: 14 Tok | Output: 18 Tok | Kontext: 32/9216 (0.3%) | Zeit: 310ms (58.1 Tok/s)

# Dashboard für tägliche Quota-Einsparungen und Durchsatz abfragen:
chaipi stats

# Oder maschinenlesbar für Monitoring-Tools / Scripts:
chaipi stats --json
```

---

## ⚙️ Optionen & Flags

| Flag / Befehl | Beschreibung |
| :--- | :--- |
| `daemon <start\|stop\|status>` | Steuert den persistenten Hintergrund-Daemon mit warmer Chrome-Instanz. |
| `stats` | Zeigt das Token-Accounting-Dashboard (RPD, RPM, TPM, Quota-Einsparung). |
| `--stats` | Gibt Token-Verbrauch, Kontext-Auslastung und Generierungs-Speed auf `stderr` aus. |
| `--no-daemon` | Erzwingt Standalone-Ausführung ohne Verbindung zum Hintergrund-Daemon. |
| `--check` | Führt einen schnellen System- & Modell-Check via CDP durch (ohne Prompt). |
| `--stream` | Gibt Tokens in Echtzeit direkt auf `stdout` aus (Streaming). |
| `-s, --system <text>` | Definiert einen System-Prompt für die Modell-Session. |
| `-t, --temperature <n>` | Steuert die Modell-Kreativität (z. B. `0.2` für Extraktion, `0.8` für Text). |
| `--top-k <n>` | Begrenzt den Sampling-Pool des Modells. |
| `-V, --verbose` | Gibt detaillierte Status- & Diagnose-Meldungen sowie Modell-Downloadfortschritte auf `stderr` aus. |
| `--profile <pfad>` | Verwendet ein bestimmtes Profilverzeichnis (Standard: `~/.cache/chaipi/profile`). |
| `--temp-profile` | Startet Chrome mit einem isolierten, temporären Profil ohne Persistenz. |
| `--url <url>` | Lädt eine benutzerdefinierte Webseite als Ausführungskontext. |
| `--json` | Liefert die CLI-Antwort im standardisierten JSON-Format (`{ success, data }`). |
| `-v, --version` | Zeigt die Version von ChAIPi an. |
| `-h, --help` | Zeigt den Hilfetext an. |

---

## 📦 Paketierung (Arch Linux / CachyOS)

Für eine saubere native Installation über `pacman`:

```bash
cd dist/archlinux
makepkg -si
```

---

## 🧪 Tests

Die Testsuite nutzt den nativen Node.js Test-Runner:

```bash
npm test
```

---

## 📄 Lizenz

MIT License © 2026 Meik
