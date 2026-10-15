import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const branch = 'automation/upstream-sync';
export const context = 'upstream-sync/validated-merge';
export function command(file, args, input) {
    return execFileSync(file, args, {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}
export function client(repo, run = command) {
    return (method, path, body) =>
        JSON.parse(
            run(
                'gh',
                [
                    'api',
                    '--method',
                    method,
                    `repos/${repo}/${path}`,
                    ...(body ? ['--input', '-'] : []),
                ],
                body && JSON.stringify(body)
            ) || 'null'
        );
}

export async function prepare({ repo, git, api, report, output, retry = false }) {
    if (repo !== '58cdn/MiSub') throw new Error('Sync is restricted to 58cdn/MiSub');
    git('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    git('fetch', '--no-tags', 'https://github.com/imzyb/MiSub.git', 'main');
    const upstream = git('rev-parse', 'FETCH_HEAD');
    const base = git('rev-parse', 'origin/main');
    const ancestor = (a, b) => {
        try {
            git('merge-base', '--is-ancestor', a, b);
            return true;
        } catch (error) {
            if (error.status === 1) return false;
            throw error;
        }
    };
    if (ancestor(upstream, base)) {
        report(`No new upstream commits. main=${base}; upstream=${upstream}`);
        return;
    }
    const prs = api('GET', `pulls?state=open&base=main&head=58cdn:${branch}&per_page=100`);
    if (prs.length > 1) throw new Error('Multiple sync PRs found; manual reconciliation required');
    const refs = api('GET', `git/matching-refs/heads/${branch}`);
    const exists = refs.some((ref) => ref.ref === `refs/heads/${branch}`);
    if (exists) {
        git('fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        const previous = git('rev-parse', `origin/${branch}`);
        if (!prs.length && !ancestor(previous, base))
            throw new Error('Unmerged sync branch has no open PR; manual recovery required');
        if (prs.length && ancestor(upstream, previous) && ancestor(base, previous) && !retry) {
            report(`No new commits for existing PR #${prs[0].number}. candidate=${previous}`);
            return;
        }
        git('checkout', '-B', branch, prs.length ? previous : base);
    } else {
        if (prs.length) throw new Error('Open sync PR has no branch');
        git('checkout', '-b', branch, base);
    }
    git('config', 'user.name', 'github-actions[bot]');
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    for (const sha of [base, upstream]) {
        try {
            git('merge', '--no-edit', '--no-ff', sha);
        } catch (error) {
            const files = git('diff', '--name-only', '--diff-filter=U');
            report(
                `Sync stopped before push. base=${base}; upstream=${upstream}; conflicts:\n${files || '(merge failed without conflict paths)'}`
            );
            try {
                git('merge', '--abort');
            } catch {
                /* No merge state when Git fails before merging. */
            }
            throw error;
        }
    }
    const head = git('rev-parse', 'HEAD');
    // Normal push rejects concurrent changes; main is never a push target.
    git('push', 'origin', `HEAD:refs/heads/${branch}`);
    const body = `Upstream: imzyb/MiSub@${upstream}\nBase: ${base}\nCandidate: ${head}\n\nTests: pending; see upstream-sync/validated-merge. Review fork customizations before merging. Preparation does not deploy. Merging main may deploy Cloudflare Pages.`;
    const pr = prs.length
        ? api('PATCH', `pulls/${prs[0].number}`, { body })
        : api('POST', 'pulls', {
              title: 'Sync upstream imzyb/MiSub',
              head: branch,
              base: 'main',
              body,
              draft: true,
          });
    api('POST', `statuses/${head}`, {
        state: 'pending',
        context,
        description: 'Candidate tests have not completed',
    });
    output({ head, base, pr: String(pr.number) });
    report(`Prepared PR #${pr.number}. base=${base}; upstream=${upstream}; candidate=${head}`);
}

export function publish({ api, head, base, pr, result, url }) {
    if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base) || !/^\d+$/.test(pr))
        throw new Error('Invalid candidate identity');
    const current = api('GET', `pulls/${pr}`);
    const main = api('GET', 'git/ref/heads/main');
    const fresh =
        current.state === 'open' &&
        current.head.ref === branch &&
        current.head.sha === head &&
        current.base.ref === 'main' &&
        current.base.sha === base &&
        main.object.sha === base;
    const state = result === 'success' && fresh ? 'success' : 'failure';
    api('POST', `statuses/${head}`, {
        state,
        context,
        target_url: url,
        description: fresh
            ? `Pinned candidate tests: ${result}`
            : 'Base or PR changed; rerun sync and tests',
    });
    if (state !== 'success') throw new Error('Candidate validation failed or became stale');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const repo = process.env.GITHUB_REPOSITORY;
    const api = client(repo);
    const report = (message) => {
        console.log(message);
        if (process.env.GITHUB_STEP_SUMMARY)
            appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    };
    try {
        if (process.argv[2] === 'publish') {
            publish({
                api,
                head: process.env.CANDIDATE_HEAD,
                base: process.env.CANDIDATE_BASE,
                pr: process.env.CANDIDATE_PR,
                result: process.env.TEST_RESULT,
                url: `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
            });
        } else {
            await prepare({
                repo,
                api,
                git: (...args) => command('git', args),
                report,
                retry: process.env.RETRY_VALIDATION === 'true',
                output: (values) => {
                    for (const [key, value] of Object.entries(values))
                        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
                },
            });
        }
    } catch (error) {
        report(`Sync blocked: ${error.message}\n${error.stderr?.toString() || ''}`);
        process.exitCode = 1;
    }
}
