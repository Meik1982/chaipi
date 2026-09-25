#!/usr/bin/env node

/**
 * scripts/deploy.mjs
 * 
 * Sauberes Deployment-Skript für ChAIPi:
 * 1. Führt Quality Gate (Tests & Syntax-Checks) im Workspace aus.
 * 2. Synchronisiert stabilen Code isoliert nach ~/.local/share/chaipi (Production).
 * 3. Hängt System-Symlinks (~/.local/bin, ~/.hermes/scripts) auf Production um.
 * 4. Startet den systemd-User-Service neu und führt einen Health-Check aus.
 * 
 * Verhindert, dass unfertige Bearbeitungen im Workspace das System instabil hinterlassen.
 */

import { existsSync, mkdirSync, cpSync, chmodSync, unlinkSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const PROD_DIR = join(homedir(), '.local', 'share', 'chaipi');
const LOCAL_BIN = join(homedir(), '.local', 'bin');
const HERMES_SCRIPTS = join(homedir(), '.hermes', 'scripts');

console.log('🚀 ChAIPi Production Deployment Pipeline');
console.log('========================================');
console.log(`📁 Workspace:   ${ROOT_DIR}`);
console.log(`🎯 Production:  ${PROD_DIR}\n`);

// Schritt 1: Quality Gate (Tests & Lint)
console.log('🔍 Schritt 1: Führe Quality-Gates (npm test) aus...');
const testResult = spawnSync('npm', ['test'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env
});

if (testResult.status !== 0) {
    console.error('\n❌ DEPLOYMENT ABGEBROCHEN: Tests sind fehlgeschlagen!');
    console.error('Das laufende System bleibt unberührt auf dem letzten stabilen Stand.');
    process.exit(1);
}
console.log('✅ Alle Tests erfolgreich bestanden.\n');

// Schritt 2: Synchronisation in das Production-Verzeichnis
console.log(`📦 Schritt 2: Synchronisiere stabilen Stand nach ${PROD_DIR}...`);
mkdirSync(PROD_DIR, { recursive: true });

const filesToDeploy = ['bin', 'lib', 'package.json', 'README.md', 'LICENSE'];
for (const item of filesToDeploy) {
    const src = join(ROOT_DIR, item);
    const dest = join(PROD_DIR, item);
    if (existsSync(src)) {
        cpSync(src, dest, { recursive: true, force: true });
    }
}

// Ausführbarkeit sicherstellen
const binFile = join(PROD_DIR, 'bin', 'chaipi.mjs');
if (existsSync(binFile)) {
    chmodSync(binFile, 0o755);
}
console.log('✅ Dateien nach Production synchronisiert.\n');

// Schritt 3: System-Symlinks auf Production ausrichten
console.log('🔗 Schritt 3: Aktualisiere System-Symlinks...');
function updateSymlink(targetPath, linkPath) {
    try {
        if (existsSync(linkPath)) {
            unlinkSync(linkPath);
        }
        symlinkSync(targetPath, linkPath);
        console.log(`   ✓ ${linkPath} -> ${targetPath}`);
    } catch (err) {
        console.warn(`   ⚠ Konnte Symlink nicht setzen (${linkPath}): ${err.message}`);
    }
}

mkdirSync(LOCAL_BIN, { recursive: true });
mkdirSync(HERMES_SCRIPTS, { recursive: true });

updateSymlink(binFile, join(LOCAL_BIN, 'chaipi'));
updateSymlink(binFile, join(LOCAL_BIN, 'local-browser-ai'));
updateSymlink(binFile, join(HERMES_SCRIPTS, 'chaipi.mjs'));
updateSymlink(binFile, join(HERMES_SCRIPTS, 'local-browser-ai.mjs'));
console.log('✅ Symlinks verweisen nun isoliert auf Production.\n');

// Schritt 4: systemd Service neu starten
console.log('🔄 Schritt 4: Starte chaipi.service neu...');
const restartRes = spawnSync('systemctl', ['--user', 'restart', 'chaipi.service'], {
    stdio: 'inherit'
});

if (restartRes.status !== 0) {
    console.warn('⚠ Warnung: systemctl restart chaipi.service meldete Exit-Code ' + restartRes.status);
} else {
    console.log('✅ systemd chaipi.service erfolgreich neu gestartet.\n');
}

// Schritt 5: Health Check
console.log('🩺 Schritt 5: Warte auf Health-Check (http://127.0.0.1:8380/health)...');
let healthy = false;
for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
        healthy = await new Promise((resolve) => {
            const req = http.get('http://127.0.0.1:8380/health', (res) => {
                if (res.statusCode === 200) resolve(true);
                else resolve(false);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(500, () => {
                req.destroy();
                resolve(false);
            });
        });
        if (healthy) break;
    } catch (e) {}
}

if (healthy) {
    console.log('✅ Health-Check: HTTP 200 OK. ChAIPi ist einsatzbereit!\n');
    console.log('🎉 Deployment erfolgreich abgeschlossen!');
    console.log('   Dein Workspace ist nun 100% entkoppelt vom produktiven System.');
} else {
    console.warn('⚠ Health-Check hat nach 4s nicht geantwortet. Prüfe `systemctl --user status chaipi.service`.');
}
