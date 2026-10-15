import {
    isAlphaProduct,
    isSourceCommit,
    parseSemver,
    compareProducts,
    productFromDisplay,
    versionTransition,
} from './product-version.js';

export { isAlphaProduct as isAlphaProbeVersion };
export function isProbeVersion(value) {
    if (typeof value !== 'string' || value.length > 64) return false;
    if (value.startsWith('0.0.1-alpha')) return isAlphaProduct(value);
    const semver = parseSemver(value);
    return (
        Boolean(semver && !semver.build) ||
        (/^0\.0\.1\.[0-9]{6}\.[1-9]\d*$/.test(value) && value.trim() === value)
    );
}
export function compareProbeVersions(left, right) {
    return compareProducts(left, right);
}
export function probeVersionIdentity(version, sourceCommit, { development, sourceState } = {}) {
    const productVersion = productFromDisplay(version);
    const validCommit = isSourceCommit(sourceCommit);
    const knownBuild = productVersion && validCommit && sourceState === 'clean';
    return {
        productVersion: productVersion || (isProbeVersion(version) ? version : null),
        displayVersion:
            knownBuild && development === true
                ? `${productVersion}.sha.${sourceCommit.slice(0, 12)}`
                : version,
        sourceCommit: validCommit ? sourceCommit : null,
        channel: productVersion ? 'testing' : 'historical',
        buildIdentityComplete: Boolean(knownBuild && typeof development === 'boolean'),
        migrationRequired: versionTransition(version, '0.0.1-alpha.1') === 'migration_required',
    };
}
export function validProbeBuildFields(metadata) {
    return (
        (metadata.buildChannel === undefined ||
            ['development', 'testing'].includes(metadata.buildChannel)) &&
        (metadata.sourceState === undefined ||
            ['clean', 'dirty', 'unknown'].includes(metadata.sourceState)) &&
        (!isAlphaProduct(metadata.wrapperVersion) || isSourceCommit(metadata.wrapperRevision))
    );
}
export function probeBuildFields(metadata) {
    return {
        ...(metadata.buildChannel === undefined ? {} : { buildChannel: metadata.buildChannel }),
        ...(metadata.sourceState === undefined ? {} : { sourceState: metadata.sourceState }),
    };
}
