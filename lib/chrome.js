import { execSync } from 'node:child_process';
import { existsSync, symlinkSync, readFileSync, writeFileSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILE_DIR } from './constants.js';

/**
 * Ermittelt den Pfad zur Chrome/Chromium-Binärdatei auf dem Host-System.
 * @returns {string}
 */
export function findChromeExecutable() {
    if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
        return process.env.CHROME_BIN;
    }
    if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }

    const osPlatform = platform();
    const candidateBinaries = [];

    if (osPlatform === 'linux') {
        candidateBinaries.push(
            'google-chrome-stable',
            'google-chrome',
            'chromium',
            'chromium-browser'
        );
        const fixedPaths = [
            '/opt/google/chrome/chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        ];
        for (const fp of fixedPaths) {
            if (existsSync(fp)) return fp;
        }
    } else if (osPlatform === 'darwin') {
        const macPaths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ];
        for (const mp of macPaths) {
            if (existsSync(mp)) return mp;
        }
        candidateBinaries.push('google-chrome', 'chromium');
    } else if (osPlatform === 'win32') {
        const winPaths = [
            join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
            join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
            join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
        ];
        for (const wp of winPaths) {
            if (existsSync(wp)) return wp;
        }
        candidateBinaries.push('chrome.exe');
    }

    for (const bin of candidateBinaries) {
        try {
            const checkCmd = osPlatform === 'win32' ? `where ${bin}` : `which ${bin}`;
            const resolved = execSync(checkCmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim().split('\n')[0];
            if (resolved && existsSync(resolved)) {
                return resolved;
            }
        } catch (e) {}
    }

    throw new Error(
        'Kein unterstützter Chrome- oder Chromium-Browser gefunden. ' +
        'Bitte installiere Google Chrome (Version 128+) oder setze die Umgebungsvariable CHROME_BIN.'
    );
}

/**
 * Erkennt vorhandene Gemini Nano Modellgewichte im regulären Browser-Profil
 * und verlinkt diese in das ChAIPi-Profilverzeichnis.
 * @param {string} profileDir 
 * @param {Function} [logger] 
 * @returns {boolean}
 */
export function seedExistingModelIfAvailable(profileDir, logger = () => {}) {
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
                const targetOptGuideDir = join(profileDir, 'OptGuideOnDeviceModel');
                if (!existsSync(targetOptGuideDir)) {
                    symlinkSync(optGuideDir, targetOptGuideDir);
                    logger(`Bestehendes On-Device Modell erkannt und verlinkt von: ${optGuideDir}`);
                }

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
                logger('Lokale Modell-Registrierung erfolgreich übernommen (kein Download erforderlich).');
                return true;
            } catch (e) {
                logger(`Hinweis beim Übernehmen des bestehenden Modells: ${e.message}`);
            }
        }
    }
    return false;
}

/**
 * Bereinigt verwaiste SingletonLock-Symlinks und zugehörige Sockets im Profilverzeichnis.
 * @param {string} profileDir 
 * @param {Function} [logger] 
 */
export function cleanStaleSingletonLock(profileDir, logger = () => {}) {
    if (!profileDir) return;
    const lockPath = join(profileDir, 'SingletonLock');
    let isLink = false;
    try {
        isLink = lstatSync(lockPath).isSymbolicLink();
    } catch (e) {
        return;
    }

    if (isLink) {
        try {
            const linkTarget = readlinkSync(lockPath);
            const match = linkTarget.match(/-(\d+)$/);
            if (match) {
                const pid = parseInt(match[1], 10);
                try {
                    process.kill(pid, 0);
                    if (profileDir === DEFAULT_PROFILE_DIR) {
                        try { process.kill(pid, 'SIGKILL'); } catch (err) {}
                    } else {
                        return;
                    }
                } catch (e) {
                    // Prozess existiert nicht mehr
                }
            }
            try { unlinkSync(lockPath); } catch (e) {}
            const cookiePath = join(profileDir, 'SingletonCookie');
            const sockPath = join(profileDir, 'SingletonSocket');
            try { unlinkSync(cookiePath); } catch (e) {}
            try { unlinkSync(sockPath); } catch (e) {}
            logger('Veralteter Chrome SingletonLock erfolgreich bereinigt.');
        } catch (e) {}
    }
}
