import { describe, expect, it, vi } from 'vitest';
import { isManualNode, isRemoteSubscription } from '../../shared/subscription-kind.js';
import { useSubscriptionForms } from '../../src/composables/useSubscriptionForms.js';
import { useNodeForms } from '../../src/composables/useNodeForms.js';
import {
    editableSubscriptionFields,
    hasObservationConfigurationChange,
} from '../../src/shared/subscription-edit-operations.js';
import { validateOperations } from '../../functions/services/subscription-protocol/operations.js';

vi.mock('../../src/stores/toast.js', () => ({
    useToastStore: () => ({ showToast: vi.fn() }),
}));

const rootUrl = 'https://fixture:fixture@source.example.invalid:443/';

describe('explicit subscription entry types', () => {
    it.each([
        rootUrl,
        `${rootUrl}?sni=tls.example.invalid&allowInsecure=1`,
        'http://proxy.example.invalid:8080',
        'https://proxy.example.invalid:443?sni=tls.example.invalid',
    ])('preserves distinct subscription and proxy intent for %s', (url) => {
        expect(isRemoteSubscription({ url, type: 'subscription' })).toBe(true);
        expect(isManualNode({ url, type: 'subscription' })).toBe(false);
        expect(isRemoteSubscription({ url, type: 'manual_node' })).toBe(false);
        expect(isManualNode({ url, type: 'manual_node' })).toBe(true);
    });

    it('keeps untyped historical HTTP records as subscriptions without inferring from IDs', () => {
        for (const id of ['old-uuid', 'sub_legacy', 'node_legacy']) {
            const item = { id, url: rootUrl };
            expect(isRemoteSubscription(item)).toBe(true);
            expect(isManualNode(item)).toBe(false);
            expect(item).not.toHaveProperty('type');
        }
        expect(isManualNode({ url: 'trojan://fixture@proxy.example.invalid:443' })).toBe(true);
    });

    it('does not let an explicit subscription become a node through a URL edit', () => {
        const item = { type: 'subscription', url: 'trojan://fixture@proxy.example.invalid:443' };
        expect(isRemoteSubscription(item)).toBe(false);
        expect(isManualNode(item)).toBe(false);
    });

    it('saves root Basic Auth URLs with subscription intent on create and edit', () => {
        const addSubscription = vi.fn();
        const updateSubscription = vi.fn();
        const form = useSubscriptionForms({ addSubscription, updateSubscription });
        form.openAdd();
        form.editingSubscription.value.url = rootUrl;
        form.handleSave();
        expect(addSubscription).toHaveBeenCalledWith(
            expect.objectContaining({ url: rootUrl, type: 'subscription' })
        );
        form.openEdit({ id: 'legacy', name: 'Legacy', url: rootUrl });
        form.handleSave();
        expect(updateSubscription).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'legacy', url: rootUrl, type: 'subscription' })
        );
    });

    it('saves explicit manual-node intent on create and edit', () => {
        const addNode = vi.fn();
        const updateNode = vi.fn();
        const form = useNodeForms({ addNode, updateNode });
        form.openAdd();
        form.editingNode.value.url = rootUrl;
        form.handleSave();
        expect(addNode).toHaveBeenCalledWith(
            expect.objectContaining({ url: rootUrl, type: 'manual_node' })
        );
        form.openEdit({ id: 'legacy', url: rootUrl });
        form.handleSave();
        expect(updateNode).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'legacy', type: 'manual_node' })
        );
    });

    it('retains type in atomic edits and invalidates observations when intent changes', () => {
        const item = { id: 'typed', url: rootUrl, type: 'subscription' };
        expect(editableSubscriptionFields('subscriptions', item)).toEqual({
            url: rootUrl,
            type: 'subscription',
        });
        expect(hasObservationConfigurationChange(item, { ...item, type: 'manual_node' })).toBe(
            true
        );
        expect(() =>
            validateOperations([{ type: 'create', collection: 'subscriptions', item }])
        ).not.toThrow();
        expect(() =>
            validateOperations([
                {
                    type: 'update',
                    collection: 'subscriptions',
                    id: 'typed',
                    fields: { type: 'inferred-proxy' },
                },
            ])
        ).toThrow();
    });
    it('rejects a subscription path in the manual node form without changing its intent', () => {
        const addNode = vi.fn();
        const form = useNodeForms({ addNode, updateNode: vi.fn() });
        form.openAdd();
        form.editingNode.value.url = `${rootUrl}api?token=fixture`;
        form.handleSave();
        expect(addNode).not.toHaveBeenCalled();
        expect(form.showModal.value).toBe(true);
        const invalidNode = { url: `${rootUrl}api?token=fixture`, type: 'manual_node' };
        expect(isManualNode(invalidNode)).toBe(false);
        expect(isRemoteSubscription(invalidNode)).toBe(false);
    });
});
