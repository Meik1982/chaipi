import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 
    VERSION, CACHE_DIR, DEFAULT_PROFILE_DIR, 
    SOCKET_PATH, PID_PATH, DAEMON_LOG_PATH, 
    DEFAULT_IDLE_TIMEOUT_MS 
} from './constants.js';
import { findChromeExecutable, cleanStaleSingletonLock, seedExistingModelIfAvailable } from './chrome.js';
import { ensureRuntimeHtml } from './bridge.js';
import { waitForCdpEndpoint, sendCdpCommand } from './cdp.js';
import { recordUsage, computeStatsMetrics } from './stats.js';

/**
 * Sendet eine JSON-Anfrage an den Unix Domain Socket des Daemons.
 * @param {object} payload 
 * @param {number} [timeoutMs=2500] 
 * @returns {Promise<any>}
 */
export function queryDaemonSocket(payload, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        if (!existsSync(SOCKET_PATH)) {
            return reject(new Error('Daemon Socket existiert nicht.'));
        }

        const client = net.createConnection(SOCKET_PATH);
        let buffer = '';
        let timer = setTimeout(() => {
            client.destroy();
            reject(new Error(`Timeout beim Warten auf Daemon-Antwort (${timeoutMs}ms).`));
        }, timeoutMs);

        client.on('connect', () => {
            client.write(JSON.stringify(payload) + '\n');
        });

        client.on('data', (chunk) => {
            buffer += chunk.toString();
            if (buffer.includes('\n')) {
                clearTimeout(timer);
                try {
                    const parsed = JSON.parse(buffer.trim().split('\n')[0]);
                    client.end();
                    resolve(parsed);
                } catch (e) {
                    client.end();
                    reject(new Error(`Ungültige Daemon-Antwort: ${buffer}`));
                }
            }
        });

        client.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Behandelt CLI-Verwaltungsbefehle für den Daemon (start, stop, status, run, worker).
 * @param {string} action 
 * @param {boolean} isJson 
 * @param {object} [options={}] 
 */
export async function handleDaemonCommand(action, isJson, options = {}) {
    if (action === 'start') {
        try {
            const status = await queryDaemonSocket({ action: 'status' }, 1000);
            if (status && status.success) {
                console.log(`ChAIPi Daemon läuft bereits (PID: ${status.pid}, Socket: ${SOCKET_PATH}).`);
                process.exit(0);
            }
        } catch (e) {}

        if (existsSync(SOCKET_PATH)) {
            try { unlinkSync(SOCKET_PATH); } catch (e) {}
        }
        if (existsSync(PID_PATH)) {
            try { unlinkSync(PID_PATH); } catch (e) {}
        }

        mkdirSync(CACHE_DIR, { recursive: true });
        const logFd = openSync(DAEMON_LOG_PATH, 'a');

        const cliScript = options.cliScript || fileURLToPath(new URL('../bin/chaipi.mjs', import.meta.url));
        const child = spawn(process.execPath, [cliScript, '--daemon-worker'], {
            detached: true,
            stdio: ['ignore', logFd, logFd]
        });
        child.unref();

        for (let i = 0; i < 75; i++) {
            await new Promise(r => setTimeout(r, 200));
            try {
                const status = await queryDaemonSocket({ action: 'status' }, 500);
                if (status && status.success) {
                    console.log(`ChAIPi Daemon erfolgreich im Hintergrund gestartet (PID: ${status.pid}, Socket: ${SOCKET_PATH}).`);
                    process.exit(0);
                }
            } catch (e) {}
        }

        console.error('[chaipi Fehler] Daemon-Start hat das Zeitlimit von 15s überschritten. Logs in ' + DAEMON_LOG_PATH);
        process.exit(1);
    } else if (action === 'stop') {
        let stopped = false;
        try {
            const res = await queryDaemonSocket({ action: 'stop' }, 2000);
            if (res && res.success) {
                stopped = true;
            }
        } catch (e) {}

        if (!stopped && existsSync(PID_PATH)) {
            try {
                const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
                if (!isNaN(pid)) {
                    process.kill(pid, 'SIGTERM');
                    stopped = true;
                }
            } catch (e) {}
        }

        for (let i = 0; i < 20; i++) {
            if (!existsSync(SOCKET_PATH) && !existsSync(PID_PATH)) break;
            await new Promise(r => setTimeout(r, 100));
        }
        if (existsSync(SOCKET_PATH)) { try { unlinkSync(SOCKET_PATH); } catch (e) {} }
        if (existsSync(PID_PATH)) { try { unlinkSync(PID_PATH); } catch (e) {} }

        if (stopped) {
            console.log('ChAIPi Daemon wurde beendet.');
        } else {
            console.log('ChAIPi Daemon läuft nicht.');
        }
        process.exit(0);
    } else if (action === 'status') {
        try {
            const status = await queryDaemonSocket({ action: 'status' }, 1500);
            if (status && status.success) {
                if (isJson) {
                    console.log(JSON.stringify({
                        success: true,
                        data: {
                            running: true,
                            pid: status.pid,
                            uptime: Math.round(status.uptime),
                            availability: status.availability,
                            socket: SOCKET_PATH
                        }
                    }, null, 2));
                } else {
                    console.log(`ChAIPi Daemon ist aktiv.
  PID:          ${status.pid}
  Uptime:       ${Math.round(status.uptime)}s
  Modell:       Gemini Nano (${status.availability})
  Socket:       ${SOCKET_PATH}`);
                }
                process.exit(0);
            }
        } catch (e) {}

        if (isJson) {
            console.log(JSON.stringify({
                success: true,
                data: {
                    running: false
                }
            }, null, 2));
        } else {
            console.log('ChAIPi Daemon läuft nicht.');
        }
        process.exit(0);
    } else if (action === 'run' || action === 'worker') {
        await runDaemonWorker(options);
    } else {
        console.error(`Unbekannte Daemon-Aktion: ${action}. Erlaubt: start, stop, status, run`);
        process.exit(1);
    }
}

/**
 * Führt den langlebigen Daemon-Worker aus, startet Headless-Chrome,
 * initialisiert CDP und stellt den Unix Domain Socket bereit.
 * @param {object} [options={}]
 */
export async function runDaemonWorker(options = {}) {
    mkdirSync(CACHE_DIR, { recursive: true });
    mkdirSync(DEFAULT_PROFILE_DIR, { recursive: true });

    const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;

    if (existsSync(SOCKET_PATH)) {
        try {
            const status = await queryDaemonSocket({ action: 'status' }, 500);
            if (status && status.success) {
                console.error(`Daemon läuft bereits (PID: ${status.pid}). Abbruch.`);
                process.exit(1);
            }
        } catch (e) {
            try { unlinkSync(SOCKET_PATH); } catch (err) {}
        }
    }

    writeFileSync(PID_PATH, String(process.pid));

    let chromeProc = null;
    let ws = null;
    let cachedAvailability = 'unknown';
    let server = null;
    let activeStreamClient = null;
    let idleTimer = null;

    function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleTimeoutMs > 0) {
            idleTimer = setTimeout(() => {
                console.error(`[chaipi Daemon] Inaktivitäts-Timeout (${Math.round(idleTimeoutMs / 60000)}m) erreicht. Beende Daemon sauber...`);
                cleanupDaemon();
                process.exit(0);
            }, idleTimeoutMs);
        }
    }

    function cleanupDaemon() {
        if (idleTimer) clearTimeout(idleTimer);
        if (ws && ws.readyState === 1) {
            try {
                ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
            } catch (e) {}
        }
        if (chromeProc) {
            try { chromeProc.kill('SIGTERM'); } catch (e) {}
        }
        if (server) {
            try { server.close(); } catch (e) {}
        }
        if (existsSync(SOCKET_PATH)) {
            try { unlinkSync(SOCKET_PATH); } catch (e) {}
        }
        if (existsSync(PID_PATH)) {
            try { unlinkSync(PID_PATH); } catch (e) {}
        }
    }

    process.on('SIGINT', () => { cleanupDaemon(); process.exit(0); });
    process.on('SIGTERM', () => { cleanupDaemon(); process.exit(0); });

    try {
        seedExistingModelIfAvailable(DEFAULT_PROFILE_DIR);
        const runtimeHtmlPath = ensureRuntimeHtml(DEFAULT_PROFILE_DIR);
        const targetUrl = `file://${runtimeHtmlPath}`;
        const remoteDebuggingPort = 9400 + Math.floor(Math.random() * 500);

        const chromeFlags = [
            '--headless=new',
            `--remote-debugging-port=${remoteDebuggingPort}`,
            `--user-data-dir=${DEFAULT_PROFILE_DIR}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-translate',
            '--enable-features=PromptAPIForGeminiNano:bypass_perf_requirement/true,OptimizationGuideModelDownloading',
            '--optimization-guide-on-device-model-execution-override',
            '--enable-unsafe-webgpu',
            targetUrl
        ];

        const chromeExe = findChromeExecutable();
        cleanStaleSingletonLock(DEFAULT_PROFILE_DIR);
        chromeProc = spawn(chromeExe, chromeFlags, {
            stdio: ['ignore', 'ignore', 'ignore']
        });

        await waitForCdpEndpoint(remoteDebuggingPort);
        const tabsRes = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
        const tabs = await tabsRes.json();
        const pageTab = tabs.find(t => t.type === 'page') || tabs[0];
        if (!pageTab || !pageTab.webSocketDebuggerUrl) {
            cleanupDaemon();
            throw new Error('Kein Page-Target in Chrome gefunden.');
        }

        ws = new WebSocket(pageTab.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve);
            ws.addEventListener('error', reject);
        });

        // CDP Event-Listener für Streaming-Events aus der Browser-Konsole
        ws.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.method === 'Runtime.consoleAPICalled') {
                    const firstVal = data.params?.args?.[0]?.value;
                    if (typeof firstVal === 'string' && firstVal.startsWith('{"__chaipi_event":')) {
                        const evt = JSON.parse(firstVal);
                        if (evt.__chaipi_event === 'stream_delta' && activeStreamClient) {
                            try {
                                activeStreamClient.write(JSON.stringify({ type: 'delta', delta: evt.delta }) + '\n');
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {}
        });

        await sendCdpCommand(ws, 'Runtime.enable');

        // Modell-Verfügbarkeit prüfen
        const checkEval = `(async () => {
            const getLm = () => {
                if (typeof LanguageModel !== 'undefined') return { api: LanguageModel, type: 'standard' };
                if (window.ai && window.ai.languageModel) return { api: window.ai.languageModel, type: 'legacy' };
                return null;
            };
            const entry = getLm();
            if (!entry) return 'unavailable';
            try {
                if (typeof entry.api.availability === 'function') return await entry.api.availability();
                if (typeof entry.api.capabilities === 'function') {
                    const caps = await entry.api.capabilities();
                    return caps.available || caps.readily || 'available';
                }
            } catch (e) { return 'error: ' + e.message; }
            return 'unknown';
        })()`;

        for (let i = 0; i < 20; i++) {
            try {
                const checkRes = await sendCdpCommand(ws, 'Runtime.evaluate', {
                    expression: checkEval,
                    awaitPromise: true,
                    returnByValue: true
                });
                cachedAvailability = checkRes?.result?.value || 'unknown';
                if (cachedAvailability !== 'unavailable' && !cachedAvailability.startsWith('error:')) {
                    break;
                }
            } catch (e) {
                cachedAvailability = 'unknown';
            }
            await new Promise(r => setTimeout(r, 100));
        }

        // Asynchrone Queue für serielle Prompt-Abarbeitung
        let requestQueue = Promise.resolve();
        function enqueue(task) {
            const next = requestQueue.then(task, task);
            requestQueue = next.catch(() => {});
            return next;
        }

        server = net.createServer((socket) => {
            let buffer = '';
            socket.on('data', (chunk) => {
                buffer += chunk.toString();
                if (buffer.includes('\n')) {
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        resetIdleTimer();

                        let req;
                        try {
                            req = JSON.parse(line.trim());
                        } catch (e) {
                            socket.write(JSON.stringify({ type: 'error', error: 'Invalid JSON' }) + '\n');
                            socket.end();
                            return;
                        }

                        if (req.action === 'status' || req.action === 'ping') {
                            socket.write(JSON.stringify({
                                type: 'status',
                                success: true,
                                pid: process.pid,
                                uptime: process.uptime(),
                                availability: cachedAvailability,
                                model: 'Gemini Nano',
                                socket: SOCKET_PATH
                            }) + '\n');
                            socket.end();
                        } else if (req.action === 'stats') {
                            socket.write(JSON.stringify({
                                type: 'stats',
                                success: true,
                                data: computeStatsMetrics()
                            }) + '\n');
                            socket.end();
                        } else if (req.action === 'stop') {
                            socket.write(JSON.stringify({ type: 'stopping', success: true }) + '\n');
                            socket.end();
                            setTimeout(() => {
                                cleanupDaemon();
                                process.exit(0);
                            }, 100);
                        } else if (req.action === 'prompt' || req.action === 'check') {
                            enqueue(async () => {
                                try {
                                    if (req.stream) {
                                        activeStreamClient = socket;
                                    }
                                    const result = await executePromptInWarmChrome(ws, req);
                                    if (result.success) {
                                        if (result.usage) {
                                            recordUsage(result.usage);
                                        }
                                        socket.write(JSON.stringify({
                                            type: 'result',
                                            success: true,
                                            text: result.text,
                                            streamed: result.streamed,
                                            usage: result.usage
                                        }) + '\n');
                                    } else {
                                        socket.write(JSON.stringify({
                                            type: 'error',
                                            success: false,
                                            error: result.error,
                                            availability: result.availability || cachedAvailability
                                        }) + '\n');
                                    }
                                } catch (err) {
                                    socket.write(JSON.stringify({
                                        type: 'error',
                                        success: false,
                                        error: err.message,
                                        availability: cachedAvailability
                                    }) + '\n');
                                } finally {
                                    activeStreamClient = null;
                                    socket.end();
                                    resetIdleTimer();
                                }
                            });
                        }
                    }
                }
            });
        });

        server.listen(SOCKET_PATH, () => {
            resetIdleTimer();
        });

        return new Promise(() => {});
    } catch (err) {
        console.error(`[chaipi Daemon Fatal] ${err.stack || err.message}`);
        cleanupDaemon();
        process.exit(1);
    }
}

/**
 * Führt einen Prompt oder Check innerhalb der bereits offenen CDP-Session aus.
 * @param {WebSocket} ws 
 * @param {object} req 
 * @returns {Promise<any>}
 */
export async function executePromptInWarmChrome(ws, req) {
    const isCheckOnly = req.action === 'check';
    const promptText = req.prompt || '';
    const customSystemPrompt = req.systemPrompt || null;
    const customTemperature = req.temperature !== undefined ? req.temperature : null;
    const customTopK = req.topK !== undefined ? req.topK : null;
    const isStreamOutput = Boolean(req.stream);

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

                const session = await lm.create(createOptions);
                const contextWindow = session.contextWindow || 9216;
                let promptTokens = 0;
                if (typeof session.measureContextUsage === 'function') {
                    try {
                        promptTokens = await session.measureContextUsage(${JSON.stringify(promptText)});
                    } catch (e) {}
                }

                if (${JSON.stringify(isStreamOutput)}) {
                    if (typeof session.promptStreaming === 'function') {
                        const stream = session.promptStreaming(${JSON.stringify(promptText)});
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

                const response = await session.prompt(${JSON.stringify(promptText)});
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

    const evalResult = await sendCdpCommand(ws, 'Runtime.evaluate', {
        expression: evalCode,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true
    });

    const outputData = JSON.parse(evalResult?.result?.value || '{}');
    return outputData;
}
