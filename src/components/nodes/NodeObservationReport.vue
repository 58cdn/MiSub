<script setup>
    import { computed } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import { PROBE_SOURCES } from '@/utils/probe-client.js';

    const props = defineProps({
        report: { type: Object, required: true },
        now: { type: Number, default: () => Date.now() },
    });
    const { t, locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    const stale = computed(
        () => props.report.expiresAt && Date.parse(props.report.expiresAt) <= props.now
    );
    const label = (id) => PROBE_SOURCES.find((s) => s.id === id)?.label || id;
    const booleanText = (value) =>
        value == null ? t('diagnostics.unknown') : t(value ? 'diagnostics.yes' : 'diagnostics.no');
    const date = (value) => new Date(value).toLocaleString(locale.value);
</script>

<template>
    <section class="observation-report" :aria-label="L('各来源证据', 'Evidence by source')">
        <p v-if="stale" class="observation-warning" role="status">{{ t('diagnostics.stale') }}</p>
        <div v-if="report.conflicts?.length" class="observation-warning" role="status">
            <strong>{{ t('diagnostics.conflicts') }}</strong>
            <p v-for="(conflict, index) in report.conflicts" :key="index">
                {{ conflict.ip || `IPv${conflict.family}` }}: {{ conflict.values.join(' / ') }}
            </p>
        </div>
        <p class="observation-note">
            {{
                L(
                    '各来源独立报告；来源耗时不是节点延迟。',
                    'Sources report independently; source duration is not node latency.'
                )
            }}
        </p>
        <article
            v-for="result in report.results"
            :key="result.source"
            class="observation-source"
            :data-source="result.source"
        >
            <header>
                <strong>{{ label(result.source) }}</strong
                ><span>{{ t(`diagnostics.status.${result.status}`) }}</span>
            </header>
            <p v-if="result.error">{{ t(`diagnostics.errors.${result.error}`) }}</p>
            <dl>
                <div>
                    <dt>{{ t('diagnostics.ip') }}</dt>
                    <dd class="observation-ip">
                        {{ result.ip || t('diagnostics.unknown')
                        }}<span v-if="result.family"> (IPv{{ result.family }})</span>
                    </dd>
                </div>
                <div>
                    <dt>{{ t('diagnostics.country') }}</dt>
                    <dd>
                        {{ result.countryCode || t('diagnostics.unknown') }} · ASN
                        {{ result.asn ?? '—' }}
                    </dd>
                </div>
                <template v-if="result.kind === 'quality'">
                    <div>
                        <dt>{{ t('diagnostics.risk') }}</dt>
                        <dd>{{ result.riskScore ?? t('diagnostics.unknown') }}</dd>
                    </div>
                    <div>
                        <dt>{{ t('diagnostics.flags') }}</dt>
                        <dd>
                            {{ t('diagnostics.residential') }}:
                            {{ booleanText(result.isResidential) }} ·
                            {{ t('diagnostics.broadcast') }}: {{ booleanText(result.isBroadcast) }}
                        </dd>
                    </div>
                </template>
            </dl>
            <p v-if="result.kind === 'quality'" class="observation-note">
                {{
                    L(
                        'IPPure 实验性评分，未验证其准确性；缺失值保持未知。',
                        'Experimental IPPure score; accuracy is unverified and missing values stay unknown.'
                    )
                }}
            </p>
            <p class="observation-note">
                <time :datetime="result.checkedAt">{{ date(result.checkedAt) }}</time> ·
                {{ t('diagnostics.duration') }} {{ result.durationMs }} ms · v{{
                    result.probeVersion
                }}<span v-if="result.httpStatus != null"> · HTTP {{ result.httpStatus }}</span
                ><span v-if="result.retryAfterSeconds != null">
                    · {{ t('diagnostics.cooldown', { seconds: result.retryAfterSeconds }) }}</span
                >
            </p>
        </article>
    </section>
</template>

<style scoped>
    .observation-report {
        min-width: 17rem;
        max-width: 30rem;
        line-height: 1.6;
        overflow-wrap: anywhere;
    }
    .observation-warning {
        margin: 0.6rem 0;
        padding: 0.6rem;
        border: 1px solid #d9770680;
        border-radius: 0.4rem;
        background: #b4530918;
    }
    .observation-source {
        margin: 0.65rem 0;
        padding: 0.65rem;
        border: 1px solid #64748b45;
        border-radius: 0.5rem;
    }
    .observation-source header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 0.4rem;
    }
    .observation-source dl {
        display: grid;
        gap: 0.5rem;
        margin: 0.5rem 0;
    }
    .observation-source dt,
    .observation-note {
        color: var(--probe-muted, #6b7280);
        font-size: 0.75rem;
    }
    .observation-source dd {
        margin: 0;
    }
    .observation-ip {
        font-family: ui-monospace, monospace;
    }
    .observation-note {
        margin: 0.5rem 0;
    }
    @media (min-width: 640px) {
        .observation-source dl {
            grid-template-columns: 1fr 1fr;
        }
    }
</style>
