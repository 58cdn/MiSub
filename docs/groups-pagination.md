# Airport subscription pagination

`/dashboard/groups` counts **subscription sources**, after both the status and text filters. Its footer displays the inclusive visible range and filtered total, including `显示 0 至 0 共 0 条结果` for an empty list. Expanded airport groups render only sources on the current page. Group identity actions retain their existing group scope.

The footer offers 10, 20, 50 and 100 sources per page. There is no unbounded option. Changing filters or page size returns to page 1; shrinking data clamps an out-of-range page to the last available page. Sorting uses the complete source list, never a pagination slice. Existing dashboard panel behavior is retained.

## Global setting

In **Settings → System → List display**, `groupsPageSize` controls the default for all administrators of the installation. It is stored through the existing `/api/settings` API and KV/D1 adapter only when the administrator explicitly saves settings. Missing or invalid legacy values resolve to 20. Numeric strings matching a supported option are normalized to numbers.

The footer selection is temporary for that mounted page. It does not save settings or write browser preferences. Reopening the page uses the global default. Successful saves immediately update the shared configuration and session cache, so navigating before the existing reload countdown finishes also uses the saved default. Failed saves do not update either.

## Design references

- [Sub2API pagination](https://github.com/Wei-Shaw/sub2api/blob/main/frontend/src/components/common/Pagination.vue): result-range hierarchy and page-size control. The implementation here uses MiSub's components, tokens, and source-count semantics.
- [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill): the installed skill's accessibility, labelled forms, responsive layout and touch-target guidance; [delivery checklist](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/.claude/skills/ui-ux-pro-max/references/pro-rules.md). The installed skill's search resources were unavailable, so the reviewed priority guidance was used directly rather than claiming database search results.
- [Awesome Design Skills: Enterprise](https://github.com/bergside/awesome-design-skills/blob/main/skills/enterprise/SKILL.md) and [Clean](https://github.com/bergside/awesome-design-skills/blob/main/skills/clean/DESIGN.md): clear hierarchy, restrained surfaces, consistent spacing and explicit states. No external design package or script was installed or executed.

The footer retains MiSub's primary and neutral colors, rounded borders and dark/light surfaces. It wraps on narrow screens, retains visible keyboard focus, labels every control, announces the range politely, and uses 44px controls. Loading controls are disabled. Initial session loading/failure uses the existing app state without presenting a false zero-result count; initial data failure currently returns to the existing sign-in view.

## Verification

Run the unit suite with `npm run test:run -- --maxWorkers=2`, then `npm run build`.

Run real application routes with isolated API fixtures:

```sh
npx playwright install chromium
node tests/browser/groups-pagination.mjs tmp/groups-pagination-evidence
```

An existing browser can be selected using `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. The script blocks external requests and never calls a production API. It produces screenshots, a pagination accessibility snapshot, and a JSON evidence report. The existing PR CI runs unit tests and the production build. Browser verification is run separately with this script: the existing publishing credential cannot add a workflow without the workflow scope, and this task does not change credential permissions.

Covered cases include 2,585 sources, the final partial page, empty data/search, combined status/text filters, bounded page-size choices, expanded groups, keyboard operation, 375/768/1024/1440px layouts, contrast in both themes, target sizes, settings save errors, successful reload, immediate navigation after saving, and initial loading/failure. Unit integration also verifies four-source and 24-source filter/page/sort/save flows preserve every source.

## Coordination with subscription integrity changes

Initial base inspected: `b752b16d1d6b5650a3d8616e506b8acb3fdbb398`. The branch now includes main through `f5c104c` (PRs #46, #37 and #41). The merge completed without textual conflicts; #37's subset reorder protection and #41's authoritative read checks are retained.

- PR #37 (`917588a`) also changes `src/composables/useSubscriptions.js`; its subset reorder protection is in a different section from this pagination change. Preserve that protection when combining the branches.
- PR #42 (`ed662e2`, including #37/#41) also touches `functions/modules/api-handler.js`, `src/composables/useSubscriptions.js`, `src/i18n/messages.js`, and `src/stores/useDataStore.js`. The reviewed patches do not overlap within those files. Preserve #42's authoritative snapshot/save logic and its `syncCachedConfig` update to `lastSavedData.config`.
- Independent review ran the four-source flow against this branch and an in-memory combination with #42. Both preserved all sources and profile references. The combined version also preserved hidden records when given a direct reorder subset. This pagination branch does not replace the underlying #37/#42 integrity work.

Merge order remains with the coordinating task; this task does not merge its PR into main.
