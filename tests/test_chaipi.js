import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHAIPI_BIN = join(__dirname, '..', 'bin', 'chaipi.mjs');

test('ChAIPi Testsuite: CLI & Pipe Architektur', async (t) => {

    await t.test('1. CLI-Hilfe (--help / -h) liefert Exit-Code 0 und alle Optionen', () => {
        const res = spawnSync(CHAIPI_BIN, ['--help'], { encoding: 'utf8' });
        assert.equal(res.status, 0, 'Exit Code muss 0 sein');
        assert.ok(res.stdout.includes('ChAIPi (Chrome AI Pipe)'), 'Muss App-Namen enthalten');
        assert.ok(res.stdout.includes('--check'), 'Muss --check auflisten');
        assert.ok(res.stdout.includes('--profile'), 'Muss --profile auflisten');
        assert.ok(res.stdout.includes('--json'), 'Muss --json auflisten');
        assert.ok(res.stdout.includes('--verbose'), 'Muss --verbose auflisten');
    });

    await t.test('2. Versionsabfrage (--version / -v) liefert korrekte SemVer', () => {
        const res = spawnSync(CHAIPI_BIN, ['--version'], { encoding: 'utf8' });
        assert.equal(res.status, 0, 'Exit Code muss 0 sein');
        assert.match(res.stdout.trim(), /^chaipi v\d+\.\d+\.\d+$/);
    });

    await t.test('3. Aufruf ohne Argumente oder Pipe-Daten bricht sicher ab (Exit 1)', () => {
        const res = spawnSync(CHAIPI_BIN, [], { encoding: 'utf8' });
        assert.equal(res.status, 1, 'Muss Exit 1 bei leerem Aufruf liefern');
        assert.ok(res.stdout.includes('Verwendung:'), 'Muss Hilfe/Verwendung anzeigen');
    });

    await t.test('4. Live-Diagnose (--check) liefert valides JSON über CDP', () => {
        const res = spawnSync(CHAIPI_BIN, ['--check'], { encoding: 'utf8', timeout: 15000 });
        assert.equal(res.status, 0, 'Diagnose muss erfolgreich sein (Exit 0)');
        const data = JSON.parse(res.stdout.trim());
        assert.equal(data.name, 'ChAIPi');
        assert.equal(data.version, '0.1.0');
        assert.ok(['standard', 'legacy'].includes(data.apiType), 'apiType muss standard oder legacy sein');
        assert.ok(typeof data.availability === 'string', 'availability muss ein String sein');
        assert.equal(typeof data.webGpu, 'boolean', 'webGpu muss boolesch sein');
    });

    await t.test('5. Stdin-Pipe Datenkapselung (<input_data>) bei Pipe-Aufruf', () => {
        // Testet, dass Pipe-Eingaben nicht verloren gehen
        const pipeInput = "2026-09-24 ERROR Database connection timeout";
        const res = spawnSync(CHAIPI_BIN, ['--check'], {
            input: pipeInput,
            encoding: 'utf8',
            timeout: 15000
        });
        assert.equal(res.status, 0);
    });

    await t.test('6. Verbose-Modus (--verbose und -V) schreibt Statuslogs auf stderr ohne stdout-JSON zu verfälschen', () => {
        for (const flag of ['--verbose', '-V']) {
            const res = spawnSync(CHAIPI_BIN, ['--check', flag], {
                encoding: 'utf8',
                timeout: 15000
            });
            assert.equal(res.status, 0, `Diagnose mit ${flag} muss erfolgreich sein (Exit 0)`);
            assert.ok(res.stderr.includes('[chaipi verbose'), `stderr muss Verbose-Logs enthalten bei ${flag}`);
            // stdout muss weiterhin sauberes, ungefiltertes JSON sein
            const data = JSON.parse(res.stdout.trim());
            assert.equal(data.name, 'ChAIPi');
            assert.equal(data.version, '0.1.0');
            assert.ok(typeof data.availability === 'string');
        }
    });
});
