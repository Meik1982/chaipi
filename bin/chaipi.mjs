#!/usr/bin/env node

/**
 * ChAIPi: Chrome AI Pipe
 * Zero-Dependency CLI-Bridge & Token Guard for Chrome's Prompt API (Gemini Nano) & WebGPU
 * 
 * Powered by Node.js 22 Built-in WebSocket & Chrome DevTools Protocol (CDP).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '0.1.0';

function printHelp() {
    console.log(`ChAIPi (Chrome AI Pipe) v${VERSION}
Zero-Dependency Chrome AI Pipe & Token Guard for the Terminal

Verwendung:
  chaipi [Optionen] "<Prompt>"
  cat datei.log | chaipi [Optionen] "<Anweisung>"
  echo "Text" | chaipi "Fasse zusammen"

Optionen:
  --check               Fragt Modellverfügbarkeit und Browser-Fähigkeiten ab (ohne Prompt)
  --profile <pfad>      Verwendet ein bestehendes Chrome-Profilverzeichnis
  --temp-profile        Erzwingt ein isoliertes temporäres Profil (Standard)
  --url <url>           Kontext-URL, die im Headless-Tab geladen wird
  --json                Gibt die Ausgabe als strukturiertes JSON zurück
  -v, --version         Zeigt die Versionsnummer an
  -h, --help            Zeigt diesen Hilfetext an

Beispiele:
  chaipi --check
  chaipi "Erstelle einen kurzen 2-Zeiler über lokale KI"
  cat /var/log/syslog | chaipi "Finde die 3 kritischsten Fehlermeldungen"
`);
}

async function readStdin() {
    if (process.stdin.isTTY) {
        return null;
    }
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => {
            data += chunk;
            if (data.length > 2 * 1024 * 1024) { // 2MB Schutzgrenze
                process.stdin.pause();
                resolve(data);
            }
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', err => reject(err));
    });
}

// Argument-Parsing
const rawArgs = process.argv.slice(2);
let isCheckOnly = false;
let isJsonOutput = false;
let isTempProfile = false;
let customProfileDir = process.env.CHROME_USER_DATA_DIR || null;
let targetUrl = 'file:///home/meik/workspace/LOCAL/index.html';
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--help' || arg === '-h') {
        printHelp();
        process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
        console.log(`chaipi v${VERSION}`);
        process.exit(0);
    } else if (arg === '--check') {
        isCheckOnly = true;
    } else if (arg === '--json') {
        isJsonOutput = true;
    } else if (arg === '--temp-profile') {
        isTempProfile = true;
    } else if (arg === '--profile' && rawArgs[i + 1]) {
        customProfileDir = rawArgs[++i];
    } else if (arg === '--url' && rawArgs[i + 1]) {
        targetUrl = rawArgs[++i];
    } else {
        positional.push(arg);
    }
}

const userPrompt = positional.join(' ').trim();
const stdinData = await readStdin();

if (!userPrompt && !isCheckOnly && !stdinData) {
    printHelp();
    process.exit(1);
}

// Prompt mit Pipe-Daten zusammenstellen
let finalPrompt = userPrompt;
if (stdinData && stdinData.trim()) {
    if (finalPrompt) {
        finalPrompt = `${finalPrompt}\n\n<input_data>\n${stdinData.trim()}\n</input_data>`;
    } else {
        finalPrompt = `Analysiere und fasse folgende Daten zusammen:\n\n<input_data>\n${stdinData.trim()}\n</input_data>`;
    }
}

// Profilpfad vorbereiten
let activeProfileDir = customProfileDir;
let createdTempDir = null;

if (!activeProfileDir || isTempProfile) {
    createdTempDir = mkdtempSync(join(tmpdir(), 'chaipi-profile-'));
    activeProfileDir = createdTempDir;
}

const remoteDebuggingPort = 9400 + Math.floor(Math.random() * 500);

const chromeFlags = [
    '--headless=new',
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${activeProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--enable-features=PromptAPIForGeminiNano:bypass_perf_requirement/true,OptimizationGuideModelDownloading',
    '--optimization-guide-on-device-model-execution-override',
    '--enable-unsafe-webgpu',
    targetUrl
];

let chromeProc = null;

function cleanup() {
    if (chromeProc) {
        try { chromeProc.kill('SIGTERM'); } catch (e) {}
    }
    if (createdTempDir) {
        try { rmSync(createdTempDir, { recursive: true, force: true }); } catch (e) {}
    }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function waitForCdpEndpoint(port, maxRetries = 40) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) {
                const data = await res.json();
                return data.webSocketDebuggerUrl;
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Chrome DevTools Endpunkt auf Port ${port} antwortet nicht.`);
}

function sendCdpCommand(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1000000);
        const handleMsg = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.id === id) {
                    ws.removeEventListener('message', handleMsg);
                    if (data.error) {
                        reject(new Error(data.error.message || JSON.stringify(data.error)));
                    } else {
                        resolve(data.result);
                    }
                }
            } catch (err) {}
        };
        ws.addEventListener('message', handleMsg);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function run() {
    chromeProc = spawn('/usr/bin/google-chrome-stable', chromeFlags, {
        stdio: ['ignore', 'ignore', 'ignore']
    });

    const browserWsUrl = await waitForCdpEndpoint(remoteDebuggingPort);

    const tabsRes = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
    const tabs = await tabsRes.json();
    const pageTab = tabs.find(t => t.type === 'page') || tabs[0];

    if (!pageTab || !pageTab.webSocketDebuggerUrl) {
        throw new Error('Kein Page-Target in Chrome gefunden.');
    }

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
    });

    await sendCdpCommand(ws, 'Runtime.enable');

    const evalCode = `
        (async () => {
            const getLm = () => {
                if (typeof LanguageModel !== 'undefined') return { api: LanguageModel, type: 'standard' };
                if (window.ai && window.ai.languageModel) return { api: window.ai.languageModel, type: 'legacy' };
                return null;
            };

            const lmEntry = getLm();
            if (!lmEntry) {
                return JSON.stringify({ 
                    success: false, 
                    error: "Chrome Prompt API (LanguageModel / window.ai) ist in dieser Session nicht verfügbar. Flags prüfen." 
                });
            }

            const { api: lm, type } = lmEntry;

            let availability = 'unknown';
            try {
                if (typeof lm.availability === 'function') {
                    availability = await lm.availability();
                } else if (typeof lm.capabilities === 'function') {
                    const caps = await lm.capabilities();
                    availability = caps.available || caps.readily || 'available';
                }
            } catch (e) {
                availability = 'check_failed: ' + e.message;
            }

            if (${JSON.stringify(isCheckOnly)}) {
                return JSON.stringify({
                    success: true,
                    text: JSON.stringify({
                        name: "ChAIPi",
                        version: "${VERSION}",
                        apiType: type,
                        availability: availability,
                        webGpu: typeof navigator.gpu !== 'undefined'
                    }, null, 2)
                });
            }

            try {
                const session = await lm.create();
                const response = await session.prompt(${JSON.stringify(finalPrompt)});
                try { session.destroy(); } catch (e) {}
                return JSON.stringify({ success: true, text: response });
            } catch (err) {
                return JSON.stringify({ 
                    success: false, 
                    error: err.message || String(err),
                    availability: availability 
                });
            }
        })()
    `;

    const evalResult = await sendCdpCommand(ws, 'Runtime.evaluate', {
        expression: evalCode,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true
    });

    ws.close();

    const outputData = JSON.parse(evalResult?.result?.value || '{}');

    if (outputData.success) {
        if (isJsonOutput) {
            console.log(JSON.stringify({ success: true, output: outputData.text }, null, 2));
        } else {
            process.stdout.write(outputData.text + '\n');
        }
    } else {
        if (isJsonOutput) {
            console.error(JSON.stringify({ success: false, error: outputData.error, availability: outputData.availability }, null, 2));
        } else {
            console.error(`[chaipi Fehler] ${outputData.error}`);
        }
        process.exit(2);
    }
}

run().catch((err) => {
    console.error(`[chaipi Fatal] ${err.message}`);
    process.exit(1);
}).finally(() => {
    cleanup();
});
