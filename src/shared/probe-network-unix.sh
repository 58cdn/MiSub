set -euo pipefail
export LC_ALL=C
trap 'printf "%s\n" "MiSub: download/verification failed; check HTTPS access, proxy and retry. No installer was executed." >&2' EXIT
u='@@URL@@'; n=@@SIZE@@; hash='@@HASH@@'
for i in 0 1 2; do
    r=$(command curl -q --silent --fail --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 45 --max-redirs 0 --max-filesize "$n" --range "0-$((n-1))" --write-out '\n%{http_code} %{redirect_url}' "$u" | command head -c "$((n+8192))" | command tr '\000' '\r' && printf .)
    r=${r%.}
    [ "${#r}" -lt "$((n+8192))" ]
    [[ "$r" != *$'\r'* ]]
    status=${r##*$'\n'}; body=${r%$'\n'*}
    case "$status" in
        '200 '|'206 ') break ;;
        301\ *|302\ *|303\ *|307\ *|308\ *)
            u=${status#* }
            [[ "$u" != *\\* && "$u" =~ ^https://(release-assets\.githubusercontent\.com|objects\.githubusercontent\.com)/[^[:space:]#]+$ ]] && [ "$i" -lt 2 ] || exit 1 ;;
        *) exit 1 ;;
    esac
done
[ "${#body}" -eq "$n" ]
if command -v sha256sum >/dev/null 2>&1; then h=$(printf %s "$body" | command sha256sum); else h=$(printf %s "$body" | command shasum -a 256); fi
[ "${h%% *}" = "$hash" ]
trap - EXIT
command bash -c "$body" -- @@INVOCATION@@
