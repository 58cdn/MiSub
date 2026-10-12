#!/usr/bin/env bash
# stdout is ONLY a binding UUID (or empty); safe diagnostics go to stderr.
set -euo pipefail
project_name="${1:?Pages project name is required}"
existing="${2:-}"
if [[ ! "$project_name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo '::error::Invalid Pages project name.' >&2; exit 1
fi
explicit="${CLOUDFLARE_PROBE_D1_DATABASE_ID:-}"
if [[ -n "$existing" && -n "$explicit" && "$existing" != "$explicit" ]]; then
  echo '::error::MISUB_PROBE_DB already points at another database. Refusing to switch storage.' >&2; exit 1
fi
id="${explicit:-$existing}"
validate_id() { [[ "$1" =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]]; }
if [[ -n "$id" ]]; then
  validate_id "$id" || { echo '::error::Invalid probe D1 database ID.' >&2; exit 1; }
  printf '%s\n' "$id"; exit 0
fi
# Preserve existing bindings even when provisioning is not requested.
if [[ "${PROVISION_NODE_PROBES:-false}" != 'true' ]]; then exit 0; fi
if [[ "${GITHUB_ACTIONS:-false}" == 'true' && ( "${GITHUB_EVENT_NAME:-}" != 'workflow_dispatch' || "${GITHUB_REF:-}" != 'refs/heads/main' ) ]]; then
  echo '::error::Probe D1 provisioning requires explicit manual dispatch on main.' >&2; exit 1
fi
: "${CLOUDFLARE_API_TOKEN:?Missing Cloudflare API token}"
: "${CLOUDFLARE_ACCOUNT_ID:?Missing Cloudflare account ID}"
api="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database"
name="${project_name}-probes"
response="$(mktemp)"
trap 'rm -f "$response"' EXIT
request() {
  local method="$1" url="$2" body="${3:-}" status
  local args=(--silent --show-error --output "$response" --write-out '%{http_code}' --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [[ "$method" != GET ]]; then args+=(--request "$method" --header 'Content-Type: application/json' --data "$body"); fi
  status="$(curl "${args[@]}" "$url")"
  if [[ "$status" != 200 && "$status" != 201 ]]; then
    echo "::error::Probe D1 provisioning failed (HTTP $status). The existing Cloudflare token needs Account / D1 / Edit permission; no business storage was switched." >&2
    return 1
  fi
  jq -e '.success == true' "$response" >/dev/null || { echo '::error::Probe D1 API returned an unsuccessful result.' >&2; return 1; }
}
request GET "${api}?name=${name}&per_page=100"
count="$(jq --arg name "$name" '[.result[] | select(.name == $name)] | length' "$response")"
if [[ "$count" -gt 1 ]]; then echo '::error::Ambiguous probe database name; refusing to choose a database.' >&2; exit 1; fi
id="$(jq -r --arg name "$name" '[.result[] | select(.name == $name) | .uuid] | first // empty' "$response")"
if [[ -z "$id" ]]; then
  echo "Creating isolated probe D1: $name" >&2
  request POST "$api" "$(jq -cn --arg name "$name" '{name:$name}')"
  id="$(jq -er '.result.uuid' "$response")"
else
  echo "Reusing isolated probe D1: $name" >&2
fi
validate_id "$id" || { echo '::error::Invalid probe D1 database ID returned by Cloudflare.' >&2; exit 1; }
printf '%s\n' "$id"
