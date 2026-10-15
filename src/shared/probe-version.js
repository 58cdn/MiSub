const dated = /^0\.0\.1\.([0-9]{6})\.([1-9][0-9]{0,5})$(?![\s\S])/;
const legacyRelease = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$(?![\s\S])/;
const legacyBuild = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$(?![\s\S])/;

export function isDatedProbeVersion(value) {
    if (typeof value !== 'string') return false;
    const match = dated.exec(value);
    if (!match) return false;
    const year = 2000 + Number(match[1].slice(0, 2));
    const month = Number(match[1].slice(2, 4));
    const day = Number(match[1].slice(4, 6));
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

export const isProbeReleaseVersion = (value) =>
    typeof value === 'string' && (legacyRelease.test(value) || isDatedProbeVersion(value));

// Historical build declarations remain readable; dated releases use the exact published identity.
export const isProbeBuildVersion = (value, prefix = false) => {
    if (typeof value !== 'string' || value.length > 64) return false;
    const normalized = prefix && value.startsWith('v') ? value.slice(1) : value;
    return legacyBuild.test(normalized) || (!prefix && isDatedProbeVersion(normalized));
};
