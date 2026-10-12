<script setup>
    import {
        computed,
        nextTick,
        onActivated,
        onBeforeUnmount,
        onDeactivated,
        onMounted,
        ref,
    } from 'vue';
    import Modal from '@/components/forms/Modal.vue';
    import NodeObservationReport from '@/components/nodes/NodeObservationReport.vue';
    import { useI18n } from '@/i18n/index.js';
    import { probeRequest } from '@/utils/probe-client.js';

    const { locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    const capabilities = ref(null),
        initializing = ref(true),
        initializationError = ref(false);
    const overview = ref(null),
        overviewOffset = ref(0),
        overviewBusy = ref(false),
        overviewError = ref(false);
    const selectedAgent = ref(null),
        history = ref(null),
        historyOffset = ref(0),
        historyState = ref(''),
        historyTitle = ref(null),
        historyBusy = ref(false),
        historyError = ref(false);
    const historyStates = ['queued', 'running', 'done', 'cancelled', 'expired'];
    const autoRefresh = ref(true),
        elapsed = ref(0),
        receivedAt = ref(null),
        historyReceivedAt = ref(null),
        monotonicNow = ref(performance.now());
    const name = ref(''),
        creating = ref(false),
        createError = ref(false),
        notice = ref('');
    const enrollmentName = ref(''),
        showEnrollment = ref(false),
        showDiscard = ref(false),
        downloadError = ref(false);
    const revokeTarget = ref(null),
        showRevoke = ref(false),
        revoking = ref(false),
        revokeError = ref(false);
    let enrollment = null,
        active = false,
        mounted = false,
        clock = null,
        refreshTimer = null;
    let historyTrigger = null;
    let initialController = null,
        overviewController = null,
        historyController = null,
        mutationController = null;
    let overviewGeneration = 0,
        historyGeneration = 0,
        lifecycle = 0;
    const downloadUrls = new Map();
    const storageReady = computed(() => capabilities.value?.storageReady === true);
    const stale = computed(
        () =>
            overviewError.value ||
            receivedAt.value === null ||
            elapsed.value >= (overview.value?.onlineWindowMs || 120000)
    );
    const retentionDays = computed(
        () => history.value?.retentionDays || overview.value?.retentionDays || 7
    );
    const validName = computed(
        () =>
            name.value.trim().length > 0 &&
            name.value.length <= 60 &&
            !/[\x00-\x1f\x7f]/.test(name.value)
    );
    const reportNow = computed(() =>
        typeof history.value?.checkedAt === 'number' && historyReceivedAt.value !== null
            ? history.value.checkedAt + Math.max(0, monotonicNow.value - historyReceivedAt.value)
            : 0
    );
    const statusText = (status) =>
        ({
            online: L('在线', 'Online'),
            offline: L('离线', 'Offline'),
            unknown: L('未知', 'Unknown'),
            revoked: L('已撤销', 'Revoked'),
            queued: L('等待检测', 'Queued'),
            running: L('检测中', 'Running'),
            done: L('已完成', 'Done'),
            stopped: L('已停止', 'Stopped'),
            passed: L('通过', 'Passed'),
            failed: L('失败', 'Failed'),
            timeout: L('超时', 'Timed out'),
            blocked: L('受限', 'Blocked'),
            unsupported: L('不支持', 'Unsupported'),
            skipped: L('未执行', 'Skipped'),
            cancelled: L('已取消', 'Cancelled'),
            expired: L('已过期', 'Expired'),
        })[status] || L('未知', 'Unknown');
    const agentStale = (agent) =>
        stale.value ||
        (agent.status === 'online' &&
            (!Number.isFinite(overview.value?.checkedAt) ||
                !Number.isFinite(agent.lastSeen) ||
                agent.lastSeen <= 0 ||
                agent.lastSeen > overview.value?.checkedAt ||
                overview.value.checkedAt + elapsed.value - agent.lastSeen >=
                    (overview.value.onlineWindowMs || 120000)));
    const agentStatus = (agent) =>
        agent.status === 'revoked'
            ? statusText('revoked')
            : agentStale(agent)
              ? L('状态待刷新', 'Status needs refresh')
              : statusText(agent.status);
    const validTime = (value) =>
        value !== null &&
        value !== undefined &&
        value !== '' &&
        new Date(value).getTime() > 0 &&
        Number.isFinite(new Date(value).getTime());
    const date = (value) =>
        validTime(value)
            ? new Date(value).toLocaleString(locale.value)
            : L('暂无记录', 'No record');
    const iso = (value) => (validTime(value) ? new Date(value).toISOString() : undefined);
    const code = (value) =>
        typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : '';
    const checkNames = computed(() => ({
        format: L('格式', 'Format'),
        tcp: L('TCP 连接', 'TCP connect'),
        proxy: L('节点 HTTP 延迟', 'Node HTTP latency'),
        speed: L('下载速度', 'Download speed'),
        unlock: L('服务 / 地区证据', 'Service / region evidence'),
        observations: L('出口 IP / 质量', 'Exit IP / quality'),
    }));
    const checks = (record) =>
        Object.entries(record.checks || {}).filter(([key]) => key in checkNames.value);
    function measurements(check) {
        const fields = [
            ['latencyMs', L('延迟', 'Latency'), 'ms'],
            ['bytes', L('字节', 'Bytes'), 'B'],
            ['bytesPerSecond', L('速度', 'Speed'), 'B/s'],
            ['httpStatus', 'HTTP', ''],
        ];
        return fields
            .filter(
                ([key]) =>
                    typeof check?.[key] === 'number' &&
                    Number.isFinite(check[key]) &&
                    check[key] >= 0
            )
            .map(([key, label, unit]) => `${label}: ${check[key]} ${unit}`.trim());
    }
    function stopReads() {
        initialController?.abort();
        overviewController?.abort();
        historyController?.abort();
        initialController = overviewController = historyController = null;
        overviewGeneration++;
        historyGeneration++;
        overviewBusy.value = historyBusy.value = false;
    }
    async function initialize() {
        if (!active || document.hidden || initialController) return;
        const controller = new AbortController(),
            generation = lifecycle;
        initialController = controller;
        initializing.value = true;
        initializationError.value = false;
        try {
            const result = await probeRequest('capabilities', { signal: controller.signal });
            if (!active || controller.signal.aborted || generation !== lifecycle) return;
            capabilities.value = result;
            if (storageReady.value) await Promise.all([loadOverview(), loadHistory()]);
        } catch {
            if (active && !controller.signal.aborted && generation === lifecycle)
                initializationError.value = true;
        } finally {
            if (initialController === controller) {
                initialController = null;
                initializing.value = false;
            }
        }
    }
    async function loadOverview() {
        if (!active || document.hidden || !storageReady.value || overviewController) return;
        const controller = new AbortController(),
            generation = ++overviewGeneration;
        overviewController = controller;
        overviewBusy.value = true;
        try {
            const result = await probeRequest(
                `agents/overview?offset=${overviewOffset.value}&limit=20`,
                { signal: controller.signal }
            );
            if (!active || controller.signal.aborted || generation !== overviewGeneration) return;
            overview.value = result;
            overviewError.value = false;
            receivedAt.value = validTime(result.checkedAt) ? performance.now() : null;
            elapsed.value = 0;
        } catch {
            if (active && !controller.signal.aborted && generation === overviewGeneration)
                overviewError.value = true;
        } finally {
            if (overviewController === controller) {
                overviewController = null;
                overviewBusy.value = false;
            }
        }
    }
    async function loadHistory() {
        if (
            !active ||
            document.hidden ||
            !selectedAgent.value ||
            !storageReady.value ||
            historyController
        )
            return;
        const controller = new AbortController(),
            generation = ++historyGeneration;
        const id = selectedAgent.value.id;
        historyController = controller;
        historyBusy.value = true;
        try {
            const result = await probeRequest(
                `agents/${encodeURIComponent(id)}/history?offset=${historyOffset.value}&limit=20${historyState.value ? `&state=${historyState.value}` : ''}`,
                { signal: controller.signal }
            );
            if (!active || controller.signal.aborted || generation !== historyGeneration) return;
            history.value = result;
            historyError.value = false;
            historyReceivedAt.value = performance.now();
            monotonicNow.value = historyReceivedAt.value;
        } catch {
            if (active && !controller.signal.aborted && generation === historyGeneration)
                historyError.value = true;
        } finally {
            if (historyController === controller) {
                historyController = null;
                historyBusy.value = false;
            }
        }
    }
    function changeOverview(offset) {
        overviewController?.abort();
        overviewController = null;
        overviewGeneration++;
        overview.value = null;
        receivedAt.value = null;
        overviewOffset.value = offset;
        overviewError.value = false;
        return loadOverview();
    }
    function reloadAfterMutation() {
        overviewController?.abort();
        historyController?.abort();
        overviewController = historyController = null;
        overviewGeneration++;
        historyGeneration++;
        overview.value = history.value = null;
        receivedAt.value = historyReceivedAt.value = null;
        overviewBusy.value = historyBusy.value = false;
        overviewError.value = historyError.value = false;
        return Promise.all([loadOverview(), loadHistory()]);
    }
    function selectHistory(agent, offset = 0) {
        historyController?.abort();
        historyController = null;
        historyGeneration++;
        selectedAgent.value = { id: agent.id, name: agent.name };
        historyOffset.value = offset;
        history.value = null;
        historyReceivedAt.value = null;
        historyError.value = false;
        return loadHistory();
    }
    async function openHistory(agent, event) {
        historyTrigger = event?.currentTarget || null;
        historyState.value = '';
        const request = selectHistory(agent),
            generation = historyGeneration;
        await nextTick();
        if (active && generation === historyGeneration) historyTitle.value?.focus();
        return request;
    }
    function changeHistoryState(state) {
        if (!selectedAgent.value || (state !== '' && !historyStates.includes(state))) return;
        historyState.value = state;
        return selectHistory(selectedAgent.value, 0);
    }
    function closeHistory() {
        historyController?.abort();
        historyController = null;
        historyGeneration++;
        selectedAgent.value = null;
        history.value = null;
        historyBusy.value = false;
        if (historyTrigger?.isConnected) historyTrigger.focus();
        historyTrigger = null;
    }
    function refresh() {
        if (!capabilities.value || initializationError.value) return initialize();
        return Promise.all([loadOverview(), loadHistory()]);
    }
    async function createAgent() {
        if (
            !active ||
            !storageReady.value ||
            creating.value ||
            revoking.value ||
            enrollment ||
            !validName.value
        )
            return;
        const controller = new AbortController(),
            generation = lifecycle;
        mutationController = controller;
        creating.value = true;
        createError.value = false;
        notice.value = '';
        try {
            const result = await probeRequest('agents', {
                method: 'POST',
                body: { name: name.value.trim() },
                signal: controller.signal,
            });
            if (!active || controller.signal.aborted || generation !== lifecycle) return;
            if (typeof result?.token !== 'string' || !result.token)
                throw new Error('invalid_enrollment');
            enrollment = { id: result.id, token: result.token };
            enrollmentName.value = result.name || name.value.trim();
            showEnrollment.value = true;
            downloadError.value = false;
            name.value = '';
            await changeOverview(0);
        } catch {
            if (active && !controller.signal.aborted && generation === lifecycle)
                createError.value = true;
        } finally {
            if (mutationController === controller) {
                mutationController = null;
                creating.value = false;
            }
        }
    }
    function clearEnrollment() {
        enrollment = null;
        enrollmentName.value = '';
        showEnrollment.value = false;
        showDiscard.value = false;
    }
    function downloadConfig() {
        if (!enrollment) return;
        let url = null;
        const link = document.createElement('a');
        try {
            const blob = new Blob(
                [
                    JSON.stringify(
                        {
                            version: 1,
                            server: window.location.origin,
                            token: enrollment.token,
                            pollSeconds: 60,
                        },
                        null,
                        2
                    ),
                ],
                { type: 'application/json' }
            );
            url = URL.createObjectURL(blob);
            link.href = url;
            link.download = 'probe.json';
            document.body.appendChild(link);
            link.click();
            clearEnrollment();
            notice.value = L(
                '配置下载已发起。请将文件保存在私密位置并按检测器文档启动。',
                'Configuration download started. Keep the file private and follow the detector setup guide.'
            );
            const pendingUrl = url;
            downloadUrls.set(
                pendingUrl,
                setTimeout(() => {
                    URL.revokeObjectURL(pendingUrl);
                    downloadUrls.delete(pendingUrl);
                }, 1000)
            );
        } catch {
            if (url) URL.revokeObjectURL(url);
            downloadError.value = true;
        } finally {
            link.remove();
        }
    }
    function requestRevoke(agent) {
        revokeTarget.value = { id: agent.id, name: agent.name };
        revokeError.value = false;
        showRevoke.value = true;
    }
    async function revokeAgent() {
        if (!revokeTarget.value || revoking.value || creating.value || !active) return;
        const controller = new AbortController(),
            generation = lifecycle,
            target = revokeTarget.value;
        mutationController = controller;
        revoking.value = true;
        revokeError.value = false;
        try {
            await probeRequest(`agents/${encodeURIComponent(target.id)}`, {
                method: 'DELETE',
                signal: controller.signal,
            });
            if (!active || controller.signal.aborted || generation !== lifecycle) return;
            if (enrollment?.id === target.id) clearEnrollment();
            showRevoke.value = false;
            notice.value = L(
                '检测器已撤销，检测记录按保留期限保存。',
                'Detector revoked. History remains available for the retention period.'
            );
            await reloadAfterMutation();
        } catch {
            if (active && !controller.signal.aborted && generation === lifecycle)
                revokeError.value = true;
        } finally {
            if (mutationController === controller) {
                mutationController = null;
                revoking.value = false;
            }
        }
    }
    function beforeUnload(event) {
        if (enrollment) {
            event.preventDefault();
            event.returnValue = '';
        }
    }
    function visibilityChanged() {
        if (document.hidden) {
            stopReads();
            return;
        }
        if (active && autoRefresh.value) refresh();
    }
    function start() {
        if (active) return;
        active = true;
        lifecycle++;
        clock = setInterval(() => {
            monotonicNow.value = performance.now();
            if (receivedAt.value !== null)
                elapsed.value = Math.max(0, monotonicNow.value - receivedAt.value);
        }, 1000);
        refreshTimer = setInterval(() => {
            if (active && autoRefresh.value && !document.hidden) refresh();
        }, 30000);
        document.addEventListener('visibilitychange', visibilityChanged);
        window.addEventListener('beforeunload', beforeUnload);
        initialize();
    }
    function stop() {
        active = false;
        lifecycle++;
        stopReads();
        mutationController?.abort();
        mutationController = null;
        clearInterval(clock);
        clearInterval(refreshTimer);
        creating.value = revoking.value = false;
        document.removeEventListener('visibilitychange', visibilityChanged);
        window.removeEventListener('beforeunload', beforeUnload);
        for (const [url, timer] of downloadUrls) {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
        }
        downloadUrls.clear();
        clearEnrollment();
        showRevoke.value = false;
        historyTrigger = null;
    }
    onMounted(() => {
        mounted = true;
        start();
    });
    onActivated(() => {
        if (mounted) start();
    });
    onDeactivated(stop);
    onBeforeUnmount(stop);
</script>

<template>
    <section
        data-testid="detector-settings"
        class="detector-settings space-y-6 text-sm text-gray-700 dark:text-gray-200"
    >
        <header class="space-y-2">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
                {{ L('添加 / 管理检测器', 'Add / manage detectors') }}
            </h3>
            <p>
                {{
                    L(
                        '检测器在你控制的设备上运行，通过节点执行检测。添加后下载配置并启动检测器。',
                        'Detectors run on devices you control and perform checks through your nodes. Add a detector, download its configuration, then start it.'
                    )
                }}
            </p>
        </header>
        <div v-if="initializing && !capabilities" role="status" class="detector-card">
            {{ L('正在检查检测器服务…', 'Checking detector service…') }}
        </div>
        <div v-if="initializationError" class="detector-error" role="alert">
            <p>
                {{
                    L(
                        '无法读取检测器服务。请检查连接或重新登录后重试。',
                        'Unable to read detector service. Check your connection or sign in again, then retry.'
                    )
                }}
            </p>
            <button
                class="detector-button"
                data-testid="detector-initial-retry"
                @click="initialize"
            >
                {{ L('重试', 'Retry') }}
            </button>
        </div>
        <div v-if="capabilities && !storageReady" class="detector-card" role="status">
            {{
                L(
                    '检测器存储尚未配置。配置完成后可添加检测器并查看记录。',
                    'Detector storage is not configured. Adding detectors and viewing history will be available after setup.'
                )
            }}
        </div>
        <form class="detector-card space-y-3" @submit.prevent="createAgent">
            <label for="detector-name" class="block font-medium text-gray-900 dark:text-white">{{
                L('检测器名称', 'Detector name')
            }}</label>
            <div class="flex flex-col gap-3 sm:flex-row">
                <input
                    id="detector-name"
                    v-model="name"
                    data-testid="detector-name"
                    class="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 dark:border-gray-600 dark:bg-gray-800"
                    maxlength="60"
                    autocomplete="off"
                    :disabled="!storageReady || creating"
                    :placeholder="L('例如：家中设备', 'For example: Home device')"
                />
                <button
                    data-testid="detector-create"
                    class="detector-button detector-primary"
                    type="submit"
                    :disabled="
                        !storageReady || !validName || creating || revoking || showEnrollment
                    "
                >
                    {{ creating ? L('正在添加…', 'Adding…') : L('添加检测器', 'Add detector') }}
                </button>
            </div>
            <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                {{
                    L(
                        '仅在点击添加后创建身份。配置含访问凭据，仅本次创建后可下载，请妥善保管。',
                        'An identity is created only when you click Add. Its configuration contains credentials and is available only after creation; keep it private.'
                    )
                }}
            </p>
            <p v-if="createError" class="detector-error" role="alert">
                {{
                    L(
                        '添加未确认成功，服务器可能已创建身份。请先刷新列表核对；无法获取配置时撤销该身份，再手动添加。请求不会自动重试。',
                        'Creation was not confirmed; an identity may already exist. Refresh the list first. Revoke any identity whose configuration is unavailable before adding again. This request is not retried automatically.'
                    )
                }}
            </p>
        </form>
        <p v-if="notice" role="status" class="detector-card">{{ notice }}</p>
        <template v-if="storageReady">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <h4 class="font-semibold text-gray-900 dark:text-white">
                    {{ L('我的检测器', 'My detectors')
                    }}<span v-if="overview"> · {{ overview.total }}</span>
                </h4>
                <div class="flex flex-wrap items-center gap-3">
                    <label class="flex min-h-11 cursor-pointer items-center gap-2"
                        ><input
                            v-model="autoRefresh"
                            data-testid="detector-auto-refresh"
                            type="checkbox"
                            class="h-4 w-4"
                        />{{ L('每 30 秒刷新', 'Refresh every 30 seconds') }}</label
                    >
                    <button
                        data-testid="detector-refresh"
                        class="detector-button"
                        :disabled="overviewBusy || historyBusy"
                        @click="refresh"
                    >
                        {{ overviewBusy ? L('刷新中…', 'Refreshing…') : L('刷新', 'Refresh') }}
                    </button>
                </div>
            </div>
            <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                {{
                    L(
                        '在线表示最近 2 分钟内收到领单或心跳通信，不表示节点检测成功。未知表示尚无有效通信时间。记录保留',
                        'Online means task polling or heartbeat communication within 2 minutes, not a successful node check. Unknown means no valid communication time. History is retained for'
                    )
                }}
                {{ retentionDays }} {{ L('天。', 'days.') }}
            </p>
            <p v-if="overview?.checkedAt" class="text-xs text-gray-500 dark:text-gray-400">
                {{ L('状态核对时间：', 'Status checked: ')
                }}<time :datetime="iso(overview.checkedAt)">{{ date(overview.checkedAt) }}</time>
            </p>
            <div v-if="overviewError" class="detector-error" role="alert">
                {{
                    L(
                        '无法刷新列表，现有状态待刷新。请检查连接或重新登录后重试。',
                        'Unable to refresh the list. Displayed states need refreshing. Check your connection or sign in again, then retry.'
                    )
                }}
            </div>
            <p v-else-if="overview && stale" role="status">
                {{
                    L(
                        '状态待刷新。已超过状态时效，请刷新以确认在线状态。',
                        'Status needs refresh. The snapshot has expired; refresh to verify connectivity.'
                    )
                }}
            </p>
            <p v-if="overviewBusy && !overview" role="status">
                {{ L('正在加载检测器…', 'Loading detectors…') }}
            </p>
            <p v-else-if="overview && !overview.agents.length" class="detector-card">
                {{
                    L(
                        '暂无检测器。添加并启动后，即可在节点检测中选择。',
                        'No detectors yet. Add and start one to select it for node checks.'
                    )
                }}
            </p>
            <div class="grid gap-4 lg:grid-cols-2">
                <article
                    v-for="agent in overview?.agents || []"
                    :key="agent.id"
                    :data-testid="`detector-card-${agent.id}`"
                    class="detector-card min-w-0 space-y-4"
                >
                    <div class="flex flex-wrap items-start justify-between gap-3">
                        <h5 class="min-w-0 break-words font-semibold text-gray-900 dark:text-white">
                            {{ agent.name }}
                        </h5>
                        <span
                            class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium dark:bg-gray-700"
                            :class="{
                                'text-emerald-700 dark:text-emerald-300':
                                    agent.status === 'online' && !agentStale(agent),
                            }"
                            >{{ agentStatus(agent) }}</span
                        >
                    </div>
                    <dl class="grid gap-2 text-xs leading-relaxed">
                        <div>
                            <dt>
                                {{
                                    L(
                                        '最后通信（领单 / 心跳）',
                                        'Last communication (poll / heartbeat)'
                                    )
                                }}
                            </dt>
                            <dd>
                                <time :datetime="iso(agent.lastSeen)">{{
                                    date(agent.lastSeen)
                                }}</time>
                            </dd>
                        </div>
                        <div>
                            <dt>{{ L('最近任务创建', 'Latest task created') }}</dt>
                            <dd>
                                <time :datetime="iso(agent.lastTaskAt)">{{
                                    date(agent.lastTaskAt)
                                }}</time>
                            </dd>
                        </div>
                        <div>
                            <dt>{{ L('最近结果回传', 'Latest result received') }}</dt>
                            <dd>
                                <time :datetime="iso(agent.lastResultAt)">{{
                                    date(agent.lastResultAt)
                                }}</time>
                            </dd>
                        </div>
                        <div v-if="agent.version || agent.platform">
                            <dt>{{ L('版本 / 平台', 'Version / platform') }}</dt>
                            <dd class="break-words">
                                {{ [agent.version, agent.platform].filter(Boolean).join(' · ') }}
                            </dd>
                        </div>
                        <div v-if="agent.revokedAt">
                            <dt>{{ L('撤销时间', 'Revoked at') }}</dt>
                            <dd>
                                <time :datetime="iso(agent.revokedAt)">{{
                                    date(agent.revokedAt)
                                }}</time>
                            </dd>
                        </div>
                    </dl>
                    <p
                        v-if="agent.taskCounts"
                        class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400"
                    >
                        <span v-for="state in ['queued', 'running', 'done', 'stopped']" :key="state"
                            >{{ statusText(state) }} {{ agent.taskCounts[state] ?? 0 }}</span
                        >
                    </p>
                    <div class="flex flex-wrap gap-2">
                        <button
                            :data-testid="`detector-history-${agent.id}`"
                            class="detector-button"
                            @click="openHistory(agent, $event)"
                        >
                            {{ L('检测记录', 'Detection history') }}
                        </button>
                        <button
                            v-if="!agent.revokedAt && agent.status !== 'revoked'"
                            :data-testid="`detector-revoke-${agent.id}`"
                            class="detector-button text-red-600 dark:text-red-400"
                            :disabled="creating || revoking"
                            @click="requestRevoke(agent)"
                        >
                            {{ L('撤销', 'Revoke') }}
                        </button>
                    </div>
                </article>
            </div>
            <nav
                class="flex items-center justify-between gap-3"
                :aria-label="L('检测器分页', 'Detector pages')"
            >
                <button
                    data-testid="detector-overview-prev"
                    class="detector-button"
                    :disabled="overviewOffset === 0"
                    @click="changeOverview(Math.max(0, overviewOffset - 20))"
                >
                    {{ L('上一页', 'Previous') }}
                </button>
                <span
                    >{{ L('第', 'Page') }} {{ Math.floor(overviewOffset / 20) + 1 }}
                    {{ L('页', '') }}</span
                >
                <button
                    data-testid="detector-overview-next"
                    class="detector-button"
                    :disabled="overview?.nextOffset == null"
                    @click="changeOverview(overview.nextOffset)"
                >
                    {{ L('下一页', 'Next') }}
                </button>
            </nav>
            <section
                v-if="selectedAgent"
                data-testid="detector-history"
                class="detector-card space-y-4"
                :aria-label="L('检测记录', 'Detection history')"
            >
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <h4
                        ref="historyTitle"
                        data-testid="detector-history-title"
                        tabindex="-1"
                        class="scroll-mt-24 break-words rounded font-semibold text-gray-900 dark:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
                    >
                        {{ selectedAgent.name }} · {{ L('检测记录', 'Detection history') }}
                    </h4>
                    <button class="detector-button" @click="closeHistory">
                        {{ L('关闭记录', 'Close history') }}
                    </button>
                </div>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                    {{ L('展示最近', 'Showing the last') }} {{ retentionDays }}
                    {{
                        L(
                            '天持久保存的任务与结果；已完成仅表示任务结束，具体结论见各检查项。',
                            'days of persisted tasks and results. Done means the task finished; each check carries its own conclusion.'
                        )
                    }}
                </p>
                <div class="flex flex-wrap items-end justify-between gap-3">
                    <div class="min-w-0 space-y-1">
                        <label for="detector-history-filter" class="block font-medium">{{
                            L('任务状态', 'Task state')
                        }}</label>
                        <select
                            id="detector-history-filter"
                            data-testid="detector-history-filter"
                            :value="historyState"
                            class="min-h-11 max-w-full rounded-lg border border-gray-300 bg-white px-3 dark:border-gray-600 dark:bg-gray-800"
                            @change="changeHistoryState($event.target.value)"
                        >
                            <option value="">{{ L('全部状态', 'All states') }}</option>
                            <option v-for="state in historyStates" :key="state" :value="state">
                                {{ statusText(state) }}
                            </option>
                        </select>
                    </div>
                    <p
                        v-if="history"
                        data-testid="detector-history-total"
                        role="status"
                        aria-atomic="true"
                        class="break-words text-sm text-gray-500 dark:text-gray-400"
                    >
                        {{ L('匹配记录：', 'Matching records: ') }}{{ history.total }} ·
                        {{ historyState ? statusText(historyState) : L('全部状态', 'All states') }}
                    </p>
                </div>
                <p v-if="historyBusy && !history" role="status">
                    {{ L('正在加载记录…', 'Loading history…') }}
                </p>
                <div v-if="historyError" class="detector-error" role="alert">
                    <p>
                        {{
                            L(
                                '无法刷新检测记录，已显示的记录可能不是最新。',
                                'Unable to refresh history. Displayed records may not be current.'
                            )
                        }}
                    </p>
                    <button class="detector-button" @click="loadHistory">
                        {{ L('重试', 'Retry') }}
                    </button>
                </div>
                <div v-if="history && !history.records.length" class="space-y-3">
                    <p>
                        {{
                            historyState
                                ? L(
                                      '保留期内没有符合当前任务状态的记录，可切换为全部状态查看。',
                                      'No records match this task state within the retention period. Choose All states to see other records.'
                                  )
                                : L(
                                      '保留期内暂无检测记录。',
                                      'No detection history within the retention period.'
                                  )
                        }}
                    </p>
                    <button
                        v-if="historyState"
                        class="detector-button"
                        data-testid="detector-history-reset"
                        @click="changeHistoryState('')"
                    >
                        {{ L('查看全部状态', 'Show all states') }}
                    </button>
                </div>
                <article
                    v-for="record in history?.records || []"
                    :key="record.id"
                    class="min-w-0 space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                >
                    <div class="flex flex-wrap justify-between gap-2">
                        <h5 class="break-words font-medium">
                            {{ record.nodeName || L('未命名节点', 'Unnamed node') }}
                        </h5>
                        <span>{{ statusText(record.state) }}</span>
                    </div>
                    <p class="break-all text-xs text-gray-500 dark:text-gray-400">
                        {{ L('任务', 'Job') }} {{ record.jobId }} · {{ L('尝试次数', 'Attempt') }}
                        {{ record.attempt }}
                    </p>
                    <p class="text-xs">
                        {{ L('创建：', 'Created: ')
                        }}<time :datetime="iso(record.createdAt)">{{ date(record.createdAt) }}</time
                        ><br />{{
                            record.state === 'done'
                                ? L('结果回传：', 'Result received: ')
                                : L('结束：', 'Ended: ')
                        }}<time :datetime="iso(record.completedAt)">{{
                            date(record.completedAt)
                        }}</time>
                    </p>
                    <div
                        v-for="[type, check] in checks(record)"
                        :key="type"
                        class="space-y-2 border-t border-gray-100 pt-3 dark:border-gray-700"
                    >
                        <p class="flex flex-wrap gap-2">
                            <strong>{{ checkNames[type] }}</strong
                            ><span>{{ statusText(check.status) }}</span
                            ><code v-if="code(check.code)" class="break-all text-xs">{{
                                code(check.code)
                            }}</code>
                        </p>
                        <p v-if="measurements(check).length" class="text-xs">
                            {{ measurements(check).join(' · ') }}
                        </p>
                        <p v-if="/^[A-Z]{2}$/.test(check.region || '')" class="text-xs">
                            {{ L('地区：', 'Region: ') }}{{ check.region }}
                        </p>
                        <p
                            v-if="
                                Number.isInteger(check.retryAfterSeconds) &&
                                check.retryAfterSeconds >= 0
                            "
                            class="text-xs"
                        >
                            {{ L('来源建议等待：', 'Source suggests waiting: ')
                            }}{{ check.retryAfterSeconds }} {{ L('秒', 'seconds') }}
                        </p>
                        <NodeObservationReport
                            v-if="type === 'observations' && check.report"
                            :report="check.report"
                            :now="reportNow"
                        />
                        <ul
                            v-if="type === 'unlock' && Array.isArray(check.services)"
                            class="space-y-2 text-xs"
                        >
                            <li
                                v-for="service in check.services"
                                :key="service.service"
                                class="break-words"
                            >
                                <strong>{{ code(service.service) }}</strong> ·
                                {{ statusText(service.status) }}
                                <code>{{ code(service.code) }}</code
                                ><span v-if="Number.isInteger(service.httpStatus)">
                                    · HTTP {{ service.httpStatus }}</span
                                ><span v-if="/^[A-Z]{2}$/.test(service.region || '')">
                                    · {{ L('地区：', 'Region: ') }}{{ service.region }}</span
                                ><span
                                    v-if="
                                        Number.isInteger(service.retryAfterSeconds) &&
                                        service.retryAfterSeconds >= 0
                                    "
                                >
                                    · {{ L('来源建议等待：', 'Source suggests waiting: ')
                                    }}{{ service.retryAfterSeconds }} {{ L('秒', 'seconds') }}</span
                                ><span v-if="validTime(service.checkedAt)">
                                    ·
                                    <time :datetime="iso(service.checkedAt)">{{
                                        date(service.checkedAt)
                                    }}</time></span
                                ><span v-else>
                                    · {{ L('来源时间未知', 'Provider time unavailable') }}</span
                                >
                            </li>
                        </ul>
                    </div>
                    <p
                        v-if="!checks(record).length"
                        class="text-xs text-gray-500 dark:text-gray-400"
                    >
                        {{ L('尚无检查结果。', 'No check results yet.') }}
                    </p>
                </article>
                <nav
                    class="flex items-center justify-between gap-3"
                    :aria-label="L('检测记录分页', 'History pages')"
                >
                    <button
                        data-testid="detector-history-prev"
                        class="detector-button"
                        :disabled="historyOffset === 0"
                        @click="selectHistory(selectedAgent, Math.max(0, historyOffset - 20))"
                    >
                        {{ L('上一页', 'Previous') }}</button
                    ><span
                        >{{ L('第', 'Page') }} {{ Math.floor(historyOffset / 20) + 1 }}
                        {{ L('页', '') }}</span
                    ><button
                        data-testid="detector-history-next"
                        class="detector-button"
                        :disabled="history?.nextOffset == null"
                        @click="selectHistory(selectedAgent, history.nextOffset)"
                    >
                        {{ L('下一页', 'Next') }}
                    </button>
                </nav>
            </section>
        </template>
        <Modal
            :show="showEnrollment && !showDiscard"
            :close-on-confirm="false"
            size="md"
            @update:show="
                (value) => {
                    if (!value) showDiscard = true;
                }
            "
        >
            <template #title
                ><h3 class="text-lg font-semibold">
                    {{ L('保存检测器配置', 'Save detector configuration') }}
                </h3></template
            >
            <template #body
                ><div class="space-y-3 text-sm">
                    <p class="break-words font-medium">{{ enrollmentName }}</p>
                    <p>
                        {{
                            L(
                                '配置包含访问凭据，仅当前会话可下载。下载后将从本页面内存清除，请勿公开分享。',
                                'The configuration contains credentials and can only be downloaded in this session. It is cleared from this page after downloading. Do not share it publicly.'
                            )
                        }}
                    </p>
                    <p>
                        {{
                            L(
                                '关闭页面或离开本设置会清除尚未下载的配置。下载完成后，根据检测器文档启动程序。',
                                'Closing or leaving these settings clears any undownloaded configuration. After saving it, start the program using the detector documentation.'
                            )
                        }}
                    </p>
                    <p v-if="downloadError" class="detector-error" role="alert">
                        {{
                            L(
                                '无法发起下载，配置仍在当前会话中，请重试或明确放弃。',
                                'Unable to start the download. The configuration remains in this session; retry or explicitly discard it.'
                            )
                        }}
                    </p>
                </div></template
            >
            <template #footer
                ><div class="flex flex-wrap gap-3">
                    <button
                        data-testid="detector-discard"
                        class="detector-button"
                        @click="showDiscard = true"
                    >
                        {{ L('放弃配置', 'Discard configuration') }}</button
                    ><button
                        data-testid="detector-download"
                        class="detector-button detector-primary"
                        @click="downloadConfig"
                    >
                        {{ L('下载配置', 'Download configuration') }}
                    </button>
                </div></template
            >
        </Modal>
        <Modal
            :show="showDiscard"
            :close-on-confirm="false"
            @update:show="(value) => (showDiscard = value)"
        >
            <template #title
                ><h3 class="text-lg font-semibold">
                    {{ L('放弃未保存的配置？', 'Discard unsaved configuration?') }}
                </h3></template
            >
            <template #body
                ><p class="text-sm">
                    {{
                        L(
                            '配置清除后无法再次下载，检测器身份仍会保留。可在列表中撤销该身份后重新添加。',
                            'The configuration cannot be downloaded again after clearing it. The identity remains; you can revoke it in the list and add another.'
                        )
                    }}
                </p></template
            >
            <template #footer
                ><div class="flex flex-wrap gap-3">
                    <button
                        data-testid="detector-cancel-discard"
                        class="detector-button"
                        @click="showDiscard = false"
                    >
                        {{ L('返回保存', 'Back to save') }}</button
                    ><button
                        data-testid="detector-confirm-discard"
                        class="detector-button detector-danger"
                        @click="clearEnrollment"
                    >
                        {{ L('确认放弃', 'Confirm discard') }}
                    </button>
                </div></template
            >
        </Modal>
        <Modal
            :show="showRevoke"
            :close-on-confirm="false"
            @update:show="(value) => (showRevoke = value)"
        >
            <template #title
                ><h3 class="text-lg font-semibold">
                    {{ L('撤销检测器？', 'Revoke detector?') }}
                </h3></template
            >
            <template #body
                ><div class="space-y-3 text-sm">
                    <p class="break-words font-medium">{{ revokeTarget?.name }}</p>
                    <p>
                        {{
                            L(
                                '凭据将立即失效，未完成任务会取消，检测记录按保留期限保存。此操作无法恢复；需要时可创建新的检测器。',
                                'Credentials stop working immediately and unfinished tasks are cancelled. History remains for the retention period. This cannot be undone; add a new detector if needed.'
                            )
                        }}
                    </p>
                    <p v-if="revokeError" class="detector-error" role="alert">
                        {{
                            L(
                                '撤销未确认成功，请刷新列表核对后重试。',
                                'Revocation was not confirmed. Refresh the list to verify before trying again.'
                            )
                        }}
                    </p>
                </div></template
            >
            <template #footer
                ><div class="flex flex-wrap gap-3">
                    <button
                        data-testid="detector-cancel-revoke"
                        class="detector-button"
                        @click="showRevoke = false"
                    >
                        {{ L('取消', 'Cancel') }}</button
                    ><button
                        data-testid="detector-confirm-revoke"
                        class="detector-button detector-danger"
                        :disabled="revoking"
                        @click="revokeAgent"
                    >
                        {{ revoking ? L('撤销中…', 'Revoking…') : L('确认撤销', 'Confirm revoke') }}
                    </button>
                </div></template
            >
        </Modal>
    </section>
</template>

<style scoped>
    @reference '../../../assets/main.css';
    .detector-card {
        @apply rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900;
    }
    .detector-button {
        @apply inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700;
    }
    .detector-primary {
        @apply border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700 dark:border-indigo-500 dark:bg-indigo-600 dark:hover:bg-indigo-500;
    }
    .detector-danger {
        @apply border-red-600 bg-red-600 text-white hover:bg-red-700 dark:border-red-500 dark:bg-red-600 dark:hover:bg-red-500;
    }
    .detector-error {
        @apply space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200;
    }
    dt {
        @apply text-gray-500 dark:text-gray-400;
    }
    dd {
        @apply text-gray-900 dark:text-gray-100;
    }
    :deep(.observation-report) {
        min-width: 0;
        max-width: 100%;
    }
    :deep([role='dialog']) {
        @apply text-gray-700 dark:text-gray-200;
    }
    button:focus-visible,
    input:focus-visible,
    select:focus-visible {
        @apply outline outline-2 outline-offset-2 outline-indigo-500;
    }
    @media (prefers-reduced-motion: reduce) {
        .detector-button {
            transition: none;
        }
    }
</style>
