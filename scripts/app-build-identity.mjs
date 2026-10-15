import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBuildIdentity, isSourceCommit } from '../src/shared/product-version.js';

export function readAppBuildIdentity({ cwd = process.cwd(), env = process.env } = {}) {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
    if (env.MISUB_PRODUCT_VERSION && env.MISUB_PRODUCT_VERSION !== pkg.version)
        throw new Error('product_version_mismatch');
    const git = (...args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    const sourceCommit = git('rev-parse', 'HEAD');
    // CI must build the actual checked-out revision, including PR merge commits.
    if (
        env.MISUB_SOURCE_COMMIT &&
        (!isSourceCommit(env.MISUB_SOURCE_COMMIT) || env.MISUB_SOURCE_COMMIT !== sourceCommit)
    )
        throw new Error('source_commit_mismatch');
    const dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
    const release = env.MISUB_RELEASE_BUILD === 'true';
    if (release && dirty) throw new Error('release_requires_clean_worktree');
    return createBuildIdentity(env.MISUB_PRODUCT_VERSION || pkg.version, sourceCommit, {
        development: !release,
        dirty,
    });
}

export function appBuildIdentityPlugin(identity) {
    return {
        name: 'misub-build-identity',
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: 'version.json',
                source: JSON.stringify(identity, null, 2) + '\n',
            });
        },
    };
}
