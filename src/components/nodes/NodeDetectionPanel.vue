<script setup>
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import { useI18n } from '@/i18n/index.js';
    import {
        PROBE_TYPES,
        PROBE_SERVICES,
        PROBE_SOURCES,
        DEFAULT_PROBE_SOURCES,
        DEFAULT_PROBE_SERVICES,
        selectedProbeNodes,
        makeProbePlan,
        probeRequest,
        probeBytes,
    } from '@/utils/probe-client.js';

    import NodeObservationReport from './NodeObservationReport.vue';

    const props = defineProps({
        nodes: { type: Array, default: () => [] },
        selectedNodeIds: { type: [Set, Array], default: () => new Set() },
        embedded: { type: Boolean, default: false },
    });
    const emit = defineEmits(['select-nodes']);
    const { locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    const selectedCount = computed(() =>
        props.selectedNodeIds instanceof Set
            ? props.selectedNodeIds.size
            : props.selectedNodeIds.length
    );
    const open = ref(false),
        scope = ref('selected'),
        busy = ref(false),
        error = ref(''),
        notice = ref('');
    const capabilities = ref(null),
        agents = ref([]),
        jobs = ref([]),
        agentIds = ref([]);
    const types = ref(['format', 'tcp', 'proxy']),
        services = ref([...DEFAULT_PROBE_SERVICES]);
    const sources = ref([...DEFAULT_PROBE_SOURCES]),
        now = ref(Date.now());
    const observationsAvailable = computed(() => capabilities.value?.observationsVersion === 1);
    const timeoutMs = ref(5000),
        downloadMiB = ref(5),
        consent = ref(false),
        allowMetered = ref(false);
    const submission = ref(null),
        completedBatches = ref(0);
    const viewedJob = ref(''),
        resultData = ref(null),
        offset = ref(0),
        detectorFilter = ref(''),
        resultBusy = ref(false);
    const localResults = ref([]),
        sortBy = ref('name');
    let timer = null,
        reading = false,
        readController = null,
        submissionController = null,
        resultController = null,
        resultGeneration = 0,
        resultIdentity = '',
        mounted = true;
    const clock = setInterval(() => {
        if (open.value) now.value = Date.now();
    }, 1000);
    // Clear evidence at the moment the selected job/page changes, including
    // submissions whose later history refresh can fail before loadResults runs.
    watch(
        [viewedJob, offset],
        () => {
            resultController?.abort();
            resultGeneration++;
            resultBusy.value = false;
            resultIdentity = '';
            resultData.value = null;
        },
        { flush: 'sync' }
    );
    const typeLabel = (type) =>
        ({
            format: L('格式检查', 'Format'),
            tcp: L('TCP 连接', 'TCP connect'),
            proxy: L('节点 HTTP 延迟', 'Node HTTP latency'),
            speed: L('下载测速', 'Download speed'),
            unlock: L('服务与地区证据', 'Service / region evidence'),
            observations: L('出口 IP / 质量', 'Exit IP / quality'),
        })[type] || type;
    const statusLabel = (status) =>
        ({
            passed: L('通过', 'Passed'),
            failed: L('失败', 'Failed'),
            timeout: L('超时', 'Timed out'),
            blocked: L('受限', 'Blocked'),
            unknown: L('未知', 'Unknown'),
            unsupported: L('不支持 / 不适用', 'Unsupported / N/A'),
            skipped: L('未执行', 'Skipped'),
            cancelled: L('已取消', 'Cancelled'),
            queued: L('等待检测器', 'Queued'),
            running: L('检测中', 'Running'),
            done: L('完成', 'Done'),
            expired: L('已过期', 'Expired'),
        })[status] || status;
    const checkLabel = (check) =>
        !check
            ? '—'
            : check.report && check.status === 'unknown'
              ? L(`${check.report.results.length} 个来源`, `${check.report.results.length} sources`)
              : check.code === 'service_reachable'
                ? L('可访问，解锁未知', 'Reachable; unlock unknown')
                : statusLabel(check.status);
    const activeAgents = computed(() => agents.value.filter((a) => !a.revokedAt));
    const network = computed(() => types.value.some((t) => t !== 'format'));
    const targetCount = computed(() =>
        scope.value === 'all' ? props.nodes.length : selectedCount.value
    );
    const budget = computed(() =>
        types.value.includes('speed')
            ? targetCount.value * agentIds.value.length * downloadMiB.value * 1024 ** 2 * 3
            : 0
    );
    const ready = computed(
        () =>
            types.value.length &&
            targetCount.value &&
            (!network.value ||
                (capabilities.value?.storageReady && agentIds.value.length && consent.value)) &&
            (!types.value.includes('speed') || allowMetered.value) &&
            (!types.value.includes('unlock') || services.value.length) &&
            (!types.value.includes('observations') ||
                (observationsAvailable.value && sources.value.length)) &&
            budget.value <= 1024 ** 3
    );
    const locked = computed(() => busy.value || submission.value !== null);
    const date = (value) => (value ? new Date(value).toLocaleString(locale.value) : '—');
    const rows = computed(() => {
        const list = viewedJob.value ? resultData.value?.nodes || [] : localResults.value;
        const filtered = detectorFilter.value
            ? list.filter((n) => n.agent_id === detectorFilter.value)
            : list;
        return [...filtered].sort((a, b) => {
            if (sortBy.value === 'latency' && detectorFilter.value) {
                const x = a.checks?.proxy,
                    y = b.checks?.proxy;
                const d =
                    (x?.status === 'passed' ? (x.latencyMs ?? Infinity) : Infinity) -
                    (y?.status === 'passed' ? (y.latencyMs ?? Infinity) : Infinity);
                if (Number.isFinite(d) && d !== 0) return d;
                if (d === -Infinity || d === Infinity) return d;
            }
            return String(a.node_name || a.name).localeCompare(
                String(b.node_name || b.name),
                locale.value
            );
        });
    });
    function errorText(code) {
        const messages = {
            unauthorized: L('登录已失效，请重新登录。', 'Your session expired. Sign in again.'),
            probe_storage_not_configured: L(
                '未绑定检测任务数据库 MISUB_PROBE_DB。格式检查仍可用。',
                'MISUB_PROBE_DB is not bound. Format checking remains available.'
            ),
            job_traffic_limit: L(
                '最坏重试下载量超过 1 GiB，请减少节点、检测器或单节点流量。',
                'Worst-case downloads exceed 1 GiB. Reduce nodes, detectors or per-node bytes.'
            ),
            selection_changed: L(
                '选择中的节点已发生变化，请重新选择。',
                'Selected nodes changed. Select them again.'
            ),
            request_cancelled_or_timeout: L(
                '请求中断或超时。提交任务可安全重试，不会重复创建同一批任务。',
                'Request timed out or was interrupted. Retrying submission will not duplicate the batch.'
            ),
            select_detectors: L('请选择 1–8 个检测器。', 'Select 1–8 detectors.'),
            no_nodes: L('没有可检测的节点。', 'No nodes to check.'),
            batch_limit: L(
                '单次最多 20 批，请减少节点后提交。',
                'Limit: 20 batches per submission. Select fewer nodes.'
            ),
            invalid_sources: L(
                '请选择至少一个可用的来源。',
                'Select at least one available source.'
            ),
            agent_unavailable: L(
                '检测器已撤销或不存在，请重新选择。',
                'A detector was revoked or removed. Select again.'
            ),
        };
        return messages[code] || `${L('操作失败', 'Operation failed')}: ${code}`;
    }
    async function refresh() {
        if (!open.value || reading) return;
        reading = true;
        const controller = new AbortController();
        readController = controller;
        try {
            const cap = await probeRequest('capabilities', { signal: controller.signal });
            if (!open.value) return;
            capabilities.value = cap;
            if (cap.storageReady) {
                const [a, j] = await Promise.all([
                    probeRequest('agents', { signal: controller.signal }),
                    probeRequest('jobs', { signal: controller.signal }),
                ]);
                if (controller.signal.aborted || !open.value) return;
                agents.value = a;
                jobs.value = j;
            }
        } catch (e) {
            if (!controller.signal.aborted && open.value) error.value = errorText(e.message);
        } finally {
            reading = false;
            if (open.value)
                timer = setTimeout(async () => {
                    await refresh();
                    if (viewedJob.value) await loadResults();
                }, 5000);
        }
    }
    function show(nextScope) {
        if (locked.value) return;
        scope.value = nextScope;
        error.value = '';
        notice.value = '';
        consent.value = false;
        allowMetered.value = false;
        if (!open.value) {
            open.value = true;
            refresh();
        }
    }
    function close() {
        if (busy.value) return;
        open.value = false;
        clearTimeout(timer);
        readController?.abort();
        resultController?.abort();
        resultGeneration++;
        resultBusy.value = false;
        resultIdentity = '';
        submission.value = null;
        localResults.value = [];
        resultData.value = null;
        viewedJob.value = '';
    }
    onMounted(() => {
        if (props.embedded) show('selected');
    });
    onBeforeUnmount(() => {
        mounted = false;
        open.value = false;
        clearTimeout(timer);
        clearInterval(clock);
        readController?.abort();
        submissionController?.abort();
        resultController?.abort();
        resultGeneration++;
        submission.value = null;
    });
    async function submit() {
        if (busy.value || (!submission.value && !ready.value)) return;
        busy.value = true;
        error.value = '';
        notice.value = '';
        submissionController = new AbortController();
        try {
            if (!submission.value) {
                const nodes = selectedProbeNodes(props.nodes, props.selectedNodeIds, scope.value);
                const plan = makeProbePlan(nodes, types.value, agentIds.value, {
                    timeoutMs: Number(timeoutMs.value),
                    downloadBytes: Math.round(downloadMiB.value * 1024 ** 2),
                    services: [...services.value],
                    allowMetered: allowMetered.value,
                    ...(types.value.includes('observations')
                        ? { observationsVersion: 1, sources: [...sources.value] }
                        : {}),
                });
                submission.value = {
                    ...plan,
                    chunks: plan.chunks.map((body) => ({ body, key: crypto.randomUUID() })),
                };
                completedBatches.value = 0;
                localResults.value = [];
            }
            const plan = submission.value;
            for (let i = completedBatches.value; i < plan.chunks.length; i++) {
                if (!mounted) throw new Error('request_cancelled_or_timeout');
                const { body, key } = plan.chunks[i];
                const result = await probeRequest(plan.network ? 'jobs' : 'format', {
                    method: 'POST',
                    body,
                    key,
                    signal: submissionController.signal,
                });
                if (!mounted) return;
                completedBatches.value = i + 1;
                if (plan.network) {
                    viewedJob.value = result.id;
                    offset.value = 0;
                } else
                    localResults.value.push(
                        ...result.nodes.map((n) => ({
                            ...n,
                            node_name: n.name,
                            agent_name: 'MiSub',
                            state: 'done',
                        }))
                    );
            }
            const count = plan.chunks.length;
            submission.value = null;
            consent.value = false;
            allowMetered.value = false;
            notice.value = L(
                `已提交 ${count} 批。关闭面板不会取消已提交任务。`,
                `${count} batches submitted. Closing this panel does not cancel jobs.`
            );
            if (plan.network) {
                jobs.value = await probeRequest('jobs', { signal: submissionController.signal });
                if (mounted) await loadResults();
            } else {
                viewedJob.value = '';
                resultData.value = null;
            }
        } catch (e) {
            error.value = errorText(e.message);
        } finally {
            busy.value = false;
        }
    }
    function discardSubmission() {
        submission.value = null;
        consent.value = false;
        allowMetered.value = false;
    }
    async function loadResults(resetJob) {
        if (!open.value || (resultBusy.value && !resetJob)) return;
        if (resetJob) {
            viewedJob.value = resetJob;
            offset.value = 0;
            detectorFilter.value = '';
        }
        const id = viewedJob.value,
            page = offset.value;
        if (!id) return;
        const identity = `${id}:${page}`;
        if (identity !== resultIdentity) resultData.value = null;
        resultIdentity = identity;
        resultController?.abort();
        const controller = new AbortController();
        resultController = controller;
        const generation = ++resultGeneration;
        resultBusy.value = true;
        try {
            const r = await probeRequest(`jobs/${encodeURIComponent(id)}?offset=${page}`, {
                signal: controller.signal,
            });
            if (
                mounted &&
                open.value &&
                generation === resultGeneration &&
                viewedJob.value === id &&
                offset.value === page
            )
                resultData.value = r;
        } catch (e) {
            if (
                mounted &&
                open.value &&
                !controller.signal.aborted &&
                generation === resultGeneration
            )
                error.value = errorText(e.message);
        } finally {
            if (generation === resultGeneration) resultBusy.value = false;
        }
    }
    async function cancelJob(id) {
        if (
            !window.confirm(
                L(
                    '取消此任务尚未完成的检测？已完成结果保留。',
                    'Cancel unfinished checks? Completed results are retained.'
                )
            )
        )
            return;
        try {
            await probeRequest(`jobs/${encodeURIComponent(id)}/cancel`, {
                method: 'POST',
                body: {},
            });
            jobs.value = await probeRequest('jobs');
            await loadResults();
        } catch (e) {
            error.value = errorText(e.message);
        }
    }
</script>

<template>
    <section class="probe-panel" :class="{ 'probe-embedded': embedded }" data-testid="probe-panel">
        <div v-if="!embedded" class="probe-toolbar">
            <strong>{{ L('节点检测', 'Node checks') }}</strong>
            <button data-testid="probe-select" type="button" @click="emit('select-nodes')">
                {{ L('选择节点', 'Select nodes') }}
            </button>
            <button
                data-testid="probe-selected"
                type="button"
                :disabled="!selectedCount || locked"
                @click="show('selected')"
            >
                {{ L('检测选中', 'Check selected') }} ({{ selectedCount }})
            </button>
            <button
                data-testid="probe-all"
                type="button"
                :disabled="!nodes.length || locked"
                @click="show('all')"
            >
                {{ L('检测全部', 'Check all') }} ({{ nodes.length }})
            </button>
            <button type="button" :disabled="locked" @click="show(scope)">
                {{ L('检测器与记录', 'Detectors & history') }}
            </button>
        </div>
        <div v-if="open" class="probe-content">
            <header class="probe-toolbar">
                <h3>
                    {{
                        scope === 'all'
                            ? L(
                                  '全部节点（跨页，包含已禁用节点）',
                                  'All nodes across pages, including disabled nodes'
                              )
                            : L('仅所选节点', 'Selected nodes only')
                    }}
                    · {{ targetCount }}
                </h3>
                <button v-if="!embedded" type="button" :disabled="busy" @click="close">
                    {{ L('收起', 'Close') }}
                </button>
            </header>
            <p class="probe-muted">
                {{
                    L(
                        '格式检查由 MiSub 执行；其他检测由选定地点的检测器执行。不会删除、禁用或改名原始节点。',
                        'MiSub validates format. Selected detectors perform network checks from their locations. Original nodes are never deleted, disabled or renamed.'
                    )
                }}
            </p>
            <p v-if="error" class="probe-error" role="alert">{{ error }}</p>
            <p v-if="notice" class="probe-notice" role="status">{{ notice }}</p>
            <p v-if="capabilities && !capabilities.storageReady" class="probe-warning">
                {{
                    L(
                        '尚未绑定 MISUB_PROBE_DB，当前仅可做格式检查。请完成检测数据库部署后添加检测器。',
                        'MISUB_PROBE_DB is not configured. Only format checks are available until deployment is completed.'
                    )
                }}
            </p>
            <div class="probe-columns">
                <div>
                    <fieldset :disabled="locked">
                        <legend>{{ L('检测内容', 'Check types') }}</legend>
                        <div class="probe-options">
                            <label v-for="type in PROBE_TYPES" :key="type"
                                ><input
                                    v-model="types"
                                    type="checkbox"
                                    :value="type"
                                    :disabled="type === 'observations' && !observationsAvailable"
                                    :data-testid="`probe-type-${type}`"
                                />{{ typeLabel(type) }}</label
                            >
                        </div>
                        <p v-if="capabilities && !observationsAvailable" class="probe-muted">
                            {{
                                L(
                                    '当前服务器尚不支持来源观测。',
                                    'This server does not yet support source observations.'
                                )
                            }}
                        </p>
                        <template v-if="types.includes('observations')">
                            <div class="probe-options">
                                <label v-for="source in PROBE_SOURCES" :key="source.id"
                                    ><input
                                        v-model="sources"
                                        type="checkbox"
                                        :value="source.id"
                                        :disabled="source.unavailable"
                                        :data-testid="`probe-source-${source.id}`"
                                    />{{ source.label
                                    }}<span v-if="source.unavailable">{{
                                        L('（未配置）', '(not configured)')
                                    }}</span
                                    ><span v-if="source.experimental">{{
                                        L('（实验性）', '(experimental)')
                                    }}</span></label
                                >
                            </div>
                            <p class="probe-muted">
                                {{
                                    L(
                                        'IPinfo 需要检测器端凭据支持，当前未启用。IPPure 需主动选择，评分准确性尚未验证。检测器须支持来源观测；旧版会跳过此类任务。',
                                        'IPinfo requires detector-side credential support and is currently unavailable. IPPure is opt-in and its accuracy is unverified. Detectors must support observations; older versions skip these tasks.'
                                    )
                                }}
                            </p>
                        </template>
                        <label class="probe-field"
                            >{{ L('单项超时（毫秒）', 'Per-check timeout (ms)') }}
                            <input
                                v-model.number="timeoutMs"
                                type="number"
                                min="1000"
                                max="15000"
                                step="1000"
                        /></label>
                        <template v-if="types.includes('unlock')">
                            <div class="probe-options">
                                <label v-for="service in PROBE_SERVICES" :key="service"
                                    ><input
                                        v-model="services"
                                        type="checkbox"
                                        :value="service"
                                        :data-testid="`probe-service-${service}`"
                                    />{{ service }}</label
                                >
                            </div>
                            <p class="probe-warning">
                                {{
                                    L(
                                        '网页可访问不等于解锁成功；地区拒绝、限流和未知会分别显示。不验证账号套餐或真实播放。',
                                        'Page access does not prove unlock. Region denial, rate limits and unknown results remain distinct. No account or playback verification.'
                                    )
                                }}
                            </p>
                        </template>
                        <template v-if="types.includes('speed')">
                            <label class="probe-field"
                                >{{ L('每节点最多读取（MiB）', 'Read cap per node (MiB)') }}
                                <input
                                    v-model.number="downloadMiB"
                                    type="number"
                                    min="0.0625"
                                    max="20"
                                    step="1"
                            /></label>
                            <p class="probe-warning">
                                {{
                                    L(
                                        '包含三个尝试的最大读取预算',
                                        'Read budget including three attempts'
                                    )
                                }}: {{ probeBytes(budget) }}.
                                {{
                                    L(
                                        '另有 TLS、协议头和缓冲流量。',
                                        'TLS, protocol headers and buffering consume additional bytes.'
                                    )
                                }}
                            </p>
                            <label
                                ><input v-model="allowMetered" type="checkbox" />{{
                                    L(
                                        '允许本次下载消耗流量',
                                        'Allow metered downloads for this run'
                                    )
                                }}</label
                            >
                        </template>
                    </fieldset>
                    <fieldset v-if="network" :disabled="locked">
                        <legend>
                            {{ L('检测地点（最多 8 个）', 'Detector locations (up to 8)') }}
                        </legend>
                        <a
                            href="/dashboard/settings?focus=detectors"
                            data-testid="probe-manage-detectors"
                            class="inline-flex min-h-11 items-center rounded-lg px-2 focus-visible:outline-2"
                        >
                            {{ L('添加 / 管理检测器', 'Add / manage detectors') }}
                        </a>
                        <div class="probe-agent-list">
                            <label v-for="a in activeAgents" :key="a.id"
                                ><input
                                    v-model="agentIds"
                                    type="checkbox"
                                    :value="a.id"
                                    :data-testid="`probe-agent-${a.id}`"
                                />{{ a.name }}
                                <small>{{
                                    a.lastSeen
                                        ? `${L('最近通信', 'Last contact')}: ${date(a.lastSeen)}`
                                        : L('尚无通信记录', 'No contact recorded')
                                }}</small></label
                            >
                        </div>
                        <p v-if="!activeAgents.length" class="probe-muted">
                            {{
                                L(
                                    '在设置中添加检测器，再到检测机器运行它。',
                                    'Add a detector in Settings, then run it on your machine.'
                                )
                            }}
                        </p>
                        <label class="probe-consent"
                            ><input
                                v-model="consent"
                                data-testid="probe-consent"
                                type="checkbox"
                            />{{
                                L(
                                    '同意将本次节点连接凭据发送给选中的自有检测器，并由它们访问节点和测试服务。',
                                    'Send this run’s node credentials to the selected trusted detectors and allow them to contact the nodes and test services.'
                                )
                            }}</label
                        >
                    </fieldset>
                    <div class="probe-toolbar">
                        <button
                            data-testid="probe-submit"
                            class="probe-primary"
                            type="button"
                            :disabled="busy || (!submission && !ready)"
                            @click="submit"
                        >
                            {{
                                busy
                                    ? L('提交中…', 'Submitting…')
                                    : submission
                                      ? L('重试未完成提交', 'Retry pending submission')
                                      : L('开始检测', 'Start checks')
                            }}
                        </button>
                        <span v-if="submission"
                            >{{ completedBatches }} / {{ submission.chunks.length }}
                            {{ L('批已提交', 'batches submitted') }}</span
                        >
                        <button
                            v-if="submission && !busy"
                            data-testid="probe-discard"
                            type="button"
                            @click="discardSubmission"
                        >
                            {{ L('放弃剩余提交', 'Discard pending batches') }}
                        </button>
                    </div>
                </div>
            </div>
            <details v-if="jobs.length" class="probe-history" open>
                <summary>{{ L('最近任务', 'Recent jobs') }}</summary>
                <div class="probe-job-list">
                    <div v-for="job in jobs" :key="job.id" class="probe-job">
                        <button type="button" :disabled="resultBusy" @click="loadResults(job.id)">
                            {{ date(job.created_at) }} ·
                            {{ job.types.map(typeLabel).join(' / ') }}</button
                        ><span
                            >{{ job.done + job.stopped }}/{{ job.total }} ·
                            {{ L('等待', 'Queued') }} {{ job.queued }} ·
                            {{ L('进行中', 'Running') }} {{ job.running }}</span
                        ><button
                            v-if="job.queued + job.running"
                            type="button"
                            @click="cancelJob(job.id)"
                        >
                            {{ L('取消', 'Cancel') }}
                        </button>
                    </div>
                </div>
            </details>
            <div v-if="viewedJob || localResults.length" class="probe-results">
                <div class="probe-toolbar">
                    <h4>{{ L('检测结果', 'Results') }}</h4>
                    <select v-model="detectorFilter" :aria-label="L('结果地点', 'Result location')">
                        <option value="">{{ L('所有地点', 'All locations') }}</option>
                        <option v-for="a in agents" :key="a.id" :value="a.id">
                            {{ a.name }}
                        </option></select
                    ><select v-model="sortBy" :aria-label="L('排序', 'Sort')">
                        <option value="name">{{ L('按名称', 'Name') }}</option>
                        <option value="latency" :disabled="!detectorFilter">
                            {{ L('该地点代理延迟', 'Proxy latency at selected location') }}
                        </option>
                    </select>
                </div>
                <p class="probe-muted">
                    {{
                        L(
                            '不同地点的延迟不可混作本机延迟。筛选和排序作用于当前结果页；完整结果按页查看。',
                            'Different locations do not represent your local latency. Filtering and sorting apply to this result page; page through the full result set.'
                        )
                    }}
                </p>
                <div class="probe-table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">{{ L('节点 / 地点', 'Node / location') }}</th>
                                <th scope="col">{{ L('状态 / 时间', 'State / time') }}</th>
                                <th v-for="type in PROBE_TYPES" :key="type" scope="col">
                                    {{ typeLabel(type) }}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(row, index) in rows" :key="row.id || index">
                                <th scope="row">
                                    {{ row.node_name || row.name
                                    }}<small>{{ row.agent_name || 'MiSub' }}</small>
                                </th>
                                <td>
                                    {{ statusLabel(row.state)
                                    }}<small>{{ date(row.completed_at) }}</small>
                                </td>
                                <td v-for="type in PROBE_TYPES" :key="type">
                                    <span
                                        :class="[
                                            'probe-state',
                                            `probe-state-${row.checks?.[type]?.status || 'unknown'}`,
                                        ]"
                                        :title="row.checks?.[type]?.code"
                                        >{{ checkLabel(row.checks?.[type]) }}</span
                                    >
                                    <small v-if="row.checks?.[type]?.latencyMs != null"
                                        >{{ row.checks[type].latencyMs }} ms</small
                                    >
                                    <small v-if="row.checks?.[type]?.bytesPerSecond != null"
                                        >{{ probeBytes(row.checks[type].bytesPerSecond) }}/s ·
                                        {{ probeBytes(row.checks[type].bytes) }}</small
                                    >
                                    <small v-if="row.checks?.[type]?.httpStatus != null"
                                        >HTTP {{ row.checks[type].httpStatus }}</small
                                    >
                                    <small v-if="row.checks?.[type]?.retryAfterSeconds != null"
                                        >{{ L('稍后重试', 'Retry after') }}
                                        {{ row.checks[type].retryAfterSeconds }} s</small
                                    >
                                    <details v-if="row.checks?.[type]?.services?.length">
                                        <summary>{{ L('服务明细', 'Services') }}</summary>
                                        <div
                                            v-for="s in row.checks[type].services"
                                            :key="s.service"
                                        >
                                            {{ s.service }}: {{ checkLabel(s)
                                            }}<small
                                                >{{ s.code
                                                }}<span v-if="s.httpStatus != null">
                                                    · HTTP {{ s.httpStatus }}</span
                                                ><span v-if="s.retryAfterSeconds != null">
                                                    · {{ L('稍后重试', 'Retry after') }}
                                                    {{ s.retryAfterSeconds }} s</span
                                                ></small
                                            >
                                            <small v-if="s.checkedAt"
                                                ><time :datetime="s.checkedAt">{{
                                                    date(s.checkedAt)
                                                }}</time></small
                                            >
                                            <small v-else>{{
                                                L('来源时间未提供', 'Provider time unavailable')
                                            }}</small>
                                        </div>
                                    </details>
                                    <details
                                        v-if="row.checks?.[type]?.report"
                                        data-testid="probe-observation-details"
                                    >
                                        <summary>
                                            {{ L('来源明细', 'Sources')
                                            }}<span
                                                v-if="row.checks[type].report.conflicts?.length"
                                            >
                                                · {{ L('存在冲突', 'Conflicting evidence') }}</span
                                            >
                                        </summary>
                                        <NodeObservationReport
                                            :report="row.checks[type].report"
                                            :now="now"
                                        />
                                    </details>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div v-if="viewedJob" class="probe-toolbar">
                    <button
                        type="button"
                        :disabled="offset === 0 || resultBusy"
                        @click="
                            offset = Math.max(0, offset - 200);
                            loadResults();
                        "
                    >
                        {{ L('上一页', 'Previous') }}</button
                    ><span
                        >{{ offset + 1 }}–{{ offset + (resultData?.nodes?.length || 0) }} /
                        {{ resultData?.job?.total || 0 }}</span
                    ><button
                        type="button"
                        :disabled="resultData?.nextOffset == null || resultBusy"
                        @click="
                            offset = resultData.nextOffset;
                            loadResults();
                        "
                    >
                        {{ L('下一页', 'Next') }}
                    </button>
                </div>
            </div>
        </div>
    </section>
</template>

<style scoped>
    .probe-panel {
        margin: 1rem 0;
        border: 1px solid #d1d5db;
        border-radius: 0.8rem;
        background: var(--probe-bg, #fff);
        color: var(--probe-text, #1f2937);
        font-size: 0.875rem;
    }
    .probe-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.6rem;
        padding: 0.7rem;
    }
    .probe-toolbar h3,
    .probe-toolbar h4 {
        flex: 1;
        font-weight: 600;
        margin: 0;
    }
    .probe-content {
        padding: 0 0.9rem 1rem;
        border-top: 1px solid #e5e7eb;
    }
    .probe-columns {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 1rem;
    }
    .probe-options {
        display: flex;
        flex-wrap: wrap;
        gap: 0.7rem 1rem;
        margin: 0.7rem 0;
    }
    .probe-panel label {
        min-height: 2.75rem;
        display: inline-flex;
        align-items: flex-start;
        gap: 0.4rem;
    }
    .probe-panel input[type='checkbox'] {
        margin-top: 0.2rem;
    }
    .probe-panel fieldset {
        border: 1px solid #d1d5db;
        border-radius: 0.5rem;
        padding: 0.7rem;
        margin: 0.8rem 0;
    }
    .probe-panel legend,
    .probe-panel summary {
        font-weight: 600;
        padding: 0 0.3rem;
    }
    .probe-panel summary {
        cursor: pointer;
        min-height: 2.75rem;
        align-content: center;
    }
    .probe-field {
        margin: 0.4rem 0;
    }
    .probe-panel input:not([type='checkbox']),
    .probe-panel select {
        border: 1px solid #9ca3af;
        background: transparent;
        border-radius: 0.4rem;
        padding: 0.35rem 0.5rem;
        max-width: 100%;
    }
    .probe-panel input[type='number'] {
        width: 7rem;
    }
    .probe-panel button {
        min-height: 2.75rem;
        padding: 0.4rem 0.7rem;
        border: 1px solid #9ca3af;
        border-radius: 0.45rem;
        background: transparent;
        cursor: pointer;
    }
    .probe-panel button:hover:not(:disabled) {
        background: #64748b18;
    }
    .probe-panel button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }
    .probe-panel button:focus-visible,
    .probe-panel input:focus-visible,
    .probe-panel select:focus-visible,
    .probe-panel summary:focus-visible,
    .probe-panel a:focus-visible {
        outline: 2px solid #6366f1;
        outline-offset: 2px;
    }
    .probe-panel .probe-primary {
        background: #4f46e5;
        color: #fff;
        border-color: #4f46e5;
    }
    .probe-panel .probe-primary:hover:not(:disabled) {
        background: #4338ca;
    }
    .probe-muted {
        color: var(--probe-muted, #6b7280);
        line-height: 1.6;
        margin: 0.5rem 0;
    }
    .probe-warning,
    .probe-error,
    .probe-notice {
        padding: 0.65rem;
        border-radius: 0.4rem;
        line-height: 1.6;
        margin: 0.65rem 0;
    }
    .probe-warning {
        background: #b4530918;
        border: 1px solid #d9770670;
    }
    .probe-error {
        background: #dc262615;
        border: 1px solid #dc262680;
    }
    .probe-notice {
        background: #05966915;
        border: 1px solid #05966970;
    }
    .probe-agent-list {
        display: grid;
        gap: 0.6rem;
    }
    .probe-consent {
        margin-top: 0.9rem;
        line-height: 1.6;
    }
    .probe-panel small {
        display: block;
        color: var(--probe-muted, #6b7280);
        font-size: 0.75rem;
        line-height: 1.5;
    }
    .probe-panel aside {
        min-width: 0;
        padding: 0.8rem 0;
    }
    .probe-panel pre {
        font-size: 0.75rem;
        line-height: 1.7;
        overflow: auto;
        background: #64748b14;
        border-radius: 0.4rem;
        padding: 0.7rem;
        margin: 0.6rem 0;
    }
    .probe-panel a {
        color: #6366f1;
        text-decoration: underline;
    }
    .probe-job {
        display: flex;
        justify-content: space-between;
        gap: 0.6rem;
        align-items: center;
        border-bottom: 1px solid #64748b30;
        padding: 0.5rem 0;
    }
    .probe-history {
        margin: 1rem 0;
    }
    .probe-job-list {
        max-height: 18rem;
        overflow: auto;
    }
    .probe-job {
        flex-wrap: wrap;
    }
    .probe-results {
        margin-top: 1rem;
    }
    .probe-table-scroll {
        overflow: auto;
    }
    .probe-panel table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.8rem;
    }
    .probe-panel th,
    .probe-panel td {
        text-align: left;
        vertical-align: top;
        padding: 0.65rem;
        min-width: 6rem;
        border-bottom: 1px solid #64748b30;
    }
    .probe-panel th {
        background: #64748b12;
        white-space: nowrap;
    }
    .probe-state {
        display: inline-block;
        padding: 0.15rem 0.35rem;
        border-radius: 0.3rem;
        background: #64748b15;
    }
    .probe-state-passed {
        background: #05966920;
        color: var(--probe-pass, #047857);
    }
    .probe-state-failed,
    .probe-state-blocked,
    .probe-state-timeout {
        background: #dc262618;
        color: var(--probe-fail, #b91c1c);
    }
    :global(.dark) .probe-panel {
        --probe-bg: #111827;
        --probe-text: #e5e7eb;
        --probe-muted: #9ca3af;
        --probe-pass: #6ee7b7;
        --probe-fail: #fca5a5;
        border-color: #374151;
    }
    :global(.dark) .probe-panel fieldset {
        border-color: #374151;
    }
    :global(.dark) .probe-panel select option {
        background: #111827;
    }
    @media (max-width: 800px) {
        .probe-columns {
            grid-template-columns: 1fr;
        }
        .probe-toolbar {
            gap: 0.4rem;
            padding: 0.6rem 0.3rem;
        }
        .probe-content {
            padding: 0 0.6rem 0.8rem;
        }
        .probe-panel button {
            min-height: 2.75rem;
        }
        .probe-panel th,
        .probe-panel td {
            padding: 0.5rem;
        }
    }
</style>
