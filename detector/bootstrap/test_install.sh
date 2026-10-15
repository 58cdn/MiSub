#!/usr/bin/env bash
# Offline command fixtures. All client, HTTP, platform and permission observations
# are mocked; no service manager, real download or real pairing is invoked.
set -eu
set -o pipefail
umask 077
export LC_ALL=C

source_dir=$(cd "$(dirname "$0")" && pwd -P)
fixture_parent=$(pwd -P)
suite_root=$(mktemp -d "$fixture_parent/.bootstrap-unix-fixtures.XXXXXXXX")
case "$suite_root" in "$fixture_parent"/.bootstrap-unix-fixtures.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$suite_root"' EXIT
original_path=$PATH
real_stat=$(command -v stat)
real_uname=$(command -v uname)
real_id=$(command -v id)
real_sha=$(command -v sha256sum || command -v shasum)
export FIXTURE_REAL_STAT="$real_stat" FIXTURE_REAL_ID="$real_id"
export FIXTURE_HOST_SYSTEM="$("$real_uname" -s)"
count=0

new_fixture() {
    count=$((count + 1))
    case_dir="$suite_root/case-$count"
    mkdir -p "$case_dir/bin" "$case_dir/home" "$case_dir/state"
    export FIXTURE_ROOT="$case_dir" FIXTURE_SYSTEM=Linux FIXTURE_MACHINE=x86_64
    export FIXTURE_TRANSLATED=0 FIXTURE_ARM=0 FIXTURE_MACOS=13.7 FIXTURE_HTTP=success FIXTURE_CLIENT=success
    export FIXTURE_PERMISSIONS=safe FIXTURE_CAPABILITY=valid
    export HOME="$case_dir/home" PATH="$case_dir/bin:$original_path"
    cat > "$case_dir/bin/uname" <<'SH'
#!/usr/bin/env bash
case "$1" in -s) printf '%s\n' "$FIXTURE_SYSTEM" ;; -m) printf '%s\n' "$FIXTURE_MACHINE" ;; *) exit 1 ;; esac
SH
    cat > "$case_dir/bin/sysctl" <<'SH'
#!/usr/bin/env bash
case "$*" in *proc_translated*) printf '%s\n' "$FIXTURE_TRANSLATED" ;; *hw.optional.arm64*) printf '%s\n' "$FIXTURE_ARM" ;; *) exit 1 ;; esac
SH
    cat > "$case_dir/bin/sw_vers" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$FIXTURE_MACOS"
SH
    cat > "$case_dir/bin/id" <<'SH'
#!/usr/bin/env bash
printf '1001\n'
SH
    cat > "$case_dir/bin/stat" <<'SH'
#!/usr/bin/env bash
# Stable permission fixtures also allow these tests to run under Git Bash.
path=${@: -1}
if [[ "$path" = "$FIXTURE_ROOT/home"* ]]; then
    if [ "$FIXTURE_PERMISSIONS" = unsafe-home ] && [ "$path" = "$FIXTURE_ROOT/home" ]; then printf '1001 777\n'
    elif [ "$FIXTURE_PERMISSIONS" = unsafe-temp ] && [[ "$path" = *'.misub-probe-bootstrap.'* ]]; then printf '1001 755\n'
    elif [ "$FIXTURE_PERMISSIONS" = wrong-owner ] && [ "$path" = "$FIXTURE_ROOT/home" ]; then printf '1002 700\n'
    else printf '1001 700\n'; fi
else printf '0 755\n'; fi
SH
    cat > "$case_dir/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    cat > "$case_dir/client" <<'SH'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$1" >> "$FIXTURE_ROOT/state/client-calls"
case "$0" in /*) ;; *) echo 'relative executable path' >&2; exit 98 ;; esac
case "$1" in
    --capabilities)
        case "$FIXTURE_CAPABILITY" in
            valid) cat "$FIXTURE_ROOT/capability" ;;
            old) echo 'flag provided but not defined: -capabilities' >&2; exit 2 ;;
            mismatch) echo 'misub-probe-bootstrap-v1 0.1.0 0000000000000000000000000000000000000000 linux-amd64' ;;
            extra) cat "$FIXTURE_ROOT/capability"; printf extra ;;
            blank) cat "$FIXTURE_ROOT/capability"; printf '\n' ;;
        esac ;;
    --setup)
        if [ "$2" = --resume ]; then
            [ "$#" -eq 4 ] && [ "$3" = --config ] && [ "$4" = "$HOME/.misub-probe/probe.json" ] || exit 97
            printf 'resume\n' >> "$FIXTURE_ROOT/state/setup-modes"
        else
            [ "$#" -eq 7 ] && [ "$2" = --server ] && [ "$3" = https://fixture.invalid ] &&
                [ "$4" = --pair-window ] && [ "$5" = 11111111-1111-1111-1111-111111111111 ] &&
                [ "$6" = --config ] && [ "$7" = "$HOME/.misub-probe/probe.json" ] || exit 97
            printf 'fresh\n' >> "$FIXTURE_ROOT/state/setup-modes"
        fi
        [ "$FIXTURE_CLIENT" != busy ] || { echo 'setup_in_progress' >&2; exit 1; }
        if [ "$2" != --resume ]; then
            [ ! -e "$7" ] && [ ! -L "$7" ] || exit 95
            printf 'pair\n' >> "$FIXTURE_ROOT/state/setup-stages"
            [ "$FIXTURE_CLIENT" != expired ] || { echo 'pairing_start_failed_check_window_in_misub' >&2; exit 1; }
            mkdir -p "$HOME/.misub-probe"
            printf 'fixture config\n' > "$7"
        fi
        [ "$FIXTURE_CLIENT" != invalid-config ] && [ -f "$HOME/.misub-probe/probe.json" ] || { echo 'configuration_invalid' >&2; exit 1; }
        if [ "$2" = --resume ]; then
            printf 'resume-install\n' >> "$FIXTURE_ROOT/state/setup-stages"
        else
            printf 'install\n' >> "$FIXTURE_ROOT/state/setup-stages"
        fi
        [ "$FIXTURE_CLIENT" != install-failed ] || { echo 'setup_install_failed_configuration_preserved_use_resume' >&2; exit 1; }
        mkdir -p "$HOME/.misub-probe/install"
        if [ ! -e "$HOME/.misub-probe/install/manifest.json" ]; then
            printf 'fixture manifest\n' > "$HOME/.misub-probe/install/manifest.json"
        fi
        printf 'start\n' >> "$FIXTURE_ROOT/state/setup-stages"
        [ "$FIXTURE_CLIENT" != start-failed ] || { echo 'setup_start_failed_configuration_preserved_use_resume' >&2; exit 1; }
        [ "$FIXTURE_CLIENT" != status-failed ] || { echo 'setup_running_process_not_confirmed_configuration_preserved' >&2; exit 1; }
        printf 'probe: installed executable path (quoted display): "%s/.misub-probe/install/fixture/misub-probe"\n' "$HOME" ;;
    *) exit 94 ;;
esac
SH
    cat > "$case_dir/bin/curl" <<'SH'
#!/usr/bin/env bash
set -eu
n=0
[ ! -e "$FIXTURE_ROOT/state/curl-count" ] || n=$(cat "$FIXTURE_ROOT/state/curl-count")
n=$((n + 1))
printf '%s\n' "$n" > "$FIXTURE_ROOT/state/curl-count"
output=''; url=''; max_time=''; range=''; protocols=''; max_size=''
[ "$1" = -q ] || exit 91
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output) output=$2; shift 2 ;;
        --max-time) max_time=$2; shift 2 ;;
        --range) range=$2; shift 2 ;;
        --proto) protocols=$2; shift 2 ;;
        --max-filesize) max_size=$2; shift 2 ;;
        -L|--location|--insecure|-k|--retry*) exit 92 ;;
        https:*) url=$1; shift ;;
        *) shift ;;
    esac
done
[ "$protocols" = '=https' ] && [ "$max_time" -le 45 ] && [ "$max_time" -gt 0 ] || exit 93
[ "$range" = "0-$((max_size - 1))" ] || exit 94
if [ "$n" = 1 ]; then
    [ "$url" = "https://github.com/58cdn/MiSub/releases/download/probe-v$FIXTURE_RELEASE_VERSION/misub-probe-$FIXTURE_TARGET" ] || exit 95
fi
case "$FIXTURE_HTTP" in
    network-two) [ "$n" -gt 2 ] || exit 7 ;;
    network-always) exit 28 ;;
    certificate) exit 60 ;;
    404|429) printf '%s\n\n' "$FIXTURE_HTTP"; : > "$output"; exit 0 ;;
    redirect)
        if [ "$n" = 1 ]; then printf '302\nhttps://release-assets.githubusercontent.com/fixture?signature=public-test\n'; : > "$output"; exit 0; fi ;;
    redirect-http|redirect-foreign|redirect-auth|redirect-port|redirect-loop)
        case "$FIXTURE_HTTP" in
            redirect-http) next='http://release-assets.githubusercontent.com/fixture' ;;
            redirect-foreign) next='https://evil.invalid/fixture' ;;
            redirect-auth) next='https://user@release-assets.githubusercontent.com/fixture' ;;
            redirect-port) next='https://release-assets.githubusercontent.com:444/fixture' ;;
            redirect-loop) next='https://objects.githubusercontent.com/fixture' ;;
        esac
        printf '302\n%s\n' "$next"; : > "$output"; exit 0 ;;
esac
cp "$FIXTURE_ROOT/client" "$output"
case "$FIXTURE_HTTP" in
    short) printf short > "$output" ;;
    long) printf long >> "$output" ;;
    corrupt) printf '#' | dd of="$output" bs=1 seek=2 conv=notrunc 2>/dev/null ;;
esac
printf '200\n\n'
SH
    chmod +x "$case_dir/bin/"* "$case_dir/client"
    render linux-amd64
}

render() {
    export FIXTURE_TARGET=$1
    local digest bytes fixture_version=${2:-0.0.1-alpha.1}
    export FIXTURE_RELEASE_VERSION=$fixture_version
    case "$real_sha" in *sha256sum) digest=$("$real_sha" "$case_dir/client") ;; *) digest=$("$real_sha" -a 256 "$case_dir/client") ;; esac
    digest=${digest%% *}
    bytes=$(wc -c < "$case_dir/client")
    bytes=${bytes//[[:space:]]/}
    sed -e "s/readonly MISUB_RELEASE_VERSION=''/readonly MISUB_RELEASE_VERSION='$fixture_version'/" \
        -e "s/readonly MISUB_RELEASE_COMMIT=''/readonly MISUB_RELEASE_COMMIT='1111111111111111111111111111111111111111'/" \
        -e "s/readonly MISUB_RELEASE_ASSETS=''/readonly MISUB_RELEASE_ASSETS='$FIXTURE_TARGET $bytes $digest'/" \
        "$source_dir/install.sh" > "$case_dir/install.sh"
    case "$FIXTURE_HOST_SYSTEM" in
        MINGW*|MSYS*|CYGWIN*)
            # The Windows compatibility shell has no RLIMIT_FSIZE. Native CI
            # exercises the unchanged production limit on Linux and macOS.
            printf '\n' > "$case_dir/rendered"
            printf 'ulimit() { :; }\n' >> "$case_dir/rendered"
            cat "$case_dir/install.sh" >> "$case_dir/rendered"
            mv "$case_dir/rendered" "$case_dir/install.sh"
            ;;
    esac
    printf 'misub-probe-bootstrap-v1 %s 1111111111111111111111111111111111111111 %s\n' "$fixture_version" "$FIXTURE_TARGET" > "$case_dir/capability"
}

run_installer() {
    status=0
    "$BASH" "$case_dir/install.sh" "$@" > "$case_dir/output" 2>&1 || status=$?
}

pair_run() { run_installer --server https://fixture.invalid --pair-window 11111111-1111-1111-1111-111111111111; }
fail() { printf 'FAIL fixture %s: %s\n' "$count" "$*" >&2; cat "$case_dir/output" >&2; exit 1; }
success() { [ "$status" -eq 0 ] || fail "expected success, got $status"; }
failure() { [ "$status" -ne 0 ] || fail 'expected failure'; grep -Fq "$1" "$case_dir/output" || fail "missing error $1"; }
calls() { local actual=0; [ ! -e "$case_dir/state/client-calls" ] || actual=$(grep -c -e "^$1$" "$case_dir/state/client-calls" || true); [ "$actual" = "$2" ] || fail "$1 called $actual times, expected $2"; }
setup_modes() { local actual=0; [ ! -e "$case_dir/state/setup-modes" ] || actual=$(grep -c -e "^$1$" "$case_dir/state/setup-modes" || true); [ "$actual" = "$2" ] || fail "setup mode $1 used $actual times, expected $2"; }
setup_stages() { local actual=0; [ ! -e "$case_dir/state/setup-stages" ] || actual=$(grep -c -e "^$1$" "$case_dir/state/setup-stages" || true); [ "$actual" = "$2" ] || fail "mock setup stage $1 reached $actual times, expected $2"; }
downloads() { local actual=0; [ ! -e "$case_dir/state/curl-count" ] || actual=$(cat "$case_dir/state/curl-count"); [ "$actual" = "$1" ] || fail "downloads $actual, expected $1"; }

for invalid_version in 0.1.0 0.2.0 0.3.0 0.0.1 0.0.1-alpha.0 0.0.1-alpha.01 0.0.1-alpha.-1 0.0.1-beta.1 0.0.1-rc.1 0.0.1-alpha.1.sha.abcdef012345 0.0.1-alpha.1+build 0.0.1.261015.1 v0.0.1-alpha.1 0.0.1-alpha.999999999999999999999999999999999999999999999999999999; do
    new_fixture; render linux-amd64 "$invalid_version"; pair_run; failure release_metadata_invalid; downloads 0
done

for valid_version in 0.0.1-alpha.9 0.0.1-alpha.10 0.0.1-alpha.9999999999999999999999999999999999999999999999999999; do
    new_fixture; render linux-amd64 "$valid_version"; pair_run; success; downloads 1; calls --capabilities 1
done

new_fixture
sed 's/1111111111111111111111111111111111111111/0000000000000000000000000000000000000000/' "$case_dir/install.sh" > "$case_dir/zero-commit.sh"
mv "$case_dir/zero-commit.sh" "$case_dir/install.sh"
pair_run; failure release_metadata_invalid; downloads 0

new_fixture
cp "$source_dir/install.sh" "$case_dir/install.sh"
pair_run; failure release_unavailable; downloads 0; calls --capabilities 0

for native_target in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
    new_fixture
    case "$native_target" in darwin-*) export FIXTURE_SYSTEM=Darwin ;; esac
    case "$native_target" in *-arm64) export FIXTURE_MACHINE=arm64 ;; esac
    render "$native_target"
    pair_run; success; calls --capabilities 1; calls --setup 1; setup_modes fresh 1; setup_modes resume 0; downloads 1
    [ -z "$(find "$HOME" -maxdepth 1 -name '.misub-probe-bootstrap.*' -print)" ] || fail private_temp_not_cleaned
done

for rosetta_signal in translated hardware; do
    new_fixture; export FIXTURE_SYSTEM=Darwin
    if [ "$rosetta_signal" = translated ]; then export FIXTURE_TRANSLATED=1; else export FIXTURE_ARM=1; fi
    render darwin-arm64; pair_run; success; downloads 1
done

new_fixture; export FIXTURE_SYSTEM=FreeBSD; pair_run; failure unsupported_platform; downloads 0
new_fixture; export FIXTURE_MACHINE=armv7l; pair_run; failure unsupported_architecture; downloads 0
new_fixture; export FIXTURE_SYSTEM=Darwin FIXTURE_TRANSLATED=unexpected; pair_run; failure platform_detection_failed; downloads 0
new_fixture; export FIXTURE_SYSTEM=Darwin FIXTURE_MACOS=12.7.1; pair_run; failure macos_13_or_newer_required; downloads 0
new_fixture; export FIXTURE_SYSTEM=Darwin FIXTURE_MACOS=unknown; pair_run; failure macos_version_unavailable; downloads 0
new_fixture; render darwin-arm64; pair_run; failure release_platform_unavailable; downloads 0

new_fixture; export FIXTURE_HTTP=network-two; pair_run; success; downloads 3; calls --setup 1
new_fixture; export FIXTURE_HTTP=network-always; pair_run; failure download_network_failed; downloads 3; calls --setup 0
new_fixture; export FIXTURE_HTTP=certificate; pair_run; failure download_failed_without_retry; downloads 1; calls --setup 0
for code in 404 429; do
    new_fixture; export FIXTURE_HTTP=$code; pair_run; failure "download_http_$code"; downloads 1; calls --setup 0
done
new_fixture; export FIXTURE_HTTP=redirect; pair_run; success; downloads 2
for redirect in http foreign auth port; do
    new_fixture; export FIXTURE_HTTP=redirect-$redirect; pair_run; failure download_redirect_refused; downloads 1; calls --capabilities 0
done
new_fixture; export FIXTURE_HTTP=redirect-loop; pair_run; failure download_redirect_limit; downloads 3; calls --capabilities 0
for size in short long; do
    new_fixture; export FIXTURE_HTTP=$size; pair_run; failure downloaded_size_mismatch; calls --capabilities 0
done
new_fixture; export FIXTURE_HTTP=corrupt; pair_run; failure downloaded_hash_mismatch; calls --capabilities 0
for capability in old mismatch extra blank; do
    new_fixture; export FIXTURE_CAPABILITY=$capability; pair_run
    if [ "$capability" = old ]; then failure client_capability_check_failed; else failure client_capabilities_mismatch; fi
    calls --setup 0
done

new_fixture; mkdir "$HOME/.misub-probe"; printf original > "$HOME/.misub-probe/probe.json"
pair_run; failure configuration_already_exists; downloads 0
[ "$(cat "$HOME/.misub-probe/probe.json")" = original ] || fail config_changed
case "$FIXTURE_HOST_SYSTEM" in
    Linux|Darwin)
        new_fixture; mkdir "$HOME/.misub-probe"; ln -s "$case_dir/missing" "$HOME/.misub-probe/probe.json"
        pair_run; failure configuration_already_exists; downloads 0
        new_fixture; ln -s "$case_dir/state" "$HOME/.misub-probe"
        pair_run; failure unsafe_config_directory; downloads 0
        new_fixture; mv "$HOME" "$case_dir/real-home"; ln -s "$case_dir/real-home" "$HOME"
        pair_run; failure unsafe_home_directory; downloads 0
        ;;
    *) printf 'SKIP: native Unix symlink observations require Linux/macOS.\n' ;;
esac
new_fixture; mkdir -p "$HOME/.misub-probe/install"; pair_run; failure installation_already_exists; downloads 0
for permissions in unsafe-home wrong-owner unsafe-temp; do
    new_fixture; export FIXTURE_PERMISSIONS=$permissions; pair_run
    case "$permissions" in unsafe-home) failure unsafe_home_permissions ;; wrong-owner) failure unsafe_home_owner ;; unsafe-temp) failure private_temp_unsafe ;; esac
    downloads 0
done

new_fixture; run_installer --resume; failure resume_requires_existing_regular_config; downloads 0
new_fixture; mkdir "$HOME/.misub-probe"; printf original > "$HOME/.misub-probe/probe.json"
run_installer --resume; success; calls --setup 1; setup_modes fresh 0; setup_modes resume 1; setup_stages pair 0; setup_stages resume-install 1
[ "$(cat "$HOME/.misub-probe/probe.json")" = original ] || fail config_changed
new_fixture; mkdir -p "$HOME/.misub-probe/install"; printf original > "$HOME/.misub-probe/probe.json"; printf manifest > "$HOME/.misub-probe/install/manifest.json"
run_installer --resume; success; calls --setup 1; setup_modes fresh 0; setup_modes resume 1; setup_stages pair 0; setup_stages resume-install 1
[ "$(cat "$HOME/.misub-probe/probe.json")" = original ] && [ "$(cat "$HOME/.misub-probe/install/manifest.json")" = manifest ] || fail saved_files_changed
new_fixture; export FIXTURE_CLIENT=expired; pair_run; failure pairing_start_failed_check_window_in_misub; failure setup_stopped; calls --setup 1; setup_stages pair 1; setup_stages install 0; setup_stages start 0
new_fixture; export FIXTURE_CLIENT=busy; pair_run; failure setup_in_progress; calls --setup 1; setup_stages pair 0
[ ! -e "$HOME/.misub-probe/probe.json" ] || fail unexpected_config
new_fixture; export FIXTURE_CLIENT=install-failed; pair_run; failure setup_install_failed_configuration_preserved_use_resume; failure 'run this installer with --resume'; calls --setup 1; setup_stages pair 1; setup_stages start 0
[ -f "$HOME/.misub-probe/probe.json" ] || fail config_removed
export FIXTURE_CLIENT=success; run_installer --resume; success; calls --setup 2; setup_modes fresh 1; setup_modes resume 1; setup_stages pair 1; setup_stages install 1; setup_stages resume-install 1; setup_stages start 1
new_fixture; export FIXTURE_CLIENT=start-failed; pair_run; failure setup_start_failed_configuration_preserved_use_resume; calls --setup 1; setup_stages pair 1; setup_stages install 1
[ -f "$HOME/.misub-probe/probe.json" ] && [ -f "$HOME/.misub-probe/install/manifest.json" ] || fail saved_files_removed
export FIXTURE_CLIENT=success; run_installer --resume; success; calls --setup 2; setup_modes fresh 1; setup_modes resume 1; setup_stages pair 1; setup_stages install 1; setup_stages resume-install 1; setup_stages start 2
new_fixture; export FIXTURE_CLIENT=status-failed; pair_run; failure setup_running_process_not_confirmed_configuration_preserved; failure setup_stopped; calls --setup 1
if grep -Fq 'local startup completed' "$case_dir/output"; then fail startup_success_reported; fi
new_fixture; export FIXTURE_CLIENT=invalid-config; pair_run; failure configuration_invalid; calls --setup 1; setup_stages install 0; setup_stages start 0
new_fixture; mkdir "$HOME/.misub-probe"; printf original > "$HOME/.misub-probe/probe.json"; export FIXTURE_CLIENT=install-failed
run_installer --resume; failure setup_resume_stopped; failure 'before retrying --resume'; calls --setup 1; setup_modes fresh 0; setup_modes resume 1; setup_stages pair 0
[ "$(cat "$HOME/.misub-probe/probe.json")" = original ] || fail config_changed
new_fixture; run_installer --resume --pair-window 11111111-1111-1111-1111-111111111111; failure resume_does_not_accept_pairing_options; downloads 0
new_fixture; run_installer --server 'https://fixture.invalid/$(touch marker)' --pair-window 11111111-1111-1111-1111-111111111111; failure server_requires_https_origin; downloads 0

new_fixture; mv "$HOME" "$case_dir/home with spaces"; export HOME="$case_dir/home with spaces"
pair_run; success; calls --setup 1; setup_modes fresh 1

case "$FIXTURE_HOST_SYSTEM" in
    Linux|Darwin)
        if [ "$("$real_id" -u)" != 0 ]; then
            # Download and executable remain mocks. Only the OS file permissions
            # and ownership are real for these fixtures.
            new_fixture; export FIXTURE_SYSTEM=$FIXTURE_HOST_SYSTEM
            if [ "$FIXTURE_HOST_SYSTEM" = Darwin ]; then render darwin-amd64; fi
            rm "$case_dir/bin/stat" "$case_dir/bin/id"
            pair_run; success; calls --setup 1
            new_fixture; export FIXTURE_SYSTEM=$FIXTURE_HOST_SYSTEM
            if [ "$FIXTURE_HOST_SYSTEM" = Darwin ]; then render darwin-amd64; fi
            rm "$case_dir/bin/stat" "$case_dir/bin/id"
            chmod 777 "$HOME"
            pair_run; failure unsafe_home_permissions; downloads 0
        else printf 'SKIP: native ownership fixtures require a regular user.\n'; fi
        ;;
    *) printf 'SKIP: native permission and file-size limits require Linux/macOS.\n' ;;
esac

for client_log in "$suite_root"/case-*/state/client-calls; do
    [ -f "$client_log" ] || continue
    if grep -Evq '^--(capabilities|setup)$' "$client_log"; then
        printf 'FAIL: bootstrap invoked an unsupported client action in %s\n' "$client_log" >&2
        exit 1
    fi
done
printf 'PASS: %s offline Unix bootstrap fixtures (HTTP, client and permissions mocked).\n' "$count"
