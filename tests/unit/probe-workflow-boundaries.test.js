import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const workflow = (name) =>
    yaml.load(readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8'));
// Evaluate the small boolean expression grammar used by these workflow gates.
// Parse every operand, including short-circuited branches, without eval or shell.
function gate(expression, context) {
    const source = String(expression).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const tokens = source.match(/&&|\|\||==|\(|\)|'[^']*'|[\w.]+/g) || [];
    expect(tokens.join('')).toBe(source.replace(/\s/g, ''));
    let index = 0;
    const atom = () => {
        const token = tokens[index++];
        if (token === '(') {
            const value = or();
            expect(tokens[index++]).toBe(')');
            return value;
        }
        if (token === 'true' || token === 'false') return token === 'true';
        if (token?.startsWith("'")) return token.slice(1, -1);
        expect(token).toMatch(/^(github|inputs)\.[a-z_]+$/);
        return context[token];
    };
    const equal = () => {
        let value = atom();
        if (tokens[index] === '==') {
            index++;
            value = value === atom();
        }
        return value;
    };
    const and = () => {
        let value = equal();
        while (tokens[index] === '&&') {
            index++;
            const right = equal();
            value = Boolean(value && right);
        }
        return value;
    };
    const or = () => {
        let value = and();
        while (tokens[index] === '||') {
            index++;
            const right = and();
            value = Boolean(value || right);
        }
        return value;
    };
    const value = or();
    expect(index).toBe(tokens.length);
    return Boolean(value);
}

describe('production probe workflow boundaries', () => {
    it('keeps normal Pages publication while resource/identity actions require independent manual opt-ins', () => {
        const w = workflow('cloudflare-pages.yml');
        for (const input of Object.values(w.on.workflow_dispatch.inputs)) {
            expect(input.type).toBe('boolean');
            expect(input.default).toBe(false);
        }
        const steps = w.jobs['build-and-deploy'].steps;
        const deploy = steps.find((s) => s.name === 'Deploy to Cloudflare Pages');
        const smoke = steps.find((s) => s.name === 'Accept deployed two-detector task loop');
        const sensitive = steps.filter((s) =>
            /production acceptance|two-detector/.test(s.name || '')
        );
        expect(sensitive).toHaveLength(3);
        expect(smoke.env.RUN_NODE_PROBE_ACCEPTANCE).toBe('true');
        for (const event of [
            'push',
            'pull_request',
            'pull_request_target',
            'schedule',
            'workflow_dispatch',
        ]) {
            for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
                for (const provision of [false, true])
                    for (const accept of [false, true]) {
                        const context = {
                            'github.event_name': event,
                            'github.ref': ref,
                            'inputs.provision_node_probes': provision,
                            'inputs.accept_node_probes': accept,
                        };
                        const manual = event === 'workflow_dispatch' && ref === 'refs/heads/main';
                        expect(gate(deploy.if, context)).toBe(
                            ref === 'refs/heads/main' &&
                                ['push', 'workflow_dispatch'].includes(event)
                        );
                        expect(gate(deploy.env.PROVISION_NODE_PROBES, context)).toBe(
                            manual && provision
                        );
                        for (const step of sensitive)
                            expect(gate(step.if, context)).toBe(manual && accept);
                    }
            }
        }
    });
    it('keeps binary/source distribution paused even on explicit manual publish until the material audit is complete', () => {
        const w = workflow('probe-detector.yml');
        expect(w.on.workflow_dispatch.inputs.publish.default).toBe(false);
        expect(w.jobs.publish).toBeUndefined();
        for (const job of Object.values(w.jobs)) {
            expect(job.permissions?.contents).not.toBe('write');
        }
        const gates = [
            ...['native', 'source'].map(
                (job) =>
                    w.jobs[job].steps.find((s) => s.uses?.startsWith('actions/upload-artifact@')).if
            ),
        ];
        for (const event of ['push', 'pull_request', 'workflow_dispatch'])
            for (const publish of [false, true]) {
                const context = {
                    'github.event_name': event,
                    'github.ref': 'refs/heads/main',
                    'inputs.publish': publish,
                };
                for (const expression of gates) {
                    expect(expression).toContain('workflow_dispatch');
                    expect(gate(expression, context)).toBe(false);
                }
            }
    });
});
