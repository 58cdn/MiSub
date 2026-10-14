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

function platformRules(policy, inventory, errors) {
    const rules = new Map();
    if (!record(policy) || policy.version !== 1 || !Array.isArray(policy.allowedSkips)) {
        errors.push('Vitest platform policy is missing or invalid.');
        return rules;
    }
    if (Object.keys(policy).some((key) => !['version', 'allowedSkips'].includes(key))) {
        errors.push('Vitest platform policy contains unknown fields.');
    }
    for (const rule of policy.allowedSkips) {
        if (
            !record(rule) ||
            Object.keys(rule).some(
                (key) =>
                    !['file', 'fullName', 'platforms', 'requiredPlatform', 'reason'].includes(key)
            ) ||
            typeof rule.file !== 'string' ||
            !inventory.includes(rule.file) ||
            typeof rule.fullName !== 'string' ||
            !rule.fullName.trim() ||
            rule.fullName !== rule.fullName.trim() ||
            !Array.isArray(rule.platforms) ||
            rule.platforms.length === 0 ||
            rule.platforms.some((platform) => !['linux', 'darwin'].includes(platform)) ||
            new Set(rule.platforms).size !== rule.platforms.length ||
            rule.requiredPlatform !== 'win32' ||
            typeof rule.reason !== 'string' ||
            !rule.reason.trim()
        ) {
            errors.push('Vitest platform skip rule is invalid or references an absent test file.');
            continue;
        }
        const key = JSON.stringify([rule.file, rule.fullName]);
        if (rules.has(key))
            errors.push(`Duplicate Vitest platform skip rule: ${rule.file} / ${rule.fullName}`);
        else rules.set(key, { ...rule, matches: 0 });
    }
    return rules;
}

export function inspectVitestCompletion(
    root,
    expected,
    report,
    { platform = process.platform, policy = { version: 1, allowedSkips: [] } } = {}
) {
    const errors = [];
    const inventory = expectedFiles(expected, errors);
    const rules = platformRules(policy, inventory, errors);
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
    for (const name of ['failed', 'todo', 'failedSuites']) {
        if (counts[name] !== 0) errors.push(`Vitest completion ${name} count must be zero.`);
    }
    let assertionCount = 0;
    let passedCount = 0;
    let allowedSkipped = 0;
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
                const rule =
                    record(assertion) && typeof assertion.fullName === 'string'
                        ? rules.get(JSON.stringify([file, assertion.fullName]))
                        : undefined;
                if (rule) rule.matches++;
                if (record(assertion) && assertion.status === 'passed') {
                    passedCount++;
                    continue;
                }
                const status = record(assertion) ? assertion.status : undefined;
                if (status === 'skipped' && rule?.platforms.includes(platform)) {
                    allowedSkipped++;
                    unrun.push({
                        file,
                        test: assertion.fullName,
                        reason: 'allowed_platform_skip',
                        platform,
                        requiredPlatform: rule.requiredPlatform,
                        policyReason: rule.reason,
                    });
                    continue;
                }
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
    for (const rule of rules.values()) {
        if (rule.matches !== 1)
            errors.push(
                `Vitest platform policy requires exactly one matching assertion: ${rule.file} / ${rule.fullName} (found ${rule.matches}).`
            );
    }
    counts.assertions = assertionCount;
    counts.allowedSkipped = allowedSkipped;
    if (counts.pending !== allowedSkipped)
        errors.push('Vitest pending count differs from explicitly allowed platform skips.');
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
