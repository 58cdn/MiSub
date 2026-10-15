"""Probe alpha identities and monotonic allocation in the probe-v namespace."""
import argparse
import pathlib
import re

# SemVer identifiers are compared as integers when numeric, never lexically.
SEMVER = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)
LEGACY = re.compile(r"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})")


def parse(value):
    if not isinstance(value, str) or len(value) > 256:
        return None
    match = SEMVER.fullmatch(value)
    if not match:
        return None
    major, minor, patch, prerelease, build = match.groups()
    identifiers = prerelease.split(".") if prerelease else []
    if any(part.isdigit() and len(part) > 1 and part[0] == "0" for part in identifiers):
        return None
    return {"core": (int(major), int(minor), int(patch)), "prerelease": identifiers,
            "build": build.split(".") if build else []}


def alpha_number(value, development=False):
    if not isinstance(value, str):
        return None
    if development and (match := re.fullmatch(r"(.+)\.sha\.([0-9a-f]{12})", value)):
        value = match[1]
    if len(value) > 64:
        return None
    parsed = parse(value)
    if parsed is None or parsed["core"] != (0, 0, 1) or parsed["build"]:
        return None
    identifiers = parsed["prerelease"]
    if len(identifiers) != 2:
        return None
    if identifiers[0] != "alpha" or not identifiers[1].isdigit() or int(identifiers[1]) == 0:
        return None
    return int(identifiers[1])


def valid(value):
    return isinstance(value, str) and (LEGACY.fullmatch(value) is not None or alpha_number(value) is not None)


def compare(left, right):
    """SemVer precedence: core and numeric prerelease identifiers compare numerically."""
    a, b = parse(left), parse(right)
    if a is None or b is None:
        raise ValueError("invalid_semver")
    if a["core"] != b["core"]:
        return (a["core"] > b["core"]) - (a["core"] < b["core"])
    pa, pb = a["prerelease"], b["prerelease"]
    if not pa or not pb:
        return (not pa) - (not pb)
    for x, y in zip(pa, pb):
        if x == y:
            continue
        if x.isdigit() and y.isdigit():
            return (int(x) > int(y)) - (int(x) < int(y))
        if x.isdigit() != y.isdigit():
            return -1 if x.isdigit() else 1
        return (x > y) - (x < y)
    return (len(pa) > len(pb)) - (len(pa) < len(pb))


def compare_alpha(left, right):
    """Compare product alpha numbers; development SHA does not affect precedence."""
    left_number, right_number = alpha_number(left, True), alpha_number(right, True)
    if left_number is None or right_number is None:
        raise ValueError("alpha_comparison_requires_explicit_legacy_migration")
    return (left_number > right_number) - (left_number < right_number)


def inventory_numbers(tags, releases):
    numbers = []
    for name in [*tags, *releases]:
        if not isinstance(name, str):
            raise ValueError("invalid_remote_version_inventory")
        if not name.startswith("probe-v"):
            continue
        number = alpha_number(name[len("probe-v"):], development=True)
        if number is not None:
            numbers.append(number)
        elif name.startswith("probe-v0.0.1-alpha."):
            # An unparseable entry must not reset the sequence or silently reuse N.
            raise ValueError("invalid_probe_alpha_inventory")
    return numbers


def next_version(tags, releases):
    number = max(inventory_numbers(tags, releases), default=0) + 1
    result = f"0.0.1-alpha.{number}"
    if alpha_number(result) is None:
        raise ValueError("release_sequence_exhausted")
    return result


def source_version(payload):
    value = payload.decode("ascii")
    if value.endswith("\r\n"):
        value = value[:-2]
    elif value.endswith("\n"):
        value = value[:-1]
    if alpha_number(value) is None:
        raise ValueError("invalid_source_product_version")
    return value


def read_version(repository):
    return source_version((pathlib.Path(repository) / "detector/VERSION").read_bytes())


def verify_source_version(version, repository):
    if version != read_version(repository):
        raise ValueError("source_product_version_mismatch")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository-root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(read_version(args.repository_root))
