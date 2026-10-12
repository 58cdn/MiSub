import { readPreference, writePreference } from './local-preference.js';

export const DETECTOR_VIEW_KEY = 'misub:admin:detectors:view:v1';
export const DETECTOR_COLUMNS = [
    'status',
    'lastSeen',
    'lastTaskAt',
    'lastResultAt',
    'version',
    'capabilities',
    'lastHeartbeatAt',
];
const defaults = () => ({
    view: 'cards',
    columns: DETECTOR_COLUMNS.filter((key) => key !== 'lastHeartbeatAt'),
});

export function readDetectorView() {
    return readPreference(
        DETECTOR_VIEW_KEY,
        (value) => {
            if (
                value?.version !== 1 ||
                !['cards', 'list'].includes(value.view) ||
                !Array.isArray(value.columns)
            )
                return undefined;
            return {
                view: value.view,
                columns: DETECTOR_COLUMNS.filter((key) => value.columns.includes(key)),
            };
        },
        defaults()
    );
}

export function saveDetectorView(view, columns) {
    if (!Array.isArray(columns)) return false;
    return writePreference(DETECTOR_VIEW_KEY, {
        version: 1,
        view: view === 'list' ? 'list' : 'cards',
        columns: DETECTOR_COLUMNS.filter((key) => columns.includes(key)),
    });
}
