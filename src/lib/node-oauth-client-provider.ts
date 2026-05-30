import open from 'open'
import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  OAuthClientInformationFull,
  OAuthClientInformationFullSchema,
  OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthProviderOptions, StaticOAuthClientMetadata } from './types'
import { readJsonFile, readRawJsonFile, writeJsonFile, readTextFile, writeTextFile, deleteConfigFile } from './mcp-auth-config'
import { StaticOAuthClientInformationFull } from './types'
import { formatLifetime, log, debugLog, MCP_REMOTE_VERSION } from './utils'
import { sanitizeUrl } from 'strict-url-sanitise'
import { randomUUID } from 'node:crypto'
import { fetchAuthorizationServerMetadata, type AuthorizationServerMetadata } from './authorization-server-metadata'
import type { ProtectedResourceMetadata } from './protected-resource-metadata'

/**
 * Implements the OAuthClientProvider interface for Node.js environments.
 * Handles OAuth flow and token storage for MCP clients.
 */
export class NodeOAuthClientProvider implements OAuthClientProvider {
  private serverUrlHash: string
  private callbackPath: string
  private callbackScheme: 'http' | 'https'
  private clientName: string
  private clientUri: string
  private softwareId: string
  private softwareVersion: string
  private staticOAuthClientMetadata: StaticOAuthClientMetadata
  private staticOAuthClientInfo: StaticOAuthClientInformationFull
  private authorizeResource: string | undefined
  private _state: string
  private _clientInfo: OAuthClientInformationFull | undefined
  private authorizationServerMetadata: AuthorizationServerMetadata | undefined
  private protectedResourceMetadata: ProtectedResourceMetadata | undefined
  private wwwAuthenticateScope: string | undefined
  // Millis since epoch when the current tokens.json was last written. The MCP
  // SDK's OAuthTokens type doesn't carry this, so we persist it as a sibling
  // field in the JSON file and read it via readRawJsonFile to avoid the SDK's
  // strict-by-default schema stripping it.
  private _tokensIssuedAt: number | undefined

  /**
   * Creates a new NodeOAuthClientProvider
   * @param options Configuration options for the provider
   */
  constructor(readonly options: OAuthProviderOptions) {
    this.serverUrlHash = options.serverUrlHash
    this.callbackPath = options.callbackPath || '/oauth/callback'
    this.callbackScheme = options.callbackScheme || 'http'
    this.clientName = options.clientName || 'MCP CLI Client'
    this.clientUri = options.clientUri || 'https://github.com/modelcontextprotocol/mcp-cli'
    this.softwareId = options.softwareId || '2e6dc280-f3c3-4e01-99a7-8181dbd1d23d'
    this.softwareVersion = options.softwareVersion || MCP_REMOTE_VERSION
    this.staticOAuthClientMetadata = options.staticOAuthClientMetadata
    this.staticOAuthClientInfo = options.staticOAuthClientInfo
    this.authorizeResource = options.authorizeResource
    this._state = randomUUID()
    this._clientInfo = undefined
    this.authorizationServerMetadata = options.authorizationServerMetadata
    this.protectedResourceMetadata = options.protectedResourceMetadata
    this.wwwAuthenticateScope = options.wwwAuthenticateScope
  }

  get redirectUrl(): string {
    // Use URL to normalize away the default port (443 for https, 80 for http)
    // so the registered URI matches what OAuth servers typically canonicalize to.
    const url = new URL(`${this.callbackScheme}://${this.options.host}:${this.options.callbackPort}${this.callbackPath}`)
    return url.toString()
  }

  get clientMetadata() {
    const effectiveScope = this.getEffectiveScope()
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.clientName,
      client_uri: this.clientUri,
      software_id: this.softwareId,
      software_version: this.softwareVersion,
      ...this.staticOAuthClientMetadata,
      scope: effectiveScope,
    }
  }

  state(): string {
    return this._state
  }

  /**
   * Gets the authorization server metadata, fetching it if not already available
   * @returns The authorization server metadata, or undefined if unavailable
   */
  async getAuthorizationServerMetadata(): Promise<AuthorizationServerMetadata | undefined> {
    // Already have metadata? Return it
    debugLog(`authorizationServerMetadata: ${JSON.stringify(this.authorizationServerMetadata)}`)
    if (this.authorizationServerMetadata) {
      return this.authorizationServerMetadata
    }

    // Fetch metadata and cache in memory for this session
    try {
      this.authorizationServerMetadata = await fetchAuthorizationServerMetadata(this.options.serverUrl)
      if (this.authorizationServerMetadata?.scopes_supported) {
        debugLog('Authorization server supports scopes', {
          scopes_supported: this.authorizationServerMetadata.scopes_supported,
        })
      }
      return this.authorizationServerMetadata
    } catch (error) {
      debugLog('Failed to fetch authorization server metadata', error)
      return undefined
    }
  }

  private getEffectiveScope(): string {
    // Priority 1: User-provided scope from staticOAuthClientMetadata (highest priority)
    if (this.staticOAuthClientMetadata?.scope && this.staticOAuthClientMetadata.scope.trim().length > 0) {
      debugLog('Using scope from staticOAuthClientMetadata', { scope: this.staticOAuthClientMetadata.scope })
      return this.staticOAuthClientMetadata.scope
    }

    // Priority 2: Scope from WWW-Authenticate header (per MCP spec)
    if (this.wwwAuthenticateScope && this.wwwAuthenticateScope.trim().length > 0) {
      debugLog('Using scope from WWW-Authenticate header', { scope: this.wwwAuthenticateScope })
      return this.wwwAuthenticateScope
    }

    // Priority 3: Scopes from Protected Resource Metadata (RFC 9728)
    if (this.protectedResourceMetadata?.scopes_supported?.length) {
      const scope = this.protectedResourceMetadata.scopes_supported.join(' ')
      debugLog('Using scopes from Protected Resource Metadata', {
        scopes_supported: this.protectedResourceMetadata.scopes_supported,
        scope,
      })
      return scope
    }

    // Priority 4: Scope from client registration response
    if (this._clientInfo?.scope && this._clientInfo.scope.trim().length > 0) {
      debugLog('Using scope from client registration response', { scope: this._clientInfo.scope })
      return this._clientInfo.scope
    }

    // Priority 5: Use authorization server's supported scopes if available
    if (this.authorizationServerMetadata?.scopes_supported?.length) {
      const scope = this.authorizationServerMetadata.scopes_supported.join(' ')
      debugLog('Using scopes from Authorization Server Metadata', {
        scopes_supported: this.authorizationServerMetadata.scopes_supported,
        scope,
      })
      return scope
    }

    // Priority 6: Fallback to hardcoded default
    debugLog('Using fallback default scope')
    return 'openid email profile'
  }

  /**
   * Gets the client information if it exists
   * @returns The client information or undefined
   */
  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    debugLog('Reading client info')
    if (this.staticOAuthClientInfo) {
      debugLog('Returning static client info')
      this._clientInfo = this.staticOAuthClientInfo
      return this.staticOAuthClientInfo
    }
    const clientInfo = await readJsonFile<OAuthClientInformationFull>(
      this.serverUrlHash,
      'client_info.json',
      OAuthClientInformationFullSchema,
    )

    if (clientInfo) {
      this._clientInfo = clientInfo
    }

    debugLog('Client info result:', clientInfo ? 'Found' : 'Not found')
    return clientInfo
  }

  /**
   * Saves client information
   * @param clientInformation The client information to save
   */
  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    debugLog('Saving client info', { client_id: clientInformation.client_id })
    this._clientInfo = clientInformation
    await writeJsonFile(this.serverUrlHash, 'client_info.json', clientInformation)
  }

  /**
   * Gets the OAuth tokens if they exist
   * @returns The OAuth tokens or undefined
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    debugLog('Reading OAuth tokens')
    debugLog('Token request stack trace:', new Error().stack)

    // Read the JSON raw so we don't lose our sibling `issued_at` field to the
    // SDK schema's default strip behavior.
    const raw = (await readRawJsonFile(this.serverUrlHash, 'tokens.json')) as Record<string, unknown> | undefined
    if (!raw) {
      debugLog('Token result: Not found')
      this._tokensIssuedAt = undefined
      return undefined
    }

    this._tokensIssuedAt = typeof raw.issued_at === 'number' ? (raw.issued_at as number) : undefined

    let tokens: OAuthTokens
    try {
      tokens = await OAuthTokensSchema.parseAsync(raw)
    } catch (error) {
      debugLog('Token schema validation failed', error)
      return undefined
    }

    const timeLeft = tokens.expires_in || 0
    if (typeof tokens.expires_in !== 'number' || tokens.expires_in < 0) {
      debugLog('⚠️ WARNING: Invalid expires_in detected while reading tokens ⚠️', {
        expiresIn: tokens.expires_in,
        tokenObject: JSON.stringify(tokens),
        stack: new Error('Invalid expires_in value').stack,
      })
    }

    debugLog('Token result:', {
      found: true,
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: `${timeLeft} seconds`,
      isExpired: timeLeft <= 0,
      expiresInValue: tokens.expires_in,
      issuedAt: this._tokensIssuedAt,
    })

    return tokens
  }

  /**
   * Returns the wall-clock millisecond timestamp that the current tokens were
   * last written to disk, or undefined if no tokens exist (or were written by
   * an older mcp-remote that didn't stamp them).
   */
  tokensIssuedAt(): number | undefined {
    return this._tokensIssuedAt
  }

  /**
   * Computes the remaining lifetime (in seconds) of the saved access token,
   * based on the stored `issued_at` timestamp and `expires_in`. Returns
   * undefined if we don't have enough information to compute it (no tokens,
   * no `expires_in`, or no `issued_at` — e.g. tokens written by an older
   * mcp-remote release).
   */
  async accessTokenRemainingSeconds(): Promise<number | undefined> {
    const tokens = await this.tokens()
    if (!tokens?.expires_in || !this._tokensIssuedAt) return undefined
    const elapsedSec = (Date.now() - this._tokensIssuedAt) / 1000
    return Math.max(0, tokens.expires_in - elapsedSec)
  }

  /**
   * Saves OAuth tokens
   * @param tokens The tokens to save
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const timeLeft = tokens.expires_in || 0
    const issuedAt = Date.now()
    this._tokensIssuedAt = issuedAt

    // Alert if expires_in is invalid
    if (typeof tokens.expires_in !== 'number' || tokens.expires_in < 0) {
      debugLog('⚠️ WARNING: Invalid expires_in detected in tokens ⚠️', {
        expiresIn: tokens.expires_in,
        tokenObject: JSON.stringify(tokens),
        stack: new Error('Invalid expires_in value').stack,
      })
    }

    // User-visible summary, printed every time tokens are saved — covers the
    // initial OAuth flow, silent refresh-token exchanges, and mid-session
    // re-auth. Lets the user see when the access token will expire without
    // turning on --debug.
    if (timeLeft > 0) {
      const expiresAt = new Date(issuedAt + timeLeft * 1000)
      log(
        `OAuth tokens saved. Access token expires in ${formatLifetime(timeLeft)} (at ${expiresAt.toLocaleString()}). ` +
          `Refresh token: ${tokens.refresh_token ? 'present' : 'none'}.`,
      )
    } else {
      log(`OAuth tokens saved (no expires_in returned by server). Refresh token: ${tokens.refresh_token ? 'present' : 'none'}.`)
    }

    debugLog('Saving tokens', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: `${timeLeft} seconds`,
      expiresInValue: tokens.expires_in,
      issuedAt,
    })

    // Persist tokens alongside our `issued_at` sibling. The SDK ignores extras
    // when it re-validates via OAuthTokensSchema, but our `tokens()` reader
    // pulls issued_at out separately via readRawJsonFile.
    await writeJsonFile(this.serverUrlHash, 'tokens.json', { ...tokens, issued_at: issuedAt })
  }

  /**
   * Redirects the user to the authorization URL
   * @param authorizationUrl The URL to redirect to
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Optionally fetch metadata for debugging/informational purposes (non-blocking)
    this.getAuthorizationServerMetadata().catch(() => {
      // Ignore errors, metadata is optional
    })

    if (this.authorizeResource) {
      authorizationUrl.searchParams.set('resource', this.authorizeResource)
    }

    const effectiveScope = this.getEffectiveScope()
    authorizationUrl.searchParams.set('scope', effectiveScope)
    debugLog('Added scope parameter to authorization URL', { scopes: effectiveScope })

    log(`\nPlease authorize this client by visiting:\n${authorizationUrl.toString()}\n`)

    debugLog('Redirecting to authorization URL', authorizationUrl.toString())

    try {
      await open(sanitizeUrl(authorizationUrl.toString()))
      log('Browser opened automatically.')
    } catch (error) {
      log('Could not open browser automatically. Please copy and paste the URL above into your browser.')
      debugLog('Failed to open browser', error)
    }
  }

  /**
   * Saves the PKCE code verifier
   * @param codeVerifier The code verifier to save
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    debugLog('Saving code verifier')
    await writeTextFile(this.serverUrlHash, 'code_verifier.txt', codeVerifier)
  }

  /**
   * Gets the PKCE code verifier
   * @returns The code verifier
   */
  async codeVerifier(): Promise<string> {
    debugLog('Reading code verifier')
    const verifier = await readTextFile(this.serverUrlHash, 'code_verifier.txt', 'No code verifier saved for session')
    debugLog('Code verifier found:', !!verifier)
    return verifier
  }

  /**
   * Invalidates the specified credentials
   * @param scope The scope of credentials to invalidate
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    debugLog(`Invalidating credentials: ${scope}`)

    switch (scope) {
      case 'all':
        await Promise.all([
          deleteConfigFile(this.serverUrlHash, 'client_info.json'),
          deleteConfigFile(this.serverUrlHash, 'tokens.json'),
          deleteConfigFile(this.serverUrlHash, 'code_verifier.txt'),
        ])
        this._clientInfo = undefined
        debugLog('All credentials invalidated')
        break

      case 'client':
        await deleteConfigFile(this.serverUrlHash, 'client_info.json')
        this._clientInfo = undefined
        debugLog('Client information invalidated')
        break

      case 'tokens':
        await deleteConfigFile(this.serverUrlHash, 'tokens.json')
        debugLog('OAuth tokens invalidated')
        break

      case 'verifier':
        await deleteConfigFile(this.serverUrlHash, 'code_verifier.txt')
        debugLog('Code verifier invalidated')
        break

      default:
        throw new Error(`Unknown credential scope: ${scope}`)
    }
  }
}
