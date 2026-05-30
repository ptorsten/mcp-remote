#!/usr/bin/env bash
#
# caddy-callback-proxy-hook.sh
#
# Example helper for mcp-remote's --pre-listen-hook / --post-auth-hook.
#
# Uses Caddy's admin API (https://caddyserver.com/docs/api) to insert (and
# later delete) a reverse-proxy route that forwards the OAuth callback URL to
# mcp-remote's local listener for the duration of a single authorization flow.
#
# Compared to the nginx variant, this script needs no file writes, no daemon
# reload, and no sudo — it just talks to Caddy's local admin socket.
#
# ─── Setup ───────────────────────────────────────────────────────────────────
#
# Caddy must be running with its admin API enabled (the default — listens on
# http://localhost:2019). Your Caddy config must already terminate TLS for the
# hostname you pass as --host and have at least one HTTP server defined.
#
# If CADDY_SERVER is not set, the script auto-discovers the server by matching
# MCP_REMOTE_CALLBACK_PORT against each server's listen addresses (e.g. a server
# listening on ":443" will be picked when --callback-port 443 is in use). Set
# CADDY_SERVER=<name> to override. List servers manually with:
#
#     curl -s http://localhost:2019/config/apps/http/servers | jq 'keys'
#
# `jq` must be installed — the script reads the existing routes array, prepends
# the OAuth-callback route to it (so it wins against any catch-alls), and PUTs
# the merged array back as one atomic update.
#
# ─── Usage in your MCP client config ─────────────────────────────────────────
#
#     "args": [
#       "mcp-remote",
#       "https://remote.mcp.server/sse",
#       "3334",
#       "--host", "my-domain.com",
#       "--callback-port", "443",
#       "--callback-scheme", "https",
#       "--pre-listen-hook", "/abs/path/to/caddy-callback-proxy-hook.sh add",
#       "--post-auth-hook",  "/abs/path/to/caddy-callback-proxy-hook.sh remove"
#     ]
#
# ─── Environment provided by mcp-remote ──────────────────────────────────────
#
#   MCP_REMOTE_HOOK_PHASE             "pre-listen" or "post-auth"
#   MCP_REMOTE_LISTEN_PORT            local port the listener binds to
#   MCP_REMOTE_CALLBACK_PORT          port advertised in the redirect URI
#   MCP_REMOTE_CALLBACK_HOST          hostname advertised in the redirect URI
#   MCP_REMOTE_CALLBACK_SCHEME        http or https
#   MCP_REMOTE_CALLBACK_PATH          callback path (e.g. /mcp/oauth/callback)
#   MCP_REMOTE_CALLBACK_REDIRECT_URI  full redirect URI
#
# ─── Overridable env ─────────────────────────────────────────────────────────
#
#   CADDY_ADMIN   Caddy admin API base URL (default http://localhost:2019)
#   CADDY_SERVER  Name of the HTTP server in Caddy's config. If unset, the script
#                 auto-picks the server whose listen address ends with the callback
#                 port. Override if auto-detection picks the wrong one.
#   ROUTE_ID      @id tag used for the transient route (default mcp-remote-oauth-callback)
#   DEBUG         Set to 1/true/yes/on to log every step (env, payload, HTTP call,
#                 response) to stderr. Defaults to OFF. mcp-remote forwards hook
#                 stderr to its own logs.

set -euo pipefail

ACTION="${1:-}"
CADDY_ADMIN="${CADDY_ADMIN:-http://localhost:2019}"
CADDY_SERVER="${CADDY_SERVER:-}"
ROUTE_ID="${ROUTE_ID:-mcp-remote-oauth-callback}"

debug_enabled() {
  case "${DEBUG:-}" in
    1 | true | TRUE | yes | YES | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

debug() {
  debug_enabled && printf '[caddy-hook][debug] %s\n' "$*" >&2 || true
}

debug_kv() {
  debug_enabled && printf '[caddy-hook][debug] %s=%s\n' "$1" "${2:-<unset>}" >&2 || true
}

# Dump every MCP_REMOTE_* env var, plus the Caddy config knobs, on every run
# when DEBUG is enabled. Done up front so failures further down still have the
# trail of breadcrumbs to look at.
if debug_enabled; then
  debug "action=${ACTION:-<missing>}"
  debug_kv CADDY_ADMIN "$CADDY_ADMIN"
  debug_kv CADDY_SERVER "${CADDY_SERVER:-<auto-discover>}"
  debug_kv ROUTE_ID "$ROUTE_ID"
  while IFS='=' read -r k v; do
    [[ "$k" == MCP_REMOTE_* ]] && debug_kv "$k" "$v"
  done < <(env)
fi

list_caddy_servers() {
  # Pretty-prints all servers and their listen addresses on stderr. Used when
  # auto-discovery fails so the user can pick the right one.
  curl -fsS "${CADDY_ADMIN}/config/apps/http/servers" |
    jq -r 'to_entries[] | "  \(.key)\tlisten=\(.value.listen // [] | tojson)"' >&2 || true
}

resolve_caddy_server() {
  # Sets CADDY_SERVER to a valid server name. If CADDY_SERVER is already set, we
  # just verify it exists. Otherwise we pick the server whose listen contains a
  # port matching MCP_REMOTE_CALLBACK_PORT (e.g. ":443" when --callback-port 443).
  local servers_json
  if ! servers_json=$(curl -fsS "${CADDY_ADMIN}/config/apps/http/servers"); then
    echo "Failed to reach Caddy admin at ${CADDY_ADMIN}" >&2
    exit 1
  fi

  if [[ -n "$CADDY_SERVER" ]]; then
    if printf '%s' "$servers_json" | jq -e --arg name "$CADDY_SERVER" 'has($name)' >/dev/null; then
      debug "using user-specified CADDY_SERVER=${CADDY_SERVER}"
      return 0
    fi
    echo "Caddy has no server named '${CADDY_SERVER}'. Available servers:" >&2
    list_caddy_servers
    echo "Set CADDY_SERVER=<name> in your hook command's environment." >&2
    exit 1
  fi

  local port="${MCP_REMOTE_CALLBACK_PORT:-}"
  if [[ -z "$port" ]]; then
    echo "CADDY_SERVER not set and MCP_REMOTE_CALLBACK_PORT missing — cannot auto-discover." >&2
    list_caddy_servers
    exit 1
  fi

  # Pick servers whose `listen` contains ":<port>" followed by end-of-string or
  # a slash. Matches ":443", "127.0.0.1:443", and ":443/path"; ignores "8443".
  local candidates
  candidates=$(printf '%s' "$servers_json" | jq -r --arg port "$port" '
    to_entries[]
    | select((.value.listen // []) | any(test(":" + $port + "(/|$)")))
    | .key
  ')
  local count
  count=$(printf '%s\n' "$candidates" | grep -cv '^$' || true)

  case "$count" in
    1)
      CADDY_SERVER="$candidates"
      debug "auto-discovered CADDY_SERVER=${CADDY_SERVER} (listens on :${port})"
      ;;
    0)
      echo "No Caddy server listens on :${port}. Available servers:" >&2
      list_caddy_servers
      echo "Set CADDY_SERVER=<name> to override auto-discovery." >&2
      exit 1
      ;;
    *)
      echo "Multiple Caddy servers listen on :${port}:" >&2
      printf '  %s\n' $candidates >&2
      echo "Set CADDY_SERVER=<name> to disambiguate." >&2
      exit 1
      ;;
  esac
}

case "$ACTION" in
  add)
    : "${MCP_REMOTE_LISTEN_PORT:?must be set by mcp-remote}"
    : "${MCP_REMOTE_CALLBACK_PATH:?must be set by mcp-remote}"
    : "${MCP_REMOTE_CALLBACK_HOST:?must be set by mcp-remote}"

    if ! command -v jq >/dev/null 2>&1; then
      echo "Error: this script needs 'jq' to merge routes into Caddy's config." >&2
      exit 1
    fi

    resolve_caddy_server

    # Build our route. @id lets us delete it cleanly via /id/<id> later.
    payload=$(cat <<EOF
{
  "@id": "${ROUTE_ID}",
  "match": [{
    "host": ["${MCP_REMOTE_CALLBACK_HOST}"],
    "path": ["${MCP_REMOTE_CALLBACK_PATH}"]
  }],
  "handle": [{
    "handler": "reverse_proxy",
    "upstreams": [{"dial": "127.0.0.1:${MCP_REMOTE_LISTEN_PORT}"}]
  }]
}
EOF
)
    debug "route payload:"
    debug_enabled && printf '%s\n' "$payload" >&2

    # Fetch the server's current routes. Caddy returns `null` when the field
    # doesn't exist; we treat that as an empty array. Anything other than 200
    # (e.g. server name doesn't exist) is fatal.
    routes_url="${CADDY_ADMIN}/config/apps/http/servers/${CADDY_SERVER}/routes"
    debug "GET ${routes_url}"

    get_body_file=$(mktemp)
    trap 'rm -f "$get_body_file"' EXIT
    get_status=$(curl -sS -o "$get_body_file" -w '%{http_code}' "${routes_url}" || echo 'curl-error')
    debug "GET response status: ${get_status}"
    if [[ -s "$get_body_file" ]]; then
      debug "GET response body:"
      debug_enabled && cat "$get_body_file" >&2 || true
    fi

    case "$get_status" in
      200) ;;
      curl-error)
        echo "Failed to reach Caddy admin at ${CADDY_ADMIN}" >&2
        exit 1
        ;;
      *)
        echo "Cannot read routes for Caddy server '${CADDY_SERVER}' (HTTP ${get_status})." >&2
        cat "$get_body_file" >&2 || true
        exit 1
        ;;
    esac

    current_routes=$(cat "$get_body_file")
    [[ -z "$current_routes" ]] && current_routes='null'

    # Drop any prior route with our @id (left over from a previous run that
    # didn't get to run --post-auth-hook), then prepend the new one.
    new_routes=$(printf '%s' "$current_routes" | jq -c --argjson new "$payload" '
      (if type == "array" then . else [] end)
      | map(select(."@id" != $new["@id"]))
      | [$new] + .
    ')
    debug "new routes array (${#new_routes} bytes):"
    debug_enabled && printf '%s\n' "$new_routes" >&2

    # PATCH replaces an existing value at the path. POST would *append* (since
    # routes is an array) and try to deserialize our array as a single Route,
    # which Caddy rejects.
    patch_body_file=$(mktemp)
    trap 'rm -f "$get_body_file" "$patch_body_file"' EXIT
    patch_status=$(curl -sS -o "$patch_body_file" -w '%{http_code}' \
      -X PATCH \
      -H "Content-Type: application/json" \
      --data "${new_routes}" \
      "${routes_url}" || echo 'curl-error')
    debug "PATCH response status: ${patch_status}"
    if [[ -s "$patch_body_file" ]]; then
      debug "PATCH response body:"
      debug_enabled && cat "$patch_body_file" >&2 || true
    fi

    case "$patch_status" in
      2*) ;;
      curl-error)
        echo "Failed to reach Caddy admin at ${CADDY_ADMIN}" >&2
        exit 1
        ;;
      *)
        echo "Caddy returned HTTP ${patch_status} when writing routes" >&2
        cat "$patch_body_file" >&2 || true
        exit 1
        ;;
    esac

    echo "Added Caddy route ${ROUTE_ID}: ${MCP_REMOTE_CALLBACK_HOST}${MCP_REMOTE_CALLBACK_PATH} -> 127.0.0.1:${MCP_REMOTE_LISTEN_PORT}"
    ;;

  remove)
    target_url="${CADDY_ADMIN}/id/${ROUTE_ID}"
    debug "DELETE ${target_url}"

    response_file=$(mktemp)
    trap 'rm -f "$response_file"' EXIT
    status=$(curl -sS -o "$response_file" -w '%{http_code}' -X DELETE "${target_url}" || echo 'curl-error')
    debug "DELETE response status: ${status}"
    if [[ -s "$response_file" ]]; then
      debug "DELETE response body:"
      debug_enabled && cat "$response_file" >&2 || true
    fi

    # Idempotent: a 404 (no such route) is fine; anything else is a real error.
    case "$status" in
      200)        echo "Removed Caddy route ${ROUTE_ID}" ;;
      404)        echo "Caddy route ${ROUTE_ID} was not registered (nothing to remove)" ;;
      curl-error) echo "Failed to reach Caddy admin at ${CADDY_ADMIN}" >&2; exit 1 ;;
      *)          echo "Caddy returned HTTP ${status} when removing ${ROUTE_ID}" >&2; exit 1 ;;
    esac
    ;;

  *)
    echo "Usage: $0 {add|remove}" >&2
    echo "(mcp-remote calls 'add' as --pre-listen-hook and 'remove' as --post-auth-hook)" >&2
    exit 1
    ;;
esac
