// Offline contract tests: execute the real shell script with fake curl/Wrangler.
// Requires Bash + jq (available on the workflow's Ubuntu runner), no credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const kvId = 'a'.repeat(32);
const d1Id = '11111111-2222-4333-8444-555555555555';
const sha = 'b'.repeat(40);
const project = (production = {}, status = 200) => ({
    suffix: '/pages/projects/misub', status,
    body: { success: status === 200, result: { production_branch: 'main', deployment_configs: { production } } },
});
const namespaces = (result) => ({
    suffix: '/storage/kv/namespaces?per_page=1000', body: { success: true, result },
});

const mockCurl = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const steps = JSON.parse(fs.readFileSync(process.env.MOCK_HTTP, 'utf8'));
const step = steps.shift();
assert.ok(step, 'Unexpected HTTP request; real network access is disabled');
assert.ok(args.at(-1).endsWith(step.suffix), 'Unexpected Cloudflare endpoint');
assert.equal(option('--request') || 'GET', step.method || 'GET');
fs.writeFileSync(process.env.MOCK_HTTP, JSON.stringify(steps));
const body = JSON.stringify(step.body);
if (option('--output')) fs.writeFileSync(option('--output'), body);
else process.stdout.write(body);
if (option('--write-out')) process.stdout.write(String(step.status || 200));
if (args.includes('--fail') && (step.status || 200) >= 400) process.exit(22);
`;
const mockWrangler = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_COMMANDS, JSON.stringify(args) + '\n');
assert.deepEqual(args.slice(0, 2), ['wrangler', 'pages']);
if (args[2] === 'secret') {
    assert.equal(args[3], 'put');
    // Check stdin without logging or persisting even the test-only credential.
    assert.ok(fs.readFileSync(0, 'utf8') === process.env[args[4]], 'Secret must use stdin');
} else if (args[2] === 'project') {
    assert.equal(args[3], 'create');
} else {
    assert.equal(args[2], 'deploy');
    // Pages rejects an explicit --config, even when its value is wrangler.toml.
    assert.ok(!args.some(a => a === '-c' || a.startsWith('-c=') || a === '--config' || a.startsWith('--config=')),
        'Pages does not support custom paths for the Wrangler configuration file');
    assert.ok(fs.existsSync('wrangler.toml'), 'Pages must discover the root configuration');
}
`;

function runScript(t, responses, overrides = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'misub-deploy-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync(join(root, 'wrangler-cf-pages.toml'), join(dir, 'wrangler-cf-pages.toml'));
    const http = join(dir, 'http.json');
    const commands = join(dir, 'commands.jsonl');
    writeFileSync(http, JSON.stringify(responses));
    writeFileSync(commands, '');
    for (const [name, code] of [['curl', mockCurl], ['npx', mockWrangler]]) {
        writeFileSync(join(dir, name), `#!${process.execPath}\n${code}`, { mode: 0o700 });
    }
    // Use an allowlist rather than inheriting production variables or credentials.
    const env = {
        PATH: `${dir}:${process.env.PATH}`, HOME: dir,
        MOCK_HTTP: http, MOCK_COMMANDS: commands,
        CLOUDFLARE_API_TOKEN: 'test-only-not-a-real-token',
        CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
        ADMIN_PASSWORD: 'test-only-not-a-real-password', GITHUB_SHA: sha,
        ...overrides,
    };
    const result = spawnSync('bash', [join(root, 'scripts/deploy-cloudflare-pages.sh')], {
        cwd: dir, env, encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    for (const key of ['CLOUDFLARE_API_TOKEN', 'ADMIN_PASSWORD', 'COOKIE_SECRET']) {
        if (env[key] && env[key] !== 'admin') assert.ok(!output.includes(env[key]), 'Credential leaked to output');
    }
    const config = join(dir, 'wrangler.toml');
    return {
        status: result.status, output,
        calls: readFileSync(commands, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
        remaining: JSON.parse(readFileSync(http, 'utf8')),
        config: existsSync(config) ? readFileSync(config, 'utf8') : '',
    };
}

function expectDeployed(result) {
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.remaining, []);
    assert.deepEqual(result.calls.at(-1), [
        'wrangler', 'pages', 'deploy', 'dist', '--project-name=misub', '--branch=main', `--commit-hash=${sha}`,
    ]);
    assert.ok(result.config.includes(`id = "${kvId}"`));
    assert.ok(result.config.includes('pages_build_output_dir = "./dist"'));
    // Project name is not necessarily the assigned pages.dev subdomain.
    assert.ok(!result.output.includes('https://misub.pages.dev'));
}

test('retry reuses the project and KV created before the failed deploy', (t) => {
    const result = runScript(t, [
        project({ env_vars: { ADMIN_PASSWORD: { type: 'secret_text' } } }),
        namespaces([{ id: kvId, title: 'misub-misub-kv' }]),
    ]);
    expectDeployed(result);
    assert.equal(result.calls.length, 2); // secret + deploy; no project creation
});

test('existing KV and D1 bindings are preserved, optional cookie uses stdin', (t) => {
    const result = runScript(t, [project({
        kv_namespaces: { MISUB_KV: { namespace_id: kvId } },
        d1_databases: { MISUB_DB: { id: d1Id } },
    })], { COOKIE_SECRET: 'test-only-not-a-real-cookie' });
    expectDeployed(result);
    assert.ok(result.config.includes(`database_id = "${d1Id}"`));
    assert.equal(result.calls.length, 3); // two secrets + deploy
});

test('first deploy creates missing resources before uploading secrets and assets', (t) => {
    const result = runScript(t, [
        project({}, 404), namespaces([]),
        { suffix: '/storage/kv/namespaces', method: 'POST', body: { success: true, result: { id: kvId } } },
    ]);
    expectDeployed(result);
    assert.deepEqual(result.calls[0], ['wrangler', 'pages', 'project', 'create', 'misub', '--production-branch=main']);
});

test('missing secrets and the default password fail before any remote commands', (t) => {
    for (const overrides of [
        { CLOUDFLARE_API_TOKEN: '' }, { CLOUDFLARE_ACCOUNT_ID: '' }, { ADMIN_PASSWORD: '' }, { ADMIN_PASSWORD: 'admin' },
    ]) {
        const result = runScript(t, [], overrides);
        assert.notEqual(result.status, 0);
        assert.deepEqual(result.calls, []);
        assert.match(result.output, /Missing Repository secret|insecure default/);
    }
});

test('a mismatched KV ID cannot silently switch existing storage', (t) => {
    const result = runScript(t, [project({ kv_namespaces: { MISUB_KV: { namespace_id: kvId } } })],
        { CLOUDFLARE_KV_NAMESPACE_ID: 'c'.repeat(32) });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /Refusing to switch storage/);
});

test('authorization errors do not trigger project creation', (t) => {
    const result = runScript(t, [project({}, 403)]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /HTTP 403/);
});

const automatic = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
const existingProduction = () => ({
    kv_namespaces: { MISUB_KV: { namespace_id: kvId } },
    env_vars: { ADMIN_PASSWORD: { type: 'secret_text' } },
});

test('automatic release preserves credentials and all existing resource IDs', (t) => {
    const production = existingProduction();
    const probeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    production.env_vars.COOKIE_SECRET = { type: 'secret_text' };
    production.d1_databases = { MISUB_DB: { id: d1Id }, MISUB_PROBE_DB: { id: probeId } };
    const result = runScript(t, [project(production)], {
        ...automatic, COOKIE_SECRET: 'test-only-different-cookie',
    });
    expectDeployed(result);
    assert.equal(result.calls.length, 1);
    assert.ok(result.config.includes(`database_id = "${d1Id}"`));
    assert.ok(result.config.includes(`database_id = "${probeId}"`));
    assert.match(result.output, /Preserving existing production secret bindings/);
});

test('automatic release needs no repository copy of the current admin password', (t) => {
    const result = runScript(t, [project(existingProduction())], {
        ...automatic, ADMIN_PASSWORD: '', COOKIE_SECRET: 'test-only-unused-cookie',
    });
    expectDeployed(result);
    assert.equal(result.calls.length, 1);
});

test('automatic release never creates a missing project', (t) => {
    const result = runScript(t, [project({}, 404)], automatic);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.remaining, []);
    assert.match(result.output, /requires an existing Pages project/);
});

test('automatic release refuses a missing or different production branch', (t) => {
    for (const branch of [undefined, 'production', '']) {
        const response = project(existingProduction());
        response.body.result.production_branch = branch;
        const result = runScript(t, [response], automatic);
        assert.notEqual(result.status, 0);
        assert.deepEqual(result.calls, []);
        assert.deepEqual(result.remaining, []);
        assert.equal(result.config, '');
        assert.match(result.output, /production branch to be main/);
    }
});

test('automatic release never discovers or creates a missing KV binding', (t) => {
    const production = existingProduction();
    delete production.kv_namespaces;
    const result = runScript(t, [project(production)], automatic);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.remaining, []);
    assert.match(result.output, /requires the existing MISUB_KV/);
});

test('automatic release refuses missing or plaintext production credentials', (t) => {
    for (const env_vars of [{}, { ADMIN_PASSWORD: { type: 'plain_text' } }, {
        ADMIN_PASSWORD: { type: 'secret_text' }, COOKIE_SECRET: { type: 'plain_text' },
    }]) {
        const result = runScript(t, [project({ ...existingProduction(), env_vars })], automatic);
        assert.notEqual(result.status, 0);
        assert.deepEqual(result.calls, []);
        assert.match(result.output, /requires existing production secret bindings/);
    }
});

test('automatic release refuses a new business database binding', (t) => {
    const result = runScript(t, [project(existingProduction())], {
        ...automatic, CLOUDFLARE_D1_DATABASE_ID: d1Id,
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /cannot add a MISUB_DB binding/);
});

test('automatic release refuses probe provisioning and a new explicit binding', (t) => {
    for (const override of [{ PROVISION_NODE_PROBES: 'true' }, { CLOUDFLARE_PROBE_D1_DATABASE_ID: d1Id }]) {
        const result = runScript(t, [project(existingProduction())], { ...automatic, ...override });
        assert.notEqual(result.status, 0);
        assert.deepEqual(result.calls, []);
        assert.deepEqual(result.remaining, []);
        assert.match(result.output, /cannot provision or add a probe database binding/);
    }
});
