import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepare, publish, branch, client } from '../../scripts/upstream-sync/sync.mjs';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'misub-sync-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const run = (cwd, ...args) =>
        execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    run(root, 'init', '--bare', 'origin');
    run(root, 'init', '-b', 'main', 'seed');
    const seed = join(root, 'seed');
    const seedGit = (...args) => run(seed, ...args);
    seedGit('config', 'user.name', 'Fixture');
    seedGit('config', 'user.email', 'fixture@example.com');
    const commit = (file, content) => {
        writeFileSync(join(seed, file), content);
        seedGit('add', file);
        seedGit('commit', '-m', file);
        return seedGit('rev-parse', 'HEAD');
    };
    const common = commit('shared', 'common\n');
    seedGit('remote', 'add', 'origin', join(root, 'origin'));
    seedGit('push', 'origin', 'main');
    run(root, 'clone', '--branch', 'main', join(root, 'origin'), 'work');
    const work = join(root, 'work');
    const calls = [],
        reports = [],
        outputs = [];
    let prs = [],
        deny = false;
    const git = (...args) => {
        calls.push(args);
        if (args[0] === 'fetch' && args.includes('https://github.com/imzyb/MiSub.git'))
            args = ['fetch', '--no-tags', seed, 'upstream'];
        return run(work, ...args);
    };
    const apiCalls = [];
    const api = (method, path, body) => {
        apiCalls.push({ method, path, body });
        if (deny) throw new Error('HTTP 403');
        if (path.startsWith('pulls?')) return prs;
        if (path.startsWith('git/matching-refs')) {
            try {
                run(root, '--git-dir=origin', 'rev-parse', `refs/heads/${branch}`);
                return [{ ref: `refs/heads/${branch}` }];
            } catch {
                return [];
            }
        }
        if (path === 'pulls' && method === 'POST') {
            prs = [{ number: 12 }];
            return prs[0];
        }
        if (path === 'pulls/12') return prs[0];
        if (path.startsWith('statuses/')) return {};
        throw new Error(`Unexpected API ${method} ${path}`);
    };
    return {
        root,
        work,
        seedGit,
        git,
        commit,
        common,
        calls,
        apiCalls,
        reports,
        outputs,
        setPRs: (value) => {
            prs = value;
        },
        deny: () => {
            deny = true;
        },
        execute: () =>
            prepare({
                repo: '58cdn/MiSub',
                git,
                api,
                report: (m) => reports.push(m),
                output: (o) => outputs.push(o),
            }),
        origin: (ref) => run(root, '--git-dir=origin', 'rev-parse', ref),
    };
}
function diverge(f) {
    f.seedGit('checkout', '-b', 'upstream', f.common);
    f.commit('upstream-file', 'upstream\n');
    f.seedGit('checkout', 'main');
    f.commit('fork-file', 'fork\n');
    f.seedGit('push', 'origin', 'main');
}

test('fork ahead with no upstream changes skips branch, PR, tests and deployment', async (t) => {
    const f = fixture(t);
    f.seedGit('branch', 'upstream');
    f.commit('fork-file', 'fork');
    f.seedGit('push', 'origin', 'main');
    await f.execute();
    assert.equal(f.apiCalls.length, 0);
    assert.equal(f.outputs.length, 0);
    assert.match(f.reports[0], /No new upstream/);
    assert.ok(!f.calls.some((c) => c[0] === 'push'));
});
test('divergent histories preserve fork and upstream and create one draft PR', async (t) => {
    const f = fixture(t);
    diverge(f);
    const main = f.origin('main');
    await f.execute();
    assert.equal(f.origin('main'), main);
    assert.equal(f.outputs.length, 1);
    assert.equal(readFileSync(join(f.work, 'fork-file'), 'utf8'), 'fork\n');
    assert.equal(readFileSync(join(f.work, 'upstream-file'), 'utf8'), 'upstream\n');
    assert.equal(f.apiCalls.find((c) => c.path === 'pulls').body.draft, true);
    assert.equal(f.apiCalls.at(-1).body.state, 'pending');
});
test('existing PR reuses number and incorporates new upstream with normal push', async (t) => {
    const f = fixture(t);
    diverge(f);
    await f.execute();
    const first = f.origin(branch);
    f.seedGit('checkout', 'upstream');
    f.commit('upstream-next', 'next');
    await f.execute();
    assert.notEqual(f.origin(branch), first);
    assert.equal(f.apiCalls.filter((c) => c.path === 'pulls' && c.method === 'POST').length, 1);
    assert.equal(f.apiCalls.filter((c) => c.path === 'pulls/12' && c.method === 'PATCH').length, 1);
    assert.ok(f.calls.filter((c) => c[0] === 'push').every((c) => !c.includes('--force')));
});
test('existing PR with same upstream and moved base refreshes candidate', async (t) => {
    const f = fixture(t);
    diverge(f);
    await f.execute();
    f.seedGit('checkout', 'main');
    const next = f.commit('base-next', 'next');
    f.seedGit('push', 'origin', 'main');
    await f.execute();
    assert.equal(f.outputs.at(-1).base, next);
    f.git('merge-base', '--is-ancestor', next, f.outputs.at(-1).head);
});
test('daily run skips unchanged open candidate without repeated push or tests', async (t) => {
    const f = fixture(t);
    diverge(f);
    await f.execute();
    const pushes = f.calls.filter((c) => c[0] === 'push').length;
    await f.execute();
    assert.equal(f.outputs.length, 1);
    assert.equal(f.calls.filter((c) => c[0] === 'push').length, pushes);
    assert.match(f.reports.at(-1), /No new commits/);
});
test('conflict aborts and records file and identities without any push or PR', async (t) => {
    const f = fixture(t);
    f.seedGit('checkout', '-b', 'upstream');
    f.commit('shared', 'upstream\n');
    f.seedGit('checkout', 'main');
    f.commit('shared', 'fork\n');
    f.seedGit('push', 'origin', 'main');
    await assert.rejects(f.execute());
    assert.ok(!f.calls.some((c) => c[0] === 'push'));
    assert.match(f.reports.join('\n'), /shared/);
    assert.equal(f.outputs.length, 0);
    assert.equal(f.git('status', '--porcelain'), '');
});
test('permission denial fails before pushing and is never a skip', async (t) => {
    const f = fixture(t);
    diverge(f);
    f.deny();
    await assert.rejects(f.execute(), /403/);
    assert.equal(f.outputs.length, 0);
    assert.ok(!f.calls.some((c) => c[0] === 'push'));
});
test('duplicate PRs stop', async (t) => {
    const f = fixture(t);
    diverge(f);
    f.setPRs([{ number: 1 }, { number: 2 }]);
    await assert.rejects(f.execute(), /Multiple/);
});
test('unmerged orphan branch stops rather than resets history', async (t) => {
    const f = fixture(t);
    diverge(f);
    await f.execute();
    f.setPRs([]);
    await assert.rejects(f.execute(), /manual recovery/);
});
test('concurrent branch advance rejects normal push and publishes no passing result', async (t) => {
    const f = fixture(t);
    diverge(f);
    await f.execute();
    f.seedGit('fetch', 'origin', branch);
    f.seedGit('checkout', '-b', 'human', 'FETCH_HEAD');
    f.commit('human', 'human');
    let injected = false;
    const git = (...args) => {
        if (args[0] === 'push' && !injected) {
            injected = true;
            f.seedGit('push', 'origin', `HEAD:${branch}`);
        }
        return f.git(...args);
    };
    const before = f.outputs.length;
    await assert.rejects(
        prepare({
            repo: '58cdn/MiSub',
            git,
            api: (method, path, body) => {
                if (path.startsWith('pulls?')) return [{ number: 12 }];
                if (path.startsWith('git/matching-refs')) return [{ ref: `refs/heads/${branch}` }];
                throw new Error(`Unexpected publish ${path}`);
            },
            retry: true,
            report: () => {},
            output: (o) => f.outputs.push(o),
        })
    );
    assert.equal(f.outputs.length, before);
});

const head = 'a'.repeat(40),
    base = 'b'.repeat(40);
for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    test(`publish only accepts completed success: ${result}`, () => {
        const states = [];
        const api = (method, path, body) => {
            if (path === 'pulls/12')
                return {
                    state: 'open',
                    head: { ref: branch, sha: head },
                    base: { ref: 'main', sha: base },
                };
            if (path === 'git/ref/heads/main') return { object: { sha: base } };
            states.push(body.state);
        };
        const action = () =>
            publish({ api, head, base, pr: '12', result, url: 'https://example.com/run' });
        if (result === 'success') action();
        else assert.throws(action);
        assert.deepEqual(states, [result === 'success' ? 'success' : 'failure']);
    });
}
for (const change of ['base', 'head', 'closed']) {
    test(`stale ${change} cannot get success`, () => {
        const states = [];
        const api = (method, path, body) => {
            if (path === 'pulls/12')
                return {
                    state: change === 'closed' ? 'closed' : 'open',
                    head: { ref: branch, sha: change === 'head' ? 'c'.repeat(40) : head },
                    base: { ref: 'main', sha: base },
                };
            if (path === 'git/ref/heads/main')
                return { object: { sha: change === 'base' ? 'c'.repeat(40) : base } };
            states.push(body.state);
        };
        assert.throws(() => publish({ api, head, base, pr: '12', result: 'success' }));
        assert.deepEqual(states, ['failure']);
    });
}
test('API body uses stdin and permission failures propagate', () => {
    const api = client('58cdn/MiSub', (file, args, input) => {
        assert.equal(file, 'gh');
        assert.ok(args.includes('--input'));
        assert.equal(JSON.parse(input).draft, true);
        throw new Error('403');
    });
    assert.throws(() => api('POST', 'pulls', { draft: true }), /403/);
});
