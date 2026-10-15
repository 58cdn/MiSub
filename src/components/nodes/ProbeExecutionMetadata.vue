<script setup>
    import { computed } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import { executionSnapshotView } from '@/utils/probe-execution-view.js';
    import { probeVersionIdentity } from '@/shared/probe-version.js';

    const props = defineProps({
        metadata: { default: null },
        state: { type: String, default: '' },
    });
    const { locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    const view = computed(() => executionSnapshotView(props.metadata, props.state));
    const identity = computed(() => {
        const data = view.value.metadata;
        return data
            ? probeVersionIdentity(data.wrapperVersion, data.wrapperRevision, {
                  development:
                      data.buildChannel === undefined
                          ? undefined
                          : data.buildChannel === 'development',
                  sourceState: data.sourceState,
              })
            : null;
    });
    const status = computed(
        () =>
            ({
                recorded: L('已记录', 'Recorded'),
                unavailable: L('无可用记录', 'No usable record'),
                invalid: L('未知', 'Unknown'),
                pending: L('尚未记录', 'Not recorded yet'),
                stopped: L('未记录', 'Not recorded'),
            })[view.value.status]
    );
    const explanation = computed(
        () =>
            ({
                unavailable: L(
                    '该结果未记录执行声明，或声明记录不可用。当次版本未知，不能用检测器当前版本补齐。',
                    'This result has no usable declaration: it was not recorded or cannot be read. Its execution version is unknown; the detector’s current version cannot fill it in.'
                ),
                invalid: L(
                    '该执行声明无法识别，当次版本未知。',
                    'This execution declaration cannot be interpreted. Its execution version is unknown.'
                ),
                pending: L(
                    '任务完成并回传结果后才记录执行声明。',
                    'The declaration is recorded when the task returns its completed result.'
                ),
                stopped: L(
                    '任务已停止，未收到完成结果，因此没有执行声明记录。',
                    'The task stopped without a completed result, so no execution declaration was recorded.'
                ),
            })[view.value.status]
    );
    const fields = computed(() => {
        const data = view.value.metadata;
        if (!data) return [];
        return [
            ['wrapperVersion', L('检测器版本', 'Detector version'), data.wrapperVersion],
            ['displayVersion', L('构建标识', 'Build identity'), identity.value.displayVersion],
            [
                'buildChannel',
                L('构建通道', 'Build channel'),
                data.buildChannel || L('未知（历史记录未提供）', 'Unknown (not recorded)'),
            ],
            [
                'sourceState',
                L('源码状态', 'Source state'),
                data.sourceState || L('未知（历史记录未提供）', 'Unknown (not recorded)'),
            ],
            [
                'wrapperRevision',
                L('源码修订', 'Source revision'),
                data.wrapperRevision === 'source'
                    ? L('源码构建，修订未提供', 'Source build; revision not provided')
                    : data.wrapperRevision,
            ],
            ['platform', L('构建平台', 'Build platform'), data.platform],
            [
                'kernelLockVersion',
                L('内核锁版本声明', 'Kernel lock declaration'),
                data.kernelLockVersion ?? L('未知（未提供）', 'Unknown (not provided)'),
            ],
            [
                'ruleSetVersion',
                L('判定规则集版本', 'Classification rule-set version'),
                data.ruleSetVersion,
            ],
            ['schemaVersion', L('声明结构版本', 'Declaration schema version'), data.schemaVersion],
        ];
    });
</script>

<template>
    <details
        class="execution-metadata"
        data-testid="probe-execution-metadata"
        :data-status="view.status"
    >
        <summary data-testid="probe-execution-toggle">
            <span class="execution-summary">
                <span>{{ L('历史执行声明', 'Historical execution declaration') }}</span>
                <span class="execution-status">{{ status }}</span>
                <span v-if="view.metadata" class="execution-version">{{
                    view.metadata.wrapperVersion
                }}</span>
            </span>
        </summary>
        <div class="execution-body">
            <template v-if="view.metadata">
                <p class="execution-source">
                    {{ L('来源：检测器自报', 'Source: detector reported') }}
                </p>
                <p class="execution-note">
                    {{
                        L(
                            '仅对应当次结果，不代表当前能力、解锁状态或实际内核执行证明。',
                            'Applies only to this result. It does not establish current capabilities, unlock status or actual kernel execution.'
                        )
                    }}
                </p>
                <dl>
                    <div v-for="[key, label, value] in fields" :key="key">
                        <dt>{{ label }}</dt>
                        <dd :data-field="key">{{ value }}</dd>
                    </div>
                </dl>
                <p v-if="identity.migrationRequired" data-testid="probe-legacy-version">
                    {{
                        L(
                            '历史版本线；迁移到 alpha 测试线需单独验收。历史身份保持原值。',
                            'Historical version line; migration to the alpha test line requires separate acceptance. The recorded identity is preserved.'
                        )
                    }}
                </p>
                <p v-else-if="!identity.buildIdentityComplete" data-testid="probe-build-unknown">
                    {{
                        L(
                            '构建来源状态不完整或包含未提交修改，不能确认干净构建身份。',
                            'Build provenance is incomplete or modified; a clean build identity cannot be confirmed.'
                        )
                    }}
                </p>
            </template>
            <p v-else class="execution-note">{{ explanation }}</p>
        </div>
    </details>
</template>

<style scoped>
    .execution-metadata {
        width: 100%;
        max-width: 42rem;
        min-width: 0;
        border-top: 1px solid var(--border-standard-light);
        color: var(--text-primary-light);
        font-size: 0.8125rem;
        font-weight: 400;
        text-align: left;
        white-space: normal;
    }
    summary {
        min-height: 44px;
        padding: 0.7rem 0.15rem;
        cursor: pointer;
        line-height: 1.5;
    }
    summary:focus-visible {
        outline: 2px solid var(--color-primary-600);
        outline-offset: 2px;
        border-radius: var(--misub-radius-sm);
    }
    .execution-summary {
        display: inline-flex;
        max-width: calc(100% - 1.5rem);
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.75rem;
        vertical-align: top;
        font-weight: 500;
    }
    .execution-status,
    .execution-note,
    dt {
        color: var(--text-secondary-light);
    }
    .execution-version,
    dd {
        overflow-wrap: anywhere;
        word-break: normal;
    }
    .execution-body {
        padding: 0 0.15rem 0.75rem;
        line-height: 1.6;
    }
    .execution-body p {
        margin: 0 0 0.5rem;
    }
    .execution-source {
        font-weight: 500;
    }
    dl {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
        gap: 0.75rem 1.5rem;
        margin: 0.75rem 0 0;
    }
    dl > div {
        min-width: 0;
    }
    dd {
        margin: 0.15rem 0 0;
        font-weight: 500;
    }
    .dark .execution-metadata {
        border-color: var(--border-standard-dark);
        color: var(--text-primary-dark);
    }
    .dark .execution-status,
    .dark .execution-note,
    .dark dt {
        color: var(--text-secondary-dark);
    }
    .dark summary:focus-visible {
        outline-color: var(--color-primary-400);
    }
</style>
