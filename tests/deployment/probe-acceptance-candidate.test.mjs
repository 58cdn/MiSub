import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    readAcceptanceIdentity,
    verifyCandidateOutput,
    verifyResultIdentity,
} from '../../scripts/probe-acceptance-candidate.mjs';

const root = resolve(
    fileURLToPath(new URL('../../', import.meta.url)),
    'tmp/acceptance-identity-tests'
);
function fixture(t, version = '0.0.1-alpha.17') {
    mkdirSync(root, { recursive: true });
    const cwd = mkdtempSync(join(root, 'source-'));
    t.after(() => {
        assert.ok(resolve(cwd).startsWith(root + sep));
        rmSync(cwd, { recursive: true, force: true });
    });
    const git = (...args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q');
    mkdirSync(join(cwd, 'detector'));
    writeFileSync(join(cwd, 'detector/VERSION'), version + '\n');
    writeFileSync(join(cwd, 'detector/kernel-lock.json'), JSON.stringify({ version: 'v1.19.32' }));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '0.0.1-alpha.1' }));
    git('add', '.');
    git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-qm',
        'fixture'
    );
    return { cwd, git, sha: git('rev-parse', 'HEAD') };
}

test('candidate uses the clean checked-out Probe product and full source, independent of app N', (t) => {
    const { cwd, sha } = fixture(t);
    assert.deepEqual(readAcceptanceIdentity(sha, cwd), {
        productVersion: '0.0.1-alpha.17',
        sourceCommit: sha,
        kernelVersion: 'v1.19.32',
        displayVersion: `0.0.1-alpha.17.sha.${sha.slice(0, 12)}`,
        platform: 'linux-amd64',
        buildChannel: 'development',
        sourceState: 'clean',
    });
    for (const expected of ['0'.repeat(40), 'a'.repeat(40), sha.slice(0, 12), undefined])
        assert.throws(() => readAcceptanceIdentity(expected, cwd), /acceptance_source_mismatch/);
});
test('candidate refuses tracked, staged and untracked source changes', (t) => {
    const { cwd, git, sha } = fixture(t);
    writeFileSync(join(cwd, 'detector/VERSION'), '0.0.1-alpha.18\n');
    assert.throws(() => readAcceptanceIdentity(sha, cwd), /acceptance_source_not_clean/);
    git('add', '.');
    assert.throws(() => readAcceptanceIdentity(sha, cwd), /acceptance_source_not_clean/);
    git('restore', '--staged', '.');
    git('restore', '.');
    writeFileSync(join(cwd, 'untracked.go'), 'package fixture\n');
    assert.throws(() => readAcceptanceIdentity(sha, cwd), /acceptance_source_not_clean/);
});
for (const version of [
    '0.1.0',
    '0.0.1',
    '0.0.1-alpha.0',
    '0.0.1-alpha.01',
    '0.0.1-alpha.2.sha.abcdef123456',
    '0.0.1-alpha.2\n',
])
    test(`candidate rejects non-product source identity ${JSON.stringify(version)}`, (t) => {
        const { cwd, sha } = fixture(t, version);
        assert.throws(() => readAcceptanceIdentity(sha, cwd), /acceptance_product_invalid/);
    });

const identity = {
    productVersion: '0.0.1-alpha.17',
    sourceCommit: 'b'.repeat(40),
    kernelVersion: 'v1.19.32',
    displayVersion: `0.0.1-alpha.17.sha.${'b'.repeat(12)}`,
    platform: 'linux-amd64',
    buildChannel: 'development',
    sourceState: 'clean',
};
const versionOutput = `misub-probe ${identity.displayVersion} (${identity.sourceCommit}); mihomo ${identity.kernelVersion}\n`;
const capabilities = `misub-probe-bootstrap-v1 ${identity.productVersion} ${identity.sourceCommit} ${identity.platform}\n`;
test('binary handshake requires product, development display, full source, kernel and target to agree', () => {
    verifyCandidateOutput(versionOutput, capabilities, identity);
    for (const output of [
        versionOutput.replace(identity.displayVersion, identity.productVersion),
        versionOutput.replace('b'.repeat(40), 'a'.repeat(40)),
        versionOutput.replace('v1.19.32', 'v1.19.31'),
        'misub-probe unknown\n',
    ])
        assert.throws(
            () => verifyCandidateOutput(output, capabilities, identity),
            /acceptance_binary_identity_mismatch/
        );
    for (const output of [
        capabilities.replace(identity.productVersion, '0.1.0'),
        capabilities.replace('b'.repeat(40), 'a'.repeat(40)),
        capabilities.replace('linux-amd64', 'linux-arm64'),
    ])
        assert.throws(
            () => verifyCandidateOutput(versionOutput, output, identity),
            /acceptance_binary_identity_mismatch/
        );
});
test('result identity must describe the same development candidate, never a historical or different build', () => {
    const metadata = {
        schemaVersion: 1,
        source: 'detector_reported',
        wrapperVersion: identity.productVersion,
        wrapperRevision: identity.sourceCommit,
        platform: identity.platform,
        buildChannel: identity.buildChannel,
        sourceState: identity.sourceState,
        kernelLockVersion: identity.kernelVersion,
    };
    verifyResultIdentity(metadata, identity);
    for (const change of [
        { schemaVersion: 2 },
        { source: 'unknown' },
        { wrapperVersion: '0.1.0' },
        { wrapperRevision: 'a'.repeat(40) },
        { platform: 'windows-amd64' },
        { buildChannel: 'testing' },
        { sourceState: 'dirty' },
        { sourceState: 'unknown' },
        { kernelLockVersion: 'v1.19.31' },
    ])
        assert.throws(
            () => verifyResultIdentity({ ...metadata, ...change }, identity),
            /acceptance_result_identity_mismatch/
        );
    assert.throws(
        () => verifyResultIdentity(null, identity),
        /acceptance_result_identity_mismatch/
    );
});
