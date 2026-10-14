<script setup>
    import { computed } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import { runtimeDeclarationView } from '@/utils/detector-runtime-view.js';

    const props = defineProps({
        capabilities: { default: null },
        checkedAt: { default: null },
        revoked: Boolean,
    });
    const { locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    const view = computed(() =>
        runtimeDeclarationView(props.capabilities, props.checkedAt, props.revoked)
    );
    const status = computed(
        () =>
            ({
                declared: L('v1 声明 · 观测 v1', 'v1 declaration · observations v1'),
                legacy: L('旧协议 · 观测 v1', 'Legacy protocol · observations v1'),
                missing: L('未声明能力', 'Capabilities not declared'),
                unsupported_schema: L('声明版本未知', 'Unknown declaration version'),
                invalid_declaration: L('声明无效', 'Invalid declaration'),
                conflicting_versions: L('声明版本矛盾', 'Conflicting declaration versions'),
                unavailable: L('未知（无可用记录）', 'Unknown (no usable record)'),
                invalid: L('未知（记录无法识别）', 'Unknown (unreadable record)'),
            })[view.value.status]
    );
    const explanation = computed(
        () =>
            ({
                declared: L(
                    '检测器在该次领单请求中声明使用 v1 能力结构和观测协议 v1。',
                    'The detector declared capability schema v1 and observations protocol v1 in this claim request.'
                ),
                legacy: L(
                    '该次领单请求只声明了旧协议的观测 v1，未提供能力结构版本。',
                    'This claim request used the legacy observations v1 declaration without a capability schema version.'
                ),
                missing: L(
                    '该次领单请求没有能力声明，能力未知。',
                    'This claim request contained no capability declaration. Capabilities are unknown.'
                ),
                unsupported_schema: L(
                    '该次声明使用了无法识别的版本，能力未知。',
                    'This declaration used an unrecognized version. Capabilities are unknown.'
                ),
                invalid_declaration: L(
                    '该次能力声明的内容无效，能力未知。',
                    'The capability declaration was invalid. Capabilities are unknown.'
                ),
                conflicting_versions: L(
                    '该次领单请求中的版本声明不一致，能力未知。',
                    'The version declarations in this claim request conflicted. Capabilities are unknown.'
                ),
                unavailable: L(
                    '没有可展示的领单声明记录，不能据此判断检测器是否支持某项能力。',
                    'No claim declaration record is available. This does not establish whether the detector supports a capability.'
                ),
                invalid: L(
                    '该记录无法安全识别，能力未知。',
                    'This record cannot be safely interpreted. Capabilities are unknown.'
                ),
            })[view.value.status]
    );
    const date = (value) => new Date(value).toLocaleString(locale.value);
    const iso = (value) => new Date(value).toISOString();
</script>

<template>
    <details
        class="runtime-declaration"
        data-testid="detector-runtime-declaration"
        :data-state="view.status"
    >
        <summary data-testid="detector-runtime-toggle">
            <span class="runtime-summary">
                <span class="runtime-state">{{ status }}</span>
                <span v-if="view.declaration" class="runtime-freshness">
                    {{
                        view.declaration.freshness === 'fresh'
                            ? L('核对时：5 分钟内收到', 'At check: received within 5 minutes')
                            : L('核对时：记录已过期', 'At check: record stale')
                    }}
                </span>
            </span>
        </summary>
        <div class="runtime-body">
            <p>{{ explanation }}</p>
            <template v-if="view.declaration">
                <p>{{ L('来源：检测器领单自报', 'Source: detector claim declaration') }}</p>
                <dl>
                    <div>
                        <dt>{{ L('服务端收到时间', 'Received by server') }}</dt>
                        <dd>
                            <time
                                data-field="receivedAt"
                                :datetime="iso(view.declaration.receivedAt)"
                                >{{ date(view.declaration.receivedAt) }}</time
                            >
                        </dd>
                    </div>
                    <div>
                        <dt>{{ L('服务端核对时间', 'Checked by server') }}</dt>
                        <dd>
                            <time data-field="checkedAt" :datetime="iso(checkedAt)">{{
                                date(checkedAt)
                            }}</time>
                        </dd>
                    </div>
                </dl>
                <p class="runtime-note">
                    {{
                        L(
                            '仅为最近记录的领单声明，不代表当前实测能力、解锁状态或调度授权。时效以本次服务端核对为准。',
                            'Only the most recently recorded claim declaration. It does not establish current measured capabilities, unlock status or scheduling authorization. Freshness is as of this server check.'
                        )
                    }}
                </p>
            </template>
        </div>
    </details>
</template>

<style scoped>
    @reference '../../../assets/main.css';
    .runtime-declaration {
        @apply min-w-0 text-xs leading-relaxed text-gray-700 dark:text-gray-300;
        max-width: 28rem;
        white-space: normal;
        overflow-wrap: anywhere;
    }
    summary {
        min-height: 44px;
        padding: 0.65rem 0.125rem;
        cursor: pointer;
    }
    summary:focus-visible {
        @apply rounded outline outline-2 outline-offset-2 outline-indigo-500;
    }
    .runtime-summary {
        display: inline-flex;
        max-width: calc(100% - 1.5rem);
        vertical-align: top;
        flex-direction: column;
        gap: 0.25rem;
    }
    .runtime-state {
        font-weight: 500;
    }
    .runtime-body {
        @apply space-y-2 border-t border-gray-200 pt-2 dark:border-gray-700;
    }
    dl {
        @apply grid gap-2;
    }
    dt {
        @apply text-gray-600 dark:text-gray-400;
    }
</style>
