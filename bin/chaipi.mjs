#!/usr/bin/env node

/**
 * ChAIPi: Chrome AI Pipe
 * Zero-Dependency CLI-Bridge & Token Guard for Chrome's Prompt API (Gemini Nano) & WebGPU
 * 
 * Powered by Node.js 22 Built-in WebSocket & Chrome DevTools Protocol (CDP).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '0.1.0';
const DEFAULT_PROFILE_DIR = join(homedir(), '.cache', 'chaipi', 'profile');

function printHelp() {
    console.log(`ChAIPi (Chrome AI Pipe) v${VERSION}
Zero-Dependency Chrome AI Pipe & Token Guard for the Terminal

Verwendung:
  chaipi [Optionen] "<Prompt>"
  cat datei.log | chaipi [Optionen] "<Anweisung>"
  echo "Text" | chaipi "Fasse zusammen"

Optionen:
  --check               Fragt Modellverfügbarkeit und Browser-Fähigkeiten ab (ohne Prompt)
  --profile <pfad>      Verwendet ein bestimmtes Profilverzeichnis (Standard: ~/.cache/chaipi/profile)
  --temp-profile        Erzwingt ein isoliertes temporäres Profil ohne Persistenz
  --url <url>           Kontext-URL, die im Headless-Tab geladen wird
  --json                Gibt die Ausgabe als strukturiertes JSON zurück
  -V, --verbose         Ausführliche Diagnose- und Statusausgabe auf stderr
  -v, --version         Zeigt die Versionsnummer an
  -h, --help            Zeigt diesen Hilfetext an

Beispiele:
  chaipi --check
  chaipi --verbose "Erstelle einen kurzen 2-Zeiler über lokale KI"
  cat /var/log/syslog | chaipi -V "Finde die 3 kritischsten Fehlermeldungen"
`);
}

// Verbose Logging Helfer (ausschließlich auf stderr)
let isVerbose = Boolean(process.env.CHAIPI_VERBOSE || process.env.DEBUG);

function verboseLog(...args) {
    if (isVerbose) {
        const time = new Date().toISOString().split('T')[1].slice(0, 8);
        process.stderr.write(`[chaipi verbose ${time}] ${args.join(' ')}\n`);
    }
}

function verboseProgress(text, newline = false) {
    if (isVerbose) {
        process.stderr.write(text + (newline ? '\n' : ''));
    }
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
let customTargetUrl = null;
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--help' || arg === '-h') {
        printHelp();
        process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
        console.log(`chaipi v${VERSION}`);
        process.exit(0);
    } else if (arg === '--verbose' || arg === '-V') {
        isVerbose = true;
    } else if (arg === '--check') {
        isCheckOnly = true;
    } else if (arg === '--json') {
        isJsonOutput = true;
    } else if (arg === '--temp-profile') {
        isTempProfile = true;
    } else if (arg === '--profile' && rawArgs[i + 1]) {
        customProfileDir = rawArgs[++i];
    } else if (arg === '--url' && rawArgs[i + 1]) {
        customTargetUrl = rawArgs[++i];
    } else {
        positional.push(arg);
    }
}

const userPrompt = positional.join(' ').trim();
verboseLog(`Starte ChAIPi CLI (Modus: ${isCheckOnly ? 'Systemprüfung (--check)' : 'Prompt-Ausführung'})...`);

const stdinData = await readStdin();
if (stdinData) {
    verboseLog(`Stdin-Pipe erkannt (${stdinData.length} Bytes empfangen).`);
}

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

if (!isCheckOnly) {
    verboseLog(`Finaler Prompt vorbereitet (${finalPrompt.length} Zeichen).`);
}

function seedExistingModelIfAvailable(profileDir) {
    const knownChromePaths = [
        join(homedir(), '.config', 'google-chrome'),
        join(homedir(), '.config', 'chromium'),
        join(homedir(), '.config', 'google-chrome-beta'),
        join(homedir(), '.config', 'google-chrome-unstable')
    ];

    for (const chromePath of knownChromePaths) {
        const optGuideDir = join(chromePath, 'OptGuideOnDeviceModel');
        const localStatePath = join(chromePath, 'Local State');
        if (existsSync(optGuideDir) && existsSync(localStatePath)) {
            try {
                // Verlinke OptGuideOnDeviceModel falls noch nicht vorhanden
                const targetOptGuideDir = join(profileDir, 'OptGuideOnDeviceModel');
                if (!existsSync(targetOptGuideDir)) {
                    symlinkSync(optGuideDir, targetOptGuideDir);
                    verboseLog(`Bestehendes On-Device Modell erkannt und verlinkt von: ${optGuideDir}`);
                }

                // Synchronisiere Component-Registrierung in Local State
                const mainState = JSON.parse(readFileSync(localStatePath, 'utf8'));
                const chaipiStatePath = join(profileDir, 'Local State');
                let chaipiState = {};
                if (existsSync(chaipiStatePath)) {
                    try { chaipiState = JSON.parse(readFileSync(chaipiStatePath, 'utf8')); } catch (e) {}
                }

                if (mainState.updateclientdata?.apps?.['fklghjjljmnfjoepjmlobpekiapffcja']) {
                    chaipiState.updateclientdata = chaipiState.updateclientdata || { apps: {} };
                    chaipiState.updateclientdata.apps['fklghjjljmnfjoepjmlobpekiapffcja'] = 
                        mainState.updateclientdata.apps['fklghjjljmnfjoepjmlobpekiapffcja'];
                }
                if (mainState.optimization_guide) {
                    chaipiState.optimization_guide = mainState.optimization_guide;
                }
                if (mainState.browser) {
                    chaipiState.browser = mainState.browser;
                }
                writeFileSync(chaipiStatePath, JSON.stringify(chaipiState, null, 2));
                verboseLog('Lokale Modell-Registrierung erfolgreich übernommen (kein Download erforderlich).');
                return true;
            } catch (e) {
                verboseLog(`Hinweis beim Übernehmen des bestehenden Modells: ${e.message}`);
            }
        }
    }
    return false;
}

// Profilpfad vorbereiten: Standard ist persistenter Cache unter ~/.cache/chaipi/profile
let activeProfileDir = customProfileDir;
let createdTempDir = null;

if (isTempProfile) {
    createdTempDir = mkdtempSync(join(tmpdir(), 'chaipi-profile-'));
    activeProfileDir = createdTempDir;
    verboseLog(`Verwende isoliertes temporäres Profil: ${activeProfileDir}`);
    verboseLog(`Hinweis: Bei temporären Profilen werden gecachte Modelldaten beim Beenden gelöscht.`);
} else {
    activeProfileDir = activeProfileDir || DEFAULT_PROFILE_DIR;
    mkdirSync(activeProfileDir, { recursive: true });
    verboseLog(`Verwende persistentes Profilverzeichnis: ${activeProfileDir}`);
}

// Automatische Übernahme des Modells aus existierendem Haupt-Chrome-Profil
seedExistingModelIfAvailable(activeProfileDir);

// Lokale Runtime-HTML im Profilordner bereitstellen (für sicheren WICG-Origin-Kontext)
const runtimeHtmlPath = join(activeProfileDir, 'chaipi-runtime.html');
if (!existsSync(runtimeHtmlPath)) {
    writeFileSync(runtimeHtmlPath, '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ChAIPi Runtime</title></head><body>ChAIPi On-Device AI Runtime</body></html>\n');
}
const targetUrl = customTargetUrl || `file://${runtimeHtmlPath}`;
verboseLog(`Kontext-URL: ${targetUrl}`);

const remoteDebuggingPort = 9400 + Math.floor(Math.random() * 500);
verboseLog(`Zugeordneter Chrome DevTools Port: ${remoteDebuggingPort}`);

const chromeFlags = [
    '--headless=new',
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${activeProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-translate',
    '--enable-features=PromptAPIForGeminiNano:bypass_perf_requirement/true,OptimizationGuideModelDownloading',
    '--optimization-guide-on-device-model-execution-override',
    '--enable-unsafe-webgpu',
    targetUrl
];

let chromeProc = null;

function cleanup() {
    if (chromeProc) {
        verboseLog('Beende Chrome-Prozess (SIGTERM)...');
        try { chromeProc.kill('SIGTERM'); } catch (e) {}
    }
    if (createdTempDir) {
        verboseLog(`Bereinige temporäres Profil: ${createdTempDir}`);
        try { rmSync(createdTempDir, { recursive: true, force: true }); } catch (e) {}
    }
}

process.on('SIGINT', () => { 
    verboseLog('Abbruch durch Benutzer (SIGINT / Ctrl+C).');
    cleanup(); 
    process.exit(130); 
});
process.on('SIGTERM', () => { 
    verboseLog('Prozess beendet (SIGTERM).');
    cleanup(); 
    process.exit(143); 
});

async function waitForCdpEndpoint(port, maxRetries = 50) {
    verboseLog(`Warte auf CDP-Endpunkt unter http://127.0.0.1:${port}/json/version...`);
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) {
                const data = await res.json();
                verboseLog(`CDP-Endpunkt bereit: Browser = ${data.Browser || 'Chrome'}`);
                return data.webSocketDebuggerUrl;
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Chrome DevTools Endpunkt auf Port ${port} antwortet nicht nach ${maxRetries * 100}ms.`);
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
    verboseLog('Starte Chrome-Subprozess...');
    chromeProc = spawn('/usr/bin/google-chrome-stable', chromeFlags, {
        stdio: ['ignore', 'ignore', isVerbose ? 'pipe' : 'ignore']
    });

    if (isVerbose && chromeProc.stderr) {
        chromeProc.stderr.on('data', chunk => {
            const text = chunk.toString().trim();
            if (text && !text.includes('DevTools listening on')) {
                verboseLog(`[Chrome Stderr] ${text}`);
            }
        });
    }

    const browserWsUrl = await waitForCdpEndpoint(remoteDebuggingPort);

    verboseLog('Rufe aktive Tabs/Targets von Chrome ab...');
    const tabsRes = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
    const tabs = await tabsRes.json();
    const pageTab = tabs.find(t => t.type === 'page') || tabs[0];

    if (!pageTab || !pageTab.webSocketDebuggerUrl) {
        throw new Error('Kein Page-Target in Chrome gefunden.');
    }

    verboseLog(`Verbinde WebSocket zu Page-Target (URL: ${pageTab.url || targetUrl})...`);
    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
    });
    verboseLog('WebSocket-Verbindung erfolgreich aufgebaut.');

    // CDP Events für Console-Logs und Downloadfortschritt registrieren
    let lastReportedPct = -1;
    ws.addEventListener('message', (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.method === 'Runtime.consoleAPICalled') {
                const firstVal = data.params?.args?.[0]?.value;
                if (typeof firstVal === 'string' && firstVal.startsWith('{"__chaipi_event":')) {
                    const evt = JSON.parse(firstVal);
                    if (evt.__chaipi_event === 'downloadprogress') {
                        let pct = 0;
                        if (evt.total === 1) {
                            pct = Math.min(100, Math.round(evt.loaded * 100));
                        } else if (evt.total > 0) {
                            pct = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
                        }
                        if (pct !== lastReportedPct) {
                            lastReportedPct = pct;
                            verboseProgress(`\r[chaipi verbose] Modell-Download: ${pct}% abgeschlossen...`);
                            if (pct >= 100) {
                                verboseProgress('\n');
                            }
                        }
                    } else if (evt.__chaipi_event === 'create_start') {
                        if (evt.availability === 'downloadable' || evt.availability === 'downloading') {
                            verboseLog(`Modell-Session wird initialisiert. Verfügbarkeit ist '${evt.availability}' – Lade Gemini Nano On-Device Modell herunter (~1.5 GB)...`);
                        } else {
                            verboseLog(`Modell-Session wird initialisiert (Verfügbarkeit: '${evt.availability}')...`);
                        }
                    } else if (evt.__chaipi_event === 'create_done') {
                        verboseLog('Modell-Session erfolgreich erstellt.');
                    } else if (evt.__chaipi_event === 'prompt_start') {
                        verboseLog(`Sende Prompt an Gemini Nano (${evt.length} Zeichen)...`);
                    } else if (evt.__chaipi_event === 'prompt_done') {
                        verboseLog('Antwort vom Modell vollständig generiert.');
                    }
                } else if (isVerbose) {
                    const text = data.params?.args?.map(a => a.value ?? a.description ?? '').join(' ');
                    if (text && !text.includes('__chaipi_event')) {
                        verboseLog(`[Browser Console] ${text}`);
                    }
                }
            }
        } catch (e) {}
    });

    verboseLog('Aktiviere CDP Runtime-Domäne...');
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
                console.log(JSON.stringify({
                    __chaipi_event: 'create_start',
                    availability: availability
                }));

                const createOptions = {};
                createOptions.monitor = (m) => {
                    const notify = (e) => {
                        console.log(JSON.stringify({
                            __chaipi_event: 'downloadprogress',
                            loaded: e.loaded,
                            total: e.total
                        }));
                    };
                    if (m) {
                        if (typeof m.addEventListener === 'function') {
                            m.addEventListener('downloadprogress', notify);
                        }
                        m.ondownloadprogress = notify;
                    }
                };

                const session = await lm.create(createOptions);
                console.log(JSON.stringify({ __chaipi_event: 'create_done' }));

                console.log(JSON.stringify({ 
                    __chaipi_event: 'prompt_start', 
                    length: ${JSON.stringify(finalPrompt)}.length 
                }));

                const response = await session.prompt(${JSON.stringify(finalPrompt)});
                console.log(JSON.stringify({ __chaipi_event: 'prompt_done' }));

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

    verboseLog('Führe JavaScript-Evaluierung im Browserkontext aus...');
    const evalResult = await sendCdpCommand(ws, 'Runtime.evaluate', {
        expression: evalCode,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true
    });

    verboseLog('Schließe WebSocket-Verbindung...');
    ws.close();

    const outputData = JSON.parse(evalResult?.result?.value || '{}');

    if (outputData.success) {
        verboseLog('Ausführung erfolgreich beendet.');
        if (isJsonOutput) {
            console.log(JSON.stringify({ success: true, output: outputData.text }, null, 2));
        } else {
            process.stdout.write(outputData.text + '\n');
        }
    } else {
        verboseLog(`Ausführungsfehler: ${outputData.error}`);
        if (isJsonOutput) {
            console.error(JSON.stringify({ success: false, error: outputData.error, availability: outputData.availability }, null, 2));
        } else {
            console.error(`[chaipi Fehler] ${outputData.error}`);
        }
        process.exit(2);
    }
}

run().catch((err) => {
    verboseLog(`Fataler Ausnahmefehler: ${err.stack || err.message}`);
    console.error(`[chaipi Fatal] ${err.message}`);
    process.exit(1);
}).finally(() => {
    cleanup();
});
