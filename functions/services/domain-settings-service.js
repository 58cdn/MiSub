import { getProtocolError, protocolError } from './subscription-protocol/index.js';

const webdavStatusFields = new Set([
    'lastCheckedAt',
    'lastBackupAt',
    'lastBackupStatus',
    'lastBackupMessage',
    'lastBackupFile',
]);

export async function commitWebdavStatusPatch(storage, patch, { expectedEpoch } = {}) {
    if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.keys(patch).some((key) => !webdavStatusFields.has(key))
    )
        throw protocolError('invalid_operation');
    const stablePatch = structuredClone(patch);
    let epoch = expectedEpoch;
    for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await storage.readDomainSnapshot();
        epoch ??= snapshot.version.epoch;
        if (snapshot.version.epoch !== epoch) throw protocolError('epoch_conflict');
        const settings = {
            ...snapshot.settings,
            webdavBackup: { ...snapshot.settings.webdavBackup, ...stablePatch },
        };
        try {
            return await storage.commitDomainOperations({
                operationId: `webdav_${crypto.randomUUID()}`,
                baseVersion: snapshot.version,
                domains: { settings },
            });
        } catch (error) {
            if (getProtocolError(error).code !== 'revision_conflict' || attempt === 2) throw error;
        }
    }
}
