#!/usr/bin/env bash
# Called by .github/workflows/cloudflare-pages.yml after npm ci/test/build.
set -euo pipefail

for key in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ADMIN_PASSWORD; do
  if [[ -z "${!key:-}" ]]; then
    echo "::error::Missing Repository secret: ${key}"
    exit 1
  fi
done

if [[ "$ADMIN_PASSWORD" == "admin" ]]; then
  echo "::error::ADMIN_PASSWORD must not be the insecure default 'admin'."
  exit 1
fi

project_name="${CLOUDFLARE_PAGES_PROJECT_NAME:-misub}"
if [[ ! "$project_name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "::error::CLOUDFLARE_PAGES_PROJECT_NAME must use lowercase letters, digits, or hyphens."
  exit 1
fi

api_base="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
api_auth=("Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
project_json="$(mktemp)"
trap 'rm -f "$project_json"' EXIT

# Look up the existing project before creating anything. Never hide auth errors as 404s.
status="$(curl --silent --show-error --output "$project_json" --write-out '%{http_code}' \
  --header "${api_auth[0]}" "${api_base}/pages/projects/${project_name}")"
case "$status" in
  200)
    jq -e '.success == true' "$project_json" >/dev/null
    echo "Using existing Pages project: $project_name"
    ;;
  404)
    echo "Creating Pages project: $project_name"
    npx wrangler pages project create "$project_name" --production-branch=main
    # A new project's settings have no production resource bindings.
    printf '{"result":{"deployment_configs":{"production":{}}}}\n' > "$project_json"
    ;;
  *)
    echo "::error::Cloudflare Pages project lookup failed (HTTP $status)."
    exit 1
    ;;
esac

# A Wrangler config is authoritative. Refuse to silently remove other KV/D1 bindings.
if jq -e '[
  (.result.deployment_configs.production.kv_namespaces // {} | keys[] | select(. != "MISUB_KV")),
  (.result.deployment_configs.production.d1_databases // {} | keys[] | select(. != "MISUB_DB"))
] | length > 0' "$project_json" >/dev/null; then
  echo "::error::Existing Pages project has other KV/D1 bindings. Review them before replacing its Wrangler configuration."
  exit 1
fi

# Extra production variables or resource bindings may be removed by a new Wrangler
# configuration. Fail closed instead of silently changing an existing deployment.
if jq -e '
  (.result.deployment_configs.production // {}) as $p |
  (
    [($p.env_vars // {} | keys[] | select(. != "ADMIN_PASSWORD" and . != "COOKIE_SECRET"))] +
    [($p.r2_buckets // {} | keys[])] +
    [($p.durable_object_namespaces // {} | keys[])] +
    [($p.services // {} | keys[])] +
    [($p.queue_producers // {} | keys[])] +
    [($p.hyperdrive_bindings // {} | keys[])] +
    [($p.analytics_engine_datasets // {} | keys[])] +
    [($p.vectorize_bindings // {} | keys[])] +
    [($p.ai_bindings // {} | keys[])] +
    [($p.browsers // {} | keys[])] +
    [($p.mtls_certificates // {} | keys[])]
  ) | length > 0
' "$project_json" >/dev/null; then
  echo "::error::Existing Pages project has additional production settings. Back up and migrate them before using this Wrangler-managed deployment."
  exit 1
fi

existing_kv="$(jq -r '.result.deployment_configs.production.kv_namespaces.MISUB_KV.namespace_id // empty' "$project_json")"
kv_id="${CLOUDFLARE_KV_NAMESPACE_ID:-$existing_kv}"
if [[ -n "$existing_kv" && -n "${CLOUDFLARE_KV_NAMESPACE_ID:-}" && "$existing_kv" != "$kv_id" ]]; then
  echo "::error::MISUB_KV already points at another namespace. Refusing to switch storage."
  exit 1
fi

if [[ -z "$kv_id" ]]; then
  # Stable name makes successive runs idempotent; existing project bindings take precedence.
  kv_name="${project_name}-misub-kv"
  namespaces="$(curl --fail --silent --show-error \
    --header "${api_auth[0]}" "${api_base}/storage/kv/namespaces?per_page=1000")"
  jq -e '.success == true' <<< "$namespaces" >/dev/null
  kv_id="$(jq -r --arg title "$kv_name" '[.result[] | select(.title == $title) | .id] | first // empty' <<< "$namespaces")"

  if [[ -z "$kv_id" ]]; then
    echo "Creating KV namespace: $kv_name"
    created="$(curl --fail --silent --show-error --request POST \
      --header "${api_auth[0]}" --header 'Content-Type: application/json' \
      --data "$(jq -cn --arg title "$kv_name" '{title:$title}')" \
      "${api_base}/storage/kv/namespaces")"
    jq -e '.success == true' <<< "$created" >/dev/null
    kv_id="$(jq -er '.result.id' <<< "$created")"
  else
    echo "Reusing KV namespace: $kv_name"
  fi
fi

if [[ ! "$kv_id" =~ ^[a-fA-F0-9]{32}$ ]]; then
  echo "::error::Invalid KV namespace ID."
  exit 1
fi

existing_d1="$(jq -r '.result.deployment_configs.production.d1_databases.MISUB_DB.id // empty' "$project_json")"
d1_id="${CLOUDFLARE_D1_DATABASE_ID:-$existing_d1}"
if [[ -n "$existing_d1" && -n "${CLOUDFLARE_D1_DATABASE_ID:-}" && "$existing_d1" != "$d1_id" ]]; then
  echo "::error::MISUB_DB already points at another D1 database. Refusing to switch storage."
  exit 1
fi
if [[ -n "$d1_id" && ! "$d1_id" =~ ^[a-fA-F0-9-]{36}$ ]]; then
  echo "::error::Invalid D1 database ID."
  exit 1
fi

# Generate at runtime only; never check account-specific resource IDs into Git.
# Retain the committed compatibility flags and build output directory.
if [[ -e wrangler.toml ]]; then
  echo "::error::Unexpected wrangler.toml in repository root. Refusing to overwrite it."
  exit 1
fi
sed -E "s/^name = .*/name = \"${project_name}\"/" wrangler-cf-pages.toml > wrangler.toml
cat >> wrangler.toml <<EOF

[[kv_namespaces]]
binding = "MISUB_KV"
id = "${kv_id}"
EOF

if [[ -n "$d1_id" ]]; then
  d1_name="${CLOUDFLARE_D1_DATABASE_NAME:-misub}"
  if [[ ! "$d1_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "::error::Invalid CLOUDFLARE_D1_DATABASE_NAME."
    exit 1
  fi
  cat >> wrangler.toml <<EOF

[[d1_databases]]
binding = "MISUB_DB"
database_name = "${d1_name}"
database_id = "${d1_id}"
EOF
fi

# Secrets are provisioned before the deployment that consumes them.
# Avoid printing secret values (do not enable shell tracing).
printf '%s' "$ADMIN_PASSWORD" | npx wrangler pages secret put ADMIN_PASSWORD --project-name="$project_name"
if [[ -n "${COOKIE_SECRET:-}" ]]; then
  printf '%s' "$COOKIE_SECRET" | npx wrangler pages secret put COOKIE_SECRET --project-name="$project_name"
fi

npx wrangler pages deploy dist \
  --project-name="$project_name" \
  --branch=main \
  --commit-hash="${GITHUB_SHA:?}" \
  --config=wrangler.toml

echo "Cloudflare Pages production deployment submitted: https://${project_name}.pages.dev"
