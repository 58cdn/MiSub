import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const portable = (value) => value.split(sep).join('/');

export function sameFiles(expected, actual, label) {
    assert.ok(expected.length > 0, `${label}: empty expected set`);
    assert.equal(new Set(expected).size, expected.length, `${label}: duplicate expected entry`);
    assert.equal(new Set(actual).size, actual.length, `${label}: duplicate actual entry`);
    assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: file inventory mismatch`);
}

export async function scriptFiles(directory, base = root) {
    const files = [];
    for (const entry of await readdir(resolve(base, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        assert.ok(!entry.isSymbolicLink(), `Symbolic test entry is not supported: ${path}`);
        if (entry.isDirectory()) files.push(...(await scriptFiles(path, base)));
        else if (/\.(?:mjs|cjs|js|ts)$/.test(entry.name)) files.push(path);
    }
    return files.sort();
}

export async function readManifest(base = root) {
    return JSON.parse(await readFile(resolve(base, 'tests/acceptance-manifest.json'), 'utf8'));
}

export async function inventory(base = root, manifest) {
    manifest ??= await readManifest(base);
    assert.ok(Array.isArray(manifest.node) && manifest.node.length, 'Missing Node entries');
    assert.ok(
        Array.isArray(manifest.browser) && manifest.browser.length,
        'Missing browser entries'
    );
    assert.ok(Array.isArray(manifest.helpers), 'Missing helper inventory');
    for (const file of manifest.node) assert.match(file, /^tests\/probes\/[\w/-]+\.check\.mjs$/);
    for (const entry of manifest.browser) {
        assert.match(entry.file, /^tests\/browser\/[\w/-]+\.mjs$/);
        assert.match(entry.report, /^[\w-]+\.json$/);
        assert.ok(
            ['tests', 'layouts', 'cases'].includes(entry.cases),
            'Unknown browser report cases'
        );
        assert.ok(
            Array.isArray(entry.errors) && entry.errors.length > 0,
            'Missing browser error fields'
        );
    }
    for (const file of manifest.helpers) {
        assert.ok(!/\.(?:check|test|spec)\./.test(file), 'A test entry cannot be a helper');
        assert.match(file, /^tests\/(?:probes|browser)\/[\w/-]+\.(?:mjs|js|ts)$/);
    }
    const expected = [
        ...manifest.node,
        ...manifest.browser.map((entry) => entry.file),
        ...manifest.helpers,
    ];
    const actual = [
        ...(await scriptFiles('tests/probes', base)),
        ...(await scriptFiles('tests/browser', base)),
    ];
    sameFiles(expected, actual, 'Probe and browser scripts');
    return manifest;
}

export function identity(base = root) {
    const git = (args) => execFileSync('git', args, { cwd: base, encoding: 'utf8' }).trim();
    const head = git(['rev-parse', 'HEAD']);
    return {
        head,
        sourceHead: process.env.TEST_SOURCE_HEAD || head,
        dirty: !!git(['status', '--porcelain']),
        node: process.version,
    };
}

export async function writeSummary(path, report) {
    await mkdir(dirname(resolve(path)), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

export function runProcess(args, { cwd = root, timeout = 180000 } = {}) {
    return new Promise((resolveResult, reject) => {
        const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', shell: false });
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            child.kill();
        }, timeout);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (expired || signal || code !== 0)
                reject(
                    new Error(
                        `Test process failed: exit=${code}, signal=${signal}, timeout=${expired}`
                    )
                );
            else resolveResult();
        });
    });
}

export const relativeFile = (file, base = root) => portable(relative(base, file));
