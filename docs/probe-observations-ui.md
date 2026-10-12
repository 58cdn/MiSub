# Native source observation UI

The NodeDetectionPanel provides explicit exit/quality source selection and independent evidence details. Bulk and single-node entrypoints use the same task/lease API, consent and trusted detector identities. The diagnostics modal embeds this panel for a single-node snapshot.

Defaults keep IPPure experimental and opt-in; IPinfo is shown as not configured. Show source timestamps, TTL expiry, HTTP/error/retry evidence, country/IP conflicts and nullable IPPure fields without ranking or inferring missing facts. Distinguish TCP connect, node HTTP URLTest and provider request duration. Service reachability remains unlock unknown.

The UI reuses Vue components/styles, bilingual labels, keyboard focus behavior and native controls with 44px targets, following UI UX Pro Max guidance. Provider completion times are shown independently; older detectors leave them unknown. Result identity changes synchronously clear evidence and cancel old reads. Closing or changing the node aborts pending client requests; already accepted jobs remain visible in history. Each new submission requires fresh node-sharing and metered-download consent.

Offline acceptance covers source opt-in, zero/false/null evidence, expiry, conflicts, rate limits, old-server capability degradation, task/page changes and late responses. Run `npm run test:run`, `npm run build` and `node tests/browser/probe-observations.mjs`. The browser fixture binds only 127.0.0.1, intercepts all API requests, blocks other origins and records desktop/mobile screenshots and JSON evidence in `tmp/probe-observations-evidence`. A browser path can be supplied with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. No real node/provider acceptance or production configuration is performed by these tests.
