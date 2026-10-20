import { isRemoteSubscription, isManualNode } from '../../shared/subscription-kind.js';
import { ref } from 'vue';
import { useToastStore } from '../stores/toast.js';
import { useDataStore } from '../stores/useDataStore.js';
import { extractNodeName } from '../lib/utils.js';
import { generateNodeId, generateSubscriptionId } from '../utils/id.js';
import { normalizeManualNodeGroupName } from './manual-nodes/groups.js';
import { parseSurgeConfig } from '../utils/protocolConverter.js';
import { t } from '../i18n/index.js';

export function useBulkImportLogic({ addSubscriptionsFromBulk, addNodesFromBulk }) {
    const { showToast } = useToastStore();
    const dataStore = useDataStore();
    const showModal = ref(false);

    const handleBulkImport = (importText, group, entryType) => {
        if (!importText) return;

        const normalizedGroup = normalizeManualNodeGroupName(group);

        const entryKey = (item) =>
            `${isRemoteSubscription(item) ? 'subscription' : 'manual_node'}:${item.url}`;
        const existingEntries = new Set(
            (dataStore.subscriptions || []).filter((item) => item.url).map(entryKey)
        );

        // 先尝试解析 Surge 格式（name = protocol, server, port, ...）
        const surgeNodes = parseSurgeConfig(importText);

        const lines = importText
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        const validSubs = [];
        const validNodes = [];

        // 如果成功解析出 Surge 节点，使用解析结果
        if (surgeNodes && surgeNodes.length > 0) {
            surgeNodes.forEach((node) => {
                // 去重检查：跳过已存在的 URL
                if (!existingEntries.has(entryKey({ ...node, type: 'manual_node' }))) {
                    validNodes.push({
                        id: generateNodeId(),
                        type: 'manual_node',
                        name: node.name || t('bulkImport.unnamed'),
                        url: node.url,
                        enabled: true,
                        status: 'unchecked',
                        group: normalizedGroup || null,
                        colorTag: null,
                        exclude: '',
                        customUserAgent: '',
                        notes: '',
                    });
                }
            });
        }

        // 处理标准 URL 格式（逐行检查）
        lines.forEach((line) => {
            const baseItem = {
                ...(entryType === 'manual_node' || entryType === 'subscription'
                    ? { type: entryType }
                    : {}),
                name: extractNodeName(line) || t('bulkImport.unnamed'),
                url: line,
                enabled: true,
                status: 'unchecked',
                group: normalizedGroup || null,
                colorTag: null,
                // Default fields for subscriptions
                exclude: '',
                customUserAgent: '',
                notes: '',
            };

            if (isRemoteSubscription(baseItem)) {
                // 去重检查：订阅 URL
                if (!existingEntries.has(entryKey(baseItem))) {
                    validSubs.push({
                        ...baseItem,
                        type: 'subscription',
                        id: generateSubscriptionId(),
                    });
                }
            } else if (isManualNode(baseItem)) {
                // 避免重复添加已从 Surge 格式解析的节点
                const alreadyParsed = validNodes.some((n) => n.url === line);
                // 去重检查：节点 URL
                if (!alreadyParsed && !existingEntries.has(entryKey(baseItem))) {
                    validNodes.push({ ...baseItem, type: 'manual_node', id: generateNodeId() });
                }
            }
        });

        let message = '';

        if (validSubs.length > 0) {
            addSubscriptionsFromBulk(validSubs);
            message += t('bulkImport.importedSubscriptions', { count: validSubs.length }) + ' ';
        }

        if (validNodes.length > 0) {
            addNodesFromBulk(validNodes, normalizedGroup);
            message += t('bulkImport.importedNodes', { count: validNodes.length });
        }

        if (message) {
            showToast(message, 'success');
        } else {
            showToast(t('bulkImport.noValidLinks'), 'warning');
        }
        showModal.value = false;
    };

    return {
        showModal,
        handleBulkImport,
    };
}
