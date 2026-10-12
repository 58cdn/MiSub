import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDiagnosticRunner } from '../../functions/services/diagnostics/runner.js';
import { selectSources, validateReport } from '../../functions/services/diagnostics/contract.js';
import { createConnectTransport } from './transport.js';

export async function executeRequest(input, options = {}) {
    if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        input.consent !== true ||
        Object.keys(input).some((key) => !['node', 'sources', 'consent'].includes(key))
    )
        throw new Error('invalid_request');
    const sources = selectSources(input.sources);
    const startedAt = Date.now();
    const requestId = randomUUID();
    const transport = createConnectTransport({ ...options, node: input.node, requestId });
    const report = await createDiagnosticRunner()({
        requestId,
        sourceIds: input.sources,
        transport,
        signal: options.signal,
        ipinfoToken: options.ipinfoToken,
    });
    return validateReport(report, requestId, sources, startedAt);
}

async function readInput(stream, signal) {
    const chunks = [];
    let size = 0;
    const cancel = () => stream.destroy(new Error('cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stream.destroy(new Error('input_timeout')), 5000);
    try {
        if (signal?.aborted) throw new Error('cancelled');
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > 16384) throw new Error('input_too_large');
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
        process.stdout.write(
            'Usage: node executors/connect/cli.js --consent [--allow-loopback-proxy] < request.json\n' +
                'Reads one {node, sources, consent:true} JSON request; HTTP/HTTPS CONNECT only.\n' +
                'No listener, credential storage or direct fallback. Real runs require your explicit authorization.\n'
        );
        return;
    }
    if (
        !args.includes('--consent') ||
        args.some((arg) => !['--consent', '--allow-loopback-proxy'].includes(arg))
    )
        throw new Error('consent_required');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
        const report = await executeRequest(await readInput(process.stdin, controller.signal), {
            allowLoopbackProxy: args.includes('--allow-loopback-proxy'),
            signal: controller.signal,
        });
        process.stdout.write(JSON.stringify(report) + '\n');
    } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const known = [
            'consent_required',
            'invalid_request',
            'invalid_node',
            'invalid_sources',
            'unsupported_protocol',
            'input_timeout',
            'input_too_large',
            'cancelled',
        ];
        process.stdout.write(
            JSON.stringify({
                version: 1,
                error: known.includes(error.message) ? error.message : 'executor_failed',
            }) + '\n'
        );
        process.exitCode = 1;
    });
}
