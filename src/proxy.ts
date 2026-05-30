#!/usr/bin/env node

/**
 * MCP Proxy with OAuth support
 * A bidirectional proxy between a local STDIO MCP server and a remote SSE server with OAuth authentication.
 *
 * Run with: npx tsx proxy.ts https://example.remote/server [callback-port]
 *
 * If callback-port is not specified, an available port will be automatically selected.
 */

import { EventEmitter } from 'events'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  connectToRemoteServer,
  log,
  debugLog,
  mcpProxy,
  parseCommandLineArgs,
  setupSignalHandlers,
  TransportStrategy,
  discoverOAuthServerInfo,
} from './lib/utils'
import { StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './lib/types'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { createLazyAuthCoordinator } from './lib/coordination'

/**
 * Main function to run the proxy
 */
async function runProxy(
  serverUrl: string,
  port: number,
  callbackPort: number,
  callbackPath: string,
  callbackScheme: 'http' | 'https',
  headers: Record<string, string>,
  transportStrategy: TransportStrategy = 'http-first',
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authorizeResource: string,
  ignoredTools: string[],
  authTimeoutMs: number,
  serverUrlHash: string,
  preListenHook: string | undefined,
  postAuthHook: string | undefined,
) {
  // Set up event emitter for auth flow
  const events = new EventEmitter()

  // Create a lazy auth coordinator
  const authCoordinator = createLazyAuthCoordinator(serverUrlHash, port, events, authTimeoutMs, callbackPath, {
    preListenHook,
    postAuthHook,
    env: { listenPort: port, callbackPort, host, scheme: callbackScheme, callbackPath },
  })

  // Discover OAuth server info via Protected Resource Metadata (RFC 9728)
  // This probes the MCP server for WWW-Authenticate header and fetches PRM
  log('Discovering OAuth server configuration...')
  const discoveryResult = await discoverOAuthServerInfo(serverUrl, headers)

  if (discoveryResult.protectedResourceMetadata) {
    log(`Discovered authorization server: ${discoveryResult.authorizationServerUrl}`)
    if (discoveryResult.protectedResourceMetadata.scopes_supported) {
      debugLog('Protected Resource Metadata scopes', {
        scopes_supported: discoveryResult.protectedResourceMetadata.scopes_supported,
      })
    }
  } else {
    debugLog('No Protected Resource Metadata found, using server URL as authorization server')
  }

  // Create the OAuth client provider with discovered server info
  const authProvider = new NodeOAuthClientProvider({
    serverUrl: discoveryResult.authorizationServerUrl,
    callbackPort,
    callbackPath,
    callbackScheme,
    host,
    clientName: 'MCP CLI Proxy',
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    serverUrlHash,
    authorizationServerMetadata: discoveryResult.authorizationServerMetadata,
    protectedResourceMetadata: discoveryResult.protectedResourceMetadata,
    wwwAuthenticateScope: discoveryResult.wwwAuthenticateScope,
  })

  // Create the STDIO transport for local connections
  const localTransport = new StdioServerTransport()

  // Keep track of the server instance for cleanup
  let server: any = null

  // Define an auth initializer function
  const authInitializer = async () => {
    const authState = await authCoordinator.initializeAuth()

    // Store server in outer scope for cleanup
    server = authState.server

    // If auth was completed by another instance, just log that we'll use the auth from disk
    if (authState.skipBrowserAuth) {
      log('Authentication was completed by another instance - will use tokens from disk')
      // TODO: remove, the callback is happening before the tokens are exchanged
      //  so we're slightly too early
      await new Promise((res) => setTimeout(res, 1_000))
    }

    return {
      waitForAuthCode: authState.waitForAuthCode,
      skipBrowserAuth: authState.skipBrowserAuth,
    }
  }

  try {
    // Connect to remote server with lazy authentication
    let currentRemoteTransport = await connectToRemoteServer(null, serverUrl, authProvider, headers, authInitializer, transportStrategy)

    // Mid-session re-auth: if the remote transport reports a 401 / Unauthorized,
    // tear it down, reset the auth coordinator (so --pre-listen-hook re-fires
    // and a fresh `once` listener is registered for --post-auth-hook), drop the
    // stored tokens, and reconnect via the same connectToRemoteServer code path
    // that handled initial auth. The new transport is swapped into the proxy
    // without closing the local stdio pipe.
    const handleAuthError = async (error: Error): Promise<void> => {
      log('Mid-session auth error detected; attempting re-auth')
      debugLog('Mid-session auth error', { message: error.message, stack: error.stack })

      const dead = currentRemoteTransport
      // Detach handlers synchronously so the in-flight close from the dead
      // transport doesn't reach mcpProxy and trip the recovery flag twice.
      dead.onclose = undefined
      dead.onerror = undefined
      dead.onmessage = undefined
      await dead.close().catch(() => {})

      try {
        // Reset the coordinator (close listener, clear lockfile) so any full
        // OAuth flow that *does* need to happen gets a fresh listener + a new
        // post-auth `once` listener. Do NOT invalidate stored tokens — the SDK
        // will try a silent refresh-token exchange on the new transport.start()
        // and only fall through to the browser-based OAuth flow if refresh
        // fails. That path then re-enters our coordinator via authInitializer
        // and re-fires --pre-listen-hook + --post-auth-hook as expected.
        await authCoordinator.resetForReAuth()

        currentRemoteTransport = await connectToRemoteServer(null, serverUrl, authProvider, headers, authInitializer, transportStrategy)

        // Re-wire the proxy on top of the existing local transport. The fresh
        // call also re-arms onAuthError for the next failure.
        mcpProxy({
          transportToClient: localTransport,
          transportToServer: currentRemoteTransport,
          ignoredTools,
          onAuthError: handleAuthError,
        })

        log(`Re-auth complete; proxy resumed using ${currentRemoteTransport.constructor.name}`)
      } catch (reAuthError) {
        log('Re-auth failed; closing connection:', reAuthError)
        debugLog('Re-auth error', reAuthError)
        try {
          await localTransport.close()
        } catch {
          // best-effort cleanup
        }
        process.exit(1)
      }
    }

    // Set up bidirectional proxy between local and remote transports
    mcpProxy({
      transportToClient: localTransport,
      transportToServer: currentRemoteTransport,
      ignoredTools,
      onAuthError: handleAuthError,
    })

    // Start the local STDIO server
    await localTransport.start()
    log('Local STDIO server running')
    log(`Proxy established successfully between local STDIO and remote ${currentRemoteTransport.constructor.name}`)
    log('Press Ctrl+C to exit')

    // Setup cleanup handler
    const cleanup = async () => {
      await currentRemoteTransport.close()
      await localTransport.close()
      // Only close the server if it was initialized
      if (server) {
        server.close()
      }
    }
    setupSignalHandlers(cleanup)
  } catch (error) {
    log('Fatal error:', error)
    if (error instanceof Error && error.message.includes('self-signed certificate in certificate chain')) {
      log(`You may be behind a VPN!

If you are behind a VPN, you can try setting the NODE_EXTRA_CA_CERTS environment variable to point
to the CA certificate file. If using claude_desktop_config.json, this might look like:

{
  "mcpServers": {
    "\${mcpServerName}": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://remote.mcp.server/sse"
      ],
      "env": {
        "NODE_EXTRA_CA_CERTS": "\${your CA certificate file path}.pem"
      }
    }
  }
}
        `)
    }
    // Only close the server if it was initialized
    if (server) {
      server.close()
    }
    process.exit(1)
  }
}

// Parse command-line arguments and run the proxy
parseCommandLineArgs(process.argv.slice(2), 'Usage: npx tsx proxy.ts <https://server-url> [callback-port] [--debug]')
  .then(
    ({
      serverUrl,
      port,
      callbackPort,
      callbackPath,
      callbackScheme,
      headers,
      transportStrategy,
      host,
      debug,
      staticOAuthClientMetadata,
      staticOAuthClientInfo,
      authorizeResource,
      ignoredTools,
      authTimeoutMs,
      serverUrlHash,
      preListenHook,
      postAuthHook,
    }) => {
      return runProxy(
        serverUrl,
        port,
        callbackPort,
        callbackPath,
        callbackScheme,
        headers,
        transportStrategy,
        host,
        staticOAuthClientMetadata,
        staticOAuthClientInfo,
        authorizeResource,
        ignoredTools,
        authTimeoutMs,
        serverUrlHash,
        preListenHook,
        postAuthHook,
      )
    },
  )
  .catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })
