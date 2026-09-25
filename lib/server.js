import http from 'node:http';
import crypto from 'node:crypto';
import { VERSION, DEFAULT_HTTP_PORT, DEFAULT_HTTP_HOST, SOCKET_PATH } from './constants.js';
import { tryExecuteViaDaemon } from './client.js';
import { computeStatsMetrics } from './stats.js';

/**
 * Wandelt ein OpenAI-kompatibles messages-Array in { prompt, systemPrompt } um.
 * @param {Array<object>} messages 
 * @returns {{ prompt: string, systemPrompt: string|null }}
 */
export function formatOpenAiMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { prompt: '', systemPrompt: null };
    }

    const systemParts = [];
    const chatTurns = [];

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const role = (msg.role || 'user').toLowerCase();
        let content = '';
        if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            // Support für multimodale Content-Arrays (Text-Teile extrahieren)
            content = msg.content
                .filter(part => part && part.type === 'text' && typeof part.text === 'string')
                .map(part => part.text)
                .join('\n');
        } else if (msg.content !== undefined && msg.content !== null) {
            content = String(msg.content);
        }

        if (role === 'system') {
            systemParts.push(content);
        } else if (role === 'user' || role === 'assistant') {
            chatTurns.push({ role, content });
        }
    }

    const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : null;

    let prompt = '';
    if (chatTurns.length === 1 && chatTurns[0].role === 'user') {
        prompt = chatTurns[0].content;
    } else if (chatTurns.length > 1) {
        prompt = chatTurns.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
    } else if (chatTurns.length === 1) {
        prompt = chatTurns[0].content;
    }

    return { prompt, systemPrompt };
}

/**
 * Liest den gesamten HTTP-Body eines Requests.
 * @param {http.IncomingMessage} req 
 * @returns {Promise<string>}
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 10 * 1024 * 1024) { // 10 MB Schutzlimit
                req.destroy();
                reject(new Error('Payload too large (Limit: 10 MB)'));
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

/**
 * Sendet eine JSON-Antwort mit CORS-Headern.
 */
function sendJson(res, statusCode, data) {
    const jsonStr = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(jsonStr),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
    });
    res.end(jsonStr);
}

/**
 * Sendet einen standardisierten OpenAI-Fehler.
 */
function sendOpenAiError(res, statusCode, message, type = 'invalid_request_error') {
    sendJson(res, statusCode, {
        error: {
            message,
            type,
            param: null,
            code: statusCode
        }
    });
}

/**
 * Erstellt und startet den OpenAI-kompatiblen HTTP-Server.
 * @param {object} options 
 * @returns {Promise<{ server: http.Server, port: number, host: string, url: string, close: () => Promise<void> }>}
 */
export function startHttpServer(options = {}) {
    const port = Number(options.port || process.env.CHAIPI_PORT || DEFAULT_HTTP_PORT);
    const host = options.host || process.env.CHAIPI_HOST || DEFAULT_HTTP_HOST;
    const verboseLog = options.verbose ? (msg) => console.error(`[chaipi server] ${msg}`) : () => {};

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
        const pathname = urlObj.pathname;
        const method = (req.method || 'GET').toUpperCase();

        // 1. CORS Preflight
        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400'
            });
            res.end();
            return;
        }

        verboseLog(`${method} ${pathname}`);

        try {
            // 2. Health & Info Endpunkte
            if ((pathname === '/' || pathname === '/health') && method === 'GET') {
                return sendJson(res, 200, {
                    status: 'ok',
                    name: 'chaipi-openai-bridge',
                    version: VERSION,
                    backend: 'Chrome Prompt API (Gemini Nano)',
                    daemon_socket: SOCKET_PATH,
                    endpoints: [
                        '/v1/models',
                        '/v1/chat/completions',
                        '/v1/completions',
                        '/v1/stats'
                    ]
                });
            }

            // 3. Stats Endpunkt
            if ((pathname === '/v1/stats' || pathname === '/stats') && method === 'GET') {
                return sendJson(res, 200, {
                    success: true,
                    data: computeStatsMetrics()
                });
            }

            // 4. OpenAI Models Endpunkt
            if (pathname === '/v1/models' && method === 'GET') {
                const now = Math.floor(Date.now() / 1000);
                return sendJson(res, 200, {
                    object: 'list',
                    data: [
                        {
                            id: 'gemini-nano',
                            object: 'model',
                            created: now,
                            owned_by: 'google-chrome-wicg',
                            permission: [],
                            root: 'gemini-nano',
                            parent: null
                        },
                        {
                            id: 'chaipi',
                            object: 'model',
                            created: now,
                            owned_by: 'chaipi',
                            permission: [],
                            root: 'chaipi',
                            parent: null
                        }
                    ]
                });
            }

            // 5. OpenAI Chat Completions Endpunkt
            if (pathname === '/v1/chat/completions' && method === 'POST') {
                const rawBody = await readBody(req);
                let payload;
                try {
                    payload = JSON.parse(rawBody);
                } catch (e) {
                    return sendOpenAiError(res, 400, `Ungültiges JSON im Request Body: ${e.message}`);
                }

                const { prompt, systemPrompt } = formatOpenAiMessages(payload.messages);
                if (!prompt) {
                    return sendOpenAiError(res, 400, 'Parameter "messages" muss mindestens eine nicht-leere Benutzereingabe enthalten.');
                }

                const modelName = payload.model || 'gemini-nano';
                const isStream = Boolean(payload.stream);
                const temperature = typeof payload.temperature === 'number' ? payload.temperature : null;
                const topK = typeof payload.top_k === 'number' ? payload.top_k : null;

                const daemonReq = {
                    action: 'prompt',
                    prompt,
                    systemPrompt,
                    temperature,
                    topK,
                    stream: isStream
                };

                const completionId = 'chatcmpl-' + crypto.randomUUID();
                const createdTime = Math.floor(Date.now() / 1000);

                if (isStream) {
                    // Streaming Response via Server-Sent Events (SSE)
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache, no-transform',
                        'Connection': 'keep-alive',
                        'Access-Control-Allow-Origin': '*'
                    });

                    // Initialer Chunk mit Rollen-Deklaration
                    const initChunk = {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: createdTime,
                        model: modelName,
                        choices: [
                            {
                                index: 0,
                                delta: { role: 'assistant', content: '' },
                                finish_reason: null
                            }
                        ]
                    };
                    res.write(`data: ${JSON.stringify(initChunk)}\n\n`);

                    try {
                        const daemonRes = await tryExecuteViaDaemon(daemonReq, {
                            onDelta: (delta) => {
                                const chunk = {
                                    id: completionId,
                                    object: 'chat.completion.chunk',
                                    created: createdTime,
                                    model: modelName,
                                    choices: [
                                        {
                                            index: 0,
                                            delta: { content: delta },
                                            finish_reason: null
                                        }
                                    ]
                                };
                                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                            }
                        });

                        if (!daemonRes.success) {
                            const errChunk = {
                                id: completionId,
                                object: 'chat.completion.chunk',
                                created: createdTime,
                                model: modelName,
                                choices: [
                                    {
                                        index: 0,
                                        delta: { content: `\n[Fehler: ${daemonRes.error}]` },
                                        finish_reason: 'error'
                                    }
                                ]
                            };
                            res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
                        } else {
                            const finalChunk = {
                                id: completionId,
                                object: 'chat.completion.chunk',
                                created: createdTime,
                                model: modelName,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {},
                                        finish_reason: 'stop'
                                    }
                                ]
                            };
                            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                        }

                        res.write('data: [DONE]\n\n');
                        res.end();
                    } catch (err) {
                        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    return;
                }

                // Non-Streaming Response
                let daemonRes;
                try {
                    daemonRes = await tryExecuteViaDaemon(daemonReq);
                } catch (err) {
                    return sendOpenAiError(res, 503, `ChAIPi Daemon nicht erreichbar (${err.message}). Läuft 'systemctl --user status chaipi.service'?`, 'server_error');
                }

                if (!daemonRes.success) {
                    return sendOpenAiError(res, 500, daemonRes.error || 'Inferenzfehler im Chrome-Backend', 'server_error');
                }

                const responsePayload = {
                    id: completionId,
                    object: 'chat.completion',
                    created: createdTime,
                    model: modelName,
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: daemonRes.text
                            },
                            finish_reason: 'stop'
                        }
                    ],
                    usage: {
                        prompt_tokens: daemonRes.usage?.promptTokens || 0,
                        completion_tokens: daemonRes.usage?.completionTokens || 0,
                        total_tokens: daemonRes.usage?.totalTokens || 0
                    }
                };

                return sendJson(res, 200, responsePayload);
            }

            // 6. OpenAI Legacy Completions Endpunkt
            if (pathname === '/v1/completions' && method === 'POST') {
                const rawBody = await readBody(req);
                let payload;
                try {
                    payload = JSON.parse(rawBody);
                } catch (e) {
                    return sendOpenAiError(res, 400, `Ungültiges JSON im Request Body: ${e.message}`);
                }

                const prompt = typeof payload.prompt === 'string' ? payload.prompt : (Array.isArray(payload.prompt) ? payload.prompt.join('\n') : '');
                if (!prompt) {
                    return sendOpenAiError(res, 400, 'Parameter "prompt" darf nicht leer sein.');
                }

                const modelName = payload.model || 'gemini-nano';
                const completionId = 'cmpl-' + crypto.randomUUID();
                const createdTime = Math.floor(Date.now() / 1000);

                const daemonReq = {
                    action: 'prompt',
                    prompt,
                    systemPrompt: null,
                    temperature: payload.temperature || null,
                    topK: payload.top_k || null,
                    stream: false
                };

                let daemonRes;
                try {
                    daemonRes = await tryExecuteViaDaemon(daemonReq);
                } catch (err) {
                    return sendOpenAiError(res, 503, `ChAIPi Daemon nicht erreichbar (${err.message})`, 'server_error');
                }

                if (!daemonRes.success) {
                    return sendOpenAiError(res, 500, daemonRes.error || 'Inferenzfehler im Chrome-Backend', 'server_error');
                }

                return sendJson(res, 200, {
                    id: completionId,
                    object: 'text_completion',
                    created: createdTime,
                    model: modelName,
                    choices: [
                        {
                            text: daemonRes.text,
                            index: 0,
                            logprobs: null,
                            finish_reason: 'stop'
                        }
                    ],
                    usage: {
                        prompt_tokens: daemonRes.usage?.promptTokens || 0,
                        completion_tokens: daemonRes.usage?.completionTokens || 0,
                        total_tokens: daemonRes.usage?.totalTokens || 0
                    }
                });
            }

            // 7. Route nicht gefunden
            return sendOpenAiError(res, 404, `Endpunkt '${method} ${pathname}' existiert nicht. Verfügbar: /v1/models, /v1/chat/completions, /v1/completions, /v1/stats`);
        } catch (err) {
            verboseLog(`Unerwarteter Serverfehler: ${err.stack || err.message}`);
            return sendOpenAiError(res, 500, `Interner Serverfehler: ${err.message}`, 'server_error');
        }
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
            const url = `http://${host}:${port}`;
            resolve({
                server,
                port,
                host,
                url,
                close: () => new Promise((resClose) => server.close(resClose))
            });
        });
    });
}
