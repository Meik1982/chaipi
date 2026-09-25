/**
 * Chrome DevTools Protocol (CDP) WebSocket Helfer
 * Nutzt den nativen globalen WebSocket-Client von Node.js 22.
 */

/**
 * Wartet, bis der HTTP-Endpunkt von Headless-Chrome erreichbar ist.
 * @param {number} port 
 * @param {number} [maxRetries=50] 
 * @param {Function} [logger] 
 * @returns {Promise<string>} WebSocket-Debugger-URL
 */
export async function waitForCdpEndpoint(port, maxRetries = 50, logger = () => {}) {
    logger(`Warte auf CDP-Endpunkt unter http://127.0.0.1:${port}/json/version...`);
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) {
                const data = await res.json();
                logger(`CDP-Endpunkt bereit: Browser = ${data.Browser || 'Chrome'}`);
                return data.webSocketDebuggerUrl;
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Chrome DevTools Endpunkt auf Port ${port} antwortet nicht nach ${maxRetries * 100}ms.`);
}

/**
 * Sendet einen synchronen CDP-Befehl über die WebSocket-Verbindung.
 * @param {WebSocket} ws 
 * @param {string} method 
 * @param {object} [params={}] 
 * @returns {Promise<any>}
 */
export function sendCdpCommand(ws, method, params = {}) {
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

        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
            ws.removeEventListener('message', handleMsg);
            reject(err);
        }
    });
}
