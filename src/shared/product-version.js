// SemVer 2.0.0 precedence uses numeric identifiers without a Number precision limit.
const numeric = /^(0|[1-9]\d*)$/;
const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function parseSemver(value) {
    if (typeof value !== 'string' || value.length > 256 || value.trim() !== value) return null;
    const match = semver.exec(value);
    if (!match || match[0] !== value) return null;
    const prerelease = match[4]?.split('.') || [];
    if (prerelease.some((part) => /^\d+$/.test(part) && !numeric.test(part))) return null;
    return { core: match.slice(1, 4), prerelease, build: match[5] || '' };
}
const compareNumeric = (a, b) =>
    a.length !== b.length ? Math.sign(a.length - b.length) : a === b ? 0 : a > b ? 1 : -1;
export function compareSemver(left, right) {
    const a = parseSemver(left),
        b = parseSemver(right);
    if (!a || !b) throw new TypeError('invalid_semver');
    for (let i = 0; i < 3; i++) {
        const result = compareNumeric(a.core[i], b.core[i]);
        if (result) return result;
    }
    if (!a.prerelease.length || !b.prerelease.length)
        return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
    for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
        const x = a.prerelease[i],
            y = b.prerelease[i];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        if (x === y) continue;
        const xn = numeric.test(x),
            yn = numeric.test(y);
        return xn && yn ? compareNumeric(x, y) : xn !== yn ? (xn ? -1 : 1) : x > y ? 1 : -1;
    }
    return 0;
}

const prefixes = Object.freeze({ app: 'v', probe: 'probe-v' });
export const isAlphaProduct = (value) =>
    typeof value === 'string' &&
    /^0\.0\.1-alpha\.[1-9]\d*$/.test(value) &&
    value.length <= 64 &&
    value.trim() === value;
export const isSourceCommit = (value) =>
    typeof value === 'string' &&
    /^[a-f0-9]{40}$/.test(value) &&
    value !== '0'.repeat(40) &&
    value.length === 40;
export function productFromTag(tag, component = 'app') {
    const prefix = Object.hasOwn(prefixes, component) ? prefixes[component] : null;
    if (!prefix || typeof tag !== 'string' || !tag.startsWith(prefix)) return null;
    const product = tag.slice(prefix.length);
    return isAlphaProduct(product) ? product : null;
}
export function productFromDisplay(value) {
    if (isAlphaProduct(value)) return value;
    if (typeof value !== 'string') return null;
    const match = /^(0\.0\.1-alpha\.[1-9]\d*)\.sha\.([a-f0-9]{7,40})$/.exec(value);
    return match && match[0] === value && isAlphaProduct(match[1]) ? match[1] : null;
}
export function compareProducts(left, right) {
    const a = productFromDisplay(left),
        b = productFromDisplay(right);
    return a && b ? compareSemver(a, b) : null;
}
export function versionTransition(current, target) {
    if (!isAlphaProduct(target)) return 'unsupported';
    const currentProduct = productFromDisplay(current);
    if (currentProduct) {
        const result = compareSemver(target, currentProduct);
        return result > 0 ? 'update' : result === 0 ? 'current' : 'ahead';
    }
    // Historical releases keep their identity and require an explicit migration.
    if (
        typeof current === 'string' &&
        (parseSemver(current) ||
            /^0\.[123]$/.test(current) ||
            /^0\.0\.1\.\d{6}\.[1-9]\d*$/.test(current))
    )
        return 'migration_required';
    return 'unknown';
}
export function nextAlphaVersion(tags, releases, component = 'app') {
    if (!Object.hasOwn(prefixes, component) || !Array.isArray(tags) || !Array.isArray(releases))
        throw new TypeError('invalid_version_inventory');
    let max = 0n;
    for (const tag of [...tags, ...releases.map((release) => release.tag_name)]) {
        const product = productFromTag(tag, component);
        if (product)
            max = max > BigInt(product.split('.').at(-1)) ? max : BigInt(product.split('.').at(-1));
    }
    const next = `0.0.1-alpha.${max + 1n}`;
    if (!isAlphaProduct(next)) throw new Error('alpha_sequence_exhausted');
    return next;
}
export function selectTestRelease(releases, component = 'app') {
    if (!Array.isArray(releases)) return null;
    return (
        releases
            .filter(
                (release) =>
                    release &&
                    release.draft === false &&
                    release.prerelease === true &&
                    productFromTag(release.tag_name, component)
            )
            .sort((a, b) =>
                compareSemver(
                    productFromTag(b.tag_name, component),
                    productFromTag(a.tag_name, component)
                )
            )[0] || null
    );
}
export function createBuildIdentity(
    productVersion,
    sourceCommit,
    { development = true, dirty = false } = {}
) {
    if (!isAlphaProduct(productVersion)) throw new Error('invalid_product_version');
    if (!isSourceCommit(sourceCommit)) throw new Error('invalid_source_commit');
    return {
        component: 'app',
        productVersion,
        displayVersion: development
            ? `${productVersion}.sha.${sourceCommit.slice(0, 8)}`
            : productVersion,
        sourceCommit,
        channel: 'alpha',
        prerelease: true,
        dirty,
    };
}
