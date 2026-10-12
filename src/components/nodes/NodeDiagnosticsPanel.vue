<script setup>
    import { computed, onUnmounted, ref, watch } from 'vue';
    import { api } from '@/lib/http.js';
    import { useI18n } from '@/i18n/index.js';

    const props = defineProps({ node: { type: Object, required: true } });
    const emit = defineEmits(['close']);
    const { t } = useI18n();
    const capabilities = ref(null);
    const selected = ref([]);
    const consent = ref(false);
    const busy = ref(false);
    const loading = ref(false);
    const error = ref('');
    const report = ref(null);
    const backButton = ref(null);
    defineExpose({ focusBack: () => backButton.value?.focus() });
    const now = ref(Date.now());
    const nextRunAt = ref(0);
    let generation = 0;
    let controller;
    const clock = setInterval(() => {
        now.value = Date.now();
    }, 1000);
    const cooldown = computed(() => Math.max(0, Math.ceil((nextRunAt.value - now.value) / 1000)));
    const stale = computed(
        () => report.value?.expiresAt && Date.parse(report.value.expiresAt) <= now.value
    );
    const canRun = computed(
        () =>
            capabilities.value?.executorConfigured &&
            consent.value &&
            selected.value.length > 0 &&
            !busy.value &&
            !loading.value &&
            !cooldown.value
    );

    const invalidate = () => {
        generation++;
        controller?.abort();
        busy.value = false;
    };
    watch(
        () => props.node.url,
        async () => {
            invalidate();
            const current = generation;
            controller = new AbortController();
            consent.value = false;
            report.value = null;
            error.value = '';
            capabilities.value = null;
            loading.value = true;
            try {
                const data = await api.get('/api/nodes/diagnostics/capabilities', {
                    signal: controller.signal,
                });
                if (current !== generation) return;
                capabilities.value = data;
                selected.value = data.sources.filter((s) => s.implemented).map((s) => s.id);
            } catch {
                if (current === generation) error.value = 'failed';
            } finally {
                if (current === generation) loading.value = false;
            }
        },
        { immediate: true }
    );

    async function run() {
        if (!canRun.value) return;
        const current = ++generation;
        controller?.abort();
        controller = new AbortController();
        busy.value = true;
        error.value = '';
        report.value = null;
        consent.value = false;
        nextRunAt.value = Date.now() + 60000;
        try {
            const data = await api.post(
                '/api/nodes/diagnostics',
                { node: props.node.url, sources: [...selected.value], consent: true },
                { signal: controller.signal }
            );
            if (current === generation) report.value = data;
        } catch (e) {
            if (current === generation) error.value = e.status === 429 ? 'limited' : 'failed';
        } finally {
            if (current === generation) busy.value = false;
        }
    }
    function cancel() {
        invalidate();
        error.value = 'cancelled';
        consent.value = false;
    }
    function close() {
        invalidate();
        emit('close');
    }
    onUnmounted(() => {
        invalidate();
        clearInterval(clock);
    });
    const booleanText = (value) =>
        value === null ? t('diagnostics.unknown') : t(value ? 'diagnostics.yes' : 'diagnostics.no');
    const label = (id) => capabilities.value?.sources.find((s) => s.id === id)?.label || id;
</script>

<template>
    <section
        class="space-y-5 text-sm text-gray-700 dark:text-gray-200"
        :aria-label="t('diagnostics.title')"
    >
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <h3 class="text-lg font-bold text-gray-900 dark:text-white">
                    {{ t('diagnostics.title') }}
                </h3>
                <p class="break-words">{{ node.name || t('manualNodes.unnamed') }}</p>
            </div>
            <button
                ref="backButton"
                type="button"
                class="min-h-11 rounded-lg px-3 font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 dark:text-indigo-300 dark:hover:bg-white/10"
                @click="close"
            >
                {{ t('diagnostics.back') }}
            </button>
        </div>
        <p>{{ t('diagnostics.explanation') }}</p>
        <p v-if="loading" role="status">{{ t('diagnostics.loading') }}</p>
        <p
            v-else-if="capabilities && !capabilities.executorConfigured"
            class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            role="status"
        >
            {{ t('diagnostics.unconfigured') }}
        </p>
        <template v-if="capabilities">
            <fieldset
                :disabled="busy || !capabilities.executorConfigured"
                class="rounded-xl border border-gray-200 p-4 dark:border-gray-700"
            >
                <legend class="px-1 font-semibold">{{ t('diagnostics.sources') }}</legend>
                <div class="grid gap-2 sm:grid-cols-2">
                    <label
                        v-for="source in capabilities.sources"
                        :key="source.id"
                        class="flex min-h-11 items-center gap-3 rounded-lg px-2"
                    >
                        <input
                            v-model="selected"
                            type="checkbox"
                            :value="source.id"
                            :disabled="!source.implemented"
                            class="h-4 w-4 accent-indigo-600"
                        />
                        <span
                            >{{ source.label
                            }}<span
                                v-if="!source.implemented"
                                class="ml-2 text-gray-500 dark:text-gray-400"
                                >{{ t('diagnostics.status.unsupported') }}</span
                            ></span
                        >
                    </label>
                </div>
            </fieldset>
            <p class="text-gray-600 dark:text-gray-300">{{ t('diagnostics.unlockLimit') }}</p>
            <label
                v-if="capabilities.executorConfigured"
                class="flex min-h-11 items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700"
            >
                <input
                    v-model="consent"
                    data-testid="consent"
                    type="checkbox"
                    :disabled="busy"
                    class="mt-1 h-4 w-4 shrink-0 accent-indigo-600"
                />
                <span>{{ t('diagnostics.consent') }}</span>
            </label>
            <div class="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    data-testid="run"
                    :disabled="!canRun"
                    class="min-h-11 rounded-lg bg-indigo-600 px-4 font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50"
                    @click="run"
                >
                    {{ t(busy ? 'diagnostics.running' : 'diagnostics.run') }}
                </button>
                <button
                    v-if="busy"
                    type="button"
                    data-testid="cancel"
                    class="min-h-11 rounded-lg border border-gray-300 px-4 dark:border-gray-600"
                    @click="cancel"
                >
                    {{ t('actions.cancel') }}
                </button>
                <span v-if="cooldown">{{ t('diagnostics.cooldown', { seconds: cooldown }) }}</span>
            </div>
        </template>
        <p
            v-if="error"
            role="alert"
            class="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
            {{ t(`diagnostics.${error}`) }}
        </p>
        <p v-if="busy" role="status" aria-live="polite">{{ t('diagnostics.runningHint') }}</p>
        <div v-if="report" class="space-y-3" aria-live="polite">
            <p v-if="report.checkedAt">
                {{ t('diagnostics.checked') }}
                <time :datetime="report.checkedAt">{{
                    new Date(report.checkedAt).toLocaleString()
                }}</time>
            </p>
            <p v-if="stale" class="font-semibold text-amber-800 dark:text-amber-200">
                {{ t('diagnostics.stale') }}
            </p>
            <div
                v-if="report.conflicts?.length"
                class="rounded-xl border border-amber-300 p-4 dark:border-amber-700"
                role="status"
            >
                <p class="font-semibold">{{ t('diagnostics.conflicts') }}</p>
                <p v-for="(conflict, index) in report.conflicts" :key="index" class="break-words">
                    {{ conflict.ip || `IPv${conflict.family}` }}: {{ conflict.values.join(' / ') }}
                </p>
            </div>
            <article
                v-for="result in report.results"
                :key="result.source"
                class="space-y-2 rounded-xl border border-gray-200 p-4 dark:border-gray-700"
            >
                <div class="flex flex-wrap justify-between gap-2">
                    <h4 class="font-bold text-gray-900 dark:text-white">
                        {{ label(result.source) }}
                    </h4>
                    <span>{{ t(`diagnostics.status.${result.status}`) }}</span>
                </div>
                <p v-if="result.error">{{ t(`diagnostics.errors.${result.error}`) }}</p>
                <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div v-if="result.kind === 'latency'">
                        <dt class="text-gray-500 dark:text-gray-400">
                            {{ t('diagnostics.latency') }}
                        </dt>
                        <dd>{{ result.latencyMs === null ? '—' : `${result.latencyMs} ms` }}</dd>
                    </div>
                    <template v-if="['exit', 'quality'].includes(result.kind)">
                        <div>
                            <dt class="text-gray-500 dark:text-gray-400">
                                {{ t('diagnostics.ip') }}
                            </dt>
                            <dd class="break-all font-mono">
                                {{ result.ip || '—'
                                }}<span v-if="result.family"> (IPv{{ result.family }})</span>
                            </dd>
                        </div>
                        <div>
                            <dt class="text-gray-500 dark:text-gray-400">
                                {{ t('diagnostics.country') }}
                            </dt>
                            <dd>
                                {{ result.countryCode || t('diagnostics.unknown') }} · ASN
                                {{ result.asn ?? '—' }}
                            </dd>
                        </div>
                    </template>
                    <template v-if="result.kind === 'quality'">
                        <div>
                            <dt class="text-gray-500 dark:text-gray-400">
                                {{ t('diagnostics.risk') }}
                            </dt>
                            <dd>{{ result.riskScore ?? t('diagnostics.unknown') }}</dd>
                        </div>
                        <div>
                            <dt class="text-gray-500 dark:text-gray-400">
                                {{ t('diagnostics.flags') }}
                            </dt>
                            <dd>
                                {{ t('diagnostics.residential') }}:
                                {{ booleanText(result.isResidential) }} ·
                                {{ t('diagnostics.broadcast') }}:
                                {{ booleanText(result.isBroadcast) }}
                            </dd>
                        </div>
                    </template>
                </dl>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                    <time :datetime="result.checkedAt">{{
                        new Date(result.checkedAt).toLocaleString()
                    }}</time>
                    · {{ t('diagnostics.duration') }} {{ result.durationMs }} ms · v{{
                        result.probeVersion
                    }}<span v-if="result.httpStatus"> · HTTP {{ result.httpStatus }}</span
                    ><span v-if="result.retryAfterSeconds">
                        ·
                        {{ t('diagnostics.cooldown', { seconds: result.retryAfterSeconds }) }}</span
                    >
                </p>
            </article>
        </div>
    </section>
</template>
