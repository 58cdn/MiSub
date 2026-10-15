#!/usr/bin/env bash
# Requires Bash 3.2+, curl and sha256sum or shasum. Release tooling embeds only
# audited, immutable metadata in the three assignments below.
set -eu
set -o pipefail
umask 077
export LC_ALL=C

readonly MISUB_RELEASE_VERSION=''
readonly MISUB_RELEASE_COMMIT=''
readonly MISUB_RELEASE_ASSETS=''

bootstrap_error() {
    printf 'MiSub Probe: %s\n' "$*" >&2
    exit 1
}

bootstrap_usage() {
    cat <<'USAGE'
Usage: bash install.sh --server https://misub.example --pair-window PUBLIC_UUID
       bash install.sh --resume

Download and verify the published client for this machine, pair after browser
approval, install for the current user and start it. Configuration is stored at
$HOME/.misub-probe/probe.json. Login startup is not enabled.

--resume validates and preserves existing configuration, then completes or
starts the existing installation. It never requests another pairing credential.
USAGE
}

bootstrap_platform() {
    local system machine translated native_arm os_version
    system=$(command uname -s) || bootstrap_error platform_detection_failed
    machine=$(command uname -m) || bootstrap_error platform_detection_failed
    case "$system" in
        Linux) platform=linux ;;
        Darwin)
            platform=darwin
            os_version=$(command sw_vers -productVersion 2>/dev/null) || bootstrap_error macos_version_unavailable
            [[ "$os_version" =~ ^[1-9][0-9]{0,2}\.[0-9]+(\.[0-9]+)?$ ]] || bootstrap_error macos_version_unavailable
            [ "${os_version%%.*}" -ge 13 ] || bootstrap_error macos_13_or_newer_required
            ;;
        *) bootstrap_error unsupported_platform ;;
    esac
    case "$machine" in
        x86_64|amd64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) bootstrap_error unsupported_architecture ;;
    esac
    if [ "$platform" = darwin ] && [ "$arch" = amd64 ]; then
        translated=$(command sysctl -in sysctl.proc_translated 2>/dev/null || true)
        native_arm=$(command sysctl -in hw.optional.arm64 2>/dev/null || true)
        if [ "$translated" = 1 ] || [ "$native_arm" = 1 ]; then
            arch=arm64
        elif { [ -n "$translated" ] && [ "$translated" != 0 ]; } ||
             { [ -n "$native_arm" ] && [ "$native_arm" != 0 ]; }; then
            bootstrap_error platform_detection_failed
        fi
    fi
    target="$platform-$arch"
}

bootstrap_version_valid() {
    [ "${#1}" -le 64 ] && [[ "$1" =~ ^0\.0\.1-alpha\.[1-9][0-9]*$ ]]
}

bootstrap_release() {
    local entry_target entry_size entry_hash extra seen
    [ -n "$MISUB_RELEASE_VERSION" ] && [ -n "$MISUB_RELEASE_COMMIT" ] &&
        [ -n "$MISUB_RELEASE_ASSETS" ] ||
        bootstrap_error 'release_unavailable: no audited pairing-capable release is available.'
    bootstrap_version_valid "$MISUB_RELEASE_VERSION" ||
        bootstrap_error release_metadata_invalid
    [[ "$MISUB_RELEASE_COMMIT" =~ ^[a-f0-9]{40}$ ]] && [ "$MISUB_RELEASE_COMMIT" != 0000000000000000000000000000000000000000 ] || bootstrap_error release_metadata_invalid
    seen='|'
    expected_size=''
    expected_hash=''
    while IFS=$' \t' read -r entry_target entry_size entry_hash extra; do
        case "$entry_target" in
            linux-amd64|linux-arm64|darwin-amd64|darwin-arm64|windows-amd64) ;;
            *) bootstrap_error release_metadata_invalid ;;
        esac
        [ -z "$extra" ] || bootstrap_error release_metadata_invalid
        [[ "$entry_size" =~ ^[1-9][0-9]{0,8}$ ]] && [ "$entry_size" -le 268435456 ] ||
            bootstrap_error release_metadata_invalid
        [[ "$entry_hash" =~ ^[a-f0-9]{64}$ ]] || bootstrap_error release_metadata_invalid
        case "$seen" in *"|$entry_target|"*) bootstrap_error release_metadata_invalid ;; esac
        seen="$seen$entry_target|"
        if [ "$entry_target" = "$target" ]; then
            expected_size=$entry_size
            expected_hash=$entry_hash
        fi
    done <<ASSETS
$MISUB_RELEASE_ASSETS
ASSETS
    [ -n "$expected_size" ] || bootstrap_error release_platform_unavailable
    release_url="https://github.com/58cdn/MiSub/releases/download/probe-v$MISUB_RELEASE_VERSION/misub-probe-$target"
}

bootstrap_stat() {
    local value
    if [ "$platform" = darwin ]; then
        value=$(command stat -f '%u %Lp' "$1") || return 1
    else
        value=$(command stat -c '%u %a' "$1") || return 1
    fi
    [[ "$value" =~ ^([0-9]+)\ ([0-7]{3,4})$ ]] || return 1
    stat_owner=${BASH_REMATCH[1]}
    stat_mode=$((8#${BASH_REMATCH[2]}))
}

bootstrap_home() {
    local component path rest
    user_id=$(command id -u) || bootstrap_error user_identity_unavailable
    [[ "$user_id" =~ ^[0-9]+$ ]] && [ "$user_id" != 0 ] ||
        bootstrap_error regular_user_required
    case "${HOME:-}" in
        /*) ;;
        *) bootstrap_error home_requires_absolute_path ;;
    esac
    case "$HOME" in
        /|*/|*//*|*/./*|*/../*|*/.|*/..|*$'\r'*|*$'\n'*) bootstrap_error unsafe_home_path ;;
    esac
    path=''
    rest=${HOME#/}
    while [ -n "$rest" ]; do
        component=${rest%%/*}
        if [ "$rest" = "$component" ]; then rest=''; else rest=${rest#*/}; fi
        path="$path/$component"
        [ -d "$path" ] && [ ! -L "$path" ] || bootstrap_error unsafe_home_directory
        bootstrap_stat "$path" || bootstrap_error unsafe_home_directory
        [ "$stat_owner" = 0 ] || [ "$stat_owner" = "$user_id" ] || bootstrap_error unsafe_home_owner
        if [ "$((stat_mode & 0022))" -ne 0 ]; then
            [ "$stat_owner" = 0 ] && [ "$((stat_mode & 01000))" -ne 0 ] ||
                bootstrap_error unsafe_home_permissions
        fi
    done
    [ "$stat_owner" = "$user_id" ] || bootstrap_error unsafe_home_owner
    config="$HOME/.misub-probe/probe.json"
    if [ -e "$HOME/.misub-probe" ] || [ -L "$HOME/.misub-probe" ]; then
        bootstrap_private_directory "$HOME/.misub-probe" || bootstrap_error unsafe_config_directory
    fi
    if [ "$resume" = true ]; then
        [ -f "$config" ] && [ ! -L "$config" ] || bootstrap_error resume_requires_existing_regular_config
    elif [ -e "$config" ] || [ -L "$config" ]; then
        bootstrap_error 'configuration_already_exists: preserve it and use --resume; do not pair again.'
    elif [ -e "$HOME/.misub-probe/install" ] || [ -L "$HOME/.misub-probe/install" ]; then
        bootstrap_error 'installation_already_exists: inspect the existing installation before pairing.'
    fi
}

bootstrap_private_directory() {
    [ -d "$1" ] && [ ! -L "$1" ] && bootstrap_stat "$1" &&
        [ "$stat_owner" = "$user_id" ] && [ "$stat_mode" -eq 448 ]
}

bootstrap_cleanup() {
    if [ -n "${work_dir:-}" ] && bootstrap_private_directory "$work_dir"; then
        # Only remove the files created by this invocation.
        command rm -f "$work_dir/client" "$work_dir/response" "$work_dir/capabilities" || true
        command rmdir "$work_dir" 2>/dev/null || true
    fi
}

bootstrap_download() {
    local url redirects attempt rc status next trailing remaining max_time
    url=$release_url
    redirects=0
    SECONDS=0
    while :; do
        attempt=1
        while :; do
            remaining=$((180 - SECONDS))
            [ "$remaining" -gt 0 ] || bootstrap_error download_deadline_exceeded
            max_time=$remaining
            [ "$max_time" -le 45 ] || max_time=45
            rc=0
            (
                # Bash implementations use 512- or 1024-byte blocks. This bounds
                # even chunked bodies when an older curl cannot enforce their size.
                ulimit -f "$(((expected_size + 511) / 512 + 2))" || exit 70
                command curl -q --silent --proto '=https' --tlsv1.2 \
                    --connect-timeout 10 --max-time "$max_time" --max-redirs 0 \
                    --max-filesize "$expected_size" --range "0-$((expected_size - 1))" \
                    --output "$work_dir/client" --write-out '%{http_code}\n%{redirect_url}\n' \
                    "$url" > "$work_dir/response"
            ) || rc=$?
            [ "$rc" -ne 0 ] || break
            case "$rc" in
                5|6|7|18|28|52|55|56)
                    [ "$attempt" -lt 3 ] || bootstrap_error download_network_failed
                    command sleep "$attempt"
                    attempt=$((attempt + 1))
                    ;;
                *) bootstrap_error download_failed_without_retry ;;
            esac
        done
        status=''; next=''; trailing=''
        {
            IFS= read -r status && IFS= read -r next && ! IFS= read -r trailing && [ -z "$trailing" ]
        } < "$work_dir/response" || bootstrap_error download_response_invalid
        [[ "$status" =~ ^[0-9]{3}$ ]] || bootstrap_error download_response_invalid
        case "$status" in
            200|206) [ -z "$next" ] || bootstrap_error download_response_invalid; break ;;
            301|302|303|307|308)
                [ "$redirects" -lt 2 ] || bootstrap_error download_redirect_limit
                [[ "$next" =~ ^https://(release-assets\.githubusercontent\.com|objects\.githubusercontent\.com)/[^[:space:]\\]+$ ]] ||
                    bootstrap_error download_redirect_refused
                url=$next
                redirects=$((redirects + 1))
                ;;
            *) bootstrap_error "download_http_$status: no pairing was attempted; retry after resolving the download error." ;;
        esac
    done
    local actual_size actual_hash
    actual_size=$(command wc -c < "$work_dir/client") || bootstrap_error downloaded_file_unreadable
    actual_size=${actual_size//[[:space:]]/}
    [ "$actual_size" = "$expected_size" ] || bootstrap_error downloaded_size_mismatch
    if command -v sha256sum >/dev/null 2>&1; then
        actual_hash=$(command sha256sum "$work_dir/client") || bootstrap_error downloaded_hash_failed
    else
        actual_hash=$(command shasum -a 256 "$work_dir/client") || bootstrap_error downloaded_hash_failed
    fi
    actual_hash=${actual_hash%% *}
    [ "$actual_hash" = "$expected_hash" ] || bootstrap_error downloaded_hash_mismatch
}

bootstrap_main() {
    local server window argument output expected_line
    server=''; window=''; resume=false; work_dir=''
    while [ "$#" -gt 0 ]; do
        argument=$1
        shift
        case "$argument" in
            --server)
                [ "$#" -gt 0 ] && [ -z "$server" ] || bootstrap_error invalid_arguments
                server=$1; shift ;;
            --pair-window)
                [ "$#" -gt 0 ] && [ -z "$window" ] || bootstrap_error invalid_arguments
                window=$1; shift ;;
            --resume) [ "$resume" = false ] || bootstrap_error invalid_arguments; resume=true ;;
            --help) [ "$#" -eq 0 ] && [ -z "$server$window" ] && [ "$resume" = false ] || bootstrap_error invalid_arguments; bootstrap_usage; return ;;
            *) bootstrap_error invalid_arguments ;;
        esac
    done
    if [ "$resume" = true ]; then
        [ -z "$server$window" ] || bootstrap_error resume_does_not_accept_pairing_options
    else
        [[ "$server" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?/?$ ]] || bootstrap_error server_requires_https_origin
        [[ "$window" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || bootstrap_error public_pairing_window_required
    fi
    bootstrap_platform
    bootstrap_release
    for argument in curl stat id mktemp wc chmod rm rmdir sleep; do
        command -v "$argument" >/dev/null 2>&1 || bootstrap_error "required_command_missing: $argument"
    done
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
        bootstrap_error sha256_tool_required
    bootstrap_home
    work_dir=$(command mktemp -d "$HOME/.misub-probe-bootstrap.XXXXXXXX") || bootstrap_error private_temp_unavailable
    bootstrap_private_directory "$work_dir" || bootstrap_error private_temp_unsafe
    trap bootstrap_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    printf 'MiSub Probe: verifying %s for %s.\n' "$MISUB_RELEASE_VERSION" "$target"
    bootstrap_download
    command chmod 700 "$work_dir/client" || bootstrap_error client_executable_unavailable
    "$work_dir/client" --capabilities > "$work_dir/capabilities" || bootstrap_error client_capability_check_failed
    expected_line="misub-probe-bootstrap-v1 $MISUB_RELEASE_VERSION $MISUB_RELEASE_COMMIT $target"
    output=$(command wc -c < "$work_dir/capabilities") || bootstrap_error client_capabilities_mismatch
    output=${output//[[:space:]]/}
    [ "$output" = "$((${#expected_line} + 1))" ] || bootstrap_error client_capabilities_mismatch
    output=''
    {
        IFS= read -r output && [ "$output" = "$expected_line" ] && ! IFS= read -r output
    } < "$work_dir/capabilities" || bootstrap_error client_capabilities_mismatch
    if [ "$resume" = true ]; then
        "$work_dir/client" --setup --resume --config "$config" ||
            bootstrap_error 'setup_resume_stopped: existing configuration and installation are preserved; resolve the reported error before retrying --resume.'
    else
        printf 'MiSub Probe: approve the displayed site, pairing code and fingerprint in MiSub.\n'
        "$work_dir/client" --setup --server "$server" --pair-window "$window" --config "$config" ||
            bootstrap_error 'setup_stopped: not retried. Existing files are preserved. If a configuration was saved, resolve the reported error then run this installer with --resume. If pairing delivery is uncertain, inspect and revoke that detector in MiSub before a new pairing.'
    fi
    printf 'MiSub Probe: local startup completed. Confirm this detector is online in MiSub; server connectivity is not established by this installer.\n'
}

bootstrap_main "$@"
