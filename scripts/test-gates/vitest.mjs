import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    discoverExpectedTests,
    inspectVitestCompletion,
    inspectVitestDiscovery,
} from './vitest-report.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
    console.error(
        'Usage: node scripts/test-gates/vitest.mjs <summary.json> (full suite; no filters)'
    );
    process.exitCode = 2;
} else {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const destination = resolve(args[0]);
    const summary = {
        version: 1,
        suite: 'vitest',
        evidence: 'offline',
        head: null,
        sourceHead: null,
        dirty: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        passed: false,
        phase: 'preflight',
        expected: [],
        discovered: [],
        completed: [],
        counts: null,
        unrun: [],
        errors: [],
    };
    let temporary;
    let child;
    let interrupted;
    const interrupt = (signal) => {
        interrupted = signal;
        child?.kill('SIGTERM');
    };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const save = async () => {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`);
    };
    const run = (commandArgs) =>
        new Promise((resolveExit, reject) => {
            if (interrupted) return reject(new Error(`Interrupted by ${interrupted}.`));
            child = spawn(process.execPath, commandArgs, { cwd: root, stdio: 'inherit' });
            child.once('error', reject);
            child.once('close', (code, signal) => {
                child = undefined;
                resolveExit({ code, signal });
            });
        });
    const load = async (path, stage) => {
        try {
            return JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
            summary.errors.push(`${stage} JSON is missing or invalid: ${error.message}`);
            return null;
        }
    };
    try {
        await save();
        summary.head = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
        }).trim();
        summary.sourceHead = process.env.TEST_SOURCE_HEAD || summary.head;
        summary.dirty =
            execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
                .length > 0;
        for (const key of ['head', 'sourceHead']) {
            if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(summary[key]))
                throw new Error(`Invalid ${key} commit identity.`);
        }
        summary.expected = await discoverExpectedTests(root);
        summary.unrun = summary.expected.map((file) => ({ file, reason: 'not_executed' }));
        if (summary.expected.length === 0)
            throw new Error('Expected Vitest file inventory is empty.');
        temporary = await mkdtemp(join(tmpdir(), 'misub-vitest-gate-'));
        const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
        const discoveryPath = join(temporary, 'discovery.json');
        const completionPath = join(temporary, 'completion.json');
        summary.phase = 'discovery';
        await save();
        const discoveryExit = await run([vitest, 'list', '--filesOnly', `--json=${discoveryPath}`]);
        if (discoveryExit.code !== 0)
            summary.errors.push(
                `Vitest discovery exited with code ${discoveryExit.code}, signal ${discoveryExit.signal}.`
            );
        const discovery = inspectVitestDiscovery(
            root,
            summary.expected,
            await load(discoveryPath, 'Discovery')
        );
        summary.discovered = discovery.discovered;
        summary.errors.push(...discovery.errors);
        if (summary.errors.length === 0) {
            summary.phase = 'execution';
            await save();
            const completionExit = await run([
                vitest,
                'run',
                '--reporter=default',
                '--reporter=json',
                `--outputFile.json=${completionPath}`,
            ]);
            if (completionExit.code !== 0)
                summary.errors.push(
                    `Vitest execution exited with code ${completionExit.code}, signal ${completionExit.signal}.`
                );
            const completion = inspectVitestCompletion(
                root,
                summary.expected,
                await load(completionPath, 'Completion')
            );
            summary.completed = completion.completed;
            summary.counts = completion.counts;
            summary.unrun = completion.unrun;
            summary.errors.push(...completion.errors);
        }
    } catch (error) {
        summary.errors.push(error.message);
    } finally {
        if (interrupted) summary.errors.push(`Interrupted by ${interrupted}.`);
        summary.finishedAt = new Date().toISOString();
        summary.passed = summary.errors.length === 0;
        summary.phase = summary.passed ? 'completed' : 'failed';
        try {
            if (temporary) await rm(temporary, { recursive: true, force: true });
        } catch (error) {
            summary.passed = false;
            summary.phase = 'failed';
            summary.errors.push(`Temporary evidence cleanup failed: ${error.message}`);
        }
        await save();
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        process.exitCode = summary.passed ? 0 : 1;
        console.log(`Vitest acceptance ${summary.passed ? 'passed' : 'failed'}: ${destination}`);
    }
}
