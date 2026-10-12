set -eu
set -o pipefail
umask 077
export LC_ALL=C
expected_size='@@SIZE@@'
expected_hash='@@HASH@@'
release_url='@@URL@@'
resume=@@RESUME@@
work_dir=''
bootstrap_error() {
    printf 'MiSub Probe: %s\n' "$*" >&2
    exit 1
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

bootstrap_platform
for argument in bash curl stat id mktemp wc rm rmdir sleep; do
    command -v "$argument" >/dev/null 2>&1 || bootstrap_error "required_command_missing: $argument"
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || bootstrap_error sha256_tool_required
bootstrap_home
work_dir=$(command mktemp -d "$HOME/.misub-probe-bootstrap.XXXXXXXX") || bootstrap_error private_temp_unavailable
bootstrap_private_directory "$work_dir" || bootstrap_error private_temp_unsafe
trap bootstrap_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bootstrap_download
@@INVOCATION@@
