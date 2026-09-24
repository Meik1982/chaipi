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

## ⚙️ Optionen & Flags

| Flag | Beschreibung |
| :--- | :--- |
| `--check` | Führt einen schnellen System- & Modell-Check via CDP durch (ohne Prompt). |
| `-V, --verbose` | Gibt detaillierte Status- & Diagnose-Meldungen sowie Modell-Downloadfortschritte auf `stderr` aus. |
| `--profile <pfad>` | Verwendet ein bestehendes Chrome-Profil (z. B. `~/.config/google-chrome`). |
| `--temp-profile` | Startet Chrome mit einem isolierten, temporären Profil (Standard). |
| `--url <url>` | Lädt eine benutzerdefinierte Webseite als Ausführungskontext. |
| `--json` | Liefert die CLI-Antwort im standardisierten JSON-Format. |
| `-v, --version` | Zeigt die Version von ChAIPi an. |
| `-h, --help` | Zeigt die integrierte Hilfe. |

---

## 🧪 Tests

Die Testsuite nutzt den nativen Node.js Test-Runner:

```bash
npm test
```

---

## 📄 Lizenz

MIT License © 2026 Meik
