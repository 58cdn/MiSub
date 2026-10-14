import assert from 'node:assert/strict';
import { run } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    identity,
    inventory,
    readManifest,
    relativeFile,
    root,
    sameFiles,
    scriptFiles,
    writeSummary,
} from './common.mjs';

export function validateNodeSummaries(expected, summaries, base = root) {
    const files = summaries.filter((item) => item.file);
    const totals = summaries.filter((item) => !item.file);
    sameFiles(
        expected,
        files.map((item) => relativeFile(item.file, base)),
        'Completed Node entries'
    );
    assert.equal(totals.length, 1, 'Missing or duplicate cumulative Node summary');
    for (const item of summaries) {
        assert.equal(item.success, true, 'Node test run failed');
        assert.ok(Number.isInteger(item.counts?.tests) && item.counts.tests > 0, 'Zero Node tests');
        assert.equal(item.counts.passed, item.counts.tests, 'Node tests did not all pass');
        for (const key of ['failed', 'cancelled', 'skipped', 'todo'])
            assert.equal(item.counts[key], 0, `Node ${key} tests`);
    }
    for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']) {
        assert.equal(
            totals[0].counts[key],
            files.reduce((sum, file) => sum + file.counts[key], 0),
            `Node ${key} summary mismatch`
        );
    }
    return totals[0].counts;
}

export async function runNodeFiles(files, base = root, summaries = []) {
    for await (const event of run({
        files: files.map((file) => resolve(base, file)),
        isolation: 'process',
        concurrency: true,
        timeout: 120000,
    })) {
        if (event.type === 'test:summary') summaries.push(event.data);
        if (event.type === 'test:fail') console.error(event.data.name, event.data.details?.error);
    }
    return validateNodeSummaries(files, summaries, base);
}

async function main() {
    assert.ok(process.argv.length <= 3, 'Usage: node scripts/test-gates/node.mjs [summary.json]');
    const path = resolve(process.argv[2] || 'tmp/test-gates/node-summary.json');
    const report = {
        lane: 'probe-node',
        ...identity(),
        passed: false,
        expected: [],
        discovered: [],
        completed: [],
        unrun: [],
        counts: null,
    };
    const summaries = [];
    try {
        const manifest = await readManifest();
        report.expected = Array.isArray(manifest.node) ? manifest.node : [];
        report.discovered = (await scriptFiles('tests/probes')).filter(
            (file) => !manifest.helpers?.includes(file)
        );
        await inventory(root, manifest);
        report.counts = await runNodeFiles(report.expected, root, summaries);
        report.passed = true;
    } catch (error) {
        report.error = error.message;
        process.exitCode = 1;
    } finally {
        report.completed = summaries
            .filter((item) => item.file)
            .map((item) => relativeFile(item.file));
        report.unrun = report.expected.filter((file) => !report.completed.includes(file));
        report.files = summaries
            .filter((item) => item.file)
            .map((item) => ({
                file: relativeFile(item.file),
                success: item.success,
                counts: item.counts,
            }));
        await writeSummary(path, report);
        console.log(JSON.stringify(report));
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
