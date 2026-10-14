import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    discoverExpectedTests,
    inspectVitestCompletion,
    inspectVitestDiscovery,
} from '../../scripts/test-gates/vitest-report.mjs';

const root = resolve('synthetic-vitest-checkout');
const expected = ['tests/unit/a.test.js', 'tests/unit/nested/b.spec.ts'];
const discoveries = (files = expected) => files.map((file) => ({ file: resolve(root, file) }));
const report = (files = expected) => ({
    success: true,
    numTotalTestSuites: 99,
    numFailedTestSuites: 0,
    numTotalTests: files.length,
    numPassedTests: files.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: files.map((file) => ({
        name: resolve(root, file),
        status: 'passed',
        message: '',
        assertionResults: [
            {
                title: 'synthetic assertion',
                fullName: `${file} synthetic assertion`,
                status: 'passed',
            },
        ],
    })),
});
const discoveryErrors = (value, inventory = expected) =>
    inspectVitestDiscovery(root, inventory, value).errors;
const completion = (value, inventory = expected) => inspectVitestCompletion(root, inventory, value);

test('inventory independently finds nested JS/TS tests and excludes scripts and helpers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vitest-inventory-test-'));
    try {
        await mkdir(join(directory, 'tests/unit/nested'), { recursive: true });
        for (const file of [
            ...expected,
            'tests/unit/helper.js',
            'tests/unit/contract.check.mjs',
            'tests/unit/nested/a.test.mjs',
        ]) {
            await writeFile(join(directory, file), '');
        }
        assert.deepEqual(await discoverExpectedTests(directory), expected);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('native Vitest discovery accepts only the exact independent inventory', () => {
    assert.deepEqual(inspectVitestDiscovery(root, expected, discoveries().reverse()), {
        discovered: expected,
        errors: [],
    });
});

test('discovery rejects empty, duplicate and malformed expected inventories', () => {
    for (const inventory of [[], null, [expected[0], expected[0]], ['tests/../a.test.js']]) {
        assert.ok(discoveryErrors(discoveries(), inventory).length > 0);
    }
});

test('discovery rejects empty or malformed native output', () => {
    for (const value of [[], null, {}, [null], [{ file: 2 }], [{ file: expected[0] }]]) {
        assert.ok(discoveryErrors(value).length > 0);
    }
});

test('discovery rejects missing, extra and duplicate files even when file counts match', () => {
    for (const value of [
        discoveries([expected[0]]),
        discoveries([expected[0], 'tests/unit/unexpected.test.js']),
        discoveries([expected[0], expected[0]]),
        [
            ...discoveries(),
            { file: resolve(root, 'tests/unit/../unit/a.test.js'), projectName: 'second' },
        ],
    ])
        assert.ok(discoveryErrors(value).length > 0);
});

test('discovery rejects paths outside the checkout or test tree', () => {
    for (const path of [resolve(root, '../tests/unit/a.test.js'), resolve(root, 'src/a.test.js')]) {
        assert.ok(discoveryErrors([{ file: path }]).length > 0);
    }
});

test('completion matches files and assertions without treating describe count as file count', () => {
    const value = completion(report());
    assert.deepEqual(value.errors, []);
    assert.deepEqual(value.completed, expected);
    assert.deepEqual(value.unrun, []);
    assert.equal(value.counts.total, 2);
    assert.equal(value.counts.assertions, 2);
});

test('completion rejects empty and malformed reports or success declarations', () => {
    for (const value of [
        null,
        [],
        {},
        report([]),
        { ...report(), success: false },
        { ...report(), success: 'true' },
    ]) {
        assert.ok(completion(value).errors.length > 0);
    }
});

test('completion rejects missing, unexpected and duplicate files', () => {
    for (const files of [
        [expected[0]],
        [expected[0], expected[0]],
        [expected[0], 'tests/unit/unexpected.test.js'],
    ]) {
        assert.ok(completion(report(files)).errors.length > 0);
    }
    assert.deepEqual(completion(report([expected[0]])).unrun, [
        { file: expected[1], reason: 'missing_completion' },
    ]);
});

test('completion rejects invalid names and malformed file records', () => {
    for (const item of [
        null,
        {},
        { ...report().testResults[0], name: expected[0] },
        { ...report().testResults[0], name: resolve(root, '../a.test.js') },
    ]) {
        const value = report();
        value.testResults[0] = item;
        assert.ok(completion(value).errors.length > 0);
    }
});

test('completion requires actual assertions in every file', () => {
    for (const assertions of [[], null, undefined]) {
        const value = report();
        value.testResults[0].assertionResults = assertions;
        const result = completion(value);
        assert.ok(result.errors.length > 0);
        assert.ok(
            result.unrun.some(
                (item) => item.file === expected[0] && item.reason === 'no_assertions'
            )
        );
    }
});

test('completion reports skipped, pending and todo assertions as unrun', () => {
    for (const status of ['skipped', 'pending', 'todo']) {
        const value = report();
        value.testResults[0].assertionResults[0].status = status;
        value.numPassedTests--;
        value[status === 'todo' ? 'numTodoTests' : 'numPendingTests']++;
        const result = completion(value);
        assert.ok(result.errors.length > 0);
        assert.equal(result.unrun[0].reason, status);
    }
});

test('failed assertions fail the gate without being described as unrun', () => {
    const value = report();
    value.testResults[0].assertionResults[0].status = 'failed';
    value.testResults[0].status = 'failed';
    value.numPassedTests--;
    value.numFailedTests++;
    const result = completion(value);
    assert.ok(result.errors.length > 0);
    assert.deepEqual(result.unrun, []);
});

test('completion rejects file errors and unknown assertion states despite positive totals', () => {
    for (const patch of [
        { status: 'failed' },
        { message: 'module import failed' },
        { assertionResults: [{}] },
        { assertionResults: [null] },
    ]) {
        const value = report();
        Object.assign(value.testResults[0], patch);
        assert.ok(completion(value).errors.length > 0);
    }
});

test('completion rejects zero, false or inconsistent numeric counts', () => {
    for (const patch of [
        { numTotalTests: 0 },
        { numPassedTests: 0 },
        { numFailedTests: 1 },
        { numPendingTests: 1 },
        { numTodoTests: 1 },
        { numFailedTestSuites: 1 },
        { numTotalTests: 3 },
        { numPassedTests: 3 },
        { numTotalTests: '2' },
        { numPassedTests: -1 },
        { numFailedTests: 0.5 },
        { numPendingTests: undefined },
    ])
        assert.ok(completion({ ...report(), ...patch }).errors.length > 0);
});

test('full-suite CLI rejects missing arguments, filters and extra arguments before running Vitest', () => {
    const cli = fileURLToPath(new URL('../../scripts/test-gates/vitest.mjs', import.meta.url));
    for (const args of [
        [],
        ['--help'],
        ['summary.json', 'a.test.js'],
        ['summary.json', '--passWithNoTests'],
    ]) {
        const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /full suite; no filters/);
    }
});
