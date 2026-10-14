import { readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const testFile = /^tests\/.+\.(?:test|spec)\.(?:js|ts)$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uniqueSorted = (values) => [...new Set(values)].sort();

// This inventory is independent of Vitest's include/exclude configuration.
export async function discoverExpectedTests(root) {
    const files = [];
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile()) {
                const name = relative(root, path).split(sep).join('/');
                if (testFile.test(name)) files.push(name);
            }
        }
    }
    await walk(resolve(root, 'tests'));
    return files.sort();
}

function expectedFiles(expected, errors) {
    if (!Array.isArray(expected) || expected.length === 0) {
        errors.push('Expected Vitest file inventory is empty or invalid.');
        return [];
    }
    const valid = [];
    for (const file of expected) {
        if (
            typeof file !== 'string' ||
            !testFile.test(file) ||
            file.includes('\\') ||
            file.split('/').some((part) => part === '.' || part === '..' || !part)
        ) {
            errors.push(`Invalid expected Vitest file: ${String(file)}`);
        } else {
            if (valid.includes(file)) errors.push(`Duplicate expected Vitest file: ${file}`);
            valid.push(file);
        }
    }
    return uniqueSorted(valid);
}

function reportedFile(root, file, stage, errors) {
    if (typeof file !== 'string' || !isAbsolute(file)) {
        errors.push(`${stage} file must be an absolute path: ${String(file)}`);
        return null;
    }
    const name = relative(resolve(root), resolve(file)).split(sep).join('/');
    if (!testFile.test(name) || name.split('/').includes('..') || isAbsolute(name)) {
        errors.push(`${stage} file is outside the expected test tree: ${file}`);
        return null;
    }
    return name;
}

function compareFiles(expected, actual, stage, errors) {
    for (const file of expected) {
        if (!actual.includes(file)) errors.push(`${stage} omitted test file: ${file}`);
    }
    for (const file of actual) {
        if (!expected.includes(file))
            errors.push(`${stage} included unexpected test file: ${file}`);
    }
}

export function inspectVitestDiscovery(root, expected, discovery) {
    const errors = [];
    const inventory = expectedFiles(expected, errors);
    const files = [];
    if (!Array.isArray(discovery) || discovery.length === 0) {
        errors.push('Vitest discovery is empty or invalid.');
    } else {
        for (const item of discovery) {
            const file = reportedFile(
                root,
                record(item) ? item.file : undefined,
                'Discovery',
                errors
            );
            if (file === null) continue;
            if (files.includes(file)) errors.push(`Duplicate discovery test file: ${file}`);
            files.push(file);
        }
    }
    const discovered = uniqueSorted(files);
    compareFiles(inventory, discovered, 'Discovery', errors);
    return { discovered, errors };
}

export function inspectVitestCompletion(root, expected, report) {
    const errors = [];
    const inventory = expectedFiles(expected, errors);
    const files = [];
    const unrun = [];
    const counts = {};
    const countKeys = {
        total: 'numTotalTests',
        passed: 'numPassedTests',
        failed: 'numFailedTests',
        pending: 'numPendingTests',
        todo: 'numTodoTests',
        failedSuites: 'numFailedTestSuites',
    };
    const source = record(report) ? report : {};
    if (!record(report)) errors.push('Vitest completion report is missing or invalid.');
    if (source.success !== true) errors.push('Vitest completion report does not declare success.');
    for (const [name, key] of Object.entries(countKeys)) {
        const value = source[key];
        counts[name] = Number.isSafeInteger(value) && value >= 0 ? value : null;
        if (counts[name] === null) errors.push(`Vitest completion has invalid ${key}.`);
    }
    if (!(counts.total > 0) || !(counts.passed > 0))
        errors.push('Vitest completed zero passing tests.');
    for (const name of ['failed', 'pending', 'todo', 'failedSuites']) {
        if (counts[name] !== 0) errors.push(`Vitest completion ${name} count must be zero.`);
    }
    let assertionCount = 0;
    let passedCount = 0;
    if (!Array.isArray(source.testResults) || source.testResults.length === 0) {
        errors.push('Vitest completion file results are empty or invalid.');
    } else {
        for (const item of source.testResults) {
            const file = reportedFile(
                root,
                record(item) ? item.name : undefined,
                'Completion',
                errors
            );
            if (file === null) continue;
            if (files.includes(file)) errors.push(`Duplicate completion test file: ${file}`);
            files.push(file);
            if (item.status !== 'passed') errors.push(`Vitest file did not pass: ${file}`);
            if (typeof item.message !== 'string' || item.message !== '') {
                errors.push(`Vitest file has a missing or nonempty error message: ${file}`);
            }
            if (!Array.isArray(item.assertionResults) || item.assertionResults.length === 0) {
                errors.push(`Vitest file contains no completed assertions: ${file}`);
                unrun.push({ file, reason: 'no_assertions' });
                continue;
            }
            for (const assertion of item.assertionResults) {
                assertionCount++;
                if (record(assertion) && assertion.status === 'passed') {
                    passedCount++;
                    continue;
                }
                const status = record(assertion) ? assertion.status : undefined;
                errors.push(`Vitest assertion did not pass in ${file}: ${String(status)}`);
                if (status !== 'failed') {
                    unrun.push({
                        file,
                        test: record(assertion)
                            ? assertion.fullName || assertion.title || null
                            : null,
                        reason: typeof status === 'string' ? status : 'invalid_assertion',
                    });
                }
            }
        }
    }
    counts.assertions = assertionCount;
    if (counts.total !== assertionCount)
        errors.push('Vitest total count differs from reported assertions.');
    if (counts.passed !== passedCount)
        errors.push('Vitest passed count differs from reported assertions.');
    const completed = uniqueSorted(files);
    compareFiles(inventory, completed, 'Completion', errors);
    for (const file of inventory) {
        if (!completed.includes(file)) unrun.push({ file, reason: 'missing_completion' });
    }
    return { completed, counts, unrun, errors };
}
