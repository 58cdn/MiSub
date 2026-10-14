import { describe, expect, it } from 'vitest';
import {
    buildSubscriptionEditOperations,
    rebaseSubscriptionEdits,
    isSubscriptionVersion,
    SUBSCRIPTION_EDIT_FIELDS,
    PROFILE_EDIT_FIELDS,
} from '../../src/shared/subscription-edit-operations.js';

const sub = (id, name = id) => ({ id, name, url: `https://example.invalid/${id}`, enabled: true });
const snapshot = (subscriptions = [sub('a'), sub('b')], profiles = []) => ({
    subscriptions,
    profiles,
});
const clone = (value) => JSON.parse(JSON.stringify(value));

describe('explicit subscription configuration edits', () => {
    it('compares nested configuration objects by value rather than key insertion order', () => {
        const before = snapshot([
            { ...sub('a'), airportIdentity: { groupId: 'g', name: 'group' } },
        ]);
        const after = snapshot([{ ...sub('a'), airportIdentity: { name: 'group', groupId: 'g' } }]);
        expect(buildSubscriptionEditOperations(before, after)).toEqual([]);
    });
    it('sends only changed configuration fields and explicit known deletes', () => {
        const before = snapshot();
        const after = snapshot([
            { ...sub('a'), name: 'changed', nodeCount: 100, _writeGeneration: 'forged' },
            sub('c'),
        ]);
        expect(buildSubscriptionEditOperations(before, after)).toEqual([
            { type: 'remove', collection: 'subscriptions', ids: ['b'] },
            { type: 'update', collection: 'subscriptions', id: 'a', fields: { name: 'changed' } },
            { type: 'create', collection: 'subscriptions', item: sub('c') },
            { type: 'reorder', collection: 'subscriptions', ids: ['a', 'c'] },
        ]);
    });
    it('does not submit runtime, ordering implementation fields or unknown keys', () => {
        const before = snapshot([sub('a')]);
        const after = clone(before);
        Object.assign(after.subscriptions[0], {
            nodeCount: 9,
            userInfo: { total: 1 },
            lastError: 'x',
            status: 'up',
            sortIndex: 8,
            isUpdating: true,
            _observedAt: 1,
            _writeGeneration: 'x',
            arbitrary: true,
        });
        expect(buildSubscriptionEditOperations(before, after)).toEqual([]);
        for (const fields of [SUBSCRIPTION_EDIT_FIELDS, PROFILE_EDIT_FIELDS]) {
            expect(fields).not.toContain('sortIndex');
            expect(fields).not.toContain('_writeGeneration');
            expect(fields).not.toContain('downloadCount');
        }
    });
    it('preserves false and empty values and clears a removed field explicitly', () => {
        const before = snapshot([
            { ...sub('a'), notes: 'old', airportIdentity: { groupId: 'g', name: 'group' } },
        ]);
        const after = snapshot([{ ...sub('a'), enabled: false, notes: '' }]);
        expect(buildSubscriptionEditOperations(before, after)).toEqual([
            {
                type: 'update',
                collection: 'subscriptions',
                id: 'a',
                fields: { enabled: false, notes: '', airportIdentity: null },
            },
        ]);
    });
    it('updates profile configuration without counters and normalizes legacy ruleLevel', () => {
        const before = snapshot(
            [],
            [
                {
                    id: 'p',
                    subscriptions: [],
                    manualNodes: [],
                    clashRuleLevel: 'basic',
                    downloadCount: 3,
                },
            ]
        );
        const after = snapshot(
            [],
            [
                {
                    id: 'p',
                    subscriptions: ['a'],
                    manualNodes: [],
                    ruleLevel: 'basic',
                    downloadCount: 99,
                    prefixSettings: { prependGroupName: true },
                },
            ]
        );
        expect(buildSubscriptionEditOperations(before, after)).toEqual([
            {
                type: 'update',
                collection: 'profiles',
                id: 'p',
                fields: { subscriptions: ['a'], prefixSettings: { prependGroupName: true } },
            },
        ]);
    });
    it('snapshots nested operation values independently of later editing', () => {
        const edited = snapshot(
            [],
            [
                {
                    id: 'p',
                    subscriptions: ['a'],
                    operators: [{ type: 'rename', args: { to: 'new' } }],
                },
            ]
        );
        const operations = buildSubscriptionEditOperations(snapshot([], []), edited);
        edited.profiles[0].subscriptions.push('b');
        edited.profiles[0].operators[0].args.to = 'later';
        expect(operations[0].item.subscriptions).toEqual(['a']);
        expect(operations[0].item.operators[0].args.to).toBe('new');
    });
    it.each([null, {}, [{ id: '' }], [{ id: 'a' }, { id: 'a' }]])(
        'rejects an incomplete edit collection',
        (items) => {
            expect(() => buildSubscriptionEditOperations(snapshot(), snapshot(items))).toThrow();
        }
    );
    it.each([
        null,
        {},
        { epoch: '', revision: 0 },
        { epoch: 'bad epoch', revision: 0 },
        { epoch: 'x', revision: -1 },
        { epoch: 'x', revision: 0.5 },
        { epoch: 'x', revision: Number.MAX_SAFE_INTEGER + 1 },
    ])('rejects an invalid version', (value) => {
        expect(isSubscriptionVersion(value)).toBe(false);
    });
    it('accepts a bounded epoch and nonnegative safe integer version', () => {
        expect(isSubscriptionVersion({ epoch: 'epoch-A_1', revision: 0 })).toBe(true);
    });
});

describe('rebase edits made after a submitted operation', () => {
    it('keeps remote additions and local additions instead of inventing remote deletes', () => {
        const submitted = snapshot([sub('a')]);
        const edited = snapshot([sub('local'), sub('a')]);
        const confirmed = snapshot([sub('remote'), sub('a')]);
        const rebased = rebaseSubscriptionEdits(submitted, edited, confirmed);
        expect(rebased.subscriptions.map((item) => item.id)).toEqual(['remote', 'local', 'a']);
        const next = buildSubscriptionEditOperations(confirmed, rebased);
        expect(next.some((operation) => operation.type === 'remove')).toBe(false);
        expect(confirmed.subscriptions.map((item) => item.id)).toEqual(['remote', 'a']);
    });
    it('keeps remote runtime observations while replaying local configuration', () => {
        const submitted = snapshot([sub('a')]);
        const edited = snapshot([sub('a', 'local')]);
        const confirmed = snapshot([{ ...sub('a'), nodeCount: 8, _writeGeneration: 'server' }]);
        expect(rebaseSubscriptionEdits(submitted, edited, confirmed).subscriptions[0]).toEqual({
            ...sub('a', 'local'),
            nodeCount: 8,
            _writeGeneration: 'server',
        });
    });
    it('does not attach an old-URL observation to a later unsaved URL', () => {
        const submitted = snapshot([{ ...sub('a'), nodeCount: 3 }]);
        const edited = snapshot([
            { ...sub('a'), url: 'https://example.invalid/later', nodeCount: 0 },
        ]);
        const confirmed = snapshot([
            {
                ...sub('a'),
                nodeCount: 99,
                userInfo: { total: 8 },
                _writeGeneration: 'server',
                _observedAt: 12,
            },
        ]);
        const result = rebaseSubscriptionEdits(submitted, edited, confirmed);
        expect(result.subscriptions[0]).toMatchObject({
            url: 'https://example.invalid/later',
            nodeCount: 0,
            _writeGeneration: 'server',
            _observedAt: 12,
        });
        expect(result.subscriptions[0].userInfo).toBeUndefined();
    });
    it('removes only an explicitly deleted known row', () => {
        expect(
            rebaseSubscriptionEdits(
                snapshot([sub('a')]),
                snapshot([]),
                snapshot([sub('remote'), sub('a')])
            ).subscriptions
        ).toEqual([sub('remote')]);
    });
    it('allows own server normalization when replaying changes from the same receipt version', () => {
        expect(
            rebaseSubscriptionEdits(
                snapshot([sub('a')]),
                snapshot([sub('a', 'later')]),
                snapshot([sub('a', 'normalized')]),
                { checkConflicts: false }
            ).subscriptions[0].name
        ).toBe('later');
    });
    it.each([
        ['same field', snapshot([sub('a', 'local')]), snapshot([sub('a', 'remote')])],
        ['deleted target', snapshot([sub('a', 'local')]), snapshot([])],
        ['delete modified target', snapshot([]), snapshot([sub('a', 'remote')])],
        [
            'new identity collision',
            snapshot([sub('a'), sub('new')]),
            snapshot([sub('a'), sub('new')]),
        ],
    ])('requires comparison on %s conflicts', (_label, edited, confirmed) => {
        expect(rebaseSubscriptionEdits(snapshot([sub('a')]), edited, confirmed)).toBeNull();
    });
});
