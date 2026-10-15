"""Probe identities: historical SemVer and UTC+8 dated release numbers."""
import datetime
import re

DATED = re.compile(r"0\.0\.1\.([0-9]{6})\.([1-9][0-9]{0,5})")
LEGACY = re.compile(r"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})")
TIMEZONE = datetime.timezone(datetime.timedelta(hours=8))


def dated_parts(value):
    match = DATED.fullmatch(value) if isinstance(value, str) else None
    if not match:
        return None
    day, number = match.groups()
    try:
        datetime.date(2000 + int(day[:2]), int(day[2:4]), int(day[4:]))
    except ValueError:
        return None
    return day, int(number)


def valid(value):
    return isinstance(value, str) and (LEGACY.fullmatch(value) is not None or dated_parts(value) is not None)


def next_version(tags, releases, now):
    if now.tzinfo is None:
        raise ValueError("timezone_required")
    local = now.astimezone(TIMEZONE)
    if not 2000 <= local.year <= 2099:
        raise ValueError("release_date_out_of_range")
    day = local.strftime("%y%m%d")
    used = []
    for name in [*tags, *releases]:
        if not isinstance(name, str):
            raise ValueError("invalid_remote_version_inventory")
        parts = dated_parts(name.removeprefix("probe-v"))
        if parts and parts[0] == day:
            used.append(parts[1])
    number = max(used, default=0) + 1
    if number > 999999:
        raise ValueError("release_sequence_exhausted")
    return f"0.0.1.{day}.{number}"
