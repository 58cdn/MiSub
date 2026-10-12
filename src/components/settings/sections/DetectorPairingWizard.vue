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
    import { useI18n } from '@/i18n/index.js';
    import { probeRequest } from '@/utils/probe-client.js';
    import { readProbeInstallation } from '@/shared/probe-release.js';

    const props = defineProps({
        enabled: { type: Boolean, default: false },
        installation: { type: Object, default: null },
        installationLoading: { type: Boolean, default: false },
        installationError: { type: Boolean, default: false },
    });
    const emit = defineEmits(['agents-changed', 'refresh-installation']);
    const { locale } = useI18n();
    const L = (zh, en) => (locale.value.startsWith('zh') ? zh : en);
    const origin = window.location.origin;
    const secure = window.location.protocol === 'https:' && validCommandOrigin(origin);
    const terminalChoice = ref('unix');
    const installation = computed(() => readProbeInstallation(props.installation));
    const terminalReady = (terminal) => {
        if (
            props.installationLoading ||
            props.installationError ||
            !installation.value?.distributionReady
        )
            return false;
        const targets = installation.value.targets.filter(({ target }) =>
            terminal === 'windows' ? target === 'windows-amd64' : target !== 'windows-amd64'
        );
        return targets.length > 0 && targets.every(({ available }) => available);
    };
    const installationAvailable = computed(() => terminalReady('unix') || terminalReady('windows'));
    const selectedTerminalAvailable = computed(() => terminalReady(terminalChoice.value));
    const installationText = computed(() => {
        if (props.installationLoading)
            return L('正在核对兼容发行包…', 'Checking compatible release packages…');
        if (props.installationError || !installation.value)
            return L(
                '无法确认兼容发行包，请刷新发行状态后重试。',
                'Compatible release packages could not be verified. Refresh release status and try again.'
            );
        if (!installationAvailable.value)
            return L(
                '兼容安装包尚未发行，一键安装暂不可用。可使用下方高级方式管理已有检测器。',
                'Compatible installation packages have not been released. One-command installation is unavailable. The advanced option below remains available for existing detectors.'
            );
        return L(
            '兼容发行包已核验，选择检测器所在设备的终端。',
            'Compatible release packages are verified. Select the terminal on the detector device.'
        );
    });
    function validCommandOrigin(value) {
        try {
            const parsed = new URL(value);
            return (
                parsed.protocol === 'https:' &&
                parsed.origin === value &&
                !parsed.username &&
                !parsed.password &&
                /^[a-z0-9.:[\]-]+$/i.test(parsed.host)
            );
        } catch {
            return false;
        }
    }
    const open = ref(false),
        heading = ref(null),
        cancelPanel = ref(null),
        startButton = ref(null);
    const pairingWindow = ref(null),
        pairing = ref(null),
        userCode = ref(''),
        confirmed = ref(false),
        recoveryConfirmed = ref(false);
    const busy = ref(''),
        error = ref(''),
        stale = ref(false),
        checking = ref(false),
        cancelling = ref(false);
    const elapsed = ref(0),
        receivedAt = ref(null),
        pollStopped = ref(false),
        nextPollAt = ref(0),
        monotonicNow = ref(performance.now());
    let active = false,
        mounted = false,
        lifecycle = 0,
        readGeneration = 0;
    let readController = null,
        actionController = null,
        clock = null,
        pollTimer = null;
    let waitMs = 5000,
        consumedSeenAt = null,
        lastNotifiedAgent = '',
        resolvedCode = '';
    let cancelTrigger = null;
    const uuid = (value) =>
        typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
    const finiteTime = (value) => Number.isFinite(value) && value > 0;
    const terminal = computed(
        () =>
            ['expired', 'cancelled'].includes(pairing.value?.status) ||
            ['expired', 'cancelled'].includes(pairingWindow.value?.status)
    );
    const expiresAt = computed(
        () => pairing.value?.expiresAt || pairingWindow.value?.expiresAt || 0
    );
    const serverNow = computed(
        () => (pairing.value?.checkedAt || pairingWindow.value?.checkedAt || 0) + elapsed.value
    );
    const expired = computed(() =>
        Boolean(
            expiresAt.value &&
            serverNow.value >= expiresAt.value &&
            pairing.value?.status !== 'consumed'
        )
    );
    const remaining = computed(() =>
        Math.max(0, Math.ceil((expiresAt.value - serverNow.value) / 1000))
    );
    const connected = computed(
        () =>
            pairing.value?.status === 'consumed' &&
            finiteTime(pairing.value.lastSeen) &&
            pairing.value.lastSeen <= pairing.value.checkedAt
    );
    const state = computed(() =>
        connected.value
            ? 'connected'
            : pairing.value?.status === 'consumed'
              ? 'consumed'
              : pairingWindow.value?.status === 'cancelled' || pairing.value?.status === 'cancelled'
                ? 'cancelled'
                : expired.value || terminal.value
                  ? 'expired'
                  : pairing.value?.status || (pairingWindow.value ? 'waiting' : 'idle')
    );
    const codeValid = computed(() =>
        /^[0-9A-HJKMNP-TV-Z]{5}-?[0-9A-HJKMNP-TV-Z]{5}$/i.test(userCode.value.trim())
    );
    const coolingDown = computed(() => monotonicNow.value < nextPollAt.value);
    const retryIn = computed(() =>
        Math.max(0, Math.ceil((nextPollAt.value - monotonicNow.value) / 1000))
    );
    const canResolve = computed(
        () =>
            pairingWindow.value &&
            !['consumed', 'connected', 'approved', 'expired', 'cancelled'].includes(state.value) &&
            codeValid.value &&
            !busy.value
    );
    const stateLabel = computed(
        () =>
            ({
                idle: L('准备配对', 'Ready to pair'),
                waiting: L('等待客户端短码', 'Waiting for a client code'),
                pending: L('等待你核对并批准', 'Awaiting your review and approval'),
                approved: L(
                    '已批准，等待客户端领取身份',
                    'Approved; waiting for the client to claim its identity'
                ),
                consumed: L(
                    '身份已创建，尚未确认连接',
                    'Identity created; connection not yet confirmed'
                ),
                connected: L('已收到首次真实通信', 'First authenticated communication received'),
                expired: L('配对已过期', 'Pairing expired'),
                cancelled: L('配对已取消', 'Pairing cancelled'),
            })[state.value]
    );
    const date = (value) =>
        finiteTime(value)
            ? new Date(value).toLocaleString(locale.value)
            : L('暂无记录', 'No record');
    const errorText = computed(
        () =>
            ({
                start: L(
                    '未确认窗口创建成功，请勿连续重试。可能创建的窗口会在 5 分钟后过期。',
                    'Window creation was not confirmed. Avoid repeated attempts; any created window expires after 5 minutes.'
                ),
                resolve: L(
                    '无法核对该短码，请检查本站、窗口及终端短码。',
                    'Unable to match this code. Check the site, window and code shown in the terminal.'
                ),
                approve: L(
                    '批准结果未确认。请刷新状态核对，请勿重复批准或重新注册。',
                    'Approval was not confirmed. Refresh its state before taking another action.'
                ),
                cancel: L(
                    '取消结果未确认。请刷新状态核对；窗口到期前仍可能有效。',
                    'Cancellation was not confirmed. Refresh its state; the window may remain active until expiry.'
                ),
                read: L(
                    '状态读取失败，显示状态待刷新。尚未确认连接。',
                    'Unable to refresh state. Displayed state may be outdated; a new connection is not confirmed.'
                ),
                slow: L(
                    '请求受到限流，已暂停一段时间后再检查。请勿重复提交。',
                    'Requests are rate limited. Status checks will wait before retrying. Avoid repeated submissions.'
                ),
                unauthorized: L(
                    '登录已失效，请重新登录后操作。',
                    'Your session expired. Sign in again before continuing.'
                ),
                invalid: L(
                    '服务返回的配对信息无法验证，请刷新状态核对。',
                    'The returned pairing information could not be verified. Refresh to check its state.'
                ),
            })[error.value] || ''
    );
    function safePair(value) {
        if (
            !value ||
            !uuid(value.id) ||
            value.windowId !== pairingWindow.value?.id ||
            value.origin !== origin ||
            !['pending', 'approved', 'consumed', 'expired', 'cancelled'].includes(value.status) ||
            !finiteTime(value.checkedAt) ||
            !finiteTime(value.expiresAt) ||
            value.expiresAt > pairingWindow.value.expiresAt ||
            typeof value.name !== 'string' ||
            !value.name.trim() ||
            value.name.length > 60 ||
            /[\x00-\x1f\x7f]/.test(value.name) ||
            typeof value.version !== 'string' ||
            !/^[A-Za-z0-9_.+-]{1,50}$/.test(value.version) ||
            typeof value.platform !== 'string' ||
            !/^[a-z0-9_-]{1,30}$/.test(value.platform) ||
            !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(value.fingerprint) ||
            (value.agentId !== null && !uuid(value.agentId)) ||
            (value.status === 'consumed' && !uuid(value.agentId))
        )
            throw new Error('invalid_pairing_response');
        return {
            id: value.id,
            windowId: value.windowId,
            origin: value.origin,
            name: value.name,
            version: value.version,
            platform: value.platform,
            fingerprint: value.fingerprint,
            status: value.status,
            checkedAt: value.checkedAt,
            expiresAt: value.expiresAt,
            agentId: value.agentId,
            lastSeen:
                finiteTime(value.lastSeen) && value.lastSeen <= value.checkedAt
                    ? value.lastSeen
                    : 0,
        };
    }
    function acceptPair(value) {
        const result = safePair(value);
        if (
            pairing.value &&
            ['id', 'name', 'version', 'platform', 'fingerprint'].some(
                (key) => result[key] !== pairing.value[key]
            )
        )
            throw new Error('invalid_pairing_response');
        pairing.value = result;
        receivedAt.value = performance.now();
        elapsed.value = 0;
        if (result.status === 'consumed') {
            if (consumedSeenAt === null) consumedSeenAt = performance.now();
            if (result.agentId && lastNotifiedAgent !== result.agentId) {
                lastNotifiedAgent = result.agentId;
                emit('agents-changed');
            }
        }
    }
    function acceptWindow(value) {
        if (
            !value ||
            !uuid(value.id) ||
            (pairingWindow.value && pairingWindow.value.id !== value.id) ||
            value.origin !== origin ||
            !['open', 'expired', 'cancelled'].includes(value.status) ||
            !finiteTime(value.createdAt) ||
            !finiteTime(value.expiresAt) ||
            value.expiresAt - value.createdAt > 300000 ||
            value.expiresAt <= value.createdAt ||
            !finiteTime(value.checkedAt)
        )
            throw new Error('invalid_pairing_response');
        pairingWindow.value = {
            id: value.id,
            origin: value.origin,
            status: value.status,
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
            checkedAt: value.checkedAt,
        };
        receivedAt.value = performance.now();
        elapsed.value = 0;
        if (pairing.value && Array.isArray(value.requests)) {
            const current = value.requests.find((item) => item?.id === pairing.value.id);
            if (current) acceptPair(current);
        }
    }
    function invalidateReads() {
        readController?.abort();
        readController = null;
        readGeneration++;
        checking.value = false;
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    function schedule(delay = waitMs) {
        clearTimeout(pollTimer);
        pollTimer = null;
        if (
            !active ||
            !open.value ||
            document.hidden ||
            !pairingWindow.value ||
            terminal.value ||
            expired.value ||
            connected.value ||
            pollStopped.value
        )
            return;
        const wait = Math.max(delay, nextPollAt.value - performance.now(), 0);
        pollTimer = setTimeout(() => refreshState(), wait);
    }
    function handleError(errorObject, fallback) {
        const code = errorObject?.message;
        if (code === 'unauthorized') {
            error.value = 'unauthorized';
            pollStopped.value = true;
        } else if (['pairing_rate_limited', 'pairing_slow_down'].includes(code)) {
            const retrySeconds =
                Number.isInteger(errorObject.retryAfterSeconds) &&
                errorObject.retryAfterSeconds >= 0 &&
                errorObject.retryAfterSeconds <= 86400
                    ? errorObject.retryAfterSeconds
                    : 30;
            waitMs = Math.min(86400000, Math.max(30000, waitMs + 5000, retrySeconds * 1000));
            nextPollAt.value = performance.now() + waitMs;
            error.value = 'slow';
        } else {
            error.value = code === 'invalid_pairing_response' ? 'invalid' : fallback;
            waitMs = Math.min(60000, waitMs * 2);
        }
    }
    async function refreshState(manual = false) {
        if (
            !active ||
            !open.value ||
            document.hidden ||
            !pairingWindow.value ||
            readController ||
            busy.value ||
            performance.now() < nextPollAt.value ||
            (!manual && (terminal.value || expired.value || connected.value || pollStopped.value))
        )
            return;
        const controller = new AbortController(),
            generation = ++readGeneration,
            session = lifecycle;
        readController = controller;
        checking.value = true;
        try {
            const result = await probeRequest(
                pairing.value
                    ? `pairings/requests/${pairing.value.id}`
                    : `pairings/windows/${pairingWindow.value.id}`,
                { signal: controller.signal }
            );
            if (
                !active ||
                controller.signal.aborted ||
                generation !== readGeneration ||
                session !== lifecycle
            )
                return;
            if (pairing.value) acceptPair(result);
            else acceptWindow(result);
            error.value = '';
            stale.value = false;
            waitMs = 5000;
        } catch (e) {
            if (active && !controller.signal.aborted && generation === readGeneration) {
                stale.value = true;
                handleError(e, 'read');
            }
        } finally {
            if (readController === controller) {
                readController = null;
                checking.value = false;
                schedule();
            }
        }
    }
    async function action(kind, path, body, accept) {
        if (
            !active ||
            !props.enabled ||
            !secure ||
            busy.value ||
            performance.now() < nextPollAt.value
        )
            return;
        invalidateReads();
        const controller = new AbortController(),
            session = lifecycle;
        actionController = controller;
        busy.value = kind;
        error.value = '';
        try {
            const result = await probeRequest(path, {
                method: 'POST',
                body,
                signal: controller.signal,
            });
            if (!active || controller.signal.aborted || session !== lifecycle) return;
            accept(result);
            stale.value = false;
            waitMs = 5000;
        } catch (e) {
            if (active && !controller.signal.aborted && session === lifecycle) {
                stale.value = true;
                handleError(e, kind);
            }
        } finally {
            if (actionController === controller) {
                actionController = null;
                busy.value = '';
                schedule();
            }
        }
    }
    async function openWizard() {
        if (!props.enabled || !secure || !installationAvailable.value) return;
        open.value = true;
        await nextTick();
        heading.value?.focus();
        schedule(0);
    }
    function createWindow() {
        if (pairingWindow.value || !selectedTerminalAvailable.value) return;
        return action('start', 'pairings/windows', {}, acceptWindow);
    }
    function resolveCode() {
        if (!canResolve.value) return;
        const normalized = userCode.value.trim().toUpperCase().replace('-', '');
        confirmed.value = false;
        return action(
            'resolve',
            'pairings/resolve',
            { windowId: pairingWindow.value.id, userCode: normalized },
            (result) => {
                const nextPair = safePair(result);
                pairing.value = null;
                acceptPair(nextPair);
                resolvedCode = normalized;
            }
        );
    }
    function clearReview() {
        confirmed.value = false;
        resolvedCode = '';
        if (pairing.value?.status === 'pending') {
            invalidateReads();
            pairing.value = null;
            schedule();
        }
    }
    function approve() {
        if (
            !confirmed.value ||
            state.value !== 'pending' ||
            !codeValid.value ||
            !resolvedCode ||
            stale.value
        )
            return;
        return action(
            'approve',
            `pairings/requests/${pairing.value.id}/approve`,
            { userCode: resolvedCode, confirmed: true },
            acceptPair
        );
    }
    function cancelWindow() {
        return action(
            'cancel',
            `pairings/windows/${pairingWindow.value.id}/cancel`,
            {},
            (result) => {
                acceptWindow(result);
                cancelling.value = false;
                nextTick(() => heading.value?.focus());
            }
        );
    }
    function reset() {
        if (!['expired', 'cancelled', 'connected', 'consumed'].includes(state.value) || busy.value)
            return;
        if (state.value === 'consumed' && !recoveryConfirmed.value) return;
        invalidateReads();
        pairingWindow.value = pairing.value = null;
        userCode.value = '';
        resolvedCode = '';
        confirmed.value = false;
        recoveryConfirmed.value = false;
        error.value = coolingDown.value ? 'slow' : '';
        stale.value = false;
        receivedAt.value = null;
        pollStopped.value = false;
        consumedSeenAt = null;
        waitMs = coolingDown.value ? Math.max(5000, nextPollAt.value - performance.now()) : 5000;
        cancelling.value = false;
    }
    async function requestCancellation(event) {
        cancelTrigger = event?.currentTarget || null;
        cancelling.value = true;
        await nextTick();
        cancelPanel.value?.focus();
    }
    async function keepWindow() {
        cancelling.value = false;
        await nextTick();
        if (cancelTrigger?.isConnected) cancelTrigger.focus();
        cancelTrigger = null;
    }
    async function closeWizard(event) {
        if (
            pairingWindow.value &&
            !['expired', 'cancelled', 'connected', 'consumed'].includes(state.value)
        ) {
            requestCancellation(event);
            return;
        }
        invalidateReads();
        open.value = false;
        await nextTick();
        startButton.value?.focus();
    }
    function visibilityChanged() {
        if (document.hidden) invalidateReads();
        else if (open.value) schedule(0);
    }
    function start() {
        if (active) return;
        active = true;
        lifecycle++;
        clock = setInterval(() => {
            monotonicNow.value = performance.now();
            if (receivedAt.value !== null)
                elapsed.value = Math.max(0, monotonicNow.value - receivedAt.value);
            const waitingEnded =
                consumedSeenAt !== null &&
                performance.now() - consumedSeenAt >= 120000 &&
                !connected.value;
            if (!pollStopped.value && (waitingEnded || expired.value || terminal.value)) {
                pollStopped.value = true;
                invalidateReads();
            }
        }, 1000);
        document.addEventListener('visibilitychange', visibilityChanged);
        if (open.value) schedule();
    }
    function stop() {
        active = false;
        lifecycle++;
        invalidateReads();
        actionController?.abort();
        actionController = null;
        clearInterval(clock);
        document.removeEventListener('visibilitychange', visibilityChanged);
        userCode.value = '';
        resolvedCode = '';
        cancelTrigger = null;
        confirmed.value = false;
        recoveryConfirmed.value = false;
        busy.value = '';
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
        data-testid="pairing-wizard"
        class="pair-card space-y-4 text-sm text-gray-700 dark:text-gray-200"
    >
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 space-y-2">
                <h4 class="font-semibold text-gray-900 dark:text-white">
                    {{ L('安装并连接检测器', 'Install and connect a detector') }}
                </h4>
                <p
                    id="pairing-release-status"
                    data-testid="pairing-installation-status"
                    role="status"
                    aria-atomic="true"
                    class="text-sm"
                >
                    {{ installationText }}
                </p>
                <p
                    v-if="
                        installation?.legacyReleases.some((release) => release.version === '0.1.0')
                    "
                    class="text-xs text-gray-500 dark:text-gray-400"
                >
                    {{
                        L(
                            'probe-v0.1.0 不支持配对或安装命令，请勿用于本向导。',
                            'probe-v0.1.0 does not support pairing or installation commands and cannot be used with this guide.'
                        )
                    }}
                </p>
            </div>
            <button
                v-if="!open"
                ref="startButton"
                class="pair-button pair-primary"
                data-testid="pairing-open"
                :disabled="!enabled || !secure || !installationAvailable"
                aria-describedby="pairing-release-status"
                @click="openWizard"
            >
                {{ L('安装并连接检测器', 'Install and connect a detector') }}
            </button>
            <button
                v-else
                class="pair-button"
                data-testid="pairing-close"
                :disabled="!!busy"
                @click="closeWizard"
            >
                {{ L('收起向导', 'Close guide') }}
            </button>
        </div>
        <div class="space-y-2">
            <p v-if="open && !selectedTerminalAvailable" class="pair-warning" role="status">
                {{
                    L(
                        '此终端对应的平台尚无完整兼容发行包，暂不能开启安装窗口。',
                        'Compatible packages are not available for every platform supported by this terminal. An installation window cannot be opened.'
                    )
                }}
            </p>
            <button
                v-if="!installationAvailable"
                data-testid="pairing-release-refresh"
                class="pair-button"
                :disabled="installationLoading || !!busy"
                @click="emit('refresh-installation')"
            >
                {{ L('刷新发行状态', 'Refresh release status') }}
            </button>
        </div>
        <p v-if="!secure" class="pair-warning">
            {{
                L(
                    '配对需要通过本站 HTTPS 地址访问。',
                    'Pairing requires this site to be accessed over HTTPS.'
                )
            }}
        </p>
        <div v-if="open" class="space-y-5">
            <h5
                ref="heading"
                data-testid="pairing-title"
                tabindex="-1"
                class="scroll-mt-24 rounded font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
                {{
                    L(
                        '开启窗口 → 输入终端短码 → 核对批准 → 确认连接',
                        'Open a window → Enter terminal code → Review and approve → Verify connection'
                    )
                }}
            </h5>
            <p data-testid="pairing-status" role="status" aria-atomic="true" class="font-semibold">
                {{ stateLabel
                }}<span v-if="stale"> · {{ L('状态待刷新', 'State needs refresh') }}</span>
            </p>
            <div v-if="errorText" class="pair-error" role="alert">{{ errorText }}</div>
            <div
                v-if="!pairingWindow || ['waiting', 'pending', 'approved'].includes(state)"
                class="min-w-0 space-y-1"
            >
                <label for="pairing-terminal" class="block font-medium">{{
                    L('命令终端', 'Command terminal')
                }}</label>
                <select
                    id="pairing-terminal"
                    v-model="terminalChoice"
                    data-testid="pairing-terminal"
                    class="min-h-11 w-full min-w-0 max-w-full rounded-lg border border-gray-300 bg-white px-3 sm:max-w-xs dark:border-gray-600 dark:bg-gray-800"
                >
                    <option value="unix">Linux / macOS</option>
                    <option value="windows">Windows PowerShell</option>
                </select>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                    {{
                        L(
                            '选择你将运行检测器的终端。此选择不会创建身份或安装软件。',
                            'Choose the terminal where you will run the detector. This selection does not create an identity or install software.'
                        )
                    }}
                </p>
            </div>
            <p
                v-if="coolingDown"
                data-testid="pairing-retry-after"
                class="text-xs text-gray-500 dark:text-gray-400"
            >
                {{ L('至少等待', 'Wait at least') }} {{ retryIn }}
                {{ L('秒后再操作。', 'seconds before trying again.') }}
            </p>
            <div v-if="!pairingWindow" class="space-y-3">
                <p>
                    {{
                        L(
                            '点击下方按钮开启 5 分钟配对窗口。只有核对短码并明确批准后，客户端才能创建检测器身份。',
                            'Open a five-minute pairing window below. The client can create an identity only after you review its code and explicitly approve it.'
                        )
                    }}
                </p>
                <p class="break-all">
                    {{ L('本站：', 'This site: ') }}<strong>{{ origin }}</strong>
                </p>
                <button
                    data-testid="pairing-start"
                    class="pair-button pair-primary"
                    :disabled="
                        !enabled || !secure || !selectedTerminalAvailable || !!busy || coolingDown
                    "
                    @click="createWindow"
                >
                    {{
                        busy === 'start'
                            ? L('正在开启…', 'Opening…')
                            : L('开启 5 分钟窗口', 'Open a 5-minute window')
                    }}
                </button>
            </div>
            <template v-else>
                <div
                    v-if="!['expired', 'cancelled', 'consumed', 'connected'].includes(state)"
                    class="space-y-3"
                >
                    <p>
                        {{ L('窗口剩余', 'Window remaining:') }} {{ remaining }}
                        {{
                            L(
                                '秒。关闭页面不会立即取消，窗口到期自动失效。',
                                'seconds. Closing this page does not immediately cancel it; the window expires automatically.'
                            )
                        }}
                    </p>
                    <p class="break-all" data-testid="pairing-window-id">
                        {{ L('公开窗口编号：', 'Public window ID: ')
                        }}<code>{{ pairingWindow.id }}</code>
                    </p>
                    <p class="text-xs text-gray-500 dark:text-gray-400">
                        {{
                            L(
                                '窗口编号用于关联客户端请求；终端中的私密设备凭据和配置不会传到本页面。只有明确批准后才可创建身份。',
                                'The public window ID associates a client request. Private device credentials and configuration stay off this page. Creating an identity requires your explicit approval.'
                            )
                        }}
                    </p>
                </div>
                <form
                    v-if="['waiting', 'pending'].includes(state)"
                    class="space-y-3"
                    @submit.prevent="resolveCode"
                >
                    <label for="pairing-user-code" class="block font-medium">{{
                        L('终端显示的短码', 'Code shown in the terminal')
                    }}</label>
                    <div class="flex flex-wrap gap-3">
                        <input
                            id="pairing-user-code"
                            v-model="userCode"
                            data-testid="pairing-code"
                            autocomplete="off"
                            autocapitalize="characters"
                            spellcheck="false"
                            maxlength="11"
                            placeholder="XXXXX-XXXXX"
                            class="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 font-mono dark:border-gray-600 dark:bg-gray-800"
                            :disabled="!!busy"
                            @input="clearReview"
                        /><button
                            data-testid="pairing-resolve"
                            class="pair-button"
                            :disabled="!canResolve || coolingDown"
                            type="submit"
                        >
                            {{
                                busy === 'resolve'
                                    ? L('正在核对…', 'Checking…')
                                    : L('核对设备', 'Review device')
                            }}
                        </button>
                    </div>
                </form>
                <div
                    v-if="pairing"
                    data-testid="pairing-device"
                    class="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                >
                    <h6 class="font-semibold">
                        {{ L('设备自报信息', 'Device-declared information') }}
                    </h6>
                    <dl class="grid gap-3 sm:grid-cols-2">
                        <div>
                            <dt>{{ L('名称', 'Name') }}</dt>
                            <dd class="break-words">{{ pairing.name }}</dd>
                        </div>
                        <div>
                            <dt>{{ L('版本 / 平台', 'Version / platform') }}</dt>
                            <dd class="break-words">
                                {{ pairing.version }} · {{ pairing.platform }}
                            </dd>
                        </div>
                        <div class="sm:col-span-2">
                            <dt>{{ L('绑定站点', 'Bound site') }}</dt>
                            <dd class="break-all">{{ pairing.origin }}</dd>
                        </div>
                        <div class="sm:col-span-2">
                            <dt>{{ L('终端比对指纹', 'Terminal comparison fingerprint') }}</dt>
                            <dd data-testid="pairing-fingerprint" class="break-all font-mono">
                                {{ pairing.fingerprint }}
                            </dd>
                        </div>
                    </dl>
                    <p class="text-xs text-gray-500 dark:text-gray-400">
                        {{
                            L(
                                '名称、平台和版本由客户端声明，指纹用于核对本次请求，不是硬件认证。请逐字核对终端中的指纹与本站地址。',
                                'Name, platform and version are declared by the client. The fingerprint identifies this request, not verified hardware. Compare it and the site address with your terminal.'
                            )
                        }}
                    </p>
                    <template v-if="state === 'pending'"
                        ><label class="flex min-h-11 cursor-pointer items-start gap-3 py-2"
                            ><input
                                v-model="confirmed"
                                data-testid="pairing-confirm"
                                type="checkbox"
                                class="mt-1 h-4 w-4 shrink-0"
                                :disabled="!!busy || stale"
                            /><span>{{
                                L(
                                    '我已核对本站、设备信息和终端指纹，允许此客户端创建检测器身份。',
                                    'I verified this site, the device details and terminal fingerprint, and allow this client to create a detector identity.'
                                )
                            }}</span></label
                        ><button
                            data-testid="pairing-approve"
                            class="pair-button pair-primary"
                            :disabled="!confirmed || !codeValid || !!busy || stale || coolingDown"
                            @click="approve"
                        >
                            {{
                                busy === 'approve'
                                    ? L('正在批准…', 'Approving…')
                                    : L('批准此设备', 'Approve this device')
                            }}
                        </button></template
                    >
                </div>
                <p v-if="state === 'approved'" class="pair-warning">
                    {{
                        L(
                            '等待终端领取并安全保存配置。批准本身不代表身份已创建或已连接。',
                            'Waiting for the terminal to claim and safely save its configuration. Approval alone does not mean an identity was created or connected.'
                        )
                    }}
                </p>
                <div v-if="['consumed', 'connected'].includes(state)" class="space-y-3">
                    <p v-if="state === 'connected'">
                        {{
                            L(
                                '已记录认证领单或心跳通信。这不表示节点检测成功。',
                                'An authenticated task poll or heartbeat was recorded. This does not indicate a successful node check.'
                            )
                        }}
                        {{ date(pairing.lastSeen) }}
                    </p>
                    <p v-else class="pair-warning">
                        {{
                            L(
                                '身份已创建，但未收到真实通信。若终端丢失兑换响应或保存配置失败，请在下方管理列表撤销此身份，再明确开启新配对；配置不能再次领取。',
                                'The identity was created, but no authenticated communication was recorded. If the terminal lost its exchange response or failed to save configuration, revoke this identity in the management list before starting a new pairing. The configuration cannot be retrieved again.'
                            )
                        }}
                    </p>
                    <p class="break-all">
                        {{ L('检测器身份：', 'Detector identity: ') }}{{ pairing.agentId }}
                    </p>
                    <p v-if="pollStopped && !connected">
                        {{
                            L(
                                '自动等待已结束，可手动刷新核对状态。',
                                'Automatic waiting has ended. Refresh manually to verify its state.'
                            )
                        }}
                    </p>
                    <div v-if="state === 'consumed'" class="space-y-3">
                        <label class="flex min-h-11 cursor-pointer items-start gap-3 py-2">
                            <input
                                v-model="recoveryConfirmed"
                                data-testid="pairing-recovery-confirm"
                                type="checkbox"
                                class="mt-1 h-4 w-4 shrink-0"
                                :disabled="!!busy"
                            />
                            <span>{{
                                L(
                                    '我已在管理列表中撤销上面的未连接身份，准备重新配对。',
                                    'I have revoked the unconnected identity shown above in the management list and am ready to pair again.'
                                )
                            }}</span>
                        </label>
                        <button
                            data-testid="pairing-recover-reset"
                            class="pair-button"
                            :disabled="!recoveryConfirmed || !!busy"
                            @click="reset"
                        >
                            {{ L('撤销后准备新配对', 'Prepare a new pairing after revocation') }}
                        </button>
                        <p class="text-xs text-gray-500 dark:text-gray-400">
                            {{
                                L(
                                    '此操作仅重置向导，不会撤销身份或开启新窗口。未取消的旧窗口仍按原定时间过期。',
                                    'This only resets the guide; it does not revoke an identity or open a new window. An uncancelled old window keeps its original expiry.'
                                )
                            }}
                        </p>
                    </div>
                </div>
                <div
                    v-if="cancelling"
                    ref="cancelPanel"
                    tabindex="-1"
                    data-testid="pairing-cancel-confirmation"
                    class="pair-warning scroll-mt-24 space-y-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
                >
                    <p>
                        {{
                            L(
                                '取消此窗口会使尚未兑换的请求失效。已经创建的身份仍需在管理列表单独撤销。',
                                'Cancelling this window invalidates unclaimed requests. Any identity already created must be revoked separately in the management list.'
                            )
                        }}
                    </p>
                    <div class="flex flex-wrap gap-3">
                        <button
                            data-testid="pairing-keep"
                            class="pair-button"
                            :disabled="!!busy"
                            @click="keepWindow"
                        >
                            {{ L('保留窗口', 'Keep window') }}</button
                        ><button
                            data-testid="pairing-cancel-confirm"
                            class="pair-button pair-danger"
                            :disabled="!!busy || coolingDown"
                            @click="cancelWindow"
                        >
                            {{
                                busy === 'cancel'
                                    ? L('正在取消…', 'Cancelling…')
                                    : L('确认取消窗口', 'Confirm cancellation')
                            }}
                        </button>
                    </div>
                </div>
                <div class="flex flex-wrap gap-3">
                    <button
                        data-testid="pairing-refresh"
                        class="pair-button"
                        :disabled="checking || !!busy || coolingDown"
                        @click="refreshState(true)"
                    >
                        {{
                            checking
                                ? L('刷新中…', 'Refreshing…')
                                : L('刷新配对状态', 'Refresh pairing state')
                        }}</button
                    ><button
                        v-if="!['expired', 'cancelled'].includes(state)"
                        data-testid="pairing-cancel"
                        class="pair-button"
                        :disabled="!!busy"
                        @click="requestCancellation"
                    >
                        {{ L('取消窗口', 'Cancel window') }}</button
                    ><button
                        v-if="['expired', 'cancelled', 'connected'].includes(state)"
                        data-testid="pairing-reset"
                        class="pair-button"
                        :disabled="!!busy"
                        @click="reset"
                    >
                        {{ L('准备另一次配对', 'Prepare another pairing') }}
                    </button>
                </div>
            </template>
        </div>
    </section>
</template>

<style scoped>
    @reference '../../../assets/main.css';
    .pair-card {
        @apply rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900;
    }
    .pair-button {
        @apply inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 font-medium transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700;
    }
    .pair-primary {
        @apply border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700 dark:border-indigo-500 dark:bg-indigo-600 dark:hover:bg-indigo-500;
    }
    .pair-danger {
        @apply border-red-600 bg-red-600 text-white hover:bg-red-700 dark:border-red-500 dark:bg-red-600 dark:hover:bg-red-500;
    }
    .pair-error {
        @apply rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200;
    }
    .pair-warning {
        @apply rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200;
    }
    dt {
        @apply text-xs text-gray-500 dark:text-gray-400;
    }
    dd {
        @apply text-gray-900 dark:text-gray-100;
    }
    button:focus-visible,
    input:focus-visible,
    select:focus-visible {
        @apply outline outline-2 outline-offset-2 outline-indigo-500;
    }
    @media (prefers-reduced-motion: reduce) {
        .pair-button {
            transition: none;
        }
    }
</style>
