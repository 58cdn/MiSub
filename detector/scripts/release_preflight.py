"""Read-only release identity gate; never reserves a tag or creates a release."""
import argparse
import datetime
import json
import os
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


def verify(version, expected, actual, main, tags, releases, now):
    if not re.fullmatch(r"[0-9a-f]{40}", expected) or expected == "0" * 40:
        raise ValueError("exact_source_commit_required")
    if actual != expected or main != expected:
        raise ValueError("main_or_execution_commit_changed")
    next_value = probe_version.next_version(tags, releases, now)
    if version != next_value:
        raise ValueError("release_version_must_be_next_utc8_sequence:" + next_value)
    return {"version": version, "commit": expected, "timezone": "UTC+08:00", "publicationReady": True}


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
        run_id = os.environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[1-9][0-9]*", run_id):
            raise ValueError("original_run_id_required")
        # Keep the dispatch date through native builds, queueing and midnight.
        original_run = api("actions/runs/" + run_id)
        allocated_at = datetime.datetime.fromisoformat(original_run["created_at"].replace("Z", "+00:00"))
        current = api("git/ref/heads/main")["object"]["sha"]
        tags = [entry["ref"].removeprefix("refs/tags/") for entry in api("git/matching-refs/tags/", True)]
        releases = [entry["tag_name"] for entry in api("releases?per_page=100", True)]
        print(json.dumps(verify(args.version, args.expected_commit, os.environ.get("GITHUB_SHA"), current,
                                tags, releases, allocated_at)))
        return 0
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print(json.dumps({"publicationReady": False, "error": "release_identity_preflight_failed"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
