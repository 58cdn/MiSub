// Immutable catalog IDs describe an explicit claim, never a build-version guess.
// A changed check/source/provider rule set requires a new catalog ID.
export function probeCapabilityCatalog(version) {
    if (version !== 1) return null;
    return {
        version: 1,
        checks: ['format', 'tcp', 'proxy', 'speed', 'unlock', 'observations'],
        sources: [
            { id: 'ipify', availability: 'implemented' },
            { id: 'ip_sb', availability: 'implemented' },
            { id: 'ifconfig', availability: 'implemented' },
            { id: 'icanhazip', availability: 'implemented' },
            { id: 'ipinfo', availability: 'unconfigured' },
            { id: 'ippure', availability: 'experimental' },
        ],
        providerRules: [
            'netflix',
            'youtube',
            'openai',
            'claude',
            'gemini',
            'disney',
            'spotify',
            'tiktok',
        ].map((id) => ({ id, ruleSetVersion: 1 })),
    };
}
