import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inventory, runProcess } from '../../scripts/test-gates/common.mjs';
import { runBrowserEntry, validateBrowserReport } from '../../scripts/test-gates/browser.mjs';

const browser = {
    file: 'tests/browser/b.mjs',
    report: 'result.json',
    cases: 'tests',
    errors: ['errors', 'external'],
};
const success = () => ({
    tests: ['scenario'],
    errors: [],
    external: [],
    overflow: [{ elements: [] }],
});
async function fixture(t) {
    const root = await mkdtemp(resolve(tmpdir(), 'misub-gate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(resolve(root, 'tests/probes'), { recursive: true });
    await mkdir(resolve(root, 'tests/browser'), { recursive: true });
    const manifest = {
        node: ['tests/probes/a.check.mjs'],
        browser: [browser],
        helpers: ['tests/probes/sqlite-helper.mjs'],
    };
    for (const file of [...manifest.node, browser.file, ...manifest.helpers])
        await writeFile(resolve(root, file), '');
    const save = () =>
        writeFile(resolve(root, 'tests/acceptance-manifest.json'), JSON.stringify(manifest));
    await save();
    return { root, manifest, save };
}

async function executeNodeGate(root) {
    const runner = resolve(root, 'runner.mjs');
    await writeFile(
        runner,
        `import { runNodeFiles, validateNodeSummaries } from ${JSON.stringify(new URL('../../scripts/test-gates/node.mjs', import.meta.url).href)};
const files = ['tests/probes/a.check.mjs'];
const summaries = [];
const counts = await runNodeFiles(files, ${JSON.stringify(root)}, summaries);
try { validateNodeSummaries(files, [...summaries, summaries[0]], ${JSON.stringify(root)}); process.exit(5); }
catch (error) { if (!/duplicate/.test(error.message)) throw error; }
console.log(JSON.stringify(counts));`
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return promisify(execFile)(process.execPath, [runner], { env, cwd: root });
}

test('manifest registers every entry and helper once', async (t) => {
    const { root, manifest } = await fixture(t);
    assert.deepEqual(await inventory(root), manifest);
});
test('missing entry fails inventory', async (t) => {
    const { root } = await fixture(t);
    await rm(resolve(root, browser.file));
    await assert.rejects(inventory(root), /inventory mismatch/);
});
test('inventory failure summaries retain expected and unrun entries in both CLIs', async (t) => {
    const { root, manifest } = await fixture(t);
    const execute = promisify(execFile);
    await mkdir(resolve(root, 'scripts/test-gates'), { recursive: true });
    for (const name of ['common', 'node', 'browser']) {
        await copyFile(
            new URL(`../../scripts/test-gates/${name}.mjs`, import.meta.url),
            resolve(root, `scripts/test-gates/${name}.mjs`)
        );
    }
    await execute('git', ['init', '--quiet', root]);
    await execute(
        'git',
        [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '--allow-empty',
            '--quiet',
            '-m',
            'fixture',
        ],
        { cwd: root }
    );
    await rm(resolve(root, browser.file));
    for (const lane of ['node', 'browser']) {
        const summary = resolve(root, `${lane}.json`);
        await assert.rejects(
            execute(process.execPath, [resolve(root, `scripts/test-gates/${lane}.mjs`), summary], {
                cwd: root,
            })
        );
        const report = JSON.parse(await readFile(summary, 'utf8'));
        const expected = lane === 'node' ? manifest.node : [browser.file];
        assert.equal(report.passed, false);
        assert.deepEqual(report.expected, expected);
        assert.deepEqual(report.unrun, expected);
        assert.deepEqual(report.completed, []);
        assert.match(report.error, /inventory mismatch/);
    }
});
test('unknown browser or Node scripts fail inventory, including nested scripts', async (t) => {
    const { root } = await fixture(t);
    await mkdir(resolve(root, 'tests/browser/new'), { recursive: true });
    await writeFile(resolve(root, 'tests/browser/new/forgotten.mjs'), '');
    await assert.rejects(inventory(root), /inventory mismatch/);
    await rm(resolve(root, 'tests/browser/new/forgotten.mjs'));
    await writeFile(resolve(root, 'tests/probes/unregistered.check.mjs'), '');
    await assert.rejects(inventory(root), /inventory mismatch/);
});
test('duplicate entries and test-as-helper registration fail', async (t) => {
    const { root, manifest, save } = await fixture(t);
    manifest.node.push(manifest.node[0]);
    await save();
    await assert.rejects(inventory(root), /duplicate/);
    manifest.node.pop();
    manifest.helpers.push(manifest.node[0]);
    await save();
    await assert.rejects(inventory(root), /cannot be a helper/);
});
test('empty lane and escaping report paths fail', async (t) => {
    const { root, manifest, save } = await fixture(t);
    manifest.node = [];
    await save();
    await assert.rejects(inventory(root), /Missing Node/);
    manifest.node = ['tests/probes/a.check.mjs'];
    manifest.browser = [{ ...browser, report: '../result.json' }];
    await save();
    await assert.rejects(inventory(root));
});

test('browser process exit and a fresh report are both required', async (t) => {
    const { root } = await fixture(t);
    const execute = async ([, directory]) =>
        writeFile(resolve(directory, browser.report), JSON.stringify(success()));
    assert.deepEqual(await runBrowserEntry(browser, root, { base: root, execute }), {
        file: browser.file,
        reportedScenarios: 1,
    });
    await assert.rejects(
        runBrowserEntry(browser, root, {
            base: root,
            execute: async () => {
                throw new Error('exit=7');
            },
        }),
        /exit=7/
    );
    await assert.rejects(
        runBrowserEntry(browser, root, { base: root, execute: async () => {} }),
        /ENOENT/
    );
});
test('old browser success and malformed fresh report cannot pass', async (t) => {
    const { root } = await fixture(t);
    await writeFile(resolve(root, browser.report), JSON.stringify(success()));
    await assert.rejects(
        runBrowserEntry(browser, root, { base: root, execute: async () => {} }),
        /ENOENT/
    );
    await assert.rejects(
        runBrowserEntry(browser, root, {
            base: root,
            execute: async ([, directory]) => writeFile(resolve(directory, browser.report), '{'),
        }),
        SyntaxError
    );
});
for (const [name, mutate] of [
    [
        'empty scenarios',
        (r) => {
            r.tests = [];
        },
    ],
    [
        'duplicate scenarios',
        (r) => {
            r.tests.push(r.tests[0]);
        },
    ],
    [
        'page error',
        (r) => {
            r.errors.push('error');
        },
    ],
    [
        'external request',
        (r) => {
            r.external.push('request');
        },
    ],
    [
        'missing errors field',
        (r) => {
            delete r.errors;
        },
    ],
    [
        'overflow',
        (r) => {
            r.overflow[0].elements.push('section');
        },
    ],
    [
        'failure report',
        (r) => {
            r.failure = 'failure';
        },
    ],
])
    test(`browser rejects ${name}`, () => {
        const report = success();
        mutate(report);
        assert.throws(() => validateBrowserReport(browser, report));
    });
test('layout report requires success marker and clean layouts', () => {
    const entry = { ...browser, cases: 'layouts', passed: true };
    const report = { ...success(), layouts: [{ bad: [] }] };
    assert.throws(() => validateBrowserReport(entry, report), /success marker/);
    report.passed = true;
    assert.equal(validateBrowserReport(entry, report), 1);
    report.layouts[0].bad.push('clipped');
    assert.throws(() => validateBrowserReport(entry, report), /overflow/);
});
test('child failure cannot be converted to a passed gate', async () => {
    await assert.rejects(runProcess(['-e', 'process.exit(7)']), /exit=7/);
});
test('real Node execution requires per-file completion and nonzero tests', async (t) => {
    const { root } = await fixture(t);
    const file = 'tests/probes/a.check.mjs';
    await writeFile(resolve(root, file), "import test from 'node:test'; test('works', () => {});");
    const counts = JSON.parse((await executeNodeGate(root)).stdout);
    assert.equal(counts.tests, 1);
    await writeFile(resolve(root, file), '');
    await assert.rejects(executeNodeGate(root), /inventory mismatch/);
});
test('real Node skips and failures cannot satisfy completion', async (t) => {
    const { root } = await fixture(t);
    const file = 'tests/probes/a.check.mjs';
    await writeFile(
        resolve(root, file),
        "import test from 'node:test'; test.skip('omitted', () => {});"
    );
    await assert.rejects(executeNodeGate(root));
    await writeFile(
        resolve(root, file),
        "import test from 'node:test'; test('fails', () => { throw new Error('fixture'); });"
    );
    await assert.rejects(executeNodeGate(root));
});
