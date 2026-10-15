import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAlphaProduct, isSourceCommit } from '../src/shared/product-version.js';

const fail = (code) => {
    throw new Error(code);
};

// 候选沿用源码产品版；此路径不分配发行序号或声明发行已验收。
export function readAcceptanceIdentity(expectedCommit, cwd = process.cwd()) {
    const git = (...args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    const sourceCommit = git('rev-parse', 'HEAD');
    if (!isSourceCommit(expectedCommit) || sourceCommit !== expectedCommit)
        fail('acceptance_source_mismatch');
    if (git('status', '--porcelain', '--untracked-files=normal'))
        fail('acceptance_source_not_clean');
    const productVersion = readFileSync(resolve(cwd, 'detector/VERSION'), 'utf8').replace(
        /\r?\n$/,
        ''
    );
    if (!isAlphaProduct(productVersion)) fail('acceptance_product_invalid');
    const kernelVersion = JSON.parse(
        readFileSync(resolve(cwd, 'detector/kernel-lock.json'), 'utf8')
    ).version;
    if (
        typeof kernelVersion !== 'string' ||
        kernelVersion.trim() !== kernelVersion ||
        !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(kernelVersion)
    )
        fail('acceptance_kernel_invalid');
    return {
        productVersion,
        sourceCommit,
        kernelVersion,
        displayVersion: `${productVersion}.sha.${sourceCommit.slice(0, 12)}`,
        platform: 'linux-amd64',
        buildChannel: 'development',
        sourceState: 'clean',
    };
}

export function verifyCandidateOutput(version, capabilities, identity) {
    if (
        version.trimEnd() !==
            `misub-probe ${identity.displayVersion} (${identity.sourceCommit}); mihomo ${identity.kernelVersion}` ||
        capabilities.trimEnd() !==
            `misub-probe-bootstrap-v1 ${identity.productVersion} ${identity.sourceCommit} ${identity.platform}`
    )
        fail('acceptance_binary_identity_mismatch');
}

export function verifyResultIdentity(metadata, identity) {
    if (
        !identity ||
        metadata?.schemaVersion !== 1 ||
        metadata.source !== 'detector_reported' ||
        metadata.wrapperVersion !== identity.productVersion ||
        metadata.wrapperRevision !== identity.sourceCommit ||
        metadata.platform !== identity.platform ||
        metadata.buildChannel !== identity.buildChannel ||
        metadata.sourceState !== identity.sourceState ||
        metadata.kernelLockVersion !== identity.kernelVersion
    )
        fail('acceptance_result_identity_mismatch');
}

export function verifyCandidate(binary, identity, cwd = process.cwd()) {
    const run = (flag) =>
        execFileSync(binary, [flag], {
            cwd,
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 65536,
            windowsHide: true,
            env: { PATH: process.env.PATH || '' },
        });
    verifyCandidateOutput(run('--version'), run('--capabilities'), identity);
}

export function buildAcceptanceCandidate(expectedCommit, cwd = process.cwd()) {
    const identity = readAcceptanceIdentity(expectedCommit, cwd);
    const detector = resolve(cwd, 'detector');
    const run = (file, args) =>
        execFileSync(file, args, {
            cwd: detector,
            stdio: 'inherit',
            windowsHide: true,
            env: { ...process.env, CGO_ENABLED: '0' },
        });
    const platform = execFileSync('go', ['env', 'GOOS', 'GOARCH'], {
        cwd: detector,
        encoding: 'utf8',
        windowsHide: true,
    })
        .trim()
        .split(/\s+/)
        .join('-');
    if (platform !== identity.platform) fail('acceptance_platform_mismatch');
    run('python3', ['-B', 'scripts/bundle.py', identity.platform]);
    readAcceptanceIdentity(expectedCommit, cwd);
    run('go', [
        'build',
        '-buildvcs=true',
        '-trimpath',
        '-ldflags',
        `-s -w -X main.version=${identity.productVersion} -X main.commit=${identity.sourceCommit} -X main.buildChannel=development`,
        '-o',
        'misub-probe',
        '.',
    ]);
    const binary = resolve(detector, 'misub-probe');
    verifyCandidate(binary, identity, cwd);
    run(binary, ['--self-test']);
    return identity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.length !== 2) fail('acceptance_candidate_arguments_invalid');
    console.log(JSON.stringify(buildAcceptanceCandidate(process.env.GITHUB_SHA)));
}
