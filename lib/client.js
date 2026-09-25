import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION, DEFAULT_PROFILE_DIR, SOCKET_PATH } from './constants.js';
import { findChromeExecutable, cleanStaleSingletonLock, seedExistingModelIfAvailable } from './chrome.js';
import { ensureRuntimeHtml } from './bridge.js';
import { waitForCdpEndpoint, sendCdpCommand } from './cdp.js';
import { recordUsage, formatStatsLine } from './stats.js';

/**
 * Versucht, eine Anfrage über den laufenden Daemon-Socket auszuführen.
 * @param {object} req 
 * @param {object} options 
 * @returns {Promise<any>}
 */
export function tryExecuteViaDaemon(req, options = {}) {
    return new Promise((resolve, reject) => {
        if (!existsSync(SOCKET_PATH)) {
            return reject(new Error('Daemon Socket existiert nicht.'));
        }

        const verboseLog = options.verboseLog || (() => {});
        const client = net.createConnection(SOCKET_PATH, () => {
            verboseLog('Mit laufendem ChAIPi Daemon verbunden. Sende Anfrage über IPC-Socket...');
            client.write(JSON.stringify(req) + '\n');
        });

        client.setTimeout(60000); // 60s Inferenz-Timeout
        let buffer = '';

        client.on('timeout', () => {
            client.destroy();
            reject(new Error('Timeout bei Kommunikation mit ChAIPi Daemon.'));
        });

        client.on('data', (chunk) => {
            buffer += chunk.toString();
            if (buffer.includes('\n')) {
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let msg;
                    try {
                        msg = JSON.parse(line.trim());
                    } catch (e) { continue; }

                    if (msg.type === 'delta') {
                        if (options.isStreamOutput && typeof msg.delta === 'string') {
                            process.stdout.write(msg.delta);
                        }
                    } else if (msg.type === 'result' || msg.type === 'error') {
                        client.destroy();
                        resolve(msg);
                        return;
                    }
                }
            }
        });

        client.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Führt den Prompt oder Check im Standalone-Modus aus (Headless Chrome starten & beenden).
 * @param {object} options 
 */
export async function runStandalone(options) {
    const {
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
        verboseLog = () => {},
        verboseProgress = () => {}
    } = options;

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

    seedExistingModelIfAvailable(activeProfileDir, verboseLog);
    const runtimeHtmlPath = ensureRuntimeHtml(activeProfileDir);
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
    let activeWs = null;

    function cleanup() {
        if (activeWs && activeWs.readyState === 1) {
            try {
                verboseLog('Sende CDP-Befehl Browser.close für sauberen Shutdown...');
                activeWs.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
            } catch (e) {}
        }
        if (chromeProc) {
            try { chromeProc.kill('SIGTERM'); } catch (e) {}
            chromeProc = null;
        }
        if (createdTempDir && existsSync(createdTempDir)) {
            try {
                verboseLog(`Lösche temporäres Profilverzeichnis: ${createdTempDir}`);
                rmSync(createdTempDir, { recursive: true, force: true });
            } catch (e) {}
        }
    }

    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGPIPE', () => { cleanup(); process.exit(0); });

    try {
        const chromeExe = findChromeExecutable();
        cleanStaleSingletonLock(activeProfileDir, verboseLog);
        verboseLog(`Starte Chrome-Subprozess (${chromeExe})...`);
        chromeProc = spawn(chromeExe, chromeFlags, {
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

        await waitForCdpEndpoint(remoteDebuggingPort, 50, verboseLog);

        verboseLog('Rufe aktive Tabs/Targets von Chrome ab...');
        const tabsRes = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
        const tabs = await tabsRes.json();
        const pageTab = tabs.find(t => t.type === 'page') || tabs[0];

        if (!pageTab || !pageTab.webSocketDebuggerUrl) {
            throw new Error('Kein Page-Target in Chrome gefunden.');
        }

        verboseLog(`Verbinde WebSocket zu Page-Target (URL: ${pageTab.url || targetUrl})...`);
        const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
        activeWs = ws;
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve);
            ws.addEventListener('error', reject);
        });
        verboseLog('WebSocket-Verbindung erfolgreich aufgebaut.');

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
                        } else if (evt.__chaipi_event === 'stream_delta') {
                            if (isStreamOutput && typeof evt.delta === 'string') {
                                process.stdout.write(evt.delta);
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
                    const startTime = Date.now();
                    console.log(JSON.stringify({
                        __chaipi_event: 'create_start',
                        availability: availability
                    }));

                    const createOptions = {};
                    if (${JSON.stringify(customSystemPrompt !== null)}) {
                        createOptions.systemPrompt = ${JSON.stringify(customSystemPrompt)};
                        createOptions.initialPrompts = [{ role: 'system', content: ${JSON.stringify(customSystemPrompt)} }];
                    }
                    if (${JSON.stringify(customTemperature !== null)}) {
                        createOptions.temperature = ${Number(customTemperature)};
                    }
                    if (${JSON.stringify(customTopK !== null)}) {
                        createOptions.topK = ${Number(customTopK)};
                    }

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

                    const contextWindow = session.contextWindow || 9216;
                    let promptTokens = 0;
                    if (typeof session.measureContextUsage === 'function') {
                        try {
                            promptTokens = await session.measureContextUsage(${JSON.stringify(finalPrompt)});
                        } catch (e) {}
                    }

                    console.log(JSON.stringify({ 
                        __chaipi_event: 'prompt_start', 
                        length: ${JSON.stringify(finalPrompt)}.length 
                    }));

                    if (${JSON.stringify(isStreamOutput)}) {
                        if (typeof session.promptStreaming === 'function') {
                            const stream = session.promptStreaming(${JSON.stringify(finalPrompt)});
                            let accumulated = '';
                            for await (const chunk of stream) {
                                if (typeof chunk === 'string') {
                                    let delta = '';
                                    if (chunk.startsWith(accumulated)) {
                                        delta = chunk.slice(accumulated.length);
                                        accumulated = chunk;
                                    } else {
                                        delta = chunk;
                                        accumulated += chunk;
                                    }
                                    console.log(JSON.stringify({ __chaipi_event: 'stream_delta', delta }));
                                }
                            }
                            console.log(JSON.stringify({ __chaipi_event: 'prompt_done' }));
                            const durationMs = Date.now() - startTime;
                            const totalTokens = session.contextUsage || promptTokens;
                            const completionTokens = Math.max(0, totalTokens - promptTokens);
                            const tokPerSec = durationMs > 0 ? Math.round((completionTokens / (durationMs / 1000)) * 10) / 10 : 0;
                            try { session.destroy(); } catch (e) {}
                            return JSON.stringify({
                                success: true,
                                text: '',
                                streamed: true,
                                usage: { promptTokens, completionTokens, totalTokens, contextWindow, durationMs, tokPerSec }
                            });
                        }
                    }

                    const response = await session.prompt(${JSON.stringify(finalPrompt)});
                    console.log(JSON.stringify({ __chaipi_event: 'prompt_done' }));
                    const durationMs = Date.now() - startTime;
                    const totalTokens = session.contextUsage || promptTokens;
                    const completionTokens = Math.max(0, totalTokens - promptTokens);
                    const tokPerSec = durationMs > 0 ? Math.round((completionTokens / (durationMs / 1000)) * 10) / 10 : 0;

                    try { session.destroy(); } catch (e) {}
                    return JSON.stringify({
                        success: true,
                        text: response,
                        usage: { promptTokens, completionTokens, totalTokens, contextWindow, durationMs, tokPerSec }
                    });
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
            if (outputData.usage) {
                recordUsage(outputData.usage);
            }
            if (outputData.streamed) {
                process.stdout.write('\n');
            } else if (isJsonOutput) {
                let parsedData = null;
                try { parsedData = JSON.parse(outputData.text); } catch (e) {}
                const jsonResp = {
                    success: true,
                    data: parsedData !== null ? parsedData : outputData.text
                };
                if (outputData.usage) {
                    jsonResp.usage = outputData.usage;
                }
                console.log(JSON.stringify(jsonResp, null, 2));
            } else {
                process.stdout.write(outputData.text + '\n');
            }

            if (isStatsOutput && outputData.usage) {
                process.stderr.write(formatStatsLine(outputData.usage) + '\n');
            }
        } else {
            verboseLog(`Ausführungsfehler: ${outputData.error}`);
            if (isJsonOutput) {
                console.error(JSON.stringify({ 
                    success: false, 
                    error: outputData.error, 
                    availability: outputData.availability 
                }, null, 2));
            } else {
                console.error(`[chaipi Fehler] ${outputData.error}`);
            }
            process.exit(2);
        }
    } finally {
        cleanup();
    }
}
