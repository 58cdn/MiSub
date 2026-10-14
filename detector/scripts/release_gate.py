#!/usr/bin/env python3
"""Build and verify clean-source release candidates; publication requires GitHub provenance.

Native builds use locked public inputs and loopback fixtures. No installation,
pairing, production credentials or service registration is performed here.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import unicodedata
import urllib.parse
import urllib.request
import zipfile

import audit_distribution as audit
import source_build as source

ROOT = pathlib.Path(__file__).resolve().parents[2]
REPOSITORY = "58cdn/MiSub"
WORKFLOW = ".github/workflows/probe-source-release.yml"
TARGETS = sorted(source.TARGETS)
MAX_FILE = 128 * 1024 * 1024
CAPABILITIES = ["pair", "install", "start", "status", "check-config", "bootstrap-v1"]
CORE_TESTS = {"TestEmbeddedKernelRoutesOnlyThroughNode", "TestEmbeddedKernelDoesNotFallbackToDirect",
              "TestEmbeddedKernelProviderTLSIdentity", "TestEmbeddedKernelRejectsUntrustedNodeTLS"}


class GateError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise GateError(code)


def identity(version, commit):
    require(isinstance(version, str) and re.fullmatch(r"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})", version), "invalid_release_version")
    require(version != "0.1.0", "legacy_release_is_immutable")
    require(isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit) and commit != "0" * 40, "invalid_source_commit")


def read(path, maximum=MAX_FILE):
    return audit.read_snapshot(pathlib.Path(path), maximum)


def read_json(path):
    return json.loads(read(path, 32 * 1024 * 1024), object_pairs_hook=audit.unique_object)


def save(path, value):
    source.save_json(pathlib.Path(path), value)


def record(path):
    path = pathlib.Path(path)
    data = read(path)
    return {"fileName": path.name, "sha256": source.digest(data), "size": len(data)}


def check_record(path, expected):
    require(record(path) == expected, "artifact_digest_or_size_mismatch")


def run(command, cwd, env, log, timeout=1800, expected_returncode=0):
    with pathlib.Path(log).open("xb") as stream:
        result = subprocess.run([str(v) for v in command], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    data = read(log, 32 * 1024 * 1024)
    if result.returncode != expected_returncode:
        print(data[-12000:].decode("utf-8", errors="replace"), file=sys.stderr)
        raise GateError("command_failed:" + pathlib.Path(log).name)
    return data


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=120).stdout


def wrapper_snapshot(repo, commit):
    require(git(repo, "rev-parse", "HEAD").decode().strip() == commit, "checkout_commit_mismatch")
    require(not git(repo, "diff", "HEAD", "--name-only"), "tracked_worktree_not_clean")
    # git archive reads committed blobs, never untracked files or ignored secrets.
    payload = git(repo, "-c", "core.autocrlf=false", "-c", "core.eol=lf",
                  "archive", "--format=tar.gz", "--prefix=wrapper/", commit)
    require(len(payload) <= MAX_FILE, "wrapper_archive_too_large")
    files = list(source.archive_files(payload, "wrapper", "tar.gz", commit))
    tree = git(repo, "rev-parse", commit + "^{tree}").decode().strip()
    require(source.git_tree(files) == tree, "wrapper_source_tree_mismatch")
    require(any(name == "LICENSE" and data for name, data, _ in files), "wrapper_license_missing")
    return payload, files, tree


def verify_wrapper_pack(path, commit, tree):
    files = list(source.archive_files(read(path), "wrapper", "tar.gz", commit))
    require(source.git_tree(files) == tree, "wrapper_archive_identity_mismatch")


class HTTPSRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(urllib.parse.urlsplit(newurl).scheme == "https", "insecure_material_redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, expected, destination):
    require(urllib.parse.urlsplit(url).scheme == "https", "insecure_material_url")
    request = urllib.request.Request(url, headers={"User-Agent": "MiSub-Source-Release/1"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HTTPSRedirects())
    with opener.open(request, timeout=90) as response:
        data = response.read(MAX_FILE + 1)
    require(len(data) <= MAX_FILE and source.digest(data) == expected, "material_download_digest_mismatch")
    with destination.open("xb") as stream:
        stream.write(data)


def source_pack_inventory(path):
    """Validate every source-pack member without extracting paths to disk."""
    files, manifest, seen, total = {}, None, set(), 0
    with gzip.GzipFile(fileobj=io.BytesIO(read(path))) as compressed:
        reader = audit.LimitedReader(compressed, source.MAX_EXPANDED)
        with tarfile.open(fileobj=reader, mode="r|", tarinfo=audit.BoundedTarInfo, bufsize=512) as archive:
            for entry in archive:
                require(entry.isfile() and not entry.issparse() and not archive.pax_headers, "source_pack_special_member")
                name = audit.canonical_path(entry.name, False)
                key = unicodedata.normalize("NFC", name).casefold()
                require(key not in seen and len(seen) < source.MAX_MEMBERS, "source_pack_duplicate_or_limit")
                require(0 <= entry.size <= source.MAX_MEMBER, "source_pack_member_limit")
                seen.add(key)
                total += entry.size
                require(total <= source.MAX_EXPANDED, "source_pack_expanded_limit")
                with archive.extractfile(entry) as stream:
                    data = stream.read(entry.size + 1)
                require(len(data) == entry.size, "source_pack_truncated")
                if name == "manifest.json":
                    require(len(data) <= 32 * 1024 * 1024, "source_manifest_size_limit")
                    manifest = json.loads(data, object_pairs_hook=audit.unique_object)
                else:
                    files[name] = {"path": name, "sha256": source.digest(data), "bytes": len(data)}
            while tail := reader.read(audit.CHUNK):
                require(not any(tail), "source_pack_trailing_data")
    require(isinstance(manifest, dict) and manifest.get("kind") == "misub-core-source-pack" and manifest.get("schemaVersion") == 1, "source_manifest_missing")
    listed = {}
    for item in manifest["files"]:
        name = item["path"]
        require(name not in listed, "source_manifest_duplicate")
        listed[name] = {k: item[k] for k in ("path", "sha256", "bytes")}
    require(listed == files, "source_manifest_content_mismatch")
    return files, manifest


def review_coverage(review, inventory, dependencies, lock_sha, modules):
    require(set(review) == {"schemaVersion", "sourceLockSha256", "reviews"} and review["schemaVersion"] == 1 and review["sourceLockSha256"] == lock_sha, "license_review_lock_mismatch")
    scopes = {"mihomo", "go", *(item["module"] for item in modules)}
    reviewed = {}
    for item in review["reviews"]:
        require(set(item) == {"scope", "inputFiles", "notices", "rationale"}, "invalid_license_review")
        scope = item["scope"]
        require(scope in scopes and scope not in reviewed, "unknown_or_duplicate_license_scope")
        require(isinstance(item["rationale"], str) and 20 <= len(item["rationale"]) <= 16000, "license_rationale_required")
        require(item["inputFiles"] and item["notices"], "license_files_or_notices_missing")
        covered = {}
        for entry in item["inputFiles"]:
            require(set(entry) == {"path", "sha256", "bytes"}, "invalid_license_file_record")
            require(entry["path"] not in covered and inventory.get(entry["path"]) == entry, "license_input_content_mismatch")
            covered[entry["path"]] = entry
        for notice in item["notices"]:
            require(set(notice) == {"path", "sha256", "bytes"} and type(notice["bytes"]) is int and notice["bytes"] > 0, "invalid_license_notice")
            require(inventory.get(notice["path"]) == notice, "license_notice_content_mismatch")
        reviewed[scope] = covered
    module_names = sorted((item["module"] for item in modules), key=len, reverse=True)
    for entry in dependencies:
        path = entry["path"]
        if path.startswith("go/"):
            scope = "go"
        elif path.startswith("mihomo/vendor/"):
            scope = next((name for name in module_names if path.startswith("mihomo/vendor/" + name + "/")), None)
        elif path.startswith("mihomo/"):
            scope = "mihomo"
        else:
            scope = None
        require(scope is not None and reviewed.get(scope, {}).get(path) == entry, "linked_file_without_reviewed_license:" + path)
    return {"reviewSha256": source.digest(source.json_bytes(review)), "linkedFiles": len(dependencies), "reviewedScopes": sorted(reviewed)}


def verify_native_tests(payload):
    passed, failed, packages = set(), set(), 0
    for line in payload.splitlines():
        event = json.loads(line, object_pairs_hook=audit.unique_object)
        if event.get("Action") == "fail":
            failed.add(event.get("Test", "package"))
        if event.get("Action") == "pass":
            if "Test" in event:
                passed.add(event["Test"])
            else:
                packages += 1
    require(not failed and packages > 0 and CORE_TESTS <= passed, "native_core_tests_not_passed")
    return {"passed": len(passed), "requiredCoreTests": sorted(CORE_TESTS), "race": True}


def embed_core(wrapper, core, target, lock):
    payload = read(core)
    filename = "mihomo-" + target + "-" + lock["source"]["version"] + (".exe" if target.startswith("windows-") else "")
    asset = {"file": filename + (".zip" if target.startswith("windows-") else ".gz")}
    if target.startswith("windows-"):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            entry = zipfile.ZipInfo(filename, (1980, 1, 1, 0, 0, 0))
            entry.compress_type, entry.external_attr = zipfile.ZIP_DEFLATED, (stat.S_IFREG | 0o755) << 16
            archive.writestr(entry, payload)
        compressed = out.getvalue()
        asset.update(entry=filename, executableSha256=source.digest(payload), executableBytes=len(payload))
    else:
        compressed = gzip.compress(payload, mtime=0)
    asset["sha256"] = source.digest(compressed)
    embedded = wrapper / "detector/embedded"
    embedded.mkdir(exist_ok=True)
    destination = embedded / ("kernel.zip" if target.startswith("windows-") else "kernel.gz")
    destination.write_bytes(compressed)
    generated = {"repository": "MetaCubeX/mihomo", "version": lock["source"]["version"],
                 "sourceCommit": lock["source"]["commit"], "assets": {target: asset}, "caMode": "system"}
    (wrapper / "detector/kernel-lock.json").write_bytes(source.json_bytes(generated))
    return generated


def wrapper_standard_dependencies(payload, prepared):
    tool = (prepared / "toolchain").resolve()
    files = {}
    for package in source.decode_packages(payload):
        require(not package.get("Error") and not package.get("DepsErrors") and not package.get("Incomplete"), "wrapper_dependency_error")
        if package.get("Module", {}).get("Main"):
            continue
        require(package.get("Standard") is True, "wrapper_external_dependency_requires_review")
        directory = pathlib.Path(package["Dir"]).resolve()
        require(directory.is_relative_to(tool), "wrapper_toolchain_dependency_outside_inputs")
        for key in ("GoFiles", "CgoFiles", "CFiles", "CXXFiles", "MFiles", "HFiles", "FFiles", "SFiles", "SysoFiles", "EmbedFiles"):
            for name in package.get(key, []):
                path = (directory / name).resolve()
                require(path.is_relative_to(tool), "wrapper_toolchain_dependency_outside_inputs")
                data = read(path)
                relative = "go/" + path.relative_to(tool).as_posix()
                files[relative] = {"path": relative, "sha256": source.digest(data), "bytes": len(data)}
    require(files, "wrapper_standard_dependencies_missing")
    return list(files.values())


def bootstrap_environment(target, environment=None):
    values = os.environ if environment is None else environment
    # Python inherits PowerShell 7's module path. Windows PowerShell 5.1 must
    # construct its own defaults when launched through this intermediate process.
    return {key: value for key, value in values.items()
            if not (target.startswith("windows-") and key.upper() == "PSMODULEPATH")}


def cli_environment(home, environment):
    values = dict(environment)
    for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME",
                "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP"):
        values[key] = str(home)
    return values


def installation_token_elevated():
    if os.name != "nt":
        return os.geteuid() == 0
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    security.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    security.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    token, elevated, returned = wintypes.HANDLE(), wintypes.DWORD(), wintypes.DWORD()
    require(security.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)), "native_token_query_failed")
    try:
        require(security.GetTokenInformation(token, 20, ctypes.byref(elevated), ctypes.sizeof(elevated), ctypes.byref(returned))
                and returned.value == ctypes.sizeof(elevated), "native_token_query_failed")
        return elevated.value != 0
    finally:
        kernel.CloseHandle(token)


def verify_doctor_report(report, version, commit, target, kernel_version, elevated):
    require(type(elevated) is bool, "native_token_evidence_invalid")
    require(isinstance(report, dict) and set(report) == {"schemaVersion", "checkedAt", "scope", "status",
            "platform", "version", "revision", "kernelLockVersion", "checks"}, "native_doctor_report_invalid")
    require(type(report["schemaVersion"]) is int and report["schemaVersion"] == 1
            and (report["scope"], report["status"], report["platform"], report["version"], report["revision"], report["kernelLockVersion"])
            == ("local_read_only", "issues_found", target, version, commit, kernel_version), "native_doctor_identity_mismatch")
    require(isinstance(report["checkedAt"], str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", report["checkedAt"]), "native_doctor_timestamp_invalid")
    expected = {"build": ("ok", "build_metadata_valid"), "platform": ("ok", "platform_supported"),
                "kernel_materials": ("ok", "kernel_archive_checksum_matches"),
                "installation": ("info", "installation_not_found"), "configuration": ("error", "configuration_missing"),
                "service": ("not_run", "service_status_not_checked"),
                "kernel_execution": ("not_run", "kernel_execution_not_checked"), "network": ("not_run", "network_not_checked")}
    if elevated:
        expected["installation"] = ("error", "installation_regular_user_required")
    checks = report["checks"]
    require(isinstance(checks, list) and len(checks) == len(expected), "native_doctor_checks_invalid")
    seen = set()
    for check in checks:
        require(isinstance(check, dict) and {"id", "state", "code"} <= set(check)
                and set(check) <= {"id", "state", "code", "remediation", "source"}, "native_doctor_checks_invalid")
        name = check["id"]
        require(isinstance(name, str) and name in expected and name not in seen, "native_doctor_checks_invalid")
        require((check["state"], check["code"]) == expected[name], "native_doctor_checks_invalid:" + name)
        require(check.get("source") == ("explicit_config" if name == "configuration" else None), "native_doctor_checks_invalid")
        seen.add(name)
    return report


def verify_cli_evidence(evidence, version, commit, target, kernel_version):
    require(type(evidence.get("schemaVersion")) is int, "invalid_native_evidence")
    if evidence.get("schemaVersion") == 1:
        require((version, commit) == ("0.2.0", "9ccee76c3cab149f34dca96c304310c9574c0d29"), "native_cli_evidence_required")
        return
    require(evidence.get("schemaVersion") == 2, "invalid_native_evidence")
    require(evidence.get("versionOutput") == f"misub-probe {version} ({commit}); mihomo {kernel_version}", "native_cli_version_mismatch")
    require(evidence.get("doctorHomeUnchanged") is True, "native_doctor_side_effects")
    verify_doctor_report(evidence.get("doctor"), version, commit, target, kernel_version, evidence.get("installationTokenElevated"))


def native(repo, work, target, version, commit, require_materials=False):
    identity(version, commit)
    require(target in TARGETS and source.host_target() == target, "native_target_mismatch")
    snapshot, files, tree = wrapper_snapshot(repo, commit)
    work.mkdir(parents=True, exist_ok=False)
    wrapper = work / "wrapper"
    source.write_files(wrapper, files)
    lock = source.load_lock(wrapper / "detector/source-build-lock.json")
    materials = work / "materials"
    materials.mkdir()
    host = lock["toolchain"]["hosts"][target]
    for name, url, digest in (("source", lock["source"]["url"], lock["source"]["sha256"]),
                              ("vendor", lock["vendor"]["url"], lock["vendor"]["sha256"]),
                              ("toolchain", "https://go.dev/dl/" + host["file"], host["sha256"])):
        print("Downloading locked " + name + " for " + target, flush=True)
        download(url, digest, materials / (name + ".archive"))
    prepared = work / "prepared"
    source.prepare(lock, materials / "source.archive", materials / "vendor.archive", materials / "toolchain.archive", prepared, target)
    source.build(lock, prepared, target, work / "core")
    review_path = wrapper / "detector/source-license-review.json"
    source.package_materials(lock, prepared, work / "core-source",
                             review_path if review_path.is_file() else None, wrapper / "detector/notices")
    build = read_json(work / "core/build-result.json")
    generated = embed_core(wrapper, work / "core" / build["output"]["file"], target, lock)
    shutil.copyfile(prepared / "source/LICENSE", wrapper / "detector/embedded/LICENSE.mihomo")
    logs = work / "logs"
    logs.mkdir()
    env = source.build_environment(prepared, target)
    go = prepared / ("toolchain/bin/go.exe" if target.startswith("windows-") else "toolchain/bin/go")
    require((wrapper / "detector/go.mod").read_text().strip().splitlines()[0] == "module github.com/58cdn/MiSub/detector", "wrapper_module_mismatch")
    deps = run([go, "list", "-deps", "-json", "."], wrapper / "detector", env, logs / "wrapper-deps.json")
    linked = build["dependencies"]["files"] + wrapper_standard_dependencies(deps, prepared)
    race_env = dict(env, CGO_ENABLED="1", MISUB_PROBE_REQUIRE_KERNEL="1")
    if "CC" in os.environ:
        race_env["CC"] = os.environ["CC"]
    test_log = run([go, "test", "-race", "-json", "-count=1", "./..."], wrapper / "detector", race_env, logs / "native-tests.jsonl")
    tests = verify_native_tests(test_log)
    run([go, "vet", "./..."], wrapper / "detector", env, logs / "vet.txt")
    bootstrap_command = (["powershell.exe", "-NoProfile", "-NonInteractive", "-File", "bootstrap/test-install-windows.ps1"]
                         if target.startswith("windows-") else ["bash", "bootstrap/test_install.sh"])
    run(bootstrap_command, wrapper / "detector", bootstrap_environment(target), logs / "bootstrap-fixtures.txt")
    output = work / "candidate"
    output.mkdir()
    binary_name = "misub-probe-" + target + (".exe" if target.startswith("windows-") else "")
    binary = output / binary_name
    recipe = ["build", "-buildvcs=false", "-trimpath", "-ldflags", "-buildid= -s -w -X main.version=" + version + " -X main.commit=" + commit]
    run([go, *recipe, "-o", binary, "."], wrapper / "detector", env, logs / "wrapper-build.txt")
    run([go, *recipe, "-o", work / "wrapper.repeat", "."], wrapper / "detector", env, logs / "wrapper-repeat.txt")
    require(read(binary) == read(work / "wrapper.repeat"), "wrapper_repeat_build_mismatch")
    cli_home = work / "cli-home"
    cli_home.mkdir()
    cli_env = cli_environment(cli_home, env)
    elevated = installation_token_elevated()
    capabilities = run([binary, "--capabilities"], cli_home, cli_env, logs / "capabilities.txt", timeout=30).decode().strip()
    require(capabilities == f"misub-probe-bootstrap-v1 {version} {commit} {target}", "native_cli_capability_mismatch")
    version_output = run([binary, "--version"], cli_home, cli_env, logs / "version.txt", timeout=30).decode().strip()
    require(version_output == f"misub-probe {version} ({commit}); mihomo {lock['source']['version']}", "native_cli_version_mismatch")
    doctor_output = run([binary, "--doctor", "--json", "--config", cli_home / "missing-probe.json"],
                        cli_home, cli_env, logs / "doctor.json", timeout=30, expected_returncode=1)
    doctor = verify_doctor_report(json.loads(doctor_output, object_pairs_hook=audit.unique_object), version, commit, target, lock["source"]["version"], elevated)
    require(not any(cli_home.iterdir()), "native_doctor_side_effects")
    run([binary, "--self-test"], cli_home, cli_env, logs / "self-test.txt")
    source.load_prepared(prepared, lock)
    core_pack = output / ("mihomo-source-" + target + ".tar.gz")
    shutil.copyfile(work / "core-source/mihomo-source-materials.tar.gz", core_pack)
    wrapper_pack = output / ("misub-wrapper-source-" + target + ".tar.gz")
    wrapper_pack.write_bytes(snapshot)
    inventory, manifest = source_pack_inventory(core_pack)
    lock_sha = source.digest(source.json_bytes(lock))
    require(manifest["lockSha256"] == lock_sha, "source_package_lock_mismatch")
    blockers, coverage = [], None
    if review_path.is_file():
        coverage = review_coverage(read_json(review_path), inventory, linked, lock_sha, manifest["modules"])
    else:
        blockers.append("reviewed_license_coverage_missing")
    evidence = {"schemaVersion": 2, "kind": "misub-native-source-candidate", "version": version, "commit": commit,
                "target": target, "wrapperTree": tree, "lockSha256": lock_sha, "coreBuild": build,
                "generatedKernelLock": generated, "wrapperRecipe": recipe, "wrapperStandardDependencies": wrapper_standard_dependencies(deps, prepared),
                "asset": record(binary), "wrapperSource": record(wrapper_pack), "coreSource": record(core_pack),
                "capabilities": capabilities, "versionOutput": version_output, "doctor": doctor, "doctorHomeUnchanged": True, "installationTokenElevated": elevated,
                "nativeTests": tests, "bootstrapFixtureSha256": source.digest(read(logs / "bootstrap-fixtures.txt")),
                "coverage": coverage, "materialBlockers": blockers, "authenticatedProvenance": "missing", "releaseReady": False}
    save(output / ("evidence-" + target + ".json"), evidence)
    print(json.dumps({"target": target, "version": version, "commit": commit, "wrapperTree": tree,
                      "asset": evidence["asset"], "versionOutput": version_output, "doctor": doctor,
                      "doctorHomeUnchanged": True, "installationTokenElevated": elevated,
                      "nativeTests": tests, "materialBlockers": blockers,
                      "authenticatedProvenance": "missing", "releaseReady": False}), flush=True)
    if require_materials:
        require(not blockers, "distribution_materials_blocked")
    return evidence


def render_bootstrap(unix, windows, assets, version, commit):
    identity(version, commit)
    require(set(assets) == set(TARGETS), "all_five_targets_required")
    for target, asset in assets.items():
        require(set(asset) == {"fileName", "size", "sha256"} and type(asset["size"]) is int and 0 < asset["size"] <= MAX_FILE
                and isinstance(asset["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", asset["sha256"])
                and asset["sha256"] != "0" * 64
                and asset["fileName"] == "misub-probe-" + target + (".exe" if target == "windows-amd64" else ""), "invalid_bootstrap_asset")
    table = "\n".join(f"{t}\t{assets[t]['size']}\t{assets[t]['sha256']}" for t in TARGETS if t != "windows-amd64")
    replacements = [("readonly MISUB_RELEASE_VERSION=''", "readonly MISUB_RELEASE_VERSION='" + version + "'"),
                    ("readonly MISUB_RELEASE_COMMIT=''", "readonly MISUB_RELEASE_COMMIT='" + commit + "'"),
                    ("readonly MISUB_RELEASE_ASSETS=''", "readonly MISUB_RELEASE_ASSETS='" + table + "'")]
    for marker, value in replacements:
        require(unix.count(marker) == 1, "bootstrap_marker_mismatch")
        unix = unix.replace(marker, value)
    win = assets["windows-amd64"]
    for marker, value in [("$MisubReleaseVersion = ''", "$MisubReleaseVersion = '" + version + "'"),
                          ("$MisubReleaseCommit = ''", "$MisubReleaseCommit = '" + commit + "'"),
                          ("$MisubReleaseSize = 0", "$MisubReleaseSize = " + str(win["size"])),
                          ("$MisubReleaseSha256 = ''", "$MisubReleaseSha256 = '" + win["sha256"] + "'")]:
        require(windows.count(marker) == 1, "bootstrap_marker_mismatch")
        windows = windows.replace(marker, value)
    scripts = unix.encode(), windows.encode()
    require(all(0 < len(script) <= 64 * 1024 and b"\0" not in script and b"\r" not in script
                and not script.startswith(b"\xef\xbb\xbf") for script in scripts), "invalid_bootstrap_script_bytes")
    return scripts


def release_context(version, commit, environment=None):
    identity(version, commit)
    env = os.environ if environment is None else environment
    expected = {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": REPOSITORY,
                "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": commit,
                "GITHUB_WORKFLOW_REF": REPOSITORY + "/" + WORKFLOW + "@refs/heads/main", "MISUB_PUBLISH": "true"}
    require(all(env.get(k) == v for k, v in expected.items()), "manual_main_release_context_required")


def provenance_policy(commit):
    return {"repository": REPOSITORY, "workflow": WORKFLOW, "sourceRef": "refs/heads/main",
            "sourceCommit": commit, "signerCommit": commit, "denySelfHostedRunners": True}


def assemble(repo, inputs, output, version, commit):
    release_context(version, commit)
    return assemble_materials(repo, inputs, output, version, commit)


def catalog_history(payload, version):
    catalog = json.loads(payload, object_pairs_hook=audit.unique_object)
    require(isinstance(catalog, dict) and type(catalog.get("schemaVersion")) is int
            and catalog["schemaVersion"] == 1 and type(catalog.get("distributionReady")) is bool,
            "invalid_source_catalog")
    previous = catalog.get("legacyReleases")
    require(isinstance(previous, list), "invalid_source_catalog")
    previous = list(previous)
    current = catalog.get("release")
    require(current is None or isinstance(current, dict), "invalid_source_catalog")
    require(not catalog["distributionReady"] or current is not None, "invalid_source_catalog")
    if catalog["distributionReady"]:
        previous.append({key: current.get(key) for key in ("version", "tag", "capabilities")})
    seen = set()
    for entry in previous:
        require(isinstance(entry, dict) and set(entry) == {"version", "tag", "capabilities"}, "invalid_source_catalog")
        old = entry["version"]
        require(isinstance(old, str) and re.fullmatch(r"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})", old)
                and old != version and old not in seen and entry["tag"] == "probe-v" + old, "invalid_source_catalog")
        caps = entry["capabilities"]
        require(isinstance(caps, list) and all(isinstance(cap, str) and cap in CAPABILITIES for cap in caps)
                and len(caps) == len(set(caps)) and (old != "0.1.0" or not caps), "invalid_source_catalog")
        seen.add(old)
    require(len(previous) <= 20, "invalid_source_catalog")
    return previous


def assemble_materials(repo, inputs, output, version, commit):
    """Verify source-bound candidates and render local release bytes, without publication authority."""
    identity(version, commit)
    _, wrapper_files, tree = wrapper_snapshot(repo, commit)
    source_files = {name: data for name, data, _ in wrapper_files}
    lock = source.load_lock(repo / "detector/source-build-lock.json")
    lock_sha = source.digest(source.json_bytes(lock))
    review = read_json(repo / "detector/source-license-review.json")
    output.mkdir(parents=True, exist_ok=False)
    assets, native_records = {}, []
    for target in TARGETS:
        directory = inputs / ("source-candidate-" + target)
        evidence_path = directory / ("evidence-" + target + ".json")
        evidence = read_json(evidence_path)
        require(evidence.get("kind") == "misub-native-source-candidate" and type(evidence.get("schemaVersion")) is int
                and evidence["schemaVersion"] in (1, 2), "invalid_native_evidence")
        require((evidence["target"], evidence["version"], evidence["commit"], evidence["wrapperTree"], evidence["lockSha256"]) == (target, version, commit, tree, lock_sha), "native_identity_mismatch")
        require(evidence["materialBlockers"] == [] and evidence["coverage"] is not None, "distribution_materials_blocked")
        require(evidence["capabilities"] == f"misub-probe-bootstrap-v1 {version} {commit} {target}", "native_cli_capability_mismatch")
        verify_cli_evidence(evidence, version, commit, target, lock["source"]["version"])
        require(evidence["nativeTests"]["race"] is True and set(evidence["nativeTests"]["requiredCoreTests"]) == CORE_TESTS and evidence["nativeTests"]["passed"] >= len(CORE_TESTS), "native_core_tests_not_passed")
        expected_binary = "misub-probe-" + target + (".exe" if target == "windows-amd64" else "")
        expected_wrapper = "misub-wrapper-source-" + target + ".tar.gz"
        require(evidence["asset"]["fileName"] == expected_binary and evidence["coreSource"]["fileName"] == "mihomo-source-" + target + ".tar.gz" and evidence["wrapperSource"]["fileName"] == expected_wrapper, "candidate_filename_mismatch")
        require(set(p.name for p in directory.iterdir()) == {expected_binary, evidence["coreSource"]["fileName"], expected_wrapper, evidence_path.name}, "unexpected_candidate_file")
        for key in ("asset", "coreSource", "wrapperSource"):
            entry = evidence[key]
            check_record(directory / entry["fileName"], entry)
        # Git's gzip implementation can differ across native runner platforms;
        # the full Git tree identity is the cross-platform source invariant.
        verify_wrapper_pack(directory / expected_wrapper, commit, tree)
        core = evidence["coreBuild"]
        require(core["kind"] == "misub-core-build" and core["source"] == lock["source"] and core["lockSha256"] == lock_sha and core["target"] == target and core["host"] == target and core["caMode"] == "system" and core["repeatBuildMatches"] is True, "core_source_binding_mismatch")
        inventory, manifest = source_pack_inventory(directory / evidence["coreSource"]["fileName"])
        require(manifest["lockSha256"] == lock_sha and manifest["source"] == lock["source"], "source_package_lock_mismatch")
        coverage = review_coverage(review, inventory, core["dependencies"]["files"] + evidence["wrapperStandardDependencies"], lock_sha, manifest["modules"])
        require(coverage == evidence["coverage"], "license_coverage_evidence_mismatch")
        for name in (expected_binary, expected_wrapper, evidence["coreSource"]["fileName"], evidence_path.name):
            shutil.copyfile(directory / name, output / name)
        assets[target] = evidence["asset"]
        native_records.append(record(output / evidence_path.name))
    unix, windows = render_bootstrap(source_files["detector/bootstrap/install.sh"].decode(), source_files["detector/bootstrap/install.ps1"].decode(), assets, version, commit)
    (output / "install.sh").write_bytes(unix)
    (output / "install.ps1").write_bytes(windows)
    url = "https://github.com/" + REPOSITORY + "/releases/download/probe-v" + version + "/"
    def public_record(entry):
        return dict(entry, url=url + entry["fileName"])
    catalog = {"schemaVersion": 1, "distributionReady": True,
               "legacyReleases": catalog_history(source_files["detector/release-catalog.json"], version),
               "release": {"version": version, "tag": "probe-v" + version, "sourceCommit": commit, "bootstrapProtocol": 1, "capabilities": CAPABILITIES,
                           "assets": [dict(public_record(assets[t]), target=t) for t in TARGETS],
                           "bootstrap": {"unix": public_record(record(output / "install.sh")), "windows": public_record(record(output / "install.ps1"))}}}
    # This is a candidate catalog, not an application update. It is published only
    # after authenticated verification; enabling the UI is a separate reviewed PR.
    save(output / "release-catalog.json", catalog)
    source_doc = (f"# MiSub Probe {version} corresponding source\n\nWrapper: https://github.com/{REPOSITORY}/tree/{commit}\n\n"
                  "Each misub-wrapper-source-TARGET.tar.gz contains the complete committed wrapper source, MIT license, bootstrap templates, release workflow and build scripts. All five snapshots are verified against the same Git tree; their gzip bytes may vary with the native Git implementation.\n\n"
                  "Each mihomo-source-TARGET.tar.gz contains the exact core, vendored dependency and standard Go sources, full notices, reviewed supplemental notices, manifest and SOURCE.md. The native evidence-TARGET.json records linked input files, generated embedded-kernel lock, compiler recipe and tested binary hashes.\n\n"
                  "The clean core uses the operating system certificate pool with TLS verification enabled. Linux requires system CA certificates; macOS 13+ and Windows 10/Server 2016+ are supported.\n\n"
                  "Rebuild using detector/scripts/release_gate.py native from the wrapper source commit. The build downloads only the reviewed, hash-pinned public source/vendor/Go materials and uses offline Go module resolution. It performs loopback and mock tests without pairing or installing a service.\n\n"
                  f"Verify artifact attestations with gh attestation verify FILE --repo {REPOSITORY} --signer-workflow {REPOSITORY}/{WORKFLOW} --source-ref refs/heads/main --source-digest {commit} --signer-digest {commit} --deny-self-hosted-runners. SHA256SUMS alone does not authenticate provenance.\n")
    (output / "SOURCE.md").write_text(source_doc, encoding="utf-8", newline="\n")
    manifest = {"schemaVersion": 1, "kind": "misub-source-release", "version": version, "commit": commit, "workflow": WORKFLOW,
                "files": [record(p) for p in sorted(output.iterdir(), key=lambda p: p.name)], "nativeEvidence": native_records,
                "provenancePolicy": provenance_policy(commit)}
    save(output / "release-manifest.json", manifest)
    sums = "".join(record(p)["sha256"] + "  " + p.name + "\n" for p in sorted(output.iterdir(), key=lambda p: p.name))
    (output / "SHA256SUMS").write_text(sums, encoding="ascii", newline="\n")
    return {"files": len(manifest["files"]) + 2, "releaseReady": False, "authenticatedProvenance": "pending-verification"}


def verify_release_files(output, version, commit):
    manifest = read_json(output / "release-manifest.json")
    require(manifest.get("kind") == "misub-source-release" and manifest.get("schemaVersion") == 1 and manifest["version"] == version and manifest["commit"] == commit and manifest["workflow"] == WORKFLOW, "release_manifest_identity_mismatch")
    require(manifest.get("provenancePolicy") == provenance_policy(commit), "release_provenance_policy_mismatch")
    names = {"release-manifest.json", "SHA256SUMS"}
    for entry in manifest["files"]:
        name = entry["fileName"]
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}", name) and name not in names, "release_manifest_filename")
        names.add(name)
        check_record(output / name, entry)
    require(set(p.name for p in output.iterdir()) == names, "unexpected_release_file")
    expected = "".join(record(output / name)["sha256"] + "  " + name + "\n" for name in sorted(names - {"SHA256SUMS"}))
    require(read(output / "SHA256SUMS") == expected.encode(), "checksum_list_mismatch")
    return sorted(names)


def verify_provenance(output, version, commit, bundle, logs):
    release_context(version, commit)
    names = verify_release_files(output, version, commit)
    require(pathlib.Path(bundle).is_file(), "attestation_bundle_required")
    logs.mkdir(parents=True, exist_ok=False)
    for name in names:
        # gh verifies the signature, transparency evidence, artifact digest and
        # certificate claims. A caller-supplied verified:true JSON is never used.
        command = ["gh", "attestation", "verify", output / name, "--repo", REPOSITORY,
                   "--bundle", bundle, "--signer-workflow", REPOSITORY + "/" + WORKFLOW,
                   "--source-ref", "refs/heads/main", "--source-digest", commit, "--signer-digest", commit,
                   "--deny-self-hosted-runners", "--cert-oidc-issuer", "https://token.actions.githubusercontent.com"]
        run(command, output, dict(os.environ), logs / (name + ".verification.txt"), timeout=120)
    return names


def release_endpoint(release_id):
    require(type(release_id) is int and release_id > 0, "invalid_release_id")
    return "repos/" + REPOSITORY + "/releases/" + str(release_id)


def verify_remote_release(release, release_id, version, records, draft=True):
    endpoint = release_endpoint(release_id)
    require(release.get("id") == release_id and type(release.get("id")) is int
            and release.get("url") == "https://api.github.com/" + endpoint
            and release.get("draft") is draft and release.get("tag_name") == "probe-v" + version
            and release.get("prerelease") is False, "draft_release_identity_mismatch")
    assets = release.get("assets")
    require(isinstance(assets, list), "release_asset_set_mismatch")
    uploaded, ids = {}, set()
    for asset in assets:
        name, asset_id = asset.get("name"), asset.get("id")
        require(name not in uploaded and type(asset_id) is int and asset_id > 0 and asset_id not in ids,
                "release_asset_set_mismatch")
        require(asset.get("url") == "https://api.github.com/repos/" + REPOSITORY + "/releases/assets/" + str(asset_id),
                "release_asset_identity_mismatch")
        uploaded[name] = asset
        ids.add(asset_id)
    require(set(uploaded) == set(records), "release_asset_set_mismatch")
    for name, expected in records.items():
        require(uploaded[name].get("state") == "uploaded" and type(uploaded[name].get("size")) is int
                and uploaded[name]["size"] == expected["size"]
                and uploaded[name].get("digest") == "sha256:" + expected["sha256"], "remote_asset_digest_or_size_mismatch")
    return uploaded


def publish(output, version, commit, bundle, logs):
    names = verify_provenance(output, version, commit, bundle, logs)
    # Probe both the release and ref collections. Any API failure is an error;
    # authentication/rate-limit/network failures cannot mean "tag absent".
    for endpoint in ("releases?per_page=100", "git/matching-refs/tags/probe-v" + version):
        response = subprocess.run(["gh", "api", "--hostname", "github.com", "--paginate", "--slurp", "https://api.github.com/repos/" + REPOSITORY + "/" + endpoint],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, check=True, timeout=120)
        pages = json.loads(response.stdout, object_pairs_hook=audit.unique_object)
        existing = [item for page in pages for item in page]
        tag = "probe-v" + version
        require(not any(item.get("tag_name") == tag or item.get("ref") == "refs/tags/" + tag for item in existing), "release_or_tag_already_exists")
    # Creating the ref is atomic and refuses an existing tag, including a tag
    # created concurrently after the read-only checks. No force update is used.
    tag = "probe-v" + version
    run(["gh", "api", "--method", "POST", "https://api.github.com/repos/" + REPOSITORY + "/git/refs", "--hostname", "github.com", "-f", "ref=refs/tags/" + tag, "-f", "sha=" + commit],
        output, dict(os.environ), logs / "create-tag.txt", timeout=120)
    # Upload failure leaves the new draft for inspection; automatic retries do
    # not replace tags/releases/assets or make an incomplete catalog public.
    response = run(["gh", "api", "--hostname", "github.com", "--method", "POST", "https://api.github.com/repos/" + REPOSITORY + "/releases",
                    "-f", "tag_name=" + tag, "-f", "target_commitish=" + commit, "-F", "draft=true", "-F", "prerelease=false",
                    "-f", "make_latest=false", "-f", "name=MiSub Probe v" + version, "-F", "body=@" + str(output / "SOURCE.md")],
                   output, dict(os.environ), logs / "create-draft.json", timeout=120)
    release = json.loads(response, object_pairs_hook=audit.unique_object)
    release_id = release.get("id")
    endpoint = release_endpoint(release_id)
    verify_remote_release(release, release_id, version, {})
    upload_url = "https://uploads.github.com/" + endpoint + "/assets"
    require(release.get("upload_url") == upload_url + "{?name,label}", "release_upload_url_mismatch")
    records = {name: record(output / name) for name in names}
    for name in names:
        run(["gh", "api", "--hostname", "github.com", "--method", "POST", upload_url + "?name=" + urllib.parse.quote(name, safe=""),
             "-H", "Content-Type: application/octet-stream", "-H", "Content-Length: " + str(records[name]["size"]), "--input", output / name],
            output, dict(os.environ), logs / (name + ".upload.json"), timeout=300)
    response = run(["gh", "api", "--hostname", "github.com", "https://api.github.com/" + endpoint], output, dict(os.environ), logs / "draft-assets.json", timeout=120)
    verify_remote_release(json.loads(response, object_pairs_hook=audit.unique_object), release_id, version, records)
    response = run(["gh", "api", "--hostname", "github.com", "--method", "PATCH", "https://api.github.com/" + endpoint, "-F", "draft=false", "-f", "make_latest=false"],
                   output, dict(os.environ), logs / "publish.json", timeout=120)
    verify_remote_release(json.loads(response, object_pairs_hook=audit.unique_object), release_id, version, records, draft=False)
    return {"tag": tag, "releaseId": release_id, "commit": commit, "assets": len(names), "releaseReady": True, "authenticatedProvenance": "verified-by-gh"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("native", "assemble", "publish"):
        child = commands.add_parser(name)
        child.add_argument("--version", required=True)
        child.add_argument("--commit", required=True)
        if name != "publish":
            child.add_argument("--repository-root", type=pathlib.Path, default=ROOT)
        if name == "native":
            child.add_argument("--work-dir", type=pathlib.Path, required=True)
            child.add_argument("--target", choices=TARGETS, required=True)
            child.add_argument("--require-materials", action="store_true")
        else:
            child.add_argument("--output-dir", type=pathlib.Path, required=True)
        if name == "assemble":
            child.add_argument("--inputs-dir", type=pathlib.Path, required=True)
        if name == "publish":
            child.add_argument("--bundle", type=pathlib.Path, required=True)
            child.add_argument("--logs-dir", type=pathlib.Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "native":
            native(args.repository_root.resolve(), args.work_dir.resolve(), args.target, args.version, args.commit, args.require_materials)
        elif args.command == "assemble":
            print(json.dumps(assemble(args.repository_root.resolve(), args.inputs_dir.resolve(), args.output_dir.resolve(), args.version, args.commit)))
        else:
            print(json.dumps(publish(args.output_dir.resolve(), args.version, args.commit, args.bundle.resolve(), args.logs_dir.resolve())))
        return 0
    except (GateError, source.BuildError, audit.AuditError, OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(json.dumps({"releaseReady": False, "error": str(error) if isinstance(error, (GateError, source.BuildError, audit.AuditError)) else "release_gate_failed"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
