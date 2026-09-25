import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Erstellt eine minimale HTML-Datei im Profilverzeichnis, um einen sicheren,
 * nicht-opaquen Kontext (file://) für die WICG Prompt API bereitzustellen.
 * @param {string} profileDir 
 * @returns {string} Absoluter Pfad zur HTML-Datei
 */
export function ensureRuntimeHtml(profileDir) {
    const runtimeHtmlPath = join(profileDir, 'chaipi-runtime.html');
    if (!existsSync(runtimeHtmlPath)) {
        writeFileSync(
            runtimeHtmlPath,
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ChAIPi Runtime</title></head><body>ChAIPi On-Device AI Runtime</body></html>\n'
        );
    }
    return runtimeHtmlPath;
}
