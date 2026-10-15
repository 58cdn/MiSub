#!/usr/bin/env python3
"""Verify an existing source-release draft; --publish permits only its final ID-bound PATCH."""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import urllib.parse

import audit_distribution as audit
import release_gate as gate
import source_build as source

MAX_METADATA = 8 * 1024 * 1024
MAX_TOTAL = 768 * 1024 * 1024
API = "https://api.github.com/repos/" + gate.REPOSITORY + "/"
RUNNERS = {"linux-amd64": "ubuntu-24.04", "linux-arm64": "ubuntu-24.04-arm", "darwin-amd64": "macos-15-intel",
           "darwin-arm64": "macos-15", "windows-amd64": "windows-2022"}
PUBLISH_STEPS = {"Recheck all source, license, executable and bootstrap identities",
                 "Attest all release bytes using this workflow's short-lived OIDC identity"}


class PublicationUncertain(gate.GateError):
    """The publication request was attempted; its current state requires a read-only check."""


def positive_id(value):
    gate.require(type(value) is int and value > 0, "invalid_recovery_id")
    return value


def expected_names():
    names = {"install.sh", "install.ps1", "release-catalog.json", "release-manifest.json", "SOURCE.md", "SHA256SUMS"}
    for target in gate.TARGETS:
        names.update({"misub-probe-" + target + (".exe" if target == "windows-amd64" else ""),
                      "misub-wrapper-source-" + target + ".tar.gz", "mihomo-source-" + target + ".tar.gz",
                      "evidence-" + target + ".json"})
    return names


def bounded_command(command, destination, maximum, timeout):
    """Bound stdout on disk and elapsed time without reading authentication material."""
    environment = {key: value for key, value in os.environ.items() if key.upper() not in {"GH_DEBUG", "DEBUG"}}
    environment.update(GH_HOST="github.com", GH_PROMPT_DISABLED="1")
    expired = threading.Event()
    process, timer, created = None, None, False
    try:
        with destination.open("xb") as output:
            created = True
            process = subprocess.Popen([str(value) for value in command], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment)

            def expire():
                expired.set()
                try:
                    process.kill()
                except OSError:
                    pass

            timer = threading.Timer(timeout, expire)
            timer.daemon = True
            timer.start()
            size = 0
            while chunk := process.stdout.read(min(65536, maximum + 1 - size)):
                size += len(chunk)
                gate.require(size <= maximum, "recovery_download_limit")
                output.write(chunk)
            code = process.wait(timeout=10)
            gate.require(not expired.is_set(), "recovery_command_timeout")
            gate.require(code == 0, "recovery_command_failed:" + destination.name)
    except BaseException:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        if created:
            destination.unlink(missing_ok=True)
        raise
    finally:
        if timer is not None:
            timer.cancel()
        if process is not None and process.stdout is not None:
            process.stdout.close()


class GitHub:
    def __init__(self, logs):
        self.logs, self.sequence = logs, 0

    def json(self, endpoint, fields=()):
        # Every endpoint is built from fixed paths and already-validated integers/version.
        gate.require(endpoint.startswith("repos/" + gate.REPOSITORY + "/") and ".." not in endpoint,
                     "recovery_api_endpoint")
        self.sequence += 1
        output = self.logs / (str(self.sequence) + "-api.json")
        command = ["gh", "api", "--hostname", "github.com", "--method", "PATCH" if fields else "GET", "https://api.github.com/" + endpoint]
        command.extend(fields)
        bounded_command(command, output, MAX_METADATA, 120)
        return gate.read_json(output)

    def asset(self, asset_id, destination, maximum):
        endpoint = "repos/" + gate.REPOSITORY + "/releases/assets/" + str(positive_id(asset_id))
        bounded_command(["gh", "api", "--hostname", "github.com", "--method", "GET", "https://api.github.com/" + endpoint,
                         "-H", "Accept: application/octet-stream"], destination, maximum, 180)

    def provenance(self, path, commit, run_id, attempt, repository_id):
        destination = self.logs / (path.name + ".provenance.json")
        command = ["gh", "attestation", "verify", path, "--repo", gate.REPOSITORY,
                   "--signer-workflow", gate.REPOSITORY + "/" + gate.WORKFLOW, "--source-ref", "refs/heads/main",
                   "--source-digest", commit, "--signer-digest", commit, "--deny-self-hosted-runners",
                   "--cert-oidc-issuer", "https://token.actions.githubusercontent.com", "--format", "json"]
        bounded_command(command, destination, MAX_METADATA, 180)
        invocation = verify_invocation(gate.read_json(destination), commit, run_id, attempt, repository_id)
        return {"fileName": path.name, "verification": gate.record(destination), "runInvocationURI": invocation}


def verify_invocation(document, commit, run_id, attempt, repository_id):
    invocation = "https://github.com/" + gate.REPOSITORY + "/actions/runs/" + str(run_id) + "/attempts/" + str(attempt)
    gate.require(isinstance(document, list) and 0 < len(document) <= 16, "authenticated_verification_result_required")
    for result in document:
        certificate = result.get("verificationResult", {}).get("signature", {}).get("certificate", {})
        expected = {"runInvocationURI": invocation, "buildTrigger": "workflow_dispatch", "runnerEnvironment": "github-hosted",
                    "buildSignerDigest": commit, "sourceRepositoryDigest": commit,
                    "sourceRepositoryURI": "https://github.com/" + gate.REPOSITORY,
                    "sourceRepositoryRef": "refs/heads/main",
                    "sourceRepositoryIdentifier": str(positive_id(repository_id)), "buildConfigDigest": commit,
                    "issuer": "https://token.actions.githubusercontent.com",
                    "buildConfigURI": "https://github.com/" + gate.REPOSITORY + "/" + gate.WORKFLOW + "@refs/heads/main",
                    "buildSignerURI": "https://github.com/" + gate.REPOSITORY + "/" + gate.WORKFLOW + "@refs/heads/main"}
        gate.require(all(certificate.get(key) == value for key, value in expected.items()), "authenticated_invocation_mismatch")
    return invocation


def verify_run(run, run_id, commit, expected_attempt):
    positive_id(run_id)
    gate.require(run.get("id") == run_id and type(run.get("id")) is int and run.get("event") == "workflow_dispatch"
                 and run.get("head_sha") == commit and run.get("head_branch") == "main" and run.get("path") == gate.WORKFLOW
                 and run.get("status") == "completed" and run.get("conclusion") in {"failure", "success"}
                 and run.get("repository", {}).get("full_name") == gate.REPOSITORY
                 and run.get("head_repository", {}).get("full_name") == gate.REPOSITORY
                 and run.get("url") == API + "actions/runs/" + str(run_id), "original_manual_run_mismatch")
    repository_id = positive_id(run["repository"].get("id"))
    gate.require(run["head_repository"].get("id") == repository_id, "original_repository_id_mismatch")
    gate.require(positive_id(run.get("run_attempt")) == positive_id(expected_attempt), "original_run_attempt_mismatch")
    return expected_attempt


def verify_jobs(result, run_id, attempt):
    jobs = result.get("jobs")
    gate.require(isinstance(jobs, list) and len(jobs) == 7 and result.get("total_count") == 7, "original_jobs_incomplete")
    by_name = {}
    for job in jobs:
        gate.require(job.get("run_id") == run_id and job.get("run_attempt") == attempt and job.get("status") == "completed"
                     and job.get("name") not in by_name, "original_job_identity_mismatch")
        by_name[job["name"]] = job
    required = {"fixtures", *("native (" + RUNNERS[target] + ", " + target + ")" for target in gate.TARGETS)}
    gate.require(set(by_name) == required | {"publish"}
                 and all(by_name[name].get("conclusion") == "success" for name in required), "original_native_jobs_not_passed")
    publication = by_name["publish"]
    gate.require(publication.get("conclusion") in {"failure", "success"}, "original_publish_not_completed")
    steps = publication.get("steps", [])
    for name in PUBLISH_STEPS:
        matches = [step for step in steps if step.get("name") == name]
        gate.require(len(matches) == 1 and matches[0].get("status") == "completed"
                     and matches[0].get("conclusion") == "success", "original_material_or_attestation_step_not_passed")


def verify_tag(tag, version, commit):
    gate.require(tag.get("ref") == "refs/tags/probe-v" + version and tag.get("object", {}).get("type") == "commit"
                 and tag["object"].get("sha") == commit
                 and tag.get("url") == API + "git/refs/tags/probe-v" + version, "original_tag_mismatch")


def draft_records(release, draft_id, version):
    records = {}
    for asset in release.get("assets", []):
        name, digest, size = asset.get("name"), asset.get("digest"), asset.get("size")
        gate.require(isinstance(name, str) and name in expected_names() and name not in records,
                     "recovery_asset_set_mismatch")
        gate.require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
                     and type(size) is int and 0 < size <= gate.MAX_FILE, "recovery_asset_record_invalid")
        gate.require(isinstance(asset.get("updated_at"), str) and asset["updated_at"], "asset_update_identity_missing")
        records[name] = {"fileName": name, "size": size, "sha256": digest[7:]}
    gate.require(set(records) == expected_names() and sum(item["size"] for item in records.values()) <= MAX_TOTAL,
                 "recovery_asset_set_or_total_limit")
    gate.verify_remote_release(release, draft_id, version, records)
    gate.require(release.get("published_at") is None and release.get("name") == "MiSub Probe v" + version
                 and isinstance(release.get("updated_at"), str) and release["updated_at"], "recovery_draft_state_invalid")
    return records


def stable_release(release):
    # Downloads change download_count. Every identity, content and update field remains fixed.
    result = {key: value for key, value in release.items() if key != "assets"}
    result["assets"] = sorted(({key: value for key, value in asset.items() if key != "download_count"}
                               for asset in release["assets"]), key=lambda asset: asset["id"])
    return result


def snapshot(client, version, commit, run_id, draft_id, expected_attempt):
    prefix = "repos/" + gate.REPOSITORY + "/"
    run = client.json(prefix + "actions/runs/" + str(run_id))
    attempt = verify_run(run, run_id, commit, expected_attempt)
    jobs = client.json(prefix + "actions/runs/" + str(run_id) + "/attempts/" + str(attempt) + "/jobs?per_page=100")
    verify_jobs(jobs, run_id, attempt)
    tag = client.json(prefix + "git/ref/tags/probe-v" + version)
    verify_tag(tag, version, commit)
    release = client.json(gate.release_endpoint(draft_id))
    records = draft_records(release, draft_id, version)
    assets = client.json(gate.release_endpoint(draft_id) + "/assets?per_page=100")
    gate.require(isinstance(assets, list) and stable_release(dict(release, assets=assets)) == stable_release(release),
                 "draft_asset_listing_changed")
    return {"run": run, "jobs": jobs, "tag": tag, "release": stable_release(release)}, records, attempt


def verify_materials(source_root, assets, work, version, commit):
    names = gate.verify_release_files(assets, version, commit)
    gate.require(set(names) == expected_names(), "recovery_asset_set_mismatch")
    inputs, expected = work / "candidates", work / "expected"
    inputs.mkdir()
    for target in gate.TARGETS:
        candidate = inputs / ("source-candidate-" + target)
        candidate.mkdir()
        for name in ("evidence-" + target + ".json", "mihomo-source-" + target + ".tar.gz",
                     "misub-wrapper-source-" + target + ".tar.gz",
                     "misub-probe-" + target + (".exe" if target == "windows-amd64" else "")):
            shutil.copyfile(assets / name, candidate / name)
    # Templates, lock and review come from the original clean source commit.
    # No Actions environment is fabricated and the signed downloads are never rewritten.
    gate.assemble_materials(source_root, inputs, expected, version, commit)
    gate.require(set(path.name for path in expected.iterdir()) == expected_names(), "reconstructed_release_set_mismatch")
    for name in names:
        gate.check_record(expected / name, gate.record(assets / name))
    return {name: gate.record(assets / name) for name in names}


def code_identity():
    commit = gate.git(gate.ROOT, "rev-parse", "HEAD").decode().strip()
    _, _, tree = gate.wrapper_snapshot(gate.ROOT, commit)
    for name in ("release_recovery.py", "release_gate.py", "source_build.py", "audit_distribution.py", "probe_version.py", "release_preflight.py"):
        relative = "detector/scripts/" + name
        committed, actual = gate.git(gate.ROOT, "show", commit + ":" + relative), gate.read(gate.ROOT / relative)
        gate.require(actual == committed or actual == committed.replace(b"\n", b"\r\n"),
                     "recovery_code_not_committed")
    return {"commit": commit, "tree": tree}


def verify_published(before, published, draft_id, version, records):
    gate.verify_remote_release(published, draft_id, version, records, draft=False)
    gate.require(isinstance(published.get("published_at"), str) and published["published_at"], "published_timestamp_missing")
    download_prefix = "https://github.com/" + gate.REPOSITORY + "/releases/download/probe-v" + version + "/"
    published_assets = stable_release(published)["assets"]
    for asset in published_assets:
        gate.require(asset.get("browser_download_url") == download_prefix + urllib.parse.quote(asset["name"], safe=""),
                     "published_asset_download_url_mismatch")
    original_assets = [dict(asset, browser_download_url=download_prefix + urllib.parse.quote(asset["name"], safe=""))
                       for asset in stable_release(before)["assets"]]
    fields = ("id", "url", "tag_name", "target_commitish", "name", "body", "prerelease", "created_at", "upload_url")
    gate.require(all(before.get(key) == published.get(key) for key in fields)
                 and original_assets == published_assets, "published_release_identity_changed")


def guard_dated_recovery(version, commit):
    if gate.probe_version.dated_parts(version) is not None:
        gate.release_preflight.verify_live_main(commit)


def recover(source_root, work, version, commit, run_id, draft_id, original_attempt, publish=False):
    gate.identity(version, commit)
    positive_id(run_id)
    positive_id(draft_id)
    positive_id(original_attempt)
    implementation = code_identity()
    # Validate the old source checkout before spending time or bandwidth on downloads.
    _, _, original_tree = gate.wrapper_snapshot(source_root, commit)
    work.mkdir(parents=True, exist_ok=False)
    logs, assets = work / "logs", work / "assets"
    logs.mkdir()
    assets.mkdir()
    client = GitHub(logs)
    before, records, attempt = snapshot(client, version, commit, run_id, draft_id, original_attempt)
    gate.save(work / "before.json", before)
    by_name = {asset["name"]: asset for asset in before["release"]["assets"]}
    for name in sorted(records):
        client.asset(by_name[name]["id"], assets / name, records[name]["size"])
        gate.check_record(assets / name, records[name])
    gate.require(before["release"].get("body") == gate.read(assets / "SOURCE.md").decode("utf-8"), "release_body_source_mismatch")
    materials = verify_materials(source_root, assets, work, version, commit)
    proofs = [client.provenance(assets / name, commit, run_id, attempt, before["run"]["repository"]["id"]) for name in sorted(records)]
    for name, record in materials.items():
        gate.check_record(assets / name, record)
    after, after_records, after_attempt = snapshot(client, version, commit, run_id, draft_id, original_attempt)
    gate.save(work / "after.json", after)
    gate.require(before == after and records == after_records and attempt == after_attempt, "recovery_remote_state_changed")
    report = {"schemaVersion": 1, "kind": "misub-draft-recovery", "version": version, "releaseId": draft_id,
              "sourceCommit": commit, "sourceTree": original_tree, "recoveryCode": implementation,
              "originalRunId": run_id, "originalRunAttempt": attempt, "assets": list(materials.values()),
              "provenance": proofs, "verified": True, "published": False}
    gate.save(work / "verified.json", report)
    if publish:
        guard_dated_recovery(version, commit)
        gate.save(work / "publication-attempt.json", {"releaseId": draft_id, "sourceCommit": commit,
                  "verifiedReport": gate.record(work / "verified.json"), "publicationAttempted": True, "published": None})
        try:
            result = client.json(gate.release_endpoint(draft_id), ("-F", "draft=false", "-f", "make_latest=false"))
            verify_published(before["release"], result, draft_id, version, materials)
            verify_tag(client.json("repos/" + gate.REPOSITORY + "/git/ref/tags/probe-v" + version), version, commit)
            verify_published(before["release"], client.json(gate.release_endpoint(draft_id)), draft_id, version, materials)
            report["published"] = True
            gate.save(work / "published.json", report)
        except (gate.GateError, source.BuildError, audit.AuditError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            raise PublicationUncertain("publication_state_requires_readback") from error
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--original-run-id", type=int, required=True)
    parser.add_argument("--original-run-attempt", type=int, required=True)
    parser.add_argument("--draft-id", type=int, required=True)
    parser.add_argument("--source-root", type=pathlib.Path, required=True)
    parser.add_argument("--work-dir", type=pathlib.Path, required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = recover(args.source_root.resolve(), args.work_dir.resolve(), args.version, args.commit,
                         args.original_run_id, args.draft_id, args.original_run_attempt, args.publish)
        print(json.dumps({key: result[key] for key in ("releaseId", "sourceCommit", "recoveryCode", "originalRunId",
                                                       "originalRunAttempt", "verified", "published")}))
        return 0
    except PublicationUncertain as error:
        print(json.dumps({"verified": True, "publicationAttempted": True, "published": None,
                          "releaseId": args.draft_id, "error": str(error)}))
        return 1
    except (gate.GateError, source.BuildError, audit.AuditError, OSError, ValueError, KeyError, TypeError, EOFError,
            gate.tarfile.TarError, gate.zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(json.dumps({"verified": False, "published": False,
                          "error": str(error) if isinstance(error, (gate.GateError, source.BuildError, audit.AuditError)) else "draft_recovery_failed"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
