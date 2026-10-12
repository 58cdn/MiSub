# Detector distribution materials audit

The offline auditor verifies supplied material bytes, inventories their contents,
and collects complete license files for further review. Distribution stays paused:
artifact uploads and Release publication retain their `&& false` conditions.
Existing release assets remain unchanged.

## Run an inventory

Python 3.10 or newer and its standard library are sufficient. The auditor does
not download materials, execute their contents, call Git, install tools, or create
credentials. Supply local archives explicitly; URLs in the lock are source
references, not instructions to fetch or execute them.

```sh
python3 -B detector/scripts/audit_distribution.py
python3 -B detector/scripts/audit_distribution.py \
  --artifact upstream-vendor=/path/to/vendor.tar.gz \
  --artifact upstream-toolchain=/path/to/toolchain.tar.gz \
  --artifact historical-core-source=/path/to/mihomo-source-v1.19.32.tar.gz \
  --collect-notices /path/to/new-notices-directory \
  --require-ready > audit-report.json
```

`--artifact ID=PATH` can be repeated for different IDs. The five kernel IDs are
`kernel-linux-amd64`, `kernel-linux-arm64`, `kernel-darwin-amd64`, and
`kernel-darwin-arm64`, plus `kernel-windows-amd64`. The lock cross-checks each kernel digest, asset URL, version
and source commit against `detector/kernel-lock.json`. Duplicate IDs, unknown IDs,
duplicate JSON keys, and unknown lock fields are rejected.

The Windows target accepts the locked ZIP containing exactly
`mihomo-windows-amd64-compatible.exe`. Both locks must agree on its outer archive
digest, entry name, executable byte count and inner executable digest. The report
records the inner size and SHA256 with `executableIdentity: "locked-sha256"`.
This identifies the pinned bytes; it does not verify executable behavior,
publisher identity, signatures, or source correspondence. The Unix kernel
reports retain their uncompressed digests without claiming those stronger checks.

The JSON report contains the checked digest, uncompressed member sizes and
digests, full member inventory, recognized notice files, module versions and
replacements from `vendor/modules.txt`, missing required files, and blockers.
Module records include replacement-only footer declarations; their count is not
the number of packages linked into a binary. Vendoring preserves the original
import path even when a module is replaced, so notice paths are associated with
that original path while the effective replacement remains visible.

| Status | Meaning |
| --- | --- |
| `verified` | Supplied bytes match the locked SHA256 and pass structural checks. `verifiedScope` is only `sha256-and-structure`. |
| `missing` | No file was supplied for the material. |
| `unverified` | Expected data is empty/missing, or a stronger claim has no implemented verifier. |
| `invalid` | Digest, archive safety, resource limit, or parsing checks failed. |

Exit `0` means an inventory completed without invalid supplied material; missing
materials are still reported. Exit `1` means invalid input, material, or collection
failure. With `--require-ready`, exit `2` means readiness is blocked. Automation
must check the exit code and the JSON `ready` value, not just report creation.

This version always reports `ready: false`: it has no wrapper/source build-binding,
generated-CA binding, complete notice-coverage, or authenticated provenance
verifier. These are explicit code capabilities, not booleans accepted from the
lock. Even matching every archive digest cannot enable distribution. Implementing
the missing verifiers and changing the separate workflow freeze require review.

## Collect full notice text

`--collect-notices` writes only into a new destination. It preserves full bytes and
archive-relative paths under each artifact ID, and creates `inventory.json`
binding each collected file to its SHA256, size, source member, containing archive
digest, locked source URL, and core lock context. Existing destinations are never
overwritten. No collection directory is created if no notice files are available
or a supplied archive is invalid. An I/O failure can leave a partial directory;
do not use a collection lacking its final `inventory.json`.

This is a source-material collection, not a release package. Recognition covers
LICENSE/LICENCE, COPYING, NOTICE, COPYRIGHT, PATENTS and AUTHORS filenames, with
common suffixes. File-level notices, unusual filenames, linked dependency
selection, generated CA licensing and applicability still require review.
`coverage` and `sourceBinding` remain `unverified`; collecting all recognized
filenames must not be described as complete license compliance.

The historical MiSub source archive is explicitly an audit reference. It is not
promoted to matching source for a new wrapper, and its empty CA file prevents even
its required-file check from passing. The collector can preserve genuine license
bytes from this archive without asserting that its source inputs are complete.

## Resource and archive boundaries

Each artifact is limited to 96 MiB compressed and 512 MiB expanded. A tar archive
has at most 30,000 members, 128 MiB per regular member, 1 MiB per metadata object,
2 MiB per notice, and 24 MiB of collected notices. Paths have at most 1,024
characters and 32 components. Module inventories have at most 2,048 records.
The lock accepts at most 16 artifacts; these limits are per artifact, and parsing
is sequential. The CLI does not expose a limit override.

The opened input descriptor must be a regular file. Its compressed contents are
read once into a bounded immutable snapshot; both the locked digest check and
archive parsing use those same bytes. Later changes to the input path or file
cannot change the notice bytes associated with the checked archive digest.

The auditor never uses tar extraction. It streams regular member bytes and rejects
absolute/traversing or nonportable paths, symbolic/hard links, devices, FIFOs,
sparse files, duplicate and case/Unicode-normalized path collisions, file/directory
conflicts, unsafe prefixes, global PAX headers, excessive extension metadata, and trailing nonzero data
after the tar end marker. The gzip trailer is read and validated. Recognized
notices are retained in bounded memory for explicit collection; other large
members are hashed incrementally.

Windows ZIPs are inspected without extraction. Before allocating ZIP directory
entries, the auditor requires a single-disk archive with exactly one member and
bounded directory metadata. It rejects unsafe or nonmatching paths, duplicates,
nonregular entries, encryption, unsupported compression, ZIP64 and alternate-path
metadata, malformed or duplicate extra fields, inconsistent local/directory
headers, overlapping data, hidden prefixes/trailers, and invalid data descriptors.
Only stored and deflated data are supported. Streaming decompression is bounded
by the locked executable size and the 128 MiB member limit, consumes the complete
compressed stream, and checks CRC32 plus the separately locked executable SHA256.

## Verified public material observations

On 2026-10-12, the official v1.19.32 vendor and toolchain archives were downloaded
with 24 MiB and 80 MiB compressed limits respectively, and their complete hashes
were recomputed locally. Their contents were inventoried without execution.
The SHA256 values agree with the [official asset listing](https://github.com/MetaCubeX/mihomo/releases/expanded_assets/v1.19.32).

| Material | Compressed bytes | Archive entries / regular files | Recognized notice files |
| --- | ---: | ---: | ---: |
| Official `vendor.tar.gz` | 17,606,440 | 7,754 / 6,667 | 173 |
| Official `toolchain.tar.gz` | 67,743,907 | 16,705 / 15,037 | 38 |
| Historical MiSub `mihomo-source-v1.19.32.tar.gz` | 18,901,195 | 9,004 / 7,715 | 176 |

The counts include AUTHORS and PATENTS. They are inventory counts under this
auditor's filename rule, not a legal-coverage conclusion. The official vendor
archive contains 136 module/replacement declaration records. Its protobuf import
module is replaced by `github.com/metacubex/protobuf-go` at
`v0.0.0-20260306035419-7ceee0674686`. The toolchain's `go/VERSION` reads `go1.26.8`
with `time 2026-08-28T16:20:06Z`; this is inspected file content, not proof that every
locked kernel was compiled by that toolchain.

- Vendor SHA256: `0e605b54a4e2508c57f7bf64ae30d98833b3d2e0c1b399dfffa75248f6e84441`.
- Toolchain SHA256: `341ed5617c5abfb37e7d6e35aef258665e06f21247c13f2a22757da92e281751`.
- Historical source SHA256: `98d5bf0a7dd6b895e35aafd4a4627bbb04e6097472baefd9cb086c52eb8c7991`.

The [fixed upstream build workflow](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/.github/workflows/build.yml)
uses a MetaCubeX Go toolchain, `with_gvisor`, per-build metadata and a generated CA
snapshot. [The core embeds the CA file as a byte slice](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/component/ca/config.go).
The historical source archive's CA file is empty. A separate static examination
of the four locked Unix kernels and the upstream Windows amd64 compatible kernel
recovered the same complete CA byte slice: 182,140 bytes, 121 parseable X.509
certificates, SHA256
`ecd9dc38bc3efb7dbd6431f57e29d2f8d6a0f0d211e1464b3fef2cbfe266fcd2`.
The examination checked each slice's pointer, length and capacity and both call
sites that pass it to `crypto/x509.(*CertPool).AppendCertsFromPEM`; it did not infer
the object's size from PEM boundaries or execute the kernels. The recorded
[object and call-site observations](detector-ca-bindings-v1.19.32.json) bind that
finding to each uncompressed binary digest.

This identifies the embedded CA bytes, not their historical package origin,
generation inputs, licensing coverage, or the full source changes represented by
the upstream `+dirty` build. These observations are not an automated verifier
accepted by this auditor, so its generated-CA binding capability and overall
readiness remain unverified. Recreating today's system CA snapshot cannot supply
the missing historical provenance.

## Future package verification contract

A release-material generator must remain blocked until it can bind, per target:

1. The actual wrapper source snapshot, immutable revision, build scripts,
   compiler, version and resulting executable digest.
2. The locked kernel bytes to full kernel source, effective dependency sources,
   exact generated inputs including CA, toolchain identity and build parameters.
3. Full applicable license/NOTICE/copyright materials to those actual inputs,
   retaining path and content hashes, including relevant toolchain/runtime and CA
   materials. The root MiSub MIT license remains distinct from dependency licenses.
4. A package manifest and `SOURCE.md` locating the exact corresponding source
   materials and their hashes, with no empty files standing in for missing inputs.
5. Authenticated provenance/signature verification, where required by the release
   policy, with expected builder/workflow identity and immutable artifact digests.
   SHA256 from the same download channel alone is not that authentication.

Rebuilding and comparing outputs can strengthen correspondence evidence. Exact
byte reproducibility is an engineering check, not a substitute for reviewing the
applicable distribution obligations. This auditor creates no signing credentials
and grants no workflow permissions.

## Offline regression tests

```sh
python3 -B -m unittest discover -s detector/scripts -p 'test_audit_distribution.py' -v
```

Tests use synthetic archives and cover lock binding, fake readiness assertions,
full notice text and digest preservation, replacements, malformed input,
traversal/links/collisions, limits, extension metadata, empty CA, corruption,
truncation, and hidden concatenated archives. Real subscriptions and real-node
network checks are outside this audit.
Windows cases additionally cover ZIP directory preflight, entry types, encryption,
data descriptors, CRC, local-header conflicts, inner size/digest mismatches and
compressed-stream trailers. An all-material fixture proves that successful checks
for all five target archives still leave `ready: false`.
