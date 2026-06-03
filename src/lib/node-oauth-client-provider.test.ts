import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NodeOAuthClientProvider } from './node-oauth-client-provider'
import * as mcpAuthConfig from './mcp-auth-config'
import * as utils from './utils'
import type { OAuthProviderOptions } from './types'
import type { AuthorizationServerMetadata } from './authorization-server-metadata'

vi.mock('./mcp-auth-config')
vi.mock('./authorization-server-metadata', () => ({
  fetchAuthorizationServerMetadata: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./utils', () => ({
  getServerUrlHash: () => 'test-hash',
  log: vi.fn(),
  debugLog: vi.fn(),
  DEBUG: false,
  MCP_REMOTE_VERSION: '1.0.0',
  formatLifetime: (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`
    return `${(seconds / 86400).toFixed(1)}d`
  },
}))
vi.mock('open', () => ({ default: vi.fn() }))

describe('NodeOAuthClientProvider - OAuth Scope Handling', () => {
  let provider: NodeOAuthClientProvider
  let mockReadJsonFile: any
  let mockWriteJsonFile: any
  let mockDeleteConfigFile: any

  const defaultOptions: OAuthProviderOptions = {
    serverUrl: 'https://example.com',
    callbackPort: 8080,
    host: 'localhost',
    serverUrlHash: 'test-hash',
  }

  let mockReadRawJsonFile: any
  beforeEach(() => {
    mockReadJsonFile = vi.mocked(mcpAuthConfig.readJsonFile)
    mockWriteJsonFile = vi.mocked(mcpAuthConfig.writeJsonFile)
    mockDeleteConfigFile = vi.mocked(mcpAuthConfig.deleteConfigFile)
    mockReadRawJsonFile = vi.mocked(mcpAuthConfig.readRawJsonFile)

    mockReadJsonFile.mockResolvedValue(undefined)
    mockWriteJsonFile.mockResolvedValue(undefined)
    mockDeleteConfigFile.mockResolvedValue(undefined)
    mockReadRawJsonFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('scope priority', () => {
    it('should prioritize custom scope from staticOAuthClientMetadata', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom read write',
        } as any,
      })

      const metadata = provider.clientMetadata
      expect(metadata.scope).toBe('custom read write')
    })

    it('should use scope from registration response', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const clientInfo = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        scope: 'openid email profile read:user',
      }

      await provider.saveClientInformation(clientInfo)
      await provider.clientInformation()

      const metadata = provider.clientMetadata
      expect(metadata.scope).toBe('openid email profile read:user')
    })

    it('should fallback to default scopes when none provided', () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const metadata = provider.clientMetadata
      expect(metadata.scope).toBe('openid email profile')
    })
  })

  describe('authorization URL', () => {
    it('should include scope parameter in authorization URL', async () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'github read:user',
        } as any,
      })

      const authUrl = new URL('https://auth.example.com/authorize')
      await provider.redirectToAuthorization(authUrl)

      expect(authUrl.searchParams.get('scope')).toBe('github read:user')
    })

    it('should include default scope in authorization URL when none specified', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const authUrl = new URL('https://auth.example.com/authorize')
      await provider.redirectToAuthorization(authUrl)

      expect(authUrl.searchParams.get('scope')).toBe('openid email profile')
    })
  })

  describe('backward compatibility', () => {
    it('should preserve existing custom scope behavior', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'user:email repo',
          client_name: 'My Custom Client',
        } as any,
      })

      const metadata = provider.clientMetadata

      expect(metadata).toMatchObject({
        scope: 'user:email repo',
        client_name: 'My Custom Client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        software_id: '2e6dc280-f3c3-4e01-99a7-8181dbd1d23d',
        software_version: '1.0.0',
      })
    })
  })

  describe('redirectUrl', () => {
    it('defaults to http and includes the callback port', () => {
      provider = new NodeOAuthClientProvider(defaultOptions)
      expect(provider.redirectUrl).toBe('http://localhost:8080/oauth/callback')
    })

    it('honors --callback-scheme https', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        callbackScheme: 'https',
        callbackPort: 8443,
      })
      expect(provider.redirectUrl).toBe('https://localhost:8443/oauth/callback')
    })

    it('omits the default port for https (443)', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        callbackScheme: 'https',
        callbackPort: 443,
        host: 'my-domain.com',
      })
      expect(provider.redirectUrl).toBe('https://my-domain.com/oauth/callback')
    })

    it('omits the default port for http (80)', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        callbackScheme: 'http',
        callbackPort: 80,
        host: 'my-domain.com',
      })
      expect(provider.redirectUrl).toBe('http://my-domain.com/oauth/callback')
    })

    it('honors a custom callback path', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        callbackPath: '/api/v1/oauth/callback',
      })
      expect(provider.redirectUrl).toBe('http://localhost:8080/api/v1/oauth/callback')
    })
  })

  describe('saveTokens logging', () => {
    it('logs a user-visible lifetime + absolute expiry when expires_in is set', async () => {
      const logSpy = vi.mocked(utils.log)
      logSpy.mockClear()
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
      } as any)

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('OAuth tokens saved'))
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('expires in 1.0h'))
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Refresh token: present'))
    })

    it('logs a no-expiry fallback when expires_in is missing', async () => {
      const logSpy = vi.mocked(utils.log)
      logSpy.mockClear()
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
      } as any)

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no expires_in returned'))
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Refresh token: none'))
    })

    it('formats short lifetimes in minutes', async () => {
      const logSpy = vi.mocked(utils.log)
      logSpy.mockClear()
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 600,
      } as any)

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('expires in 10m'))
    })

    it('persists issued_at alongside the saved tokens', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)
      const before = Date.now()

      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
      } as any)

      // writeJsonFile should be called with the original token fields *plus* issued_at
      expect(mockWriteJsonFile).toHaveBeenCalledWith(
        'test-hash',
        'tokens.json',
        expect.objectContaining({
          access_token: 'a',
          expires_in: 3600,
          issued_at: expect.any(Number),
        }),
      )
      const written = mockWriteJsonFile.mock.calls[0][2]
      expect(written.issued_at).toBeGreaterThanOrEqual(before)
      expect(written.issued_at).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('issued_at persistence and remaining lifetime', () => {
    it('reads issued_at from disk and exposes it via tokensIssuedAt()', async () => {
      const persistedAt = Date.now() - 60_000
      mockReadRawJsonFile.mockResolvedValueOnce({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        issued_at: persistedAt,
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.tokens()
      expect(provider.tokensIssuedAt()).toBe(persistedAt)
    })

    it('computes remaining seconds from issued_at + expires_in', async () => {
      const persistedAt = Date.now() - 600_000 // 10 minutes ago
      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600, // 60-minute lifetime
        issued_at: persistedAt,
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      const remaining = await provider.accessTokenRemainingSeconds()
      // ~3000s remaining (60 min - 10 min); allow a small fudge factor for test runtime.
      expect(remaining).toBeGreaterThan(2990)
      expect(remaining).toBeLessThanOrEqual(3000)
    })

    it('returns undefined remaining when issued_at is missing (older token file)', async () => {
      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      const remaining = await provider.accessTokenRemainingSeconds()
      expect(remaining).toBeUndefined()
    })

    it('clamps remaining to 0 when issued_at is far in the past', async () => {
      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 60,
        issued_at: Date.now() - 3600_000, // 1h ago, but token only valid 60s
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      const remaining = await provider.accessTokenRemainingSeconds()
      expect(remaining).toBe(0)
    })

    it('returns undefined when tokens file does not exist', async () => {
      mockReadRawJsonFile.mockResolvedValue(undefined)
      provider = new NodeOAuthClientProvider(defaultOptions)

      const tokens = await provider.tokens()
      expect(tokens).toBeUndefined()
      expect(provider.tokensIssuedAt()).toBeUndefined()
    })
  })

  describe('refresh_expires_in capture', () => {
    it('persists refresh_expires_in when the server provided it', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)
      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        refresh_expires_in: 7 * 24 * 3600, // 1 week
      } as any)

      expect(mockWriteJsonFile).toHaveBeenCalledWith(
        'test-hash',
        'tokens.json',
        expect.objectContaining({
          refresh_expires_in: 7 * 24 * 3600,
          issued_at: expect.any(Number),
        }),
      )
    })

    it('omits refresh_expires_in on disk when the server did not provide it', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)
      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
      } as any)

      const written = mockWriteJsonFile.mock.calls[0][2]
      expect(written.refresh_expires_in).toBeUndefined()
    })

    it('logs refresh-token lifetime when refresh_expires_in is provided', async () => {
      const logSpy = vi.mocked(utils.log)
      logSpy.mockClear()
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        refresh_expires_in: 86_400, // 1 day
      } as any)

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Refresh token valid for 1.0d'))
    })

    it('notes the unknown-lifetime case when refresh_expires_in is missing', async () => {
      const logSpy = vi.mocked(utils.log)
      logSpy.mockClear()
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
      } as any)

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('server did not provide refresh_expires_in'))
    })

    it('computes refresh token remaining seconds from issued_at + refresh_expires_in', async () => {
      const persistedAt = Date.now() - 600_000 // 10 minutes ago
      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        refresh_expires_in: 86_400,
        issued_at: persistedAt,
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      const remaining = await provider.refreshTokenRemainingSeconds()
      // ~ (86400 - 600) seconds, allow fudge
      expect(remaining).toBeGreaterThan(86_400 - 600 - 5)
      expect(remaining).toBeLessThanOrEqual(86_400 - 600)
    })

    it('returns undefined remaining when refresh_expires_in is missing', async () => {
      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        issued_at: Date.now() - 1000,
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      const remaining = await provider.refreshTokenRemainingSeconds()
      expect(remaining).toBeUndefined()
    })

    it('returns undefined remaining when there is no refresh token at all', async () => {
      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_expires_in: 86_400,
        issued_at: Date.now() - 1000,
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      const remaining = await provider.refreshTokenRemainingSeconds()
      expect(remaining).toBeUndefined()
    })

    it('debug log is deduped on repeat tokens() calls with unchanged state', async () => {
      const debugLogSpy = vi.mocked(utils.debugLog)
      debugLogSpy.mockClear()

      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        issued_at: Date.now() - 1000,
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      // First call — should emit "Reading OAuth tokens", stack trace, and Token result
      await provider.tokens()
      const firstCallCount = debugLogSpy.mock.calls.length
      expect(debugLogSpy).toHaveBeenCalledWith(expect.stringContaining('Reading OAuth tokens'))
      expect(debugLogSpy).toHaveBeenCalledWith('Token result:', expect.anything())

      // Second call with identical state — should NOT add more "Reading OAuth tokens" / "Token result" log entries
      debugLogSpy.mockClear()
      await provider.tokens()
      expect(debugLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Reading OAuth tokens'))
      expect(debugLogSpy).not.toHaveBeenCalledWith('Token result:', expect.anything())
      // Sanity: prior call count was non-trivial so we know the comparison is meaningful
      expect(firstCallCount).toBeGreaterThan(0)
    })

    it('re-emits the debug log when token state changes between reads', async () => {
      const debugLogSpy = vi.mocked(utils.debugLog)
      provider = new NodeOAuthClientProvider(defaultOptions)

      // First read
      mockReadRawJsonFile.mockResolvedValueOnce({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        issued_at: 1_000_000,
      })
      await provider.tokens()

      // Second read with the same shape but a different issued_at (simulates a refresh)
      debugLogSpy.mockClear()
      mockReadRawJsonFile.mockResolvedValueOnce({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        issued_at: 2_000_000,
      })
      await provider.tokens()

      expect(debugLogSpy).toHaveBeenCalledWith(expect.stringContaining('Reading OAuth tokens'))
      expect(debugLogSpy).toHaveBeenCalledWith('Token result:', expect.anything())
    })

    it('clamps refresh remaining to 0 when past expiry', async () => {
      mockReadRawJsonFile.mockResolvedValue({
        access_token: 'a',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r',
        refresh_expires_in: 60,
        issued_at: Date.now() - 3600_000, // 1h ago, refresh only valid 60s
      })
      provider = new NodeOAuthClientProvider(defaultOptions)

      const remaining = await provider.refreshTokenRemainingSeconds()
      expect(remaining).toBe(0)
    })
  })

  describe('credential invalidation', () => {
    it('should reset to default scopes after client invalidation', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      const clientInfo = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        scope: 'extracted custom scopes',
      }

      mockReadJsonFile.mockResolvedValueOnce(clientInfo)
      await provider.clientInformation()
      expect(provider.clientMetadata.scope).toBe('extracted custom scopes')

      await provider.invalidateCredentials('client')

      expect(provider.clientMetadata.scope).toBe('openid email profile')
      expect(mockDeleteConfigFile).toHaveBeenCalledWith('test-hash', 'client_info.json')
    })

    it('should not delete client info when invalidating only tokens', async () => {
      provider = new NodeOAuthClientProvider(defaultOptions)

      await provider.invalidateCredentials('tokens')

      expect(mockDeleteConfigFile).toHaveBeenCalledWith('test-hash', 'tokens.json')
      expect(mockDeleteConfigFile).not.toHaveBeenCalledWith('test-hash', 'client_info.json')
    })
  })

  describe('scopes_supported parsing', () => {
    it('should use custom scopes without filtering', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['openid', 'email', 'profile'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'openid email profile custom:read custom:write',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      // Should use all requested scopes without filtering
      expect(clientMetadata.scope).toBe('openid email profile custom:read custom:write')
    })

    it('should use requested scopes regardless of scopes_supported', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['some', 'other', 'scopes'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      // Should use requested scopes even if not in scopes_supported
      expect(clientMetadata.scope).toBe('custom:read custom:write')
    })

    it('should use scopes when scopes_supported is missing', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        // No scopes_supported
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write special:scope',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      expect(clientMetadata.scope).toBe('custom:read custom:write special:scope')
    })

    it('should use scopes when scopes_supported is empty', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: [],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write',
        } as any,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      expect(clientMetadata.scope).toBe('custom:read custom:write')
    })

    it('should use scopes when no metadata is provided', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: 'custom:read custom:write',
        } as any,
      })

      const clientMetadata = provider.clientMetadata
      expect(clientMetadata.scope).toBe('custom:read custom:write')
    })

    it('should use scopes from client registration response', async () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['openid', 'email'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        authorizationServerMetadata: metadata,
      })

      const clientInfo = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:8080/oauth/callback'],
        scope: 'openid email profile custom:read',
      }

      await provider.saveClientInformation(clientInfo)
      await provider.clientInformation()

      const clientMetadata = provider.clientMetadata
      // Should use all scopes from registration response
      expect(clientMetadata.scope).toBe('openid email profile custom:read')
    })

    it('should use scopes_supported when no user or client scopes provided', () => {
      const metadata: AuthorizationServerMetadata = {
        issuer: 'https://example.com',
        scopes_supported: ['openid', 'email'],
      }

      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        authorizationServerMetadata: metadata,
      })

      const clientMetadata = provider.clientMetadata
      // Should use scopes_supported when nothing else is provided
      expect(clientMetadata.scope).toBe('openid email')
    })

    it('should treat empty scope string as no scope and use default', () => {
      provider = new NodeOAuthClientProvider({
        ...defaultOptions,
        staticOAuthClientMetadata: {
          scope: '',
        } as any,
      })

      const clientMetadata = provider.clientMetadata
      // Empty scope should fallback to default
      expect(clientMetadata.scope).toBe('openid email profile')
    })
  })
})
