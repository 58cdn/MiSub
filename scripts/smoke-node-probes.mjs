// Explicit manual acceptance only. No credentials or user nodes are logged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAcceptanceIdentity, verifyCandidate, verifyResultIdentity } from './probe-acceptance-candidate.mjs';
const execute = promisify(execFile);
const TYPES = ['format', 'tcp', 'proxy', 'speed', 'unlock'];
const fail = code => { throw new Error(code); };
export function verifyDeployment(project, expectedSha) {
    const deployment = project?.canonical_deployment;
    if (deployment?.deployment_trigger?.metadata?.commit_hash !== expectedSha || deployment.environment !== 'production' || deployment.latest_stage?.status !== 'success') fail('production_commit_not_ready');
    const host = project?.subdomain;
    if (typeof host !== 'string' || !/^[a-z0-9-]+\.pages\.dev$/.test(host)) fail('invalid_production_subdomain');
    const origin = `https://${host}`;
    const deployed = new URL(deployment.url);
    if (deployed.protocol !== 'https:' || !deployed.hostname.endsWith(`.${host}`) || deployed.username || deployed.password) fail('invalid_deployment_url');
    return { origin, deploymentUrl: deployed.origin };
}
async function jsonRequest(url, options = {}) {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    if (text.length > 1024 * 1024) fail('response_too_large');
    let body; try { body = JSON.parse(text); } catch { fail('non_json_response'); }
    return { response, body };
}
export function checkAcceptance(data, detectorIds, identity) {
    if (data?.nodes?.length !== 2 || data.nextOffset !== null) fail('incomplete_probe_matrix');
    const ids = new Set();
    for (const node of data.nodes) {
        if (!detectorIds.includes(node.agent_id) || ids.has(node.agent_id) || node.state !== 'done') fail('detector_matrix_mismatch');
        ids.add(node.agent_id);
        verifyResultIdentity(node.executionMetadata, identity);
        for (const type of TYPES) {
            const check = node.checks?.[type];
            if (type === 'format') {
                if (check?.status !== 'passed') fail('format_acceptance_failed');
            } else if (check?.status !== 'blocked' || check.code !== 'unsafe_target') fail('reserved_address_not_blocked');
        }
    }
    // The only credential in this fixture must never appear in a public results DTO.
    if (JSON.stringify(data).includes('probe-fixture-only')) fail('credential_in_result');
}
export async function smoke(env = process.env) {
    if (env.RUN_NODE_PROBE_ACCEPTANCE !== 'true' || (env.GITHUB_ACTIONS === 'true' && (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'))) fail('manual_acceptance_required');
    for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'ADMIN_PASSWORD', 'GITHUB_SHA']) if (!env[key]) fail('missing_smoke_environment');
    const projectName = env.CLOUDFLARE_PAGES_PROJECT_NAME || 'misub';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName) || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID) || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) fail('invalid_smoke_environment');
    const identity = readAcceptanceIdentity(env.GITHUB_SHA);
    const binary = resolve(env.PROBE_BINARY || 'detector/misub-probe');
    verifyCandidate(binary, identity);
    let location;
    for (let i = 0; i < 10; i++) {
        const { response, body } = await jsonRequest(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${projectName}`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
        if (!response.ok || body.success !== true) fail('project_lookup_failed');
        try { location = verifyDeployment(body.result, env.GITHUB_SHA); break; } catch (e) { if (e.message !== 'production_commit_not_ready') throw e; }
        await new Promise(r => setTimeout(r, 3000));
    }
    if (!location) fail('production_commit_not_ready');
    const { origin, deploymentUrl } = location;
    const unauth = await jsonRequest(`${origin}/api/probes/v1/capabilities`);
    if (unauth.response.status !== 401) fail('probe_route_auth_boundary_failed');
    const login = await jsonRequest(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }) });
    if (!login.response.ok || login.body.success !== true) fail('smoke_login_failed_no_password_reset_attempted');
    const cookies = login.response.headers.getSetCookie();
    const cookie = cookies.find(x => x.startsWith('auth_session='))?.split(';')[0];
    if (!cookie) fail('session_cookie_missing');
    async function admin(path, method = 'GET', body, key) {
        const out = await jsonRequest(`${origin}/api/probes/v1/${path}`, { method, headers: { Cookie: cookie, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!out.response.ok || out.body.success !== true) {
            const code = out.body.error?.code;
            fail(/^[a-z_]{1,60}$/.test(code || '') ? `probe_api_${code}` : 'probe_api_failed');
        }
        return out.body.data;
    }
    const capability = await admin('capabilities');
    if (!capability.storageReady || TYPES.some(t => !capability.types?.includes(t))) fail('probe_database_or_types_missing');
    const dir = await mkdtemp(join(tmpdir(), 'misub-smoke-'));
    const agents = []; let jobId; let cleanupFailed = false;
    try {
        for (const suffix of ['A', 'B']) {
            const agent = await admin('agents', 'POST', { name: `[CI ${env.GITHUB_SHA.slice(0, 8)}] ${suffix}` });
            agents.push(agent);
            if (!/^mp1_[a-f0-9]{64}$/.test(agent.token)) fail('invalid_enrollment_token');
            await writeFile(join(dir, `${agent.id}.json`), JSON.stringify({ version: 1, server: origin, token: agent.token, pollSeconds: 60 }), { mode: 0o600 });
        }
        const payload = {
            scope: 'snapshot', nodes: [{ id: 'ci-reserved-address', name: 'CI reserved-address fixture (not a user node)', url: 'trojan://probe-fixture-only@198.51.100.1:443' }],
            types: TYPES, agentIds: agents.map(a => a.id), consent: true,
            options: { timeoutMs: 1000, downloadBytes: 65536, allowMetered: true, services: ['netflix', 'youtube', 'openai'] },
        };
        const key = crypto.randomUUID();
        const job = await admin('jobs', 'POST', payload, key); jobId = job.id;
        const replay = await admin('jobs', 'POST', payload, key);
        if (replay.id !== job.id || replay.replay !== true) fail('production_idempotency_failed');
        await Promise.all(agents.map(async agent => {
            let output;
            try {
                output = await execute(binary, ['--config', join(dir, `${agent.id}.json`), '--once'], { timeout: 90000, maxBuffer: 65536, env: { PATH: env.PATH || '', HOME: dir, TMPDIR: dir } });
            } catch { fail('detector_process_failed'); }
            if (!output.stdout.includes('result_accepted')) fail('detector_did_not_complete');
        }));
        checkAcceptance(await admin(`jobs/${job.id}`), agents.map(a => a.id), identity);
    } finally {
        if (jobId) { try { await admin(`jobs/${jobId}/cancel`, 'POST', {}); } catch { cleanupFailed = true; } }
        for (const agent of agents) {
            try {
                const revoked = await admin(`agents/${agent.id}`, 'DELETE');
                if (!revoked.revoked) cleanupFailed = true;
            } catch { cleanupFailed = true; }
        }
        await rm(dir, { recursive: true, force: true });
        if (cleanupFailed) fail('temporary_detector_cleanup_failed');
    }
    const report = `Probe reserved-target acceptance passed\nProduction: ${origin}\nDeployment: ${deploymentUrl}\nCommit: ${env.GITHUB_SHA}\nProbe product: ${identity.productVersion}\nProbe build: ${identity.displayVersion}\nProbe source: ${identity.sourceCommit}\nTwo temporary identities: real standalone binary claim/result, matching execution identity, five-type result shape, idempotency, reserved-address rejection, revocation.\nBrowser pairing and user-node acceptance remain separate; no user node was fetched or tested.\n`;
    console.log(report);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `\n## Node probe acceptance\n\n${report}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    smoke().catch(error => {
        const code = /^[a-z_]{1,100}$/.test(error?.message || '') ? error.message : 'smoke_failed';
        console.error(`::error::${code}`); process.exitCode = 1;
    });
}
