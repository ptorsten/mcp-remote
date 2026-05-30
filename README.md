# `mcp-remote`

Connect an MCP Client that only supports local (stdio) servers to a Remote MCP Server, with auth support:

**Note: this is a working proof-of-concept** but should be considered **experimental**.

## Why is this necessary?

So far, the majority of MCP servers in the wild are installed locally, using the stdio transport. This has some benefits: both the client and the server can implicitly trust each other as the user has granted them both permission to run. Adding secrets like API keys can be done using environment variables and never leave your machine. And building on `npx` and `uvx` has allowed users to avoid explicit install steps, too.

But there's a reason most software that _could_ be moved to the web _did_ get moved to the web: it's so much easier to find and fix bugs & iterate on new features when you can push updates to all your users with a single deploy.

With the latest MCP [Authorization specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization), we now have a secure way of sharing our MCP servers with the world _without_ running code on user's laptops. Or at least, you would, if all the popular MCP _clients_ supported it yet. Most are stdio-only, and those that _do_ support HTTP+SSE don't yet support the OAuth flows required.

That's where `mcp-remote` comes in. As soon as your chosen MCP client supports remote, authorized servers, you can remove it. Until that time, drop in this one liner and dress for the MCP clients you want!

## Usage

All the most popular MCP clients (Claude Desktop, Cursor & Windsurf) use the following config format:

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ]
    }
  }
}
```

### Custom Headers

To bypass authentication, or to emit custom headers on all requests to your remote server, pass `--header` CLI arguments:

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "--header",
        "Authorization: Bearer ${AUTH_TOKEN}"
      ],
      "env": {
        "AUTH_TOKEN": "..."
      }
    },
  }
}
```

**Note:** Cursor and Claude Desktop (Windows) have a bug where spaces inside `args` aren't escaped when it invokes `npx`, which ends up mangling these values. You can work around it using:

```jsonc
{
  // rest of config...
  "args": [
    "mcp-remote",
    "https://remote.mcp.server/sse",
    "--header",
    "Authorization:${AUTH_HEADER}" // note no spaces around ':'
  ],
  "env": {
    "AUTH_HEADER": "Bearer <auth-token>" // spaces OK in env vars
  }
},
```

### Multiple Instances

To run multiple instances of the same remote server with different configurations (e.g., different Atlassian tenants), use the `--resource` flag to isolate OAuth sessions:

```json
{
  "mcpServers": {
    "atlassian_tenant1": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.atlassian.com/v1/sse",
        "--resource",
        "https://tenant1.atlassian.net/"
      ]
    },
    "atlassian_tenant2": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.atlassian.com/v1/sse",
        "--resource",
        "https://tenant2.atlassian.net/"
      ]
    }
  }
}
```

Each unique combination of server URL, resource, and custom headers will maintain separate OAuth sessions and token storage.

### Flags

* If `npx` is producing errors, consider adding `-y` as the first argument to auto-accept the installation of the `mcp-remote` package.

```json
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ]
```

* To force `npx` to always check for an updated version of `mcp-remote`, add the `@latest` flag:

```json
      "args": [
        "mcp-remote@latest",
        "https://remote.mcp.server/sse"
      ]
```

* To change which port `mcp-remote` listens for an OAuth redirect (by default `3334`), add an additional argument after the server URL. Note that whatever port you specify, if it is unavailable an open port will be chosen at random.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "9696"
      ]
```

* To change which host `mcp-remote` registers as the OAuth callback URL (by default `localhost`), add the `--host` flag.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "--host",
        "127.0.0.1"
      ]
```

* To run `mcp-remote` behind a reverse proxy, you may need the OAuth redirect URI to advertise a different port than the one the local server actually listens on. Use `--callback-port` to set the port that appears in the registered redirect URI; it defaults to the listen port (the positional port argument).

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "3334",
        "--host",
        "my-domain.com",
        "--callback-port",
        "443"
      ]
```

  In this example `mcp-remote` listens on `127.0.0.1:3334`, while the redirect URI registered with the authorization server is `http://my-domain.com:443/oauth/callback`. Configure your reverse proxy to forward requests for that URL to `127.0.0.1:3334`.

* To prepend a path prefix to the OAuth callback (so it can sit behind a reverse proxy that routes by path), pass `--callback-path-prefix`. The prefix is applied to *both* the local listener path and the registered redirect URI, so configure your reverse proxy to forward the prefix as-is (no stripping).

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "--callback-path-prefix",
        "/mcp"
      ]
```

  This makes the local listener serve `/mcp/oauth/callback` and registers the redirect URI as `http://localhost:<callback-port>/mcp/oauth/callback`.

* If the reverse proxy terminates TLS, set `--callback-scheme https` so the registered redirect URI uses `https://`. Combined with `--host`, `--callback-port`, and `--callback-path-prefix`, this lets the OAuth flow round-trip through your HTTPS-terminating proxy. Default ports (443 for https, 80 for http) are omitted from the URL so it matches what most authorization servers canonicalize to.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "3334",
        "--host",
        "my-domain.com",
        "--callback-port",
        "443",
        "--callback-scheme",
        "https"
      ]
```

  Registers `https://my-domain.com/oauth/callback` as the redirect URI while the local listener runs on `127.0.0.1:3334`.

* To set up the reverse proxy on demand (and tear it down once auth is done), use `--pre-listen-hook` and `--post-auth-hook`. The pre-listen hook runs synchronously just before the local OAuth callback listener binds; the post-auth hook fires after the OAuth code is received at the callback. Both are best-effort — failures are logged but do not abort the flow.

  Each hook is invoked as a shell command with the following environment variables set:

  | Variable                           | Meaning                                                         |
  | ---------------------------------- | --------------------------------------------------------------- |
  | `MCP_REMOTE_HOOK_PHASE`            | `pre-listen` or `post-auth`                                     |
  | `MCP_REMOTE_LISTEN_PORT`           | Local port the OAuth listener binds to                          |
  | `MCP_REMOTE_CALLBACK_PORT`         | Port advertised in the redirect URI (see `--callback-port`)     |
  | `MCP_REMOTE_CALLBACK_HOST`         | Hostname advertised in the redirect URI (see `--host`)          |
  | `MCP_REMOTE_CALLBACK_SCHEME`       | `http` or `https` (see `--callback-scheme`)                     |
  | `MCP_REMOTE_CALLBACK_PATH`         | Callback path, e.g. `/oauth/callback`                           |
  | `MCP_REMOTE_CALLBACK_REDIRECT_URI` | Full redirect URI                                               |

  Hooks only fire on the primary mcp-remote instance — when a second instance attaches to an in-progress auth flow via lockfile coordination, it reuses the primary's setup and does not invoke any hooks.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "3334",
        "--host",
        "my-domain.com",
        "--callback-port",
        "443",
        "--callback-scheme",
        "https",
        "--pre-listen-hook",
        "/abs/path/to/examples/caddy-callback-proxy-hook.sh add",
        "--post-auth-hook",
        "/abs/path/to/examples/caddy-callback-proxy-hook.sh remove"
      ]
```

  **In-process re-auth.** If the remote MCP server reports `401 Unauthorized` mid-session (e.g. the access token expired and refresh failed), `mcp-remote` does not exit. It closes the dead transport, resets the OAuth coordinator, drops stored tokens, and runs the OAuth flow again — which re-fires `--pre-listen-hook` and `--post-auth-hook` and registers a fresh callback listener. The new remote transport is swapped into the proxy without closing the stdio pipe, so your MCP client stays connected. In-flight requests on the dead transport are lost; the client is expected to retry them on its own.

  Two example scripts ship with the repository:

  - [`examples/nginx-callback-proxy-hook.sh`](examples/nginx-callback-proxy-hook.sh) — writes an nginx `location` snippet into an included directory and reloads nginx.
  - [`examples/caddy-callback-proxy-hook.sh`](examples/caddy-callback-proxy-hook.sh) — registers and deregisters a Caddy reverse-proxy route via Caddy's admin API (no daemon reload required).

  Both register a transient reverse-proxy rule that forwards the OAuth callback path to mcp-remote's local listener for the duration of a single auth flow. If your refresh token later expires, run mcp-remote again to re-trigger the hooks — or omit `--post-auth-hook` and leave the rule in place permanently.

* To allow HTTP connections in trusted private networks, add the `--allow-http` flag. Note: This should only be used in secure private networks where traffic cannot be intercepted.

```json
      "args": [
        "mcp-remote",
        "http://internal-service.vpc/sse",
        "--allow-http"
      ]
```

* To enable detailed debugging logs, add the `--debug` flag. This will write verbose logs to `~/.mcp-auth/{server_hash}_debug.log` with timestamps and detailed information about the auth process, connections, and token refreshing.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "--debug"
      ]
```

* To suppress default logs, add the `--silent` flag. This will prevent logs from being emitted, except in the case where `--debug` is also passed.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "--silent"
      ]
```

* To enable an outbound HTTP(S) proxy for mcp-remote, add the `--enable-proxy` flag. When enabled, mcp-remote will use the proxy settings from common environment variables (for example `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`).

```json
    "args": [
      "mcp-remote",
      "https://remote.mcp.server/sse",
      "--enable-proxy"
    ],
    "env": {
      "HTTPS_PROXY": "http://127.0.0.1:3128",
      "NO_PROXY": "localhost,127.0.0.1"
    }
```

* To ignore specific tools from the remote server, add the `--ignore-tool` flag. This will filter out tools matching the specified patterns from both `tools/list` responses and block `tools/call` requests. Supports wildcard patterns with `*`.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "--ignore-tool",
        "delete*",
        "--ignore-tool",
        "remove*"
      ]
```

You can specify multiple `--ignore-tool` flags to ignore different patterns. Examples:
- `delete*` - ignores all tools starting with "delete" (e.g., `deleteTask`, `deleteUser`)
- `*account` - ignores all tools ending with "account" (e.g., `getAccount`, `updateAccount`)
- `exactTool` - ignores only the tool named exactly "exactTool"

* To change the timeout for the OAuth callback (by default `30` seconds), add the `--auth-timeout` flag with a value in seconds. This is useful if the authentication process on the server side takes a long time.

```json
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse",
        "--auth-timeout",
        "60"
      ]
```

### Transport Strategies

MCP Remote supports different transport strategies when connecting to an MCP server. This allows you to control whether it uses Server-Sent Events (SSE) or HTTP transport, and in what order it tries them.

Specify the transport strategy with the `--transport` flag:

```bash
npx mcp-remote https://example.remote/server --transport sse-only
```

**Available Strategies:**

- `http-first` (default): Tries HTTP transport first, falls back to SSE if HTTP fails with a 404 error
- `sse-first`: Tries SSE transport first, falls back to HTTP if SSE fails with a 405 error
- `http-only`: Only uses HTTP transport, fails if the server doesn't support it
- `sse-only`: Only uses SSE transport, fails if the server doesn't support it

### Static OAuth Client Metadata

MCP Remote supports providing static OAuth client metadata instead of using the mcp-remote defaults.
This is useful when connecting to OAuth servers that expect specific client/software IDs or scopes.

Provide the client metadata as a JSON string or as a `@` prefixed filepath with the `--static-oauth-client-metadata` flag:

```bash
npx mcp-remote https://example.remote/server --static-oauth-client-metadata '{ "scope": "space separated scopes" }'
# uses node readfile, so you probably want to use absolute paths if you're not sure what the cwd is
npx mcp-remote https://example.remote/server --static-oauth-client-metadata '@/Users/username/Library/Application Support/Claude/oauth_client_metadata.json'
```

### Static OAuth Client Information

Per the [spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#2-4-dynamic-client-registration),
servers are encouraged but not required to support [OAuth dynamic client registration](https://datatracker.ietf.org/doc/html/rfc7591).

For these servers, MCP Remote supports providing static OAuth client information instead.
This is useful when connecting to OAuth servers that require pre-registered clients.

Provide the client metadata as a JSON string or as a `@` prefixed filepath with the `--static-oauth-client-info` flag:

```bash
export MCP_REMOTE_CLIENT_ID=xxx
export MCP_REMOTE_CLIENT_SECRET=yyy
npx mcp-remote https://example.remote/server --static-oauth-client-info "{ \"client_id\": \"$MCP_REMOTE_CLIENT_ID\", \"client_secret\": \"$MCP_REMOTE_CLIENT_SECRET\" }"
# uses node readfile, so you probably want to use absolute paths if you're not sure what the cwd is
npx mcp-remote https://example.remote/server --static-oauth-client-info '@/Users/username/Library/Application Support/Claude/oauth_client_info.json'
```

### Claude Desktop

[Official Docs](https://modelcontextprotocol.io/quickstart/user)

In order to add an MCP server to Claude Desktop you need to edit the configuration file located at:

* macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
* Windows: `%APPDATA%\Claude\claude_desktop_config.json`

If it does not exist yet, [you may need to enable it under Settings > Developer](https://modelcontextprotocol.io/quickstart/user#2-add-the-filesystem-mcp-server).

Restart Claude Desktop to pick up the changes in the configuration file.
Upon restarting, you should see a hammer icon in the bottom right corner
of the input box.

### Cursor

[Official Docs](https://docs.cursor.com/context/model-context-protocol). The configuration file is located at `~/.cursor/mcp.json`.

As of version `0.48.0`, Cursor supports unauthed SSE servers directly. If your MCP server is using the official MCP OAuth authorization protocol, you still need to add a **"command"** server and call `mcp-remote`.

### Windsurf

[Official Docs](https://docs.codeium.com/windsurf/mcp). The configuration file is located at `~/.codeium/windsurf/mcp_config.json`.

## Building Remote MCP Servers

For instructions on building & deploying remote MCP servers, including acting as a valid OAuth client, see the following resources:

* https://developers.cloudflare.com/agents/guides/remote-mcp-server/

In particular, see:

* https://github.com/cloudflare/workers-oauth-provider for defining an MCP-comlpiant OAuth server in Cloudflare Workers
* https://github.com/cloudflare/agents/tree/main/examples/mcp for defining an `McpAgent` using the [`agents`](https://npmjs.com/package/agents) framework.

For more information about testing these servers, see also:

* https://developers.cloudflare.com/agents/guides/test-remote-mcp-server/

Know of more resources you'd like to share? Please add them to this Readme and send a PR!

## Troubleshooting

### Clear your `~/.mcp-auth` directory

`mcp-remote` stores all the credential information inside `~/.mcp-auth` (or wherever your `MCP_REMOTE_CONFIG_DIR` points to). If you're having persistent issues, try running:

```sh
rm -rf ~/.mcp-auth
```

Then restarting your MCP client.

### Check your Node version

Make sure that the version of Node you have installed is [18 or
higher](https://modelcontextprotocol.io/quickstart/server). Claude
Desktop will use your system version of Node, even if you have a newer
version installed elsewhere.

### Restart Claude

When modifying `claude_desktop_config.json` it can helpful to completely restart Claude

### VPN Certs

You may run into issues if you are behind a VPN, you can try setting the `NODE_EXTRA_CA_CERTS`
environment variable to point to the CA certificate file. If using `claude_desktop_config.json`,
this might look like:

```json
{
 "mcpServers": {
    "remote-example": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ],
      "env": {
        "NODE_EXTRA_CA_CERTS": "{your CA certificate file path}.pem"
      }
    }
  }
}
```

### Check the logs

* [Follow Claude Desktop logs in real-time](https://modelcontextprotocol.io/docs/tools/debugging#debugging-in-claude-desktop)
* MacOS / Linux:<br/>`tail -n 20 -F ~/Library/Logs/Claude/mcp*.log`
* For bash on WSL:<br/>`tail -n 20 -f "C:\Users\YourUsername\AppData\Local\Claude\Logs\mcp.log"`
* Powershell: <br/>`Get-Content "C:\Users\YourUsername\AppData\Local\Claude\Logs\mcp.log" -Wait -Tail 20`

## Debugging

### Debug Logs

For troubleshooting complex issues, especially with token refreshing or authentication problems, use the `--debug` flag:

```json
"args": [
  "mcp-remote",
  "https://remote.mcp.server/sse",
  "--debug"
]
```

This creates detailed logs in `~/.mcp-auth/{server_hash}_debug.log` with timestamps and complete information about every step of the connection and authentication process. When you find issues with token refreshing, laptop sleep/resume issues, or auth problems, provide these logs when seeking support.

### Authentication Errors

If you encounter the following error, returned by the `/callback` URL:

```
Authentication Error
Token exchange failed: HTTP 400
```

You can run `rm -rf ~/.mcp-auth` to clear any locally stored state and tokens.

### "Client" mode

Run the following on the command line (not from an MCP server):

```shell
npx -p mcp-remote@latest mcp-remote-client https://remote.mcp.server/sse
```

This will run through the entire authorization flow and attempt to list the tools & resources at the remote URL. Try this after running `rm -rf ~/.mcp-auth` to see if stale credentials are your problem, otherwise hopefully the issue will be more obvious in these logs than those in your MCP client.
