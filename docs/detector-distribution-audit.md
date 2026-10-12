# Detector distribution audit

Distribution remains paused. This PR adds verifiable input inventories and a fail-closed readiness gate for future detector packages. It does not publish or replace release assets, create signing credentials, grant OIDC permissions, or claim that existing prebuilt kernels have complete corresponding-source proof.

The audit must bind each target to its pinned kernel bytes, source commit, effective dependency modules and replacements, full license/NOTICE/copyright materials, toolchain and generated build inputs. In particular, the fixed Mihomo build embeds a generated CA snapshot; a new snapshot cannot be asserted to match an existing binary. Official vendor/toolchain asset digests are evidence to verify, not permission to execute their contents.

Read-only archive inspection rejects unsafe paths, links, duplicate entries and size/resource abuse. Machine-readable findings distinguish verified, missing and unverified material. Offline fixtures cover gate behavior; --require-ready fails while required evidence is incomplete. Existing source preparation success is not release readiness, and SHA256 alone is not an authenticated signature or provenance verification.

All artifact upload and Release publication conditions retain their hard false gates. The repository records actual blockers and a future verification contract without inventing evidence or downloading/executing unknown installation scripts.
