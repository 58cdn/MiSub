// Shared by the settings API and the dashboard. Never offer an unbounded page.
export const GROUPS_PAGE_SIZE_OPTIONS = Object.freeze([10, 20, 50, 100]);
export const DEFAULT_GROUPS_PAGE_SIZE = 20;

export function normalizeGroupsPageSize(value) {
    const size = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return GROUPS_PAGE_SIZE_OPTIONS.includes(size) ? size : DEFAULT_GROUPS_PAGE_SIZE;
}
