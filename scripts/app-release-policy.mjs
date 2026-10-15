import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    createBuildIdentity,
    nextAlphaVersion,
    isSourceCommit,
} from '../src/shared/product-version.js';

// Inventory includes every tag and release (including drafts), fetched with pagination.
export function planAppRelease({
    productVersion,
    sourceCommit,
    mainCommit,
    tags,
    releases,
    inventoryComplete,
    sourceState,
}) {
    if (inventoryComplete !== true) throw new Error('complete_inventory_required');
    if (!isSourceCommit(sourceCommit) || sourceCommit !== mainCommit || sourceState !== 'clean')
        throw new Error('clean_main_source_required');
    if (productVersion !== nextAlphaVersion(tags, releases, 'app'))
        throw new Error('next_unused_alpha_required');
    return {
        ...createBuildIdentity(productVersion, sourceCommit, { development: false }),
        tag_name: `v${productVersion}`,
        target_commitish: sourceCommit,
        prerelease: true,
        make_latest: 'false',
        draft: true,
        distributionReady: false,
        acceptance: 'pending',
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [input, output] = process.argv.slice(2);
    if (!input || !output)
        throw new Error(
            'Usage: node scripts/app-release-policy.mjs inventory.json release-plan.json'
        );
    writeFileSync(
        output,
        JSON.stringify(planAppRelease(JSON.parse(readFileSync(input, 'utf8'))), null, 2) + '\n'
    );
}
