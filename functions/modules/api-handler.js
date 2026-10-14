/**
 * API处理模块
 * 处理各种API请求
 */

import {
    StorageFactory,
    SettingsCache,
    STORAGE_TYPES,
    validateStoredCollection,
} from '../storage-adapter.js';
import {
    getCookieSecret,
    getAdminPassword,
    setAdminPassword,
    isUsingDefaultPassword,
    createJsonResponse,
    createErrorResponse,
    migrateProfileIds,
    JSON_BODY_LIMITS,
    readJsonWithLimit,
} from './utils.js';
import {
    authMiddleware,
    handleLogin,
    handleLogout,
    createUnauthorizedResponse,
} from './auth-middleware.js';
import { sendTgNotification, checkAndNotify } from './notifications.js';
import { clearAllNodeCaches } from '../services/node-cache-service.js';
import { buildSubscriptionNodeCacheKey } from '../services/subscription-service.js';
import { maybeRunScheduledTasks } from './scheduled-task-runner.js';
import {
    isAtomicSubscriptionStorage,
    isAtomicSubscriptionRequested,
    getProtocolError,
    protocolError,
    requireMutationMetadata,
} from '../services/subscription-protocol/index.js';

import {
    KV_KEY_SUBS,
    KV_KEY_PROFILES,
    KV_KEY_SETTINGS,
    DEFAULT_SETTINGS as defaultSettings,
} from './config.js';
import { listRuleTemplates } from './rule-template-handler.js';

const PROFILE_DOWNLOAD_COUNT_PREFIX = 'misub_profile_download_count_';

function normalizeLoginPath(customLoginPath) {
    if (typeof customLoginPath !== 'string') return '/login';
    const normalized = customLoginPath.trim().replace(/^\/+/, '');
    return normalized && normalized !== 'login' ? `/${normalized}` : '/login';
}

function normalizeProfile(profile = {}) {
    const normalized = { ...profile };
    normalized.subscriptions = Array.isArray(profile.subscriptions) ? profile.subscriptions : [];
    normalized.manualNodes = Array.isArray(profile.manualNodes) ? profile.manualNodes : [];
    normalized.enabled = profile.enabled !== false;
    normalized.isPublic = profile.isPublic === true;
    normalized.downloadCount = Number(profile.downloadCount) || 0;
    return normalized;
}

async function attachProfileDownloadCounts(storageAdapter, profiles) {
    if (!Array.isArray(profiles) || profiles.length === 0) return profiles;

    const counts = await Promise.all(
        profiles.map((profile) =>
            storageAdapter.get(`${PROFILE_DOWNLOAD_COUNT_PREFIX}${profile.customId || profile.id}`)
        )
    );

    return profiles.map((profile, index) =>
        normalizeProfile({
            ...profile,
            downloadCount: Number(counts[index]) || Number(profile.downloadCount) || 0,
        })
    );
}

function isStorageUnavailableError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return (
        message.includes('kv storage is paused') ||
        message.includes('storage is paused') ||
        message.includes('namespace is paused')
    );
}

/**
 * 获取存储适配器实例
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Object>} 存储适配器实例
 */
async function getStorageAdapter(env, { requireBinding = false } = {}) {
    const storageType = await StorageFactory.getStorageType(env);
    if (requireBinding) assertStorageBinding(env, storageType);
    return StorageFactory.createAdapter(env, storageType);
}

function assertStorageBinding(env, storageType) {
    const available =
        storageType === STORAGE_TYPES.D1
            ? Boolean(env?.MISUB_DB)
            : storageType === STORAGE_TYPES.KV && Boolean(StorageFactory.resolveKV(env));
    if (!available) {
        const error = new Error('STORAGE_UNAVAILABLE');
        error.code = 'STORAGE_UNAVAILABLE';
        throw error;
    }
}

async function readAuthoritativeCollection(storageAdapter, method, key) {
    const items =
        typeof storageAdapter[method] === 'function'
            ? await storageAdapter[method]({ authoritative: true })
            : ((await storageAdapter.get(key)) ?? []);
    return validateStoredCollection(items);
}

function storageReadFailureResponse(error) {
    if (error?.code !== 'STORAGE_COLLECTION_READ_FAILED' && error?.code !== 'STORAGE_UNAVAILABLE') {
        return null;
    }
    return createJsonResponse(
        {
            success: false,
            code: error.code,
            message: '无法读取完整订阅数据，请检查存储状态后重试',
        },
        503
    );
}

function subscriptionProtocolFailure(error) {
    const failure = getProtocolError(error);
    return createJsonResponse(
        { success: false, code: failure.code, message: failure.message },
        failure.status
    );
}

async function saveAtomicSubscriptions(storageAdapter, request, payload, env) {
    const metadata = requireMutationMetadata(payload, request);
    if (!Array.isArray(payload?.operations)) throw protocolError('legacy_write_blocked');
    if ('misubs' in payload || 'profiles' in payload || 'diff' in payload)
        throw protocolError('invalid_operation');
    const result = await storageAdapter.commitSubscriptionOperations({
        ...metadata,
        operations: payload.operations,
    });
    if (!result.replayed) {
        try {
            await clearAllNodeCaches(storageAdapter);
            const settings = (await storageAdapter.get(KV_KEY_SETTINGS)) || defaultSettings;
            await Promise.allSettled(
                result.snapshot.subscriptions
                    .filter((sub) => sub?.enabled && /^https?:\/\//i.test(sub.url || ''))
                    .map((sub) => checkAndNotify(structuredClone(sub), settings, env))
            );
        } catch {
            console.warn('[API /misubs] Post-commit effects unavailable');
        }
    }
    return createJsonResponse({
        success: true,
        data: {
            misubs: result.snapshot.subscriptions,
            profiles: result.snapshot.profiles,
            version: result.snapshot.version,
        },
        receipt: result.receipt,
        replayed: result.replayed,
    });
}

function invalidSubscriptionDataResponse() {
    return createJsonResponse(
        {
            success: false,
            code: 'INVALID_SUBSCRIPTION_DATA',
            message: '订阅与订阅组数据格式错误，每个集合必须包含有效且互不重复的字符串 ID',
        },
        400
    );
}

function validateSavedCollection(items) {
    validateStoredCollection(items);
    if (new Set(items.map((item) => item.id)).size !== items.length) {
        throw new Error('duplicate_item_id');
    }
}

function validateSubscriptionSaveRequest(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('invalid_request');
    if (!data.diff) {
        validateSavedCollection(data.misubs);
        validateSavedCollection(data.profiles);
        return;
    }

    const assertPatchObject = (patch) => {
        // Empty array patches remain compatible with existing no-op clients.
        if (typeof patch !== 'object' || (Array.isArray(patch) && patch.length > 0)) {
            throw new Error('invalid_patch');
        }
    };
    assertPatchObject(data.diff);
    for (const patch of [data.diff.subscriptions, data.diff.profiles]) {
        if (patch == null) continue;
        assertPatchObject(patch);
        for (const operation of ['added', 'updated']) {
            if (patch[operation] !== undefined) validateSavedCollection(patch[operation]);
        }
        if (
            patch.removed !== undefined &&
            (!Array.isArray(patch.removed) ||
                patch.removed.some((id) => typeof id !== 'string' || !id.trim()))
        ) {
            throw new Error('invalid_removed_ids');
        }
    }
}

function isSimpleArrayDiff(diff) {
    if (!diff || typeof diff !== 'object') return false;
    const allowedKeys = ['added', 'updated', 'removed'];
    if (!Object.keys(diff).every((key) => allowedKeys.includes(key))) return false;
    return ['added', 'updated', 'removed'].every((key) => Array.isArray(diff[key] || []));
}

async function applyRowLevelDiff(storageAdapter, type, diff) {
    const isProfile = type === 'profiles';
    const putItem = isProfile
        ? storageAdapter.putProfile?.bind(storageAdapter)
        : storageAdapter.putSubscription?.bind(storageAdapter);
    const deleteItem = isProfile
        ? storageAdapter.deleteProfileById?.bind(storageAdapter)
        : storageAdapter.deleteSubscriptionById?.bind(storageAdapter);

    if (!putItem || !deleteItem || !isSimpleArrayDiff(diff)) {
        return false;
    }

    // KV 模式下不支持行级 Diff，必须使用全量覆盖以保证原子性
    if (storageAdapter.type === STORAGE_TYPES.KV) {
        return false;
    }

    const { added = [], updated = [], removed = [] } = diff;

    await Promise.all([
        ...added.map((item) => putItem(item)),
        ...updated.map((item) => putItem(item)),
        ...removed.map((id) => deleteItem(id)),
    ]);

    return true;
}

async function syncCollectionRowLevel(storageAdapter, type, finalItems, currentItems) {
    const isProfile = type === 'profiles';
    const putItem = isProfile
        ? storageAdapter.putProfile?.bind(storageAdapter)
        : storageAdapter.putSubscription?.bind(storageAdapter);
    const deleteItem = isProfile
        ? storageAdapter.deleteProfileById?.bind(storageAdapter)
        : storageAdapter.deleteSubscriptionById?.bind(storageAdapter);

    if (!putItem || !deleteItem || !Array.isArray(finalItems)) {
        return false;
    }

    // KV 模式下不支持行级同步，必须使用全量覆盖以保证原子性
    if (storageAdapter.type === STORAGE_TYPES.KV) {
        return false;
    }

    const currentMap = new Map(currentItems.map((item) => [item.id, item]));
    const finalMap = new Map(finalItems.map((item) => [item.id, item]));

    const puts = [];
    const deletes = [];

    for (const item of finalItems) {
        const existing = currentMap.get(item.id);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(item)) {
            puts.push(putItem(item));
        }
    }

    for (const existing of currentItems) {
        if (!finalMap.has(existing.id)) {
            deletes.push(deleteItem(existing.id));
        }
    }

    await Promise.all([...puts, ...deletes]);
    return true;
}

/**
 * 处理数据获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleDataRequest(env, context = null) {
    let storageType = 'unknown';
    let atomic = false;
    try {
        storageType = await StorageFactory.getStorageType(env);
        assertStorageBinding(env, storageType);
        const storageAdapter = StorageFactory.createAdapter(env, storageType);
        atomic = isAtomicSubscriptionStorage(storageAdapter);
        const snapshot = atomic ? await storageAdapter.readDomainSnapshot() : null;
        const cachedSettings = atomic ? snapshot.settings : await SettingsCache.get(env);
        const [misubs, rawProfiles, settings, ruleTemplates] = await Promise.all([
            atomic
                ? snapshot.subscriptions
                : readAuthoritativeCollection(storageAdapter, 'getAllSubscriptions', KV_KEY_SUBS),
            atomic
                ? snapshot.profiles
                : readAuthoritativeCollection(storageAdapter, 'getAllProfiles', KV_KEY_PROFILES),
            Promise.resolve(cachedSettings || {}).then((res) => res || {}),
            atomic
                ? snapshot.ruleTemplates
                : listRuleTemplates(storageAdapter).catch((error) => {
                      console.warn(
                          '[API /data] Failed to load custom rule templates:',
                          error?.message || error
                      );
                      return [];
                  }),
        ]);
        const profiles = atomic
            ? rawProfiles
            : await attachProfileDownloadCounts(storageAdapter, rawProfiles);

        // 自动迁移旧版 profile ID（去除 'profile_' 前缀）
        if (!atomic && migrateProfileIds(profiles)) {
            storageAdapter
                .put(KV_KEY_PROFILES, profiles)
                .catch((err) =>
                    console.error('[Migration] Failed to persist migrated profile IDs:', err)
                );
        }
        const config = {
            ...defaultSettings,
            ...(atomic ? redactSettingsForResponse(settings) : settings),
            ...(atomic ? { storageType: STORAGE_TYPES.D1 } : {}),
            isDefaultPassword: await isUsingDefaultPassword(env),
        };
        try {
            const taskContext = context || { env };
            const runPromise = maybeRunScheduledTasks(taskContext, { source: 'admin-api' });
            const tracked = runPromise.catch(() =>
                console.warn('[ScheduledTasks] lazy check failed')
            );
            if (typeof taskContext.waitUntil === 'function') taskContext.waitUntil(tracked);
        } catch (taskError) {
            console.warn('[ScheduledTasks] lazy check init failed');
        }
        return createJsonResponse({
            misubs,
            profiles,
            ruleTemplates,
            config,
            ...(atomic
                ? {
                      version: snapshot.version,
                      subscriptionProtocol: storageAdapter.subscriptionProtocol,
                  }
                : {}),
        });
    } catch (e) {
        if (atomic || isAtomicSubscriptionRequested(env)) return subscriptionProtocolFailure(e);
        const failure = storageReadFailureResponse(e);
        if (failure) return failure;
        console.error('[API Error /data] Failed to read from storage', {
            storageType,
            hasKv: !!StorageFactory.resolveKV(env),
            hasD1: !!env?.MISUB_DB,
        });
        return createErrorResponse('读取数据失败，请稍后重试', 500);
    }
}

/**
 * 处理订阅和配置保存API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
import { applyPatch } from './patch-utils.js';

// ... (existing imports)

/**
 * 处理订阅和配置保存API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleMisubsSave(request, env) {
    let atomic = false;
    try {
        // 步骤1: 解析请求体
        let requestData;
        try {
            requestData = await readJsonWithLimit(request, JSON_BODY_LIMITS.large);
        } catch (parseError) {
            if (isAtomicSubscriptionRequested(env))
                return subscriptionProtocolFailure(protocolError('invalid_data'));
            console.error('[API Error /misubs] JSON解析失败:', parseError);
            return createJsonResponse(
                {
                    success: false,
                    message:
                        parseError.status === 413
                            ? parseError.message
                            : '请求数据格式错误，请检查数据格式',
                },
                parseError.status || 400
            );
        }

        const storageAdapter = await getStorageAdapter(env, { requireBinding: true });
        atomic = isAtomicSubscriptionStorage(storageAdapter);
        if (atomic) return await saveAtomicSubscriptions(storageAdapter, request, requestData, env);

        try {
            validateSubscriptionSaveRequest(requestData);
        } catch {
            return invalidSubscriptionDataResponse();
        }

        const { misubs, profiles, diff } = requestData;

        let finalMisubs = misubs;
        let finalProfiles = profiles;

        // Complete both authoritative reads before notifications or business writes.
        const [currentMisubs, currentProfiles] = await Promise.all([
            readAuthoritativeCollection(storageAdapter, 'getAllSubscriptions', KV_KEY_SUBS),
            readAuthoritativeCollection(storageAdapter, 'getAllProfiles', KV_KEY_PROFILES),
        ]);

        // 步骤1.5: 检查是否为 Diff 模式
        if (diff) {
            console.info('[API] Processing Diff Patch...');
            // 应用补丁
            if (diff.subscriptions) {
                finalMisubs = applyPatch(currentMisubs, diff.subscriptions);
            } else {
                finalMisubs = currentMisubs; // 无变动
            }

            if (diff.profiles) {
                finalProfiles = applyPatch(currentProfiles, diff.profiles);
            } else {
                finalProfiles = currentProfiles; // 无变动
            }
        }

        if (Array.isArray(finalProfiles)) {
            finalProfiles = finalProfiles.map((p, index) => ({
                ...normalizeProfile(p),
                sortIndex: index,
            }));

            // [Fix] Sync sortIndex back to diff for correct row-level persistence
            if (diff?.profiles) {
                const profileMap = new Map(finalProfiles.map((p) => [p.id, p]));
                if (diff.profiles.added)
                    diff.profiles.added = diff.profiles.added.map((p) => ({
                        ...p,
                        sortIndex: profileMap.get(p.id)?.sortIndex,
                    }));
                if (diff.profiles.updated)
                    diff.profiles.updated = diff.profiles.updated.map((p) => ({
                        ...p,
                        sortIndex: profileMap.get(p.id)?.sortIndex,
                    }));
            }
        }

        if (Array.isArray(finalMisubs)) {
            finalMisubs = finalMisubs.map((s, index) => ({
                ...s,
                sortIndex: index,
            }));

            // [Fix] Sync sortIndex back to diff for correct row-level persistence
            if (diff?.subscriptions) {
                const subMap = new Map(finalMisubs.map((s) => [s.id, s]));
                if (diff.subscriptions.added)
                    diff.subscriptions.added = diff.subscriptions.added.map((s) => ({
                        ...s,
                        sortIndex: subMap.get(s.id)?.sortIndex,
                    }));
                if (diff.subscriptions.updated)
                    diff.subscriptions.updated = diff.subscriptions.updated.map((s) => ({
                        ...s,
                        sortIndex: subMap.get(s.id)?.sortIndex,
                    }));
            }
        }

        try {
            validateSavedCollection(finalMisubs);
            validateSavedCollection(finalProfiles);
        } catch {
            return invalidSubscriptionDataResponse();
        }

        // 步骤4: 获取设置（带错误处理）
        let settings;
        try {
            settings = (await storageAdapter.get(KV_KEY_SETTINGS)) || defaultSettings;
        } catch (settingsError) {
            settings = defaultSettings; // 使用默认设置继续
        }

        // 步骤5: 处理通知（非阻塞，错误不影响保存）
        // 仅在有订阅数据时处理
        if (finalMisubs && finalMisubs.length > 0) {
            try {
                const notificationPromises = finalMisubs
                    .filter((sub) => sub?.enabled && sub.url && sub.url.startsWith('http'))
                    .map((sub) =>
                        checkAndNotify(sub, settings, env).catch((notifyError) => {
                            console.warn(
                                '[API] Notification failed for subscription:',
                                sub?.name || sub?.url,
                                notifyError
                            );
                        })
                    );

                // 并行处理通知，但不等待完成
                Promise.all(notificationPromises).catch((e) => {
                    console.warn('[API] Notification batch error:', e);
                });
            } catch (notificationError) {
                console.warn('[API] Notification system error:', notificationError);
            }
        }

        // 步骤6: 保存数据到存储（使用存储适配器）
        try {
            if (diff) {
                const [subsHandled, profilesHandled] = await Promise.all([
                    diff.subscriptions
                        ? applyRowLevelDiff(storageAdapter, 'subscriptions', diff.subscriptions)
                        : false,
                    diff.profiles
                        ? applyRowLevelDiff(storageAdapter, 'profiles', diff.profiles)
                        : false,
                ]);

                const saveTasks = [];
                if (!subsHandled) saveTasks.push(storageAdapter.put(KV_KEY_SUBS, finalMisubs));
                if (!profilesHandled)
                    saveTasks.push(storageAdapter.put(KV_KEY_PROFILES, finalProfiles));
                if (saveTasks.length > 0) {
                    await Promise.all(saveTasks);
                }
            } else {
                const [subsHandled, profilesHandled] = await Promise.all([
                    syncCollectionRowLevel(
                        storageAdapter,
                        'subscriptions',
                        finalMisubs,
                        currentMisubs
                    ),
                    syncCollectionRowLevel(
                        storageAdapter,
                        'profiles',
                        finalProfiles,
                        currentProfiles
                    ),
                ]);

                const saveTasks = [];
                if (!subsHandled) saveTasks.push(storageAdapter.put(KV_KEY_SUBS, finalMisubs));
                if (!profilesHandled)
                    saveTasks.push(storageAdapter.put(KV_KEY_PROFILES, finalProfiles));
                if (saveTasks.length > 0) {
                    await Promise.all(saveTasks);
                }
            }
        } catch (storageError) {
            console.error('[API Error /misubs] Storage put failed');
            return createJsonResponse(
                {
                    success: false,
                    message: '数据保存失败，存储服务暂时不可用，请稍后重试',
                },
                500
            );
        }

        // 步骤6.5: 清除节点缓存（订阅变动后确保拉取最新数据）
        try {
            const preserveKeys = (Array.isArray(finalMisubs) ? finalMisubs : [])
                .filter((sub) => sub?.enableNodeCache === true)
                .map((sub) => buildSubscriptionNodeCacheKey(sub));
            const cacheResult = await clearAllNodeCaches(storageAdapter, { preserveKeys });
            console.info(
                `[API] Cleared ${cacheResult.cleared} node caches after subscription update, preserved ${cacheResult.skipped || 0}`
            );
        } catch (cacheError) {
            // 缓存清除失败不影响保存结果
            console.warn('[API] Failed to clear node caches:', cacheError.message);
        }

        // 步骤7: 返回保存后的数据，确保前端能更新状态
        return createJsonResponse({
            success: true,
            message: diff ? '增量更新已保存' : '订阅源及订阅组已保存',
            data: {
                misubs: finalMisubs,
                profiles: finalProfiles,
            },
        });
    } catch (e) {
        if (atomic || isAtomicSubscriptionRequested(env)) return subscriptionProtocolFailure(e);
        const failure = storageReadFailureResponse(e);
        if (failure) return failure;
        console.error('[API Error /misubs] Save failed');
        return createJsonResponse(
            {
                success: false,
                message: '保存失败，服务器内部错误，请稍后重试',
            },
            500
        );
    }
}

/**
 * 处理设置获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
function redactSettingsForResponse(settings = {}) {
    const redacted = {
        ...settings,
        webdavBackup: settings.webdavBackup
            ? { ...settings.webdavBackup, password: '' }
            : settings.webdavBackup,
    };
    for (const key of [
        'adminPassword',
        'ADMIN_PASSWORD',
        'password',
        'cookieSecret',
        'COOKIE_SECRET',
        'sessionSecret',
    ])
        delete redacted[key];
    return redacted;
}

export async function handleSettingsGet(env) {
    try {
        if (isAtomicSubscriptionRequested(env)) {
            const storage = await getStorageAdapter(env);
            const snapshot = await storage.readDomainSnapshot();
            return createJsonResponse({
                success: true,
                data: redactSettingsForResponse({
                    ...defaultSettings,
                    ...snapshot.settings,
                    storageType: STORAGE_TYPES.D1,
                }),
                version: snapshot.version,
                subscriptionProtocol: storage.subscriptionProtocol,
            });
        }
        const settings = (await SettingsCache.get(env)) || {};
        return createJsonResponse(redactSettingsForResponse({ ...defaultSettings, ...settings }));
    } catch (e) {
        if (isAtomicSubscriptionRequested(env)) return subscriptionProtocolFailure(e);
        if (isStorageUnavailableError(e)) {
            return createJsonResponse({
                ...defaultSettings,
                storageType: 'kv',
                storageUnavailable: true,
            });
        }
        return createErrorResponse('读取设置失败', 500);
    }
}

/**
 * 处理设置保存API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleSettingsSave(request, env) {
    try {
        const payload = await readJsonWithLimit(request, JSON_BODY_LIMITS.large);
        const metadata = isAtomicSubscriptionRequested(env)
            ? requireMutationMetadata(payload, request)
            : null;
        const newSettings = metadata ? payload.settings : payload;
        if (
            metadata &&
            (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings))
        )
            throw protocolError('invalid_data');
        if (
            isAtomicSubscriptionRequested(env) &&
            newSettings.storageType !== undefined &&
            newSettings.storageType !== STORAGE_TYPES.D1
        ) {
            return subscriptionProtocolFailure(protocolError('legacy_write_blocked'));
        }

        const reservedPathRoots = new Set([
            'settings',
            'login',
            'groups',
            'nodes',
            'subscriptions',
            'dashboard',
            'api',
            'explore',
            'sub',
            'cron',
            'assets',
            '@vite',
            'public',
            'profile',
            'logout',
            'auth_debug',
            'auth_check',
            'data',
            'kv_test',
            'clients',
            'system',
            'github',
            'telegram',
            'test_notification',
            'misubs',
            'node_count',
            'nodes',
            'fetch_external_url',
            'batch_update_nodes',
            'subscription_nodes',
            'debug_subscription',
            'preview',
        ]);

        const normalizePathRoot = (value) => {
            if (typeof value !== 'string') return '';
            return value.trim().replace(/^\/+/, '').split('/')[0].toLowerCase();
        };

        const rejectReservedValue = (value, fieldLabel) => {
            const pathRoot = normalizePathRoot(value);
            if (pathRoot && reservedPathRoots.has(pathRoot)) {
                return createJsonResponse(
                    {
                        success: false,
                        message: `"/${pathRoot}" 是系统保留路径，不可用作${fieldLabel}`,
                    },
                    400
                );
            }
            return null;
        };

        // 校验 customLoginPath 是否为系统保留路径
        if (newSettings.customLoginPath) {
            const rejected = rejectReservedValue(newSettings.customLoginPath, '自定义登录路径');
            if (rejected) return rejected;
        }

        // 订阅 Token 也不能使用会和路由冲突的保留路径
        if (newSettings.mytoken && newSettings.mytoken !== 'auto') {
            const rejected = rejectReservedValue(newSettings.mytoken, '自定义订阅Token');
            if (rejected) return rejected;
        }
        if (newSettings.profileToken && newSettings.profileToken !== 'profiles') {
            const rejected = rejectReservedValue(newSettings.profileToken, '订阅组分享Token');
            if (rejected) return rejected;
        }

        const storageAdapter = await getStorageAdapter(env);
        const snapshot = metadata ? await storageAdapter.readDomainSnapshot() : null;
        if (snapshot) {
            if (snapshot.version.epoch !== metadata.baseVersion.epoch)
                throw protocolError('epoch_conflict');
            if (snapshot.version.revision !== metadata.baseVersion.revision)
                throw protocolError('revision_conflict');
        }
        const oldSettings = snapshot
            ? snapshot.settings
            : (await storageAdapter.get(KV_KEY_SETTINGS)) || {};
        if (newSettings.webdavBackup && oldSettings.webdavBackup) {
            const incomingPassword = newSettings.webdavBackup.password;
            if (incomingPassword === '' || incomingPassword == null) {
                newSettings.webdavBackup = {
                    ...newSettings.webdavBackup,
                    password: oldSettings.webdavBackup.password,
                };
            }
        }
        let finalSettings = { ...oldSettings, ...newSettings };
        let domainResult;

        // 使用存储适配器保存设置
        try {
            if (metadata) {
                domainResult = await storageAdapter.commitDomainOperations({
                    ...metadata,
                    domains: { settings: finalSettings },
                });
                finalSettings = domainResult.snapshot.settings;
            } else await storageAdapter.put(KV_KEY_SETTINGS, finalSettings);
        } catch (storageError) {
            if (isAtomicSubscriptionRequested(env)) throw storageError;
            if (isStorageUnavailableError(storageError)) {
                return createJsonResponse(
                    {
                        success: false,
                        message:
                            'KV 存储已暂停，设置当前无法保存。请先恢复 KV 绑定，或配置 D1 后切换到 D1 存储。',
                    },
                    503
                );
            }
            throw storageError;
        }

        if (!isAtomicSubscriptionStorage(storageAdapter)) {
            // 双存储同步：尽量保持 KV / D1 一致
            try {
                const d1Adapter = StorageFactory.createAdapter(env, STORAGE_TYPES.D1);
                await d1Adapter.put(KV_KEY_SETTINGS, finalSettings);
            } catch (syncError) {
                console.warn(
                    '[API] Failed to sync settings to D1:',
                    syncError?.message || syncError
                );
            }
            try {
                const kvAdapter = StorageFactory.createAdapter(env, STORAGE_TYPES.KV);
                await kvAdapter.put(KV_KEY_SETTINGS, finalSettings);
            } catch (syncError) {
                console.warn(
                    '[API] Failed to sync settings to KV:',
                    syncError?.message || syncError
                );
            }
        }
        SettingsCache.clear();

        // 纯界面偏好的保存（客户端用 X-MiSub-Save-Scope: preferences 声明，
        // 目前只有「忽略的待处理项」走这条路）不需要让整站节点缓存失效，
        // 也不该给用户发一条「设置已更新」的 TG 消息 ——
        // 「忽略」是轻量动作，每次都触发通知 + 全量缓存重建会很扰民。
        // 用请求头而不是在 body 里塞标记：body 会被 { ...oldSettings, ...newSettings }
        // 合并进设置并持久化，标记会变成脏数据。
        // 注意：只有确实不影响节点处理的载荷才允许带这个头，
        // 否则会漏掉必要的缓存失效。
        const preferencesOnly = request.headers.get('x-misub-save-scope') === 'preferences';

        if (!preferencesOnly) {
            // 清除节点缓存（设置变更可能影响节点处理逻辑）
            try {
                await clearAllNodeCaches(storageAdapter);
            } catch (cacheError) {
                console.warn('[API] Failed to clear node caches:', cacheError.message);
            }

            const message = `⚙️ *MiSub 设置更新* ⚙️\n\n您的 MiSub 应用设置已成功更新。`;
            if (metadata) {
                try {
                    await sendTgNotification(finalSettings, message);
                } catch {
                    console.warn('[API /settings] Post-commit notification unavailable');
                }
            } else await sendTgNotification(finalSettings, message);
        }

        return createJsonResponse({
            success: true,
            message: '设置已保存',
            data: redactSettingsForResponse(finalSettings),
            ...(domainResult
                ? {
                      version: domainResult.snapshot.version,
                      receipt: domainResult.receipt,
                      replayed: domainResult.replayed,
                      subscriptionProtocol: storageAdapter.subscriptionProtocol,
                  }
                : {}),
        });
    } catch (e) {
        if (isAtomicSubscriptionRequested(env))
            return subscriptionProtocolFailure(
                e instanceof SyntaxError
                    ? protocolError('invalid_data')
                    : e?.status === 413
                      ? protocolError('capacity_exceeded')
                      : e
            );
        return createErrorResponse('保存设置失败', 500);
    }
}

/**
 * 处理设置重置API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleSettingsReset(env, request = null) {
    try {
        if (isAtomicSubscriptionRequested(env)) {
            const payload = request ? await readJsonWithLimit(request, JSON_BODY_LIMITS.small) : {};
            const metadata = requireMutationMetadata(payload, request);
            const storage = await getStorageAdapter(env);
            const result = await storage.commitDomainOperations({
                ...metadata,
                domains: { settings: { storageType: STORAGE_TYPES.D1 } },
            });
            SettingsCache.clear();
            return createJsonResponse({
                success: true,
                data: redactSettingsForResponse({
                    ...defaultSettings,
                    ...result.snapshot.settings,
                    storageType: STORAGE_TYPES.D1,
                }),
                version: result.snapshot.version,
                receipt: result.receipt,
                replayed: result.replayed,
                subscriptionProtocol: storage.subscriptionProtocol,
            });
        }
        const storageAdapter = await getStorageAdapter(env);

        // 使用存储适配器删除设置（会自动处理 KV 和 D1 映射）
        await storageAdapter.delete(KV_KEY_SETTINGS);

        // 如果存在双存储配置，尝试同时清理另一端
        try {
            if (storageAdapter.type === STORAGE_TYPES.D1) {
                const kvNs = StorageFactory.resolveKV(env);
                if (kvNs) await kvNs.delete(KV_KEY_SETTINGS);
            } else if (env.MISUB_DB) {
                const d1Adapter = StorageFactory.createAdapter(env, STORAGE_TYPES.D1);
                await d1Adapter.delete(KV_KEY_SETTINGS);
            }
        } catch (syncError) {
            console.warn('[API Reset] Dual storage sync cleanup failed:', syncError.message);
        }

        // 清除内存缓存
        SettingsCache.clear();

        return createJsonResponse({
            success: true,
            message: '设置已恢复出厂状态',
            data: defaultSettings,
        });
    } catch (e) {
        if (isAtomicSubscriptionRequested(env))
            return subscriptionProtocolFailure(
                e instanceof SyntaxError
                    ? protocolError('invalid_data')
                    : e?.status === 413
                      ? protocolError('capacity_exceeded')
                      : e
            );
        console.error('[API Error /settings/reset]', e);
        return createErrorResponse('重置设置失败', 500);
    }
}

/**
 * 处理公开订阅组获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handlePublicProfilesRequest(env) {
    try {
        const storageAdapter = await getStorageAdapter(env);
        const cachedSettings = await SettingsCache.get(env);
        const [profiles, settings] = await Promise.all([
            typeof storageAdapter.getAllProfiles === 'function'
                ? storageAdapter.getAllProfiles()
                : storageAdapter.get(KV_KEY_PROFILES).then((res) => res || []),
            Promise.resolve(cachedSettings || {}).then((res) => res || {}),
        ]);

        const profileToken = settings.profileToken || 'profiles';
        const defaultLocale = settings.defaultLocale || 'zh-CN';

        // 获取公告配置（仅当启用时返回）
        const announcement = settings.announcement?.enabled
            ? {
                  enabled: true, // [修复] 必须包含此字段，否则前端 v-if 判断会失败
                  title: settings.announcement.title || '',
                  content: settings.announcement.content || '',
                  type: settings.announcement.type || 'info',
                  dismissible: settings.announcement.dismissible !== false,
                  updatedAt: settings.announcement.updatedAt,
              }
            : null;

        // Hero Configuration
        const hero = {
            title1: settings.heroTitle1 || '发现',
            title2: settings.heroTitle2 || '优质订阅',
            description:
                settings.heroDescription ||
                '浏览并获取由管理员分享的精选订阅组合，一键导入到您的客户端。',
        };

        // Guestbook Config (Safe subset)
        const guestbook = {
            enabled: settings.guestbook?.enabled,
            requireAudit: settings.guestbook?.requireAudit,
            allowAnonymous: settings.guestbook?.allowAnonymous,
        };

        // 过滤出公开且启用的订阅组
        const publicProfiles = profiles
            .map(normalizeProfile)
            .filter((p) => p.isPublic && p.enabled)
            .map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description || '',
                customId: p.customId,
                updatedAt: p.updatedAt,
                subscriptionCount: (p.subscriptions || []).length,
                manualNodeCount: (p.manualNodes || []).length,
            }));

        // Custom Page Config
        const customPage = {
            enabled: settings.customPage?.enabled || false,
            type: settings.customPage?.type || 'html',
            content: settings.customPage?.content || '',
            css: settings.customPage?.css || '',
            useDefaultLayout: settings.customPage?.useDefaultLayout !== false,
            allowExternalStylesheets: settings.customPage?.allowExternalStylesheets === true,
            allowScripts: settings.customPage?.allowScripts === true,
            hideBranding: settings.customPage?.hideBranding === true,
            hideHeader: settings.customPage?.hideHeader === true,
            hideFooter: settings.customPage?.hideFooter === true,
        };

        return createJsonResponse({
            success: true,
            data: publicProfiles,
            config: {
                profileToken,
                announcement,
                hero,
                guestbook,
                customPage,
                defaultLocale,
            },
        });
    } catch (e) {
        console.error('[API Error /public/profiles]', e);
        return createErrorResponse('获取公开订阅组失败', 500);
    }
}

/**
 * 处理公开配置获取API
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handlePublicConfig(request, env) {
    try {
        const storageAdapter = await getStorageAdapter(env);
        const settings = (await storageAdapter.get(KV_KEY_SETTINGS)) || {};

        // Merge with default settings to ensure enablePublicPage exists
        const mergedSettings = { ...defaultSettings, ...settings };
        const configuredLoginPath = normalizeLoginPath(mergedSettings.customLoginPath);
        let isLoginPath = configuredLoginPath === '/login';
        try {
            const clientPath = request?.headers?.get('X-MiSub-Path');
            const referer = request?.headers?.get('Referer');
            const sourcePath = clientPath || (referer ? new URL(referer).pathname : '');
            if (sourcePath) {
                isLoginPath = new URL(sourcePath, request.url).pathname === configuredLoginPath;
            }
        } catch {
            // Keep the safe default when the browser sends an invalid/missing path.
        }

        return createJsonResponse({
            enablePublicPage: mergedSettings.enablePublicPage,
            isLoginPath,
            customPage: {
                enabled: mergedSettings.customPage?.enabled || false,
                useDefaultLayout: mergedSettings.customPage?.useDefaultLayout !== false,
                allowExternalStylesheets:
                    mergedSettings.customPage?.allowExternalStylesheets === true,
                allowScripts: mergedSettings.customPage?.allowScripts === true,
                hideBranding: mergedSettings.customPage?.hideBranding === true,
                hideHeader: mergedSettings.customPage?.hideHeader === true,
                hideFooter: mergedSettings.customPage?.hideFooter === true,
            },
        });
    } catch (e) {
        console.error('[API Error /public/config]', e);
        return createErrorResponse('获取公开配置失败', 500);
    }
}

/**
 * 处理密码更新API
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleUpdatePassword(request, env) {
    if (request.method !== 'POST') {
        return createErrorResponse('Method Not Allowed', 405);
    }

    try {
        const { password } = await readJsonWithLimit(request, JSON_BODY_LIMITS.auth);

        if (!password || typeof password !== 'string' || password.length < 6) {
            return createErrorResponse('密码必须至少6位字符', 400);
        }

        await setAdminPassword(env, password);
        return createJsonResponse({ success: true, message: '密码已更新' });
    } catch (e) {
        console.error('[API Error /settings/password]', e);
        return createErrorResponse('Failed to update password', 500);
    }
}
