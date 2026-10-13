# Detector core source builds

`detector/scripts/source_build.py` builds a new Mihomo core from an immutable
source snapshot. It accepts local inputs, preserves their complete source bytes
and records the resulting executable. It does not download or install software,
run the core, create an identity, sign a package or publish a Release.

The source build is distinct from the upstream release binaries described in
`kernel-lock.json`. Its version string is `v1.19.32-misub-source`. The historical
distribution inventory retains its own `ready: false` result. Neither report is
a release authorization.

## Inputs and trust roots

The reviewed [source build lock](../detector/source-build-lock.json) pins:

- Mihomo commit `88dcbf7f1614a67c3b36b848ee3592dfa92ada36`, its Git tree and the
  SHA256 of the commit-specific source archive.
- The exact effective vendor archive and the protobuf module replacement.
- Standard Go `1.27.2`, with official archive SHA256 values for each build host.
- Five output targets, build tags, version, timestamp and system CA mode.

Preparation recomputes the entire Git tree from archive file contents and
executable modes. Vendored files are identified by their actual locked archive
bytes; module names and versions describe the archive's declarations. They do
not assert independent verification of each module against its original remote.
The build checks the dependency graph against those declarations, including
replacements, and records every selected source/assembly/embed file digest.

Go archives contain the compiler, runtime, source and notices. Every prepared
file is checked against the supplied archive before and after building. The
`prepared.json` inventory is re-derived from retained, SHA256-verified inputs;
editing that report cannot authorize altered source or tools. Run builds in an
isolated CI job with no untrusted concurrent writer to the workspace.

The official hashes are published at [Go downloads](https://go.dev/dl/). The
locked upstream source and vendor URLs are included in the lock; the script
never fetches them or executes upstream installation scripts.

## System certificate authorities

The fixed commit's `component/ca/ca-certificates.crt` is intentionally empty
(Git blob `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`). Preparation verifies that
exact input, as part of the complete source tree. The unmodified
[CA implementation](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/component/ca/config.go)
initializes its ordinary pool from `x509.SystemCertPool`; its zero-trust pool
also falls back to system verification when no embedded certificates exist.
The generator does not inject certificates or disable TLS verification.

Linux needs installed system CA certificates. A missing or untrusted issuer
must remain a TLS error. Build success does not verify a user's actual trust
store. The wrapper must preserve its controlled core environment and must not
introduce a TLS bypass to accommodate a machine without trusted roots.

Standard Go `1.27.2` requires macOS 13 or later for Darwin builds. Windows builds
target Windows 10 / Windows Server 2016 or later. Linux targets require kernel
3.2 or later. Architecture mappings are `amd64` (baseline v1) and `arm64`;
Windows currently supports amd64 only. This does not inherit older OS support
from the upstream custom Go toolchain.

## Offline commands

Use Python 3.10 or later. Supply the toolchain archive matching the machine that
runs the build; a prepared host can cross-compile all five output targets.
Directories passed as new work/output destinations must not already exist.

```sh
python3 -B detector/scripts/source_build.py prepare \
  --source-archive /materials/mihomo-clean-source.tar.gz \
  --vendor-archive /materials/vendor.tar.gz \
  --toolchain-archive /materials/go1.27.2.linux-amd64.tar.gz \
  --work-dir /work/core-inputs

python3 -B detector/scripts/source_build.py build \
  --work-dir /work/core-inputs --target linux-amd64 \
  --output-dir /work/core-linux-amd64

python3 -B detector/scripts/source_build.py package \
  --work-dir /work/core-inputs --output-dir /work/core-source \
  --license-review detector/source-license-review.json \
  --supplement-dir detector/notices
```

`prepare` validates bounded archive bytes before using them. It accepts regular
files and portable paths, rejecting symlinks, hard links, devices, traversal,
case/Unicode collisions and unexpected global metadata. A failed operation can
leave a partial new directory; it has no valid final result and must not be used
as evidence. Existing destinations are never overwritten.

`build` sets `GOTOOLCHAIN=local`, `GOENV=off`, `GOWORK=off`, `GOPROXY=off`,
`GOSUMDB=off`, `CGO_ENABLED=0`, and uses `-mod=vendor -buildvcs=false -trimpath
-tags with_gvisor`. It clears inherited Go flags and experiments, fixes build
metadata, invokes the locked compiler twice and compares the output bytes.
Repeated invocations on one host can reuse a cache; this check is not a claim of
independent-host reproducibility. The Git commit is carried by the material
manifest rather than a misleading `vcs.modified` flag on an extracted archive.

`package` creates a deterministic `mihomo-source-materials.tar.gz` containing:

- The complete core source snapshot and exact vendor files.
- The standard Go source tree, version and all recognized toolchain notices.
- Full recognized license/notice files and unchanged file-level notices in the
  complete sources, with a hashed inventory.
- This generator, its archive auditor dependency, the lock and `SOURCE.md`.
- The supplied license review and its byte-verified supplementary notice texts.

The source package covers the core and toolchain. A release must also provide
the matching MiSub wrapper source, installation scripts and build recipe.

## Stable output contract

Every final JSON result has `schemaVersion: 1` and a `kind` identifying its
purpose. The prepared workspace stores `prepared.json`. A successful `build`
stores `build-result.json` with:

| Field | Meaning |
| --- | --- |
| `kind` | `misub-core-build` |
| `target`, `host` | Output target and compiler host |
| `lockSha256` | SHA256 of the canonical, sorted/indented lock JSON plus newline |
| `source`, `vendorSha256`, `toolchain` | Exact inputs, version and compiler archive digest |
| `recipe`, `environment` | Go build arguments and enforced build settings |
| `output` | Executable `file`, `bytes` and `sha256` |
| `dependencies` | Selected packages, effective module replacements and file hashes |
| `caMode` | `system` |
| `repeatBuildMatches` | Two local invocations produced identical bytes |
| `nativeRuntimeTests` | `not-performed-by-generator` |
| `authenticatedProvenance` | `missing` |
| `releaseReady` | `false` |

`source-pack-result.json` uses kind `misub-core-source-pack`, includes the archive
filename/size/SHA256 and inventory counts, and retains `noticeCoverage:
requires-review`, `authenticatedProvenance: missing`, `releaseReady: false`.
The package's internal `manifest.json` provides full file and notice inventories.
Exit zero means the requested local material operation succeeded. It must never
be interpreted as permission to publish.

## Release verification still required

The release pipeline must bind its immutable MiSub commit and trusted workflow
identity to each core output, matching wrapper output, source package and final
platform archive. Verify authenticated GitHub provenance (or an explicitly
defined authenticated execution/artifact binding), subject digests and expected
builder identity. A local JSON result or a checksum from the download channel
alone is not that authentication.

Run the native wrapper/core fixture suites for all five targets, including
certificate-validation failures, process lifecycle, pairing and installation
fixtures. Cross-compilation does not establish runtime compatibility.

The [license mapping](../detector/source-license-review.json) binds the five
targets' actual linked core files, including the wrapper's standard-library
inputs, to full notices. It retains original file-level attribution and applicable
license terms; it does not relicense dependencies. Supplementary material is
stored under [detector/notices](../detector/notices):

- `metacubex-chacha-v0.1.5-LICENSE`: the maintainers' root MIT license from
  [commit 7b981d42](https://github.com/MetaCubeX/chacha/commit/7b981d42c3baca5a004e7b0ecfb9b67ee20e583a).
  This is the direct child of the pinned `v0.1.5` commit `07294f50`; its sole
  change adds `LICENSE`, so the code is identical. The full text attributes both
  Andreas Auernhammer and MetaCubex. Its Git blob is
  `1440ef3906198ee444765c54715bce210c2ff6f4`.
- `xtaci-tcpraw-LICENSE`: the full MIT terms from the origin explicitly identified
  by the core's `transport/hysteria/conns/faketcp/LICENSE`. The upstream license
  was introduced in [initial commit f9736877](https://github.com/xtaci/tcpraw/blob/f97368775ea9d2348f403fbb95e76e31b10b7a58/LICENSE)
  and remains unchanged through `cbf96359f63c20cfd3b27a9b3927d1ebc6f4182d`.
- `golang-x-sys-v0.16.0-LICENSE`: the Go BSD terms for the origin explicitly
  identified by go-krypto's copied CPU source, pinned to
  `0829ab15b6946f47c40012db2e0c04772730317d`. Go-authored copied files in other
  scopes retain their file-level BSD attribution and a reference to the full Go
  BSD license alongside each module's own terms.
- `rasky-go-lzo-LICENSE-README.md`: the author's explicit `GPL-2.0-or-later`
  clarification in [commit ad21c35a](https://github.com/rasky/go-lzo/commit/ad21c35a111113348567708a4db74f998be1a4c3).
  All 17 blobs were compared with the pinned `96a758ed` version; only README
  changes, so the declaration covers identical code. The original GPLv2 text
  remains in the vendor tree, with the clarification and GPLv3 full text included.

The source pack retains both original notices and supplements. GPL/LGPL grants
are accompanied by the complete core GPLv3 text and corresponding build inputs.
The release verifier must independently check the actual linked-file union,
full notice bytes and scope coverage against this mapping. The generator keeps
`noticeCoverage: requires-review`; it does not equate inventory with completed
review or authenticated release provenance.

## Fixture verification

```sh
python3 -B -m unittest discover -s detector/scripts -p 'test_source_build.py' -v
```

Tests exercise Git tree binding, file modes, locked archive tampering, forged
prepared inventories, source changes, replacement mismatches, CA mode,
environment isolation, archive boundaries, dependency paths and deterministic
source/notice preservation. They execute no downloaded core or fake compiler.
