import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ProbeExecutionMetadata from '../../src/components/nodes/ProbeExecutionMetadata.vue';
import { createI18n } from '../../src/i18n/index.js';

const snapshot = Object.freeze({
    schemaVersion: 1,
    source: 'detector_reported',
    wrapperVersion: '0.3.0-fixture',
    wrapperRevision: 'b'.repeat(40),
    platform: 'linux-amd64',
    kernelLockVersion: 'v1.19.32',
    ruleSetVersion: 7,
});
const languages = [
    {
        locale: 'zh-CN',
        title: '历史执行声明',
        recorded: '已记录',
        source: '来源：检测器自报',
        sourceBuild: '源码构建，修订未提供',
        kernelUnknown: '未知（未提供）',
        buildUnknown: '未知（历史记录未提供）',
        note: '仅对应当次结果，不代表当前能力、解锁状态或实际内核执行证明。',
        pending: '尚未记录',
        stopped: '未记录',
        unavailable: '无可用记录',
        invalid: '未知',
        pendingNote: '任务完成并回传结果后才记录执行声明。',
        stoppedNote: '任务已停止，未收到完成结果，因此没有执行声明记录。',
        unavailableNote:
            '该结果未记录执行声明，或声明记录不可用。当次版本未知，不能用检测器当前版本补齐。',
        invalidNote: '该执行声明无法识别，当次版本未知。',
        labels: [
            '检测器版本',
            '构建标识',
            '构建通道',
            '源码状态',
            '源码修订',
            '构建平台',
            '内核锁版本声明',
            '判定规则集版本',
            '声明结构版本',
        ],
    },
    {
        locale: 'en-US',
        title: 'Historical execution declaration',
        recorded: 'Recorded',
        source: 'Source: detector reported',
        sourceBuild: 'Source build; revision not provided',
        kernelUnknown: 'Unknown (not provided)',
        buildUnknown: 'Unknown (not recorded)',
        note: 'Applies only to this result. It does not establish current capabilities, unlock status or actual kernel execution.',
        pending: 'Not recorded yet',
        stopped: 'Not recorded',
        unavailable: 'No usable record',
        invalid: 'Unknown',
        pendingNote: 'The declaration is recorded when the task returns its completed result.',
        stoppedNote:
            'The task stopped without a completed result, so no execution declaration was recorded.',
        unavailableNote:
            'This result has no usable declaration: it was not recorded or cannot be read. Its execution version is unknown; the detector’s current version cannot fill it in.',
        invalidNote:
            'This execution declaration cannot be interpreted. Its execution version is unknown.',
        labels: [
            'Detector version',
            'Build identity',
            'Build channel',
            'Source state',
            'Source revision',
            'Build platform',
            'Kernel lock declaration',
            'Classification rule-set version',
            'Declaration schema version',
        ],
    },
];
const wrappers = [];
const originalLanguage = document.documentElement.lang;

function render(language, props = {}) {
    const i18n = createI18n({ initialLocale: language.locale });
    const wrapper = mount(ProbeExecutionMetadata, {
        props: { metadata: snapshot, state: 'done', ...props },
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    return { wrapper, i18n };
}

function assertNoDeclaration(wrapper) {
    expect(wrapper.find('dl').exists()).toBe(false);
    expect(wrapper.find('[data-field]').exists()).toBe(false);
    expect(wrapper.find('.execution-source').exists()).toBe(false);
    expect(wrapper.find('.execution-version').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(snapshot.wrapperRevision);
    expect(wrapper.html()).not.toContain(snapshot.wrapperVersion);
}

afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    document.documentElement.lang = originalLanguage;
});

describe.each(languages)('execution metadata component: $locale', (language) => {
    it('renders all accepted fields with localized labels and bounded declaration wording', () => {
        const { wrapper } = render(language);
        expect(wrapper.attributes('data-status')).toBe('recorded');
        expect(wrapper.get('summary').text()).toContain(language.title);
        expect(wrapper.get('.execution-status').text()).toBe(language.recorded);
        expect(wrapper.get('.execution-version').text()).toBe(snapshot.wrapperVersion);
        expect(wrapper.get('.execution-source').text()).toBe(language.source);
        expect(wrapper.get('.execution-note').text()).toBe(language.note);
        expect(wrapper.findAll('dt').map((node) => node.text())).toEqual(language.labels);
        const fields = Object.fromEntries(
            wrapper.findAll('dd').map((node) => [node.attributes('data-field'), node.text()])
        );
        expect(fields).toEqual({
            wrapperVersion: snapshot.wrapperVersion,
            displayVersion: snapshot.wrapperVersion,
            buildChannel: language.buildUnknown,
            sourceState: language.buildUnknown,
            wrapperRevision: snapshot.wrapperRevision,
            platform: snapshot.platform,
            kernelLockVersion: snapshot.kernelLockVersion,
            ruleSetVersion: '7',
            schemaVersion: '1',
        });
        expect(wrapper.text()).not.toContain('detector_reported');
    });

    it('explains a source build and an absent kernel declaration without substituting current agent data', () => {
        const { kernelLockVersion: _kernel, ...metadata } = snapshot;
        const { wrapper } = render(language, {
            metadata: {
                ...metadata,
                wrapperRevision: 'source',
                currentAgent: { version: '9.9.9', kernelLockVersion: 'v9.9.9' },
            },
        });
        expect(wrapper.attributes('data-status')).toBe('recorded');
        expect(wrapper.get('[data-field="wrapperRevision"]').text()).toBe(language.sourceBuild);
        expect(wrapper.get('[data-field="kernelLockVersion"]').text()).toBe(language.kernelUnknown);
        expect(wrapper.get('.execution-source').text()).toBe(language.source);
        expect(wrapper.text()).not.toContain('9.9.9');
    });

    it.each([
        ['queued', 'pending'],
        ['running', 'pending'],
        ['cancelled', 'stopped'],
        ['expired', 'stopped'],
    ])('prioritizes %s over a supplied valid declaration', (state, status) => {
        const { wrapper } = render(language, { state });
        expect(wrapper.attributes('data-status')).toBe(status);
        expect(wrapper.get('.execution-status').text()).toBe(language[status]);
        expect(wrapper.get('.execution-note').text()).toBe(language[`${status}Note`]);
        assertNoDeclaration(wrapper);
    });

    it.each([null, undefined])(
        'explains an unavailable done record without asserting why it is missing: %s',
        (metadata) => {
            const { wrapper } = render(language, { metadata });
            expect(wrapper.attributes('data-status')).toBe('unavailable');
            expect(wrapper.get('.execution-status').text()).toBe(language.unavailable);
            expect(wrapper.get('.execution-note').text()).toBe(language.unavailableNote);
            assertNoDeclaration(wrapper);
        }
    );

    it.each([
        ['unknown schema', { ...snapshot, schemaVersion: 2 }],
        ['untrusted source', { ...snapshot, source: 'PRIVATE_METADATA_FIXTURE' }],
        [
            'nested sensitive field',
            {
                ...snapshot,
                wrapperVersion: { token: 'PRIVATE_METADATA_FIXTURE', path: '/private/fixture' },
            },
        ],
    ])('distinguishes an invalid done record: %s', (_name, metadata) => {
        const { wrapper } = render(language, { metadata });
        expect(wrapper.attributes('data-status')).toBe('invalid');
        expect(wrapper.get('.execution-status').text()).toBe(language.invalid);
        expect(wrapper.get('.execution-note').text()).toBe(language.invalidNote);
        expect(wrapper.html()).not.toContain('PRIVATE_METADATA_FIXTURE');
        expect(wrapper.html()).not.toContain('/private/fixture');
        assertNoDeclaration(wrapper);
    });

    it('never renders unknown sensitive fields or their markup', () => {
        const metadata = Object.freeze({
            ...snapshot,
            token: 'PRIVATE_METADATA_FIXTURE',
            path: '/private/fixture',
            error: '<img src="PRIVATE_METADATA_FIXTURE" onerror="alert(1)">',
            nested: Object.freeze({ credentials: { password: 'PRIVATE_METADATA_FIXTURE' } }),
        });
        const { wrapper } = render(language, { metadata });
        expect(wrapper.attributes('data-status')).toBe('recorded');
        expect(wrapper.findAll('dd')).toHaveLength(9);
        expect(wrapper.html()).not.toContain('PRIVATE_METADATA_FIXTURE');
        expect(wrapper.html()).not.toContain('/private/fixture');
        expect(wrapper.find('img').exists()).toBe(false);
        expect(metadata.token).toBe('PRIVATE_METADATA_FIXTURE');
    });

    it('uses a collapsed native details element and summary without replacing their semantics', async () => {
        const { wrapper } = render(language);
        const details = wrapper.element;
        const summary = wrapper.get('summary');
        expect(details.tagName).toBe('DETAILS');
        expect(details.firstElementChild).toBe(summary.element);
        expect(details.open).toBe(false);
        expect(wrapper.attributes('open')).toBeUndefined();
        expect(summary.attributes('role')).toBeUndefined();
        expect(summary.attributes('tabindex')).toBeUndefined();
        expect(summary.attributes('aria-expanded')).toBeUndefined();
        expect(summary.find('button').exists()).toBe(false);
        details.open = true;
        await wrapper.trigger('toggle');
        expect(details.open).toBe(true);
        expect(wrapper.get('summary').text()).toContain(language.title);
        details.open = false;
        await wrapper.trigger('toggle');
        expect(details.open).toBe(false);
    });
});

it('removes previously rendered fields when a task stops or its record becomes unavailable', async () => {
    const { wrapper } = render(languages[1]);
    for (const props of [
        { state: 'cancelled', metadata: snapshot },
        { state: 'done', metadata: null },
        { state: 'done', metadata: { ...snapshot, source: 'PRIVATE_METADATA_FIXTURE' } },
        { state: 'running', metadata: snapshot },
    ]) {
        await wrapper.setProps(props);
        assertNoDeclaration(wrapper);
        expect(wrapper.html()).not.toContain('PRIVATE_METADATA_FIXTURE');
    }
    await wrapper.setProps({ state: 'done', metadata: snapshot });
    expect(wrapper.attributes('data-status')).toBe('recorded');
    expect(wrapper.get('[data-field="wrapperVersion"]').text()).toBe(snapshot.wrapperVersion);
});

it('updates display language without changing the accepted snapshot', async () => {
    const { wrapper, i18n } = render(languages[1]);
    i18n.locale.value = 'zh-CN';
    await nextTick();
    expect(wrapper.get('summary').text()).toContain(languages[0].title);
    expect(wrapper.get('.execution-source').text()).toBe(languages[0].source);
    expect(wrapper.findAll('dt').map((node) => node.text())).toEqual(languages[0].labels);
    expect(wrapper.get('[data-field="wrapperRevision"]').text()).toBe(snapshot.wrapperRevision);
});
