#!/usr/bin/env node

/**
 * ChAIPi: Zero-Dependency Chrome AI Pipe & Token Guard for the Terminal
 * Nutzt Google Chromes integrierte Prompt API (Gemini Nano) oder WebGPU über natives CDP.
 * 
 * Lizenz: MIT © 2026 Meik
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION, SOCKET_PATH } from '../lib/constants.js';
import { sanitizePipeInput, buildSecurePipePrompt } from '../lib/security.js';
import { handleDaemonCommand } from '../lib/daemon.js';
import { tryExecuteViaDaemon, runStandalone } from '../lib/client.js';
import { recordUsage, computeStatsMetrics, formatStatsLine } from '../lib/stats.js';
import { startHttpServer } from '../lib/server.js';

function printHelp() {
    console.log(`ChAIPi (Chrome AI Pipe) v${VERSION}
Zero-Dependency Chrome AI Pipe & Token Guard for the Terminal

Verwendung:
  chaipi [Optionen] "<Prompt>"
  cat datei.log | chaipi [Optionen] "<Anweisung>"
  echo "Text" | chaipi "Fasse zusammen"
  chaipi daemon <start|stop|status|run>
  chaipi stats
  chaipi serve [--port <port>] [--host <host>]

Optionen:
  --check               Fragt Modellverfügbarkeit und Browser-Fähigkeiten ab (ohne Prompt)
  --stream              Gibt Tokens in Echtzeit direkt auf stdout aus (Streaming)
  --stats               Gibt Token- und Performance-Metriken auf stderr aus
  -s, --system <text>   Definiert einen System-Prompt für die Modell-Session
  -t, --temperature <n> Steuert die Modell-Kreativität (z. B. 0.2 für Extraktion, 0.8 für Text)
  --top-k <n>           Begrenzt den Sampling-Pool des Modells
  --no-daemon           Erzwingt Standalone-Ausführung ohne Hintergrund-Daemon
  --profile <pfad>      Verwendet ein bestimmtes Profilverzeichnis (Standard: ~/.cache/chaipi/profile)
  --temp-profile        Erzwingt ein isoliertes temporäres Profil ohne Persistenz
  --url <url>           Kontext-URL, die im Headless-Tab geladen wird
  --json                Gibt die Ausgabe als strukturiertes JSON zurück
  -V, --verbose         Ausführliche Diagnose- und Statusausgabe auf stderr
  -v, --version         Zeigt die Versionsnummer an
  -h, --help            Zeigt diesen Hilfetext an

Daemon, Server & Monitoring:
  chaipi daemon start   Startet den Hintergrund-Worker mit warmer Chrome-Instanz
  chaipi daemon stop    Beendet den Hintergrund-Worker
  chaipi daemon status  Zeigt den Status des Hintergrund-Workers an
  chaipi daemon run     Führt den Daemon im Vordergrund aus (Debugging)
  chaipi stats          Zeigt Quota-Einsparungen und Token-Raten (RPM/TPM/RPD)
  chaipi serve          Startet OpenAI-kompatiblen HTTP-Server (Standard: Port 8380)

Beispiele:
  chaipi --check
  chaipi daemon start
  chaipi stats
  chaipi --stats "Schreibe eine kurze Geschichte über Unix-Pipes"
  chaipi -s "Antworte ausschließlich als JSON" "Extrahiere Keys aus Logzeile"
  cat /var/log/syslog | chaipi -t 0.2 "Finde die 3 kritischsten Fehlermeldungen"
`);
}

function showStatsDashboard(isJson) {
    const metrics = computeStatsMetrics();
    if (isJson) {
        console.log(JSON.stringify({
            success: true,
            data: metrics
        }, null, 2));
        return;
    }

    console.log(`ChAIPi Token- & Quota-Statistiken

Lokale Aktivität:
  Heutige Anfragen (RPD):       ${metrics.rpd}
  Aktuelle Rate (RPM):          ${metrics.rpm} Anfragen/Min
  Aktueller Durchsatz (TPM):    ${metrics.tpm.toLocaleString('de-DE')} Tokens/Min
  Durchschnitts-Speed:          ${metrics.avgTokPerSec} Tok/s
  Prompt-Tokens heute:          ${metrics.todayPromptTokens.toLocaleString('de-DE')} Tokens
  Output-Tokens heute:          ${metrics.todayCompletionTokens.toLocaleString('de-DE')} Tokens

Cloud-Quota Ersparnis (Google AI Studio Guard):
  Eingesparte Cloud-Anfragen:   ${metrics.savedRequestsToday} Requests (100% lokal abgefangen)
  Eingesparte Tokens heute:     ${metrics.todaySavedTokens.toLocaleString('de-DE')} Tokens
  Eingesparte Tokens gesamt:    ${metrics.totalSavedTokens.toLocaleString('de-DE')} Tokens
  Geschätzte Ersparnis:         ~$${metrics.estimatedSavingsUsd} USD (gemessen an Cloud-Preisen)

Persistente Datenbank: ~/.cache/chaipi/stats.json`);
}

const rawArgs = process.argv.slice(2);

let isCheckOnly = false;
let isStreamOutput = false;
let isJsonOutput = false;
let isStatsOutput = false;
let isStatsSubcommand = false;
let isServeSubcommand = false;
let isHttpFlag = false;
let servePort = 8380;
let serveHost = '127.0.0.1';
let isVerbose = Boolean(process.env.CHAIPI_VERBOSE || process.env.DEBUG);
let noDaemon = false;
let customSystemPrompt = null;
let customTemperature = null;
let customTopK = null;
let customProfileDir = null;
let isTempProfile = false;
let customTargetUrl = null;
let daemonSubcommand = null;
const promptArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--help' || arg === '-h') {
        printHelp();
        process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
        console.log(`chaipi v${VERSION}`);
        process.exit(0);
    } else if (arg === 'daemon') {
        daemonSubcommand = rawArgs[i + 1] || 'status';
        i++;
    } else if (arg === '--daemon-worker') {
        daemonSubcommand = 'worker';
    } else if (arg === 'stats') {
        isStatsSubcommand = true;
    } else if (arg === 'serve') {
        isServeSubcommand = true;
    } else if (arg === '--http') {
        isHttpFlag = true;
    } else if ((arg === '--port' || arg === '-p') && rawArgs[i + 1]) {
        servePort = Number(rawArgs[++i]);
    } else if (arg === '--host' && rawArgs[i + 1]) {
        serveHost = rawArgs[++i];
    } else if (arg === '--stats') {
        isStatsOutput = true;
    } else if (arg === '--no-daemon') {
        noDaemon = true;
    } else if (arg === '--check') {
        isCheckOnly = true;
    } else if (arg === '--stream') {
        isStreamOutput = true;
    } else if (arg === '--json') {
        isJsonOutput = true;
    } else if (arg === '-V' || arg === '--verbose') {
        isVerbose = true;
    } else if (arg === '-s' || arg === '--system') {
        customSystemPrompt = rawArgs[++i];
    } else if (arg === '-t' || arg === '--temperature') {
        customTemperature = parseFloat(rawArgs[++i]);
    } else if (arg === '--top-k') {
        customTopK = parseInt(rawArgs[++i], 10);
    } else if (arg === '--profile') {
        customProfileDir = rawArgs[++i];
    } else if (arg === '--temp-profile') {
        isTempProfile = true;
    } else if (arg === '--url') {
        customTargetUrl = rawArgs[++i];
    } else {
        promptArgs.push(arg);
    }
}

function verboseLog(...args) {
    if (isVerbose) {
        const time = new Date().toTimeString().split(' ')[0];
        console.error(`[chaipi verbose ${time}]`, ...args);
    }
}

function verboseProgress(text, newline = false) {
    if (isVerbose) {
        process.stderr.write(text + (newline ? '\n' : ''));
    }
}

async function readStdin() {
    if (process.stdin.isTTY) return null;
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => { resolve(data.trim() ? data : null); });
        process.stdin.on('error', () => { resolve(null); });
    });
}

async function main() {
    // 1. Stats-Dashboard Befehl direkt abhandeln
    if (isStatsSubcommand) {
        showStatsDashboard(isJsonOutput);
        process.exit(0);
    }

    // 2. OpenAI-kompatiblen HTTP-Server starten
    if (isServeSubcommand) {
        try {
            const serverInfo = await startHttpServer({
                port: servePort,
                host: serveHost,
                verbose: isVerbose
            });
            console.log(`ChAIPi OpenAI-kompatibler HTTP-Server aktiv:
  URL:          ${serverInfo.url}
  Endpunkte:    ${serverInfo.url}/v1/chat/completions
                ${serverInfo.url}/v1/models
                ${serverInfo.url}/v1/stats
  Backend:      Chrome Prompt API (Gemini Nano) über ~/.cache/chaipi/chaipi.sock
  Beenden:      Strg+C`);

            const shutdown = async () => {
                console.log('\n[chaipi] Fahre HTTP-Server herunter...');
                await serverInfo.close();
                process.exit(0);
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
            return new Promise(() => {});
        } catch (err) {
            console.error(`[chaipi serve Fehler] Server konnte nicht gestartet werden: ${err.message}`);
            process.exit(1);
        }
    }

    // 3. Daemon-Verwaltungsbefehle direkt abhandeln
    if (daemonSubcommand) {
        const scriptPath = fileURLToPath(import.meta.url);
        await handleDaemonCommand(daemonSubcommand, isJsonOutput, { 
            cliScript: scriptPath,
            enableHttp: isHttpFlag,
            httpPort: servePort,
            httpHost: serveHost
        });
        if (daemonSubcommand !== 'worker' && daemonSubcommand !== 'run') {
            process.exit(0);
        }
        return;
    }

    const stdinData = await readStdin();
    const instruction = promptArgs.join(' ').trim();

    if (!isCheckOnly && !instruction && !stdinData) {
        console.log('Verwendung: chaipi [Optionen] "<Prompt>" oder "cat datei | chaipi <Anweisung>"');
        console.log('Hilfe: chaipi --help');
        console.error('[chaipi Fehler] Kein Prompt und keine Pipe-Eingabe angegeben.');
        process.exit(1);
    }

    let finalPrompt = '';
    if (stdinData) {
        const sanitizedInput = sanitizePipeInput(stdinData);
        finalPrompt = instruction 
            ? buildSecurePipePrompt(sanitizedInput, instruction)
            : `Fasse die folgenden Eingabedaten zusammen und hebe die wichtigsten Kernpunkte hervor:\n\n<input_data>\n${sanitizedInput}\n</input_data>`;
    } else {
        finalPrompt = instruction;
    }

    // 2. Transparenter IPC-Aufruf an Daemon versuchen (falls aktiv und nicht deaktiviert)
    const canUseDaemon = !noDaemon && !isTempProfile && !customProfileDir && !customTargetUrl && existsSync(SOCKET_PATH);

    if (canUseDaemon) {
        try {
            const req = {
                action: isCheckOnly ? 'check' : 'prompt',
                prompt: finalPrompt,
                systemPrompt: customSystemPrompt,
                temperature: customTemperature,
                topK: customTopK,
                stream: isStreamOutput
            };

            const res = await tryExecuteViaDaemon(req, { isStreamOutput, verboseLog });
            if (res.success) {
                if (res.usage) {
                    recordUsage(res.usage);
                }
                if (res.streamed) {
                    process.stdout.write('\n');
                } else if (isJsonOutput) {
                    let parsedData = null;
                    try { parsedData = JSON.parse(res.text); } catch (e) {}
                    const jsonResp = {
                        success: true,
                        data: parsedData !== null ? parsedData : res.text
                    };
                    if (res.usage) {
                        jsonResp.usage = res.usage;
                    }
                    console.log(JSON.stringify(jsonResp, null, 2));
                } else {
                    process.stdout.write(res.text + '\n');
                }

                if (isStatsOutput && res.usage) {
                    process.stderr.write(formatStatsLine(res.usage) + '\n');
                }
                process.exit(0);
            } else {
                verboseLog(`Daemon meldete Inferenzfehler: ${res.error}. Wechsle auf Standalone-Ausführung...`);
            }
        } catch (daemonErr) {
            verboseLog(`Verbindung zum Daemon fehlgeschlagen (${daemonErr.message}). Wechsle auf Standalone-Ausführung...`);
        }
    }

    // 4. Standalone-Ausführung als Fallback
    await runStandalone({
        isCheckOnly,
        isStreamOutput,
        isJsonOutput,
        isStatsOutput,
        isVerbose,
        customProfileDir,
        isTempProfile,
        customTargetUrl,
        customSystemPrompt,
        customTemperature,
        customTopK,
        finalPrompt,
        verboseLog,
        verboseProgress
    });
}

main().catch((err) => {
    verboseLog(`Fataler Ausnahmefehler: ${err.stack || err.message}`);
    console.error(`[chaipi Fatal] ${err.message}`);
    process.exit(1);
});
