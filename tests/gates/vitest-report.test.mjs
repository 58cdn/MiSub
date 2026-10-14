import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const repositoryPlatformPolicy = JSON.parse(
    await readFile(
        new URL('../../scripts/test-gates/vitest-platforms.json', import.meta.url),
        'utf8'
    )
);
// Synthetic reports below contain only the parser fixture, not every repository
// test. The full CI runner checks all real cases against the complete policy.
const platformPolicy = {
    ...repositoryPlatformPolicy,
    allowedSkips: [repositoryPlatformPolicy.allowedSkips[0]],
};
const nativeCase = platformPolicy.allowedSkips[0];
const nativeFiles = [nativeCase.file, expected[0]];
const platformReport = (status = 'skipped') => {
    const value = report(nativeFiles);
    value.testResults[0].assertionResults[0].fullName = nativeCase.fullName;
    value.testResults[0].assertionResults[0].status = status;
    if (status !== 'passed') {
        value.numPassedTests--;
        value[
            status === 'todo'
                ? 'numTodoTests'
                : status === 'failed'
                  ? 'numFailedTests'
                  : 'numPendingTests'
        ]++;
    }
    return value;
};
const platformCompletion = (value, platform = 'linux', policy = platformPolicy) =>
    inspectVitestCompletion(root, nativeFiles, value, { platform, policy });

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

test('the native parser fixture permits only its exact skip on Linux and macOS', () => {
    assert.deepEqual(platformPolicy.allowedSkips, [
        {
            file: 'tests/unit/probe-bootstrap-command.test.js',
            fullName:
                'auditable one-command probe bootstrap parses complete native commands with Windows PowerShell 5.1 without executing them',
            platforms: ['linux', 'darwin'],
            requiredPlatform: 'win32',
            reason: 'Windows PowerShell 5.1 native command parsing must execute in the Windows Vitest CI lane.',
        },
    ]);
    for (const platform of ['linux', 'darwin']) {
        const result = platformCompletion(platformReport(), platform);
        assert.deepEqual(result.errors, []);
        assert.equal(result.counts.allowedSkipped, 1);
        assert.equal(result.counts.passed, 1);
        assert.equal(result.counts.total, 2);
        assert.deepEqual(result.unrun, [
            {
                file: nativeCase.file,
                test: nativeCase.fullName,
                reason: 'allowed_platform_skip',
                platform,
                requiredPlatform: 'win32',
                policyReason: nativeCase.reason,
            },
        ]);
    }
});

test('native parser must execute on Windows and cannot be skipped on other unregistered platforms', () => {
    for (const platform of ['win32', 'freebsd', 'linux-x64', '']) {
        const result = platformCompletion(platformReport(), platform);
        assert.ok(result.errors.length > 0);
        assert.equal(result.counts.allowedSkipped, 0);
        assert.equal(result.unrun[0].reason, 'skipped');
    }
});

test('an omitted platform uses the real Node platform', () => {
    const result = inspectVitestCompletion(root, nativeFiles, platformReport(), {
        policy: platformPolicy,
    });
    const allowed = nativeCase.platforms.includes(process.platform);
    assert.equal(result.errors.length === 0, allowed);
    assert.equal(result.counts.allowedSkipped, allowed ? 1 : 0);
});

test('a registered parser that executes and passes is accepted on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
        const result = platformCompletion(platformReport('passed'), platform);
        assert.deepEqual(result.errors, []);
        assert.equal(result.counts.allowedSkipped, 0);
        assert.equal(result.counts.passed, 2);
        assert.deepEqual(result.unrun, []);
    }
});

test('platform rules never permit pending, todo or failed parser results', () => {
    for (const status of ['pending', 'todo', 'failed']) {
        const result = platformCompletion(platformReport(status));
        assert.ok(result.errors.length > 0);
        assert.equal(result.counts.allowedSkipped, 0);
    }
});

test('an unknown skipped test still fails alongside an allowed platform skip', () => {
    const value = platformReport();
    value.testResults[1].assertionResults[0].status = 'skipped';
    value.numPendingTests++;
    value.numPassedTests--;
    const result = platformCompletion(value);
    assert.ok(result.errors.length > 0);
    assert.equal(result.counts.allowedSkipped, 1);
    assert.equal(result.unrun[1].reason, 'skipped');
});

test('policy requires an exact full name, exact file and exactly one reported case even when all pass', () => {
    for (const change of [
        (value) => {
            value.testResults[0].assertionResults[0].fullName += ' renamed';
        },
        (value) => {
            delete value.testResults[0].assertionResults[0].fullName;
        },
        (value) => {
            value.testResults[0].assertionResults[0].fullName = nativeCase.fullName.toUpperCase();
        },
        (value) => {
            value.testResults[1].assertionResults[0].fullName = nativeCase.fullName;
            value.testResults[0].assertionResults[0].fullName = 'other';
        },
        (value) => {
            value.testResults[0].assertionResults.push({
                ...value.testResults[0].assertionResults[0],
            });
            value.numTotalTests++;
            value.numPassedTests++;
        },
    ]) {
        const value = platformReport('passed');
        change(value);
        assert.ok(
            platformCompletion(value).errors.some((error) =>
                error.includes('exactly one matching assertion')
            )
        );
    }
});

test('platform policy rejects stale, duplicate or malformed rules', () => {
    for (const policy of [
        null,
        {},
        { ...platformPolicy, version: 2 },
        { ...platformPolicy, unknown: true },
        { version: 1, allowedSkips: [nativeCase, nativeCase] },
        ...[
            { file: 'tests/unit/removed.test.js' },
            { fullName: '' },
            { fullName: `${nativeCase.fullName} ` },
            { platforms: ['win32'] },
            { platforms: ['linux', 'linux'] },
            { platforms: [] },
            { requiredPlatform: 'linux' },
            { reason: '' },
            { reason: null },
            { unknown: true },
        ].map((patch) => ({ version: 1, allowedSkips: [{ ...nativeCase, ...patch }] })),
    ])
        assert.ok(platformCompletion(platformReport('passed'), 'linux', policy).errors.length > 0);
});

test('duplicate named skipped assertions fail even when all aggregate counts agree', () => {
    const value = platformReport();
    value.testResults[0].assertionResults.push({ ...value.testResults[0].assertionResults[0] });
    value.numTotalTests++;
    value.numPendingTests++;
    const result = platformCompletion(value);
    assert.equal(result.counts.allowedSkipped, 2);
    assert.ok(result.errors.some((error) => error.includes('exactly one matching assertion')));
});

test('platform skip counts must match actual assertions and cannot cover zero executed tests', () => {
    for (const patch of [{ numPendingTests: 0 }, { numPendingTests: 2 }, { numPassedTests: 2 }]) {
        assert.ok(platformCompletion({ ...platformReport(), ...patch }).errors.length > 0);
    }
    const value = platformReport();
    value.testResults = [value.testResults[0]];
    value.numTotalTests = 1;
    value.numPassedTests = 0;
    const result = inspectVitestCompletion(root, [nativeCase.file], value, {
        platform: 'linux',
        policy: platformPolicy,
    });
    assert.ok(result.errors.some((error) => error.includes('zero passing tests')));
});
