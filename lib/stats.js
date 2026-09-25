import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from './constants.js';

export const STATS_FILE = join(CACHE_DIR, 'stats.json');

/**
 * Lädt die persistierten Statistiken aus stats.json.
 * @param {string} [statsPath=STATS_FILE]
 * @returns {object}
 */
export function loadStats(statsPath = STATS_FILE) {
    if (!existsSync(statsPath)) {
        return {
            version: 1,
            totalRequests: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalSavedTokens: 0,
            history: [],
            daily: {}
        };
    }
    try {
        const raw = readFileSync(statsPath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return {
            version: 1,
            totalRequests: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalSavedTokens: 0,
            history: [],
            daily: {}
        };
    }
}

/**
 * Speichert Nutzungsdaten eines Requests persistent ab und aktualisiert gleitende Fenster.
 * @param {object} entry
 * @param {string} [statsPath=STATS_FILE]
 */
export function recordUsage(entry, statsPath = STATS_FILE) {
    const stats = loadStats(statsPath);
    const now = Date.now();
    const today = new Date(now).toISOString().split('T')[0];

    const pTok = Number(entry.promptTokens) || 0;
    const cTok = Number(entry.completionTokens) || 0;
    const dur = Number(entry.durationMs) || 0;
    const saved = Math.max(0, pTok - cTok);

    stats.totalRequests = (stats.totalRequests || 0) + 1;
    stats.totalPromptTokens = (stats.totalPromptTokens || 0) + pTok;
    stats.totalCompletionTokens = (stats.totalCompletionTokens || 0) + cTok;
    stats.totalSavedTokens = (stats.totalSavedTokens || 0) + saved;

    if (!Array.isArray(stats.history)) {
        stats.history = [];
    }
    stats.history.push({ ts: now, pTok, cTok, dur });

    // History auf die letzten 200 Einträge oder 24 Stunden begrenzen
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    stats.history = stats.history.filter(h => h.ts > oneDayAgo).slice(-200);

    // Tägliches Tracking
    stats.daily = stats.daily || {};
    if (!stats.daily[today]) {
        stats.daily[today] = { requests: 0, promptTokens: 0, completionTokens: 0, savedTokens: 0 };
    }
    stats.daily[today].requests += 1;
    stats.daily[today].promptTokens += pTok;
    stats.daily[today].completionTokens += cTok;
    stats.daily[today].savedTokens += saved;

    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(statsPath, JSON.stringify(stats, null, 2));
    } catch (e) {}

    return stats;
}

/**
 * Berechnet abgeleitete Echtzeit-Kennzahlen (RPM, TPM, RPD, Durchschnittsgeschwindigkeit).
 * @param {object} [stats]
 * @param {number} [now=Date.now()]
 * @returns {object}
 */
export function computeStatsMetrics(stats = loadStats(), now = Date.now()) {
    const today = new Date(now).toISOString().split('T')[0];
    const history = Array.isArray(stats.history) ? stats.history : [];

    // Gleitendes 60-Sekunden-Fenster für RPM und TPM
    const sixtySecsAgo = now - 60 * 1000;
    const recentRequests = history.filter(h => h.ts >= sixtySecsAgo);

    const rpm = recentRequests.length;
    const tpm = recentRequests.reduce((sum, h) => sum + (h.pTok + h.cTok), 0);

    // RPD (Requests Per Day) für den heutigen Tag
    const todayStats = (stats.daily && stats.daily[today]) || {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        savedTokens: 0
    };

    // Durchschnittliche Generierungsgeschwindigkeit (Tok/s) der letzten Anfragen
    let totalOutputTokens = 0;
    let totalDurationMs = 0;
    for (const req of history.slice(-20)) {
        if (req.cTok > 0 && req.dur > 0) {
            totalOutputTokens += req.cTok;
            totalDurationMs += req.dur;
        }
    }
    const avgTokPerSec = totalDurationMs > 0 
        ? Math.round((totalOutputTokens / (totalDurationMs / 1000)) * 10) / 10 
        : 0;

    return {
        rpm,
        tpm,
        rpd: todayStats.requests,
        todayPromptTokens: todayStats.promptTokens,
        todayCompletionTokens: todayStats.completionTokens,
        todaySavedTokens: todayStats.savedTokens,
        totalRequests: stats.totalRequests || 0,
        totalSavedTokens: stats.totalSavedTokens || 0,
        avgTokPerSec
    };
}

/**
 * Erzeugt eine kompakte Statuszeile für --stats.
 * @param {object} usage 
 * @returns {string}
 */
export function formatStatsLine(usage) {
    const pTok = usage.promptTokens ?? 0;
    const cTok = usage.completionTokens ?? 0;
    const tot = usage.totalTokens ?? (pTok + cTok);
    const win = usage.contextWindow ?? 9216;
    const pct = win > 0 ? ((tot / win) * 100).toFixed(1) : 0;
    const dur = usage.durationMs ?? 0;
    const tokPerSec = usage.tokPerSec ?? (dur > 0 ? ((cTok / (dur / 1000))).toFixed(1) : 0);

    return `[chaipi stats] Prompt: ${pTok} Tok | Output: ${cTok} Tok | Kontext: ${tot}/${win} (${pct}%) | Zeit: ${dur}ms (${tokPerSec} Tok/s)`;
}
