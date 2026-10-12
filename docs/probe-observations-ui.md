# Native source observation UI

Extend the existing NodeDetectionPanel with explicit exit/quality source selection and independent evidence details. Reuse the same task/lease API, consent and trusted detector identities for both bulk and single-node entrypoints. The previous diagnostics modal will become a single-node adapter of this panel rather than calling a second executor API.

Defaults keep IPPure experimental and opt-in; IPinfo is shown as not configured. Show source timestamps, TTL expiry, HTTP/error/retry evidence, country/IP conflicts and nullable IPPure fields without ranking or inferring missing facts. Distinguish TCP connect, node HTTP URLTest and provider request duration. Service reachability remains unlock unknown.

Reuse current Vue components/styles, bilingual labels, focus behavior and accessible native controls, following UI UX Pro Max guidance. Verify mock-only component/API tests and desktop/mobile rendering. No real network probes, credentials, deployment or release changes.
