"""Read-only release identity gate; never reserves a tag or creates a release."""
import argparse
import json
import os
import pathlib
import re
import subprocess

import probe_version

REPOSITORY = "58cdn/MiSub"


def api(endpoint, paginated=False):
    command = ["gh", "api", "--hostname", "github.com"]
    if paginated:
        command += ["--paginate", "--slurp"]
    command += ["repos/" + REPOSITORY + "/" + endpoint]
    result = subprocess.run(command, check=True, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    value = json.loads(result.stdout)
    if paginated:
        if not isinstance(value, list) or not all(isinstance(page, list) for page in value):
            raise ValueError("invalid_remote_inventory")
        return [item for page in value for item in page]
    return value


def inventory():
    tag_rows = api("git/matching-refs/tags/", True)
    release_rows = api("releases?per_page=100", True)
    if not all(isinstance(entry, dict) and isinstance(entry.get("ref"), str)
               and entry["ref"].startswith("refs/tags/") and len(entry["ref"]) > len("refs/tags/") for entry in tag_rows):
        raise ValueError("invalid_remote_tag_inventory")
    if not all(isinstance(entry, dict) and isinstance(entry.get("tag_name"), str)
               and entry["tag_name"] for entry in release_rows):
        raise ValueError("invalid_remote_release_inventory")
    tags = [entry["ref"][len("refs/tags/"):] for entry in tag_rows]
    releases = [entry["tag_name"] for entry in release_rows]
    return tags, releases


def verify_next_version(version):
    next_value = probe_version.next_version(*inventory())
    if version != next_value:
        raise ValueError("release_version_must_be_next_alpha_sequence:" + next_value)


def verify_reserved_version(version):
    number = probe_version.alpha_number(version)
    tags, releases = inventory()
    if (number is None or "probe-v" + version not in tags
            or max(probe_version.inventory_numbers(tags, releases), default=0) != number):
        raise ValueError("reserved_alpha_version_is_not_latest_sequence")


def verify(version, expected, actual, main, tags, releases):
    if not re.fullmatch(r"[0-9a-f]{40}", expected) or expected == "0" * 40:
        raise ValueError("exact_source_commit_required")
    if actual != expected or main != expected:
        raise ValueError("main_or_execution_commit_changed")
    next_value = probe_version.next_version(tags, releases)
    if version != next_value:
        raise ValueError("release_version_must_be_next_alpha_sequence:" + next_value)
    return {"version": version, "commit": expected, "channel": "testing", "prerelease": True, "publicationReady": True}


def verify_live_main(expected):
    if api("git/ref/heads/main")["object"]["sha"] != expected:
        raise ValueError("main_or_execution_commit_changed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-commit", required=True)
    args = parser.parse_args()
    try:
        if (os.environ.get("GITHUB_EVENT_NAME"), os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_REF")) != ("workflow_dispatch", REPOSITORY, "refs/heads/main"):
            raise ValueError("canonical_manual_main_required")
        probe_version.verify_source_version(args.version, pathlib.Path(__file__).resolve().parents[2])
        current = api("git/ref/heads/main")["object"]["sha"]
        print(json.dumps(verify(args.version, args.expected_commit, os.environ.get("GITHUB_SHA"), current, *inventory())))
        return 0
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print(json.dumps({"publicationReady": False, "error": "release_identity_preflight_failed"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
