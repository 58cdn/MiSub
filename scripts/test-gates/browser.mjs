import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    identity,
    inventory,
    readManifest,
    root,
    runProcess,
    sameFiles,
    scriptFiles,
    writeSummary,
} from './common.mjs';

export function validateBrowserReport(entry, report) {
    assert.ok(
        report && typeof report === 'object' && !Array.isArray(report),
        'Missing browser report'
    );
    assert.ok(!report.failure, 'Browser report contains failure');
    for (const field of entry.errors)
        assert.deepEqual(report[field], [], `Browser ${field} is not empty`);
    const cases = report[entry.cases];
    assert.ok(Array.isArray(cases) && cases.length > 0, 'Zero browser scenarios');
    assert.equal(
        new Set(cases.map((item) => JSON.stringify(item))).size,
        cases.length,
        'Duplicate browser scenarios'
    );
    if (entry.passed) assert.equal(report.passed, true, 'Browser success marker missing');
    if (entry.cases === 'tests') {
        assert.ok(
            cases.every((item) => typeof item === 'string' && item.length > 0),
            'Invalid browser scenario labels'
        );
        assert.ok(
            Array.isArray(report.overflow) && report.overflow.length > 0,
            'Missing browser layout results'
        );
        for (const layout of report.overflow)
            assert.deepEqual(layout.elements, [], 'Browser overflow');
    }
    if (entry.cases === 'layouts')
        for (const layout of cases) assert.deepEqual(layout.bad, [], 'Browser layout overflow');
    return cases.length;
}

export async function runBrowserEntry(entry, evidence, { base = root, execute = runProcess } = {}) {
    // Every invocation gets a new directory; an old success report cannot satisfy this run.
    const directory = await mkdtemp(resolve(evidence, 'entry-'));
    await execute([resolve(base, entry.file), directory], { cwd: base });
    const result = JSON.parse(await readFile(resolve(directory, entry.report), 'utf8'));
    return { file: entry.file, reportedScenarios: validateBrowserReport(entry, result) };
}

async function main() {
    assert.ok(
        process.argv.length <= 3,
        'Usage: node scripts/test-gates/browser.mjs [summary.json]'
    );
    const path = resolve(process.argv[2] || 'tmp/test-gates/browser-summary.json');
    const report = {
        lane: 'probe-browser',
        ...identity(),
        passed: false,
        expected: [],
        discovered: [],
        attempted: [],
        completed: [],
        failed: [],
        unrun: [],
        results: [],
    };
    try {
        const manifest = await readManifest();
        report.expected = Array.isArray(manifest.browser)
            ? manifest.browser.map((entry) => entry?.file)
            : [];
        report.discovered = (await scriptFiles('tests/browser')).filter(
            (file) => !manifest.helpers?.includes(file)
        );
        await inventory(root, manifest);
        await mkdir(resolve(root, 'tmp/test-gates'), { recursive: true });
        const evidence = await mkdtemp(resolve(root, 'tmp/test-gates/browser-'));
        for (const entry of manifest.browser) {
            report.attempted.push(entry.file);
            report.results.push(await runBrowserEntry(entry, evidence));
            report.completed.push(entry.file);
        }
        sameFiles(report.expected, report.completed, 'Completed browser entries');
        report.passed = true;
    } catch (error) {
        report.error = error.message;
        process.exitCode = 1;
    } finally {
        report.failed = report.attempted.filter((file) => !report.completed.includes(file));
        report.unrun = report.expected.filter((file) => !report.attempted.includes(file));
        await writeSummary(path, report);
        console.log(JSON.stringify(report));
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
