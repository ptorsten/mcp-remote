import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseCommandLineArgs, runHook, shouldIncludeTool, mcpProxy, setupOAuthCallbackServerWithLongPoll, getServerUrlHash } from './utils'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { EventEmitter } from 'events'
import express from 'express'

// All sanitizeUrl tests have been moved to the strict-url-sanitise package

describe('Feature: Command Line Arguments Parsing', () => {
  it('Scenario: Parse basic server URL', async () => {
    // Given command line arguments with only a server URL
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the server URL should be correctly extracted
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(typeof result.serverUrl).toBe('string')
  })

  it('Scenario: Parse server URL with callback port', async () => {
    // Given command line arguments with server URL and port
    const args = ['https://example.com/sse', '3000']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then both server URL and callback port should be correctly extracted
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.callbackPort).toBe(3000)
    // And listen port defaults to the same value as the advertised callback port
    expect(result.port).toBe(3000)
    // And the callback path defaults to /oauth/callback
    expect(result.callbackPath).toBe('/oauth/callback')
  })

  it('Scenario: Parse --callback-port decouples advertised port from listen port', async () => {
    // Given a positional listen port and a separate --callback-port flag
    const args = ['https://example.com/sse', '3334', '--callback-port', '443']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the advertised callback port should be 443 and the listen port 3334
    expect(result.port).toBe(3334)
    expect(result.callbackPort).toBe(443)
  })

  it('Scenario: --callback-port without positional listen port picks an available listen port', async () => {
    // Given only --callback-port is provided
    const args = ['https://example.com/sse', '--callback-port', '443']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then advertised port is 443 and listen port is a chosen available port (not 443)
    expect(result.callbackPort).toBe(443)
    expect(typeof result.port).toBe('number')
    expect(result.port).toBeGreaterThan(0)
  })

  it('Scenario: Ignore invalid --callback-port value', async () => {
    // Given an invalid --callback-port value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '3334', '--callback-port', 'not-a-port']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the invalid value is ignored and callbackPort falls back to listen port
    expect(result.callbackPort).toBe(3334)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Warning: Ignoring invalid --callback-port value'))
    consoleSpy.mockRestore()
  })

  it('Scenario: Parse --callback-path-prefix adds prefix to callback path', async () => {
    // Given --callback-path-prefix /api/v1
    const args = ['https://example.com/sse', '--callback-path-prefix', '/api/v1']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the full callback path includes the prefix
    expect(result.callbackPath).toBe('/api/v1/oauth/callback')
  })

  it('Scenario: --callback-path-prefix normalizes leading and trailing slashes', async () => {
    // Given a prefix without leading slash and with trailing slash
    const args = ['https://example.com/sse', '--callback-path-prefix', 'api/v1/']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the slashes are normalized so the full path is well-formed
    expect(result.callbackPath).toBe('/api/v1/oauth/callback')
  })

  it('Scenario: Parse --callback-scheme https', async () => {
    // Given --callback-scheme https
    const args = ['https://example.com/sse', '--callback-scheme', 'https']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the callback scheme is https
    expect(result.callbackScheme).toBe('https')
  })

  it('Scenario: Default --callback-scheme is http', async () => {
    // Given no --callback-scheme flag
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the callback scheme defaults to http (preserves prior behavior)
    expect(result.callbackScheme).toBe('http')
  })

  it('Scenario: Ignore invalid --callback-scheme value', async () => {
    // Given an invalid --callback-scheme value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--callback-scheme', 'ftp']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the invalid value is ignored and scheme falls back to http
    expect(result.callbackScheme).toBe('http')
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Warning: Ignoring invalid --callback-scheme value: ftp. Must be 'http' or 'https'."),
    )
    consoleSpy.mockRestore()
  })

  it('Scenario: Parse --pre-listen-hook and --post-auth-hook', async () => {
    // Given hook commands
    const args = [
      'https://example.com/sse',
      '--pre-listen-hook',
      '/usr/local/bin/my-helper add',
      '--post-auth-hook',
      '/usr/local/bin/my-helper remove',
    ]
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the hook commands are returned verbatim
    expect(result.preListenHook).toBe('/usr/local/bin/my-helper add')
    expect(result.postAuthHook).toBe('/usr/local/bin/my-helper remove')
  })

  it('Scenario: Hooks default to undefined when not specified', async () => {
    // Given no hook flags
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then hooks are undefined
    expect(result.preListenHook).toBeUndefined()
    expect(result.postAuthHook).toBeUndefined()
  })

  it('Scenario: Parse --heartbeat-interval', async () => {
    const args = ['https://example.com/sse', '--heartbeat-interval', '30']
    const result = await parseCommandLineArgs(args, 'test usage')
    expect(result.heartbeatIntervalMs).toBe(30000)
  })

  it('Scenario: --heartbeat-interval defaults to 30 seconds when unspecified', async () => {
    const args = ['https://example.com/sse']
    const result = await parseCommandLineArgs(args, 'test usage')
    expect(result.heartbeatIntervalMs).toBe(30_000)
  })

  it('Scenario: --heartbeat-interval=0 disables heartbeats without a warning', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--heartbeat-interval', '0']
    const result = await parseCommandLineArgs(args, 'test usage')
    expect(result.heartbeatIntervalMs).toBe(0)
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Warning'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Heartbeat disabled'))
    consoleSpy.mockRestore()
  })

  it('Scenario: Invalid --heartbeat-interval value is warned and falls back to the default', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--heartbeat-interval', 'soon']
    const result = await parseCommandLineArgs(args, 'test usage')
    expect(result.heartbeatIntervalMs).toBe(30_000)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Warning: Ignoring invalid --heartbeat-interval value: soon'))
    consoleSpy.mockRestore()
  })

  it('Scenario: Empty --callback-path-prefix leaves the default path', async () => {
    // Given --callback-path-prefix with an empty/slash-only value
    const args = ['https://example.com/sse', '--callback-path-prefix', '/']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the path remains /oauth/callback (no spurious leading slash duplication)
    expect(result.callbackPath).toBe('/oauth/callback')
  })

  it('Scenario: Parse localhost URL with HTTP protocol', async () => {
    // Given command line arguments with localhost HTTP URL
    const args = ['http://localhost:8080/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the localhost HTTP URL should be accepted
    expect(result.serverUrl).toBe('http://localhost:8080/sse')
  })

  it('Scenario: Parse 127.0.0.1 URL with HTTP protocol', async () => {
    // Given command line arguments with 127.0.0.1 HTTP URL
    const args = ['http://127.0.0.1:8080/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the 127.0.0.1 HTTP URL should be accepted
    expect(result.serverUrl).toBe('http://127.0.0.1:8080/sse')
  })

  it('Scenario: Parse single custom header', async () => {
    // Given command line arguments with a custom header
    const args = ['https://example.com/sse', '--header', 'foo: taz']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom header should be correctly parsed
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.headers).toEqual({ foo: 'taz' })
  })

  it('Scenario: Parse multiple custom headers', async () => {
    // Given command line arguments with multiple custom headers
    const args = ['https://example.com/sse', '--header', 'Authorization: Bearer token123', '--header', 'Content-Type: application/json']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all custom headers should be correctly parsed
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.headers).toEqual({
      Authorization: 'Bearer token123',
      'Content-Type': 'application/json',
    })
  })

  it('Scenario: Ignore invalid header format', async () => {
    // Given command line arguments with an invalid header format
    const args = ['https://example.com/sse', '--header', 'invalid-header-format']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the invalid header should be ignored and headers should be empty
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.headers).toEqual({})
  })

  it('Scenario: Handle --allow-http flag for non-localhost URLs', async () => {
    // Given command line arguments with HTTP URL and --allow-http flag
    const args = ['http://example.com/sse', '--allow-http']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the HTTP URL should be accepted due to --allow-http flag
    expect(result.serverUrl).toBe('http://example.com/sse')
  })

  it('Scenario: Accept HTTPS URLs without --allow-http flag', async () => {
    // Given command line arguments with HTTPS URL only
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the HTTPS URL should be accepted without any additional flags
    expect(result.serverUrl).toBe('https://example.com/sse')
  })

  it('Scenario: Handle --allow-http with other arguments', async () => {
    // Given command line arguments with HTTP URL, port, --allow-http flag, and custom header
    const args = ['http://example.com/sse', '4000', '--allow-http', '--header', 'Authorization: Bearer abc123']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all arguments should be correctly parsed including HTTP URL acceptance
    expect(result.serverUrl).toBe('http://example.com/sse')
    expect(result.callbackPort).toBe(4000)
    expect(result.headers).toEqual({ Authorization: 'Bearer abc123' })
  })

  it('Scenario: Use default transport strategy when not specified', async () => {
    // Given command line arguments with only server URL
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default transport strategy should be http-first
    expect(result.transportStrategy).toBe('http-first')
  })

  it('Scenario: Parse transport strategy sse-only', async () => {
    // Given command line arguments with --transport sse-only
    const args = ['https://example.com/sse', '--transport', 'sse-only']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to sse-only
    expect(result.transportStrategy).toBe('sse-only')
  })

  it('Scenario: Parse transport strategy http-only', async () => {
    // Given command line arguments with --transport http-only
    const args = ['https://example.com/sse', '--transport', 'http-only']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to http-only
    expect(result.transportStrategy).toBe('http-only')
  })

  it('Scenario: Parse transport strategy sse-first', async () => {
    // Given command line arguments with --transport sse-first
    const args = ['https://example.com/sse', '--transport', 'sse-first']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to sse-first
    expect(result.transportStrategy).toBe('sse-first')
  })

  it('Scenario: Parse transport strategy http-first', async () => {
    // Given command line arguments with --transport http-first
    const args = ['https://example.com/sse', '--transport', 'http-first']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the transport strategy should be set to http-first
    expect(result.transportStrategy).toBe('http-first')
  })

  it('Scenario: Ignore invalid transport strategy and use default', async () => {
    // Given command line arguments with invalid transport strategy
    const args = ['https://example.com/sse', '--transport', 'invalid-strategy']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the invalid strategy should be ignored and default should be used
    expect(result.transportStrategy).toBe('http-first') // Should fallback to default
  })

  it('Scenario: Use default host when not specified', async () => {
    // Given command line arguments with only server URL
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default host should be localhost
    expect(result.host).toBe('localhost')
  })

  it('Scenario: Parse custom IP host', async () => {
    // Given command line arguments with custom IP host
    const args = ['https://example.com/sse', '--host', '127.0.0.1']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom IP host should be correctly set
    expect(result.host).toBe('127.0.0.1')
  })

  it('Scenario: Parse custom domain host', async () => {
    // Given command line arguments with custom domain host
    const args = ['https://example.com/sse', '--host', 'myserver.local']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom domain host should be correctly set
    expect(result.host).toBe('myserver.local')
  })

  it('Scenario: Handle host with multiple other arguments', async () => {
    // Given command line arguments with host, port, and transport strategy
    const args = ['https://example.com/sse', '3000', '--host', 'custom.host.com', '--transport', 'sse-only']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all arguments should be correctly parsed including the host
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.callbackPort).toBe(3000)
    expect(result.host).toBe('custom.host.com')
    expect(result.transportStrategy).toBe('sse-only')
  })

  it('Scenario: Return empty ignored tools array when none specified', async () => {
    // Given command line arguments without --ignore-tool flags
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the ignored tools array should be empty
    expect(result.ignoredTools).toEqual([])
  })

  it('Scenario: Parse single ignored tool', async () => {
    // Given command line arguments with one --ignore-tool flag
    const args = ['https://example.com/sse', '--ignore-tool', 'foo']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the ignored tools array should contain the specified tool
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.ignoredTools).toEqual(['foo'])
  })

  it('Scenario: Parse multiple ignored tools', async () => {
    // Given command line arguments with multiple --ignore-tool flags
    const args = ['https://example.com/sse', '--ignore-tool', 'foo', '--ignore-tool', 'bar', '--ignore-tool', 'baz']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the ignored tools array should contain all specified tools
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.ignoredTools).toEqual(['foo', 'bar', 'baz'])
  })

  it('Scenario: Handle ignored tools with other arguments', async () => {
    // Given command line arguments with ignored tools mixed with other arguments
    const args = [
      'https://example.com/sse',
      '4000',
      '--ignore-tool',
      'tool1',
      '--host',
      'localhost',
      '--ignore-tool',
      'tool2',
      '--transport',
      'sse-only',
    ]
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then all arguments should be correctly parsed including ignored tools
    expect(result.serverUrl).toBe('https://example.com/sse')
    expect(result.callbackPort).toBe(4000)
    expect(result.host).toBe('localhost')
    expect(result.transportStrategy).toBe('sse-only')
    expect(result.ignoredTools).toEqual(['tool1', 'tool2'])
  })

  it('Scenario: Use default auth timeout when not specified', async () => {
    // Given command line arguments without --auth-timeout flag
    const args = ['https://example.com/sse']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default auth timeout should be 30000ms
    expect(result.authTimeoutMs).toBe(30000)
  })

  it('Scenario: Parse valid auth timeout in seconds and convert to milliseconds', async () => {
    // Given command line arguments with valid --auth-timeout
    const args = ['https://example.com/sse', '--auth-timeout', '60']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the timeout should be converted to milliseconds
    expect(result.authTimeoutMs).toBe(60000)
  })

  it('Scenario: Use default timeout when invalid auth timeout value is provided', async () => {
    // Given command line arguments with invalid --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', 'invalid']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default timeout should be used and warning logged
    expect(result.authTimeoutMs).toBe(30000)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Ignoring invalid auth timeout value: invalid. Must be a positive number.'),
    )

    consoleSpy.mockRestore()
  })

  it('Scenario: Use default timeout when negative auth timeout value is provided', async () => {
    // Given command line arguments with negative --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '-30']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default timeout should be used and warning logged
    expect(result.authTimeoutMs).toBe(30000)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Ignoring invalid auth timeout value: -30. Must be a positive number.'),
    )

    consoleSpy.mockRestore()
  })

  it('Scenario: Use default timeout when zero auth timeout value is provided', async () => {
    // Given command line arguments with zero --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '0']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the default timeout should be used and warning logged
    expect(result.authTimeoutMs).toBe(30000)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Ignoring invalid auth timeout value: 0. Must be a positive number.'),
    )

    consoleSpy.mockRestore()
  })

  it('Scenario: Log when using custom auth timeout', async () => {
    // Given command line arguments with custom --auth-timeout value
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '45']
    const usage = 'test usage'

    // When parsing the command line arguments
    const result = await parseCommandLineArgs(args, usage)

    // Then the custom timeout should be used and logged
    expect(result.authTimeoutMs).toBe(45000)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Using auth callback timeout: 45 seconds'))

    consoleSpy.mockRestore()
  })

  it('Scenario: Suppresses LOG when using --silent', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = ['https://example.com/sse', '--auth-timeout', '45', '--silent']
    const usage = 'test usage'

    const result = await parseCommandLineArgs(args, usage)

    expect(result.authTimeoutMs).toBe(45000)
    expect(consoleSpy).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

describe('Feature: Tool Filtering with Ignore Patterns', () => {
  it('Scenario: Single wildcard pattern ignores matching tools', () => {
    // Given ignore patterns with create* wildcard
    const ignorePatterns = ['create*']

    // When checking if createTask should be included
    const result1 = shouldIncludeTool(ignorePatterns, 'createTask')
    // Then it should be excluded (return false)
    expect(result1).toBe(false)

    // When checking if getTask should be included
    const result2 = shouldIncludeTool(ignorePatterns, 'getTask')
    // Then it should be included (return true)
    expect(result2).toBe(true)
  })

  it('Scenario: Multiple wildcard patterns ignore matching tools', () => {
    // Given ignore patterns with create* and put* wildcards
    const ignorePatterns = ['create*', 'put*']

    // When checking if createTask should be included
    const result1 = shouldIncludeTool(ignorePatterns, 'createTask')
    // Then it should be excluded (return false)
    expect(result1).toBe(false)

    // When checking if infoTask should be included
    const result2 = shouldIncludeTool(ignorePatterns, 'infoTask')
    // Then it should be included (return true)
    expect(result2).toBe(true)
  })

  it('Scenario: Suffix wildcard pattern ignores matching tools', () => {
    // Given ignore patterns with *account suffix wildcard
    const ignorePatterns = ['*account']

    // When checking various account-related tools
    const result1 = shouldIncludeTool(ignorePatterns, 'getAccount')
    const result2 = shouldIncludeTool(ignorePatterns, 'putAccount')
    const result3 = shouldIncludeTool(ignorePatterns, 'account')

    // Then all should be excluded (return false)
    expect(result1).toBe(false)
    expect(result2).toBe(false)
    expect(result3).toBe(false)
  })

  it('Scenario: Empty ignore patterns include all tools', () => {
    // Given empty ignore patterns
    const ignorePatterns: string[] = []

    // When checking any tool
    const result = shouldIncludeTool(ignorePatterns, 'anyTool')

    // Then it should be included (return true)
    expect(result).toBe(true)
  })

  it('Scenario: Non-matching patterns include tools', () => {
    // Given ignore patterns that don't match the tool
    const ignorePatterns = ['delete*', 'remove*']

    // When checking a tool that doesn't match any pattern
    const result = shouldIncludeTool(ignorePatterns, 'createTask')

    // Then it should be included (return true)
    expect(result).toBe(true)
  })

  it('Scenario: Exact match without wildcards', () => {
    // Given ignore patterns with exact tool names
    const ignorePatterns = ['exactTool', 'anotherTool']

    // When checking the exact tool name
    const result1 = shouldIncludeTool(ignorePatterns, 'exactTool')
    // Then it should be excluded (return false)
    expect(result1).toBe(false)

    // When checking a different tool name
    const result2 = shouldIncludeTool(ignorePatterns, 'differentTool')
    // Then it should be included (return true)
    expect(result2).toBe(true)
  })
})

describe('Feature: MCP Proxy', () => {
  it('Scenario: Proxy initialize message from client to server', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when client sends an initialize message
    const initializeMessage = {
      jsonrpc: '2.0' as const,
      method: 'initialize',
      id: '1',
      params: {
        clientInfo: {
          name: 'Test Client',
          version: '1.0.0',
        },
      },
    }

    // Simulate client sending a message by calling the message handler directly
    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(initializeMessage)
    }

    // Then the message should be forwarded to the server
    expect(mockTransportToServer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'initialize',
        id: '1',
        params: expect.objectContaining({
          clientInfo: expect.objectContaining({
            name: expect.stringContaining('Test Client'),
            version: '1.0.0',
          }),
        }),
      }),
    )
  })

  it('Scenario: Proxy server response back to client', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // First simulate client sending a request (so there's a pending request)
    const clientRequest = {
      jsonrpc: '2.0' as const,
      method: 'initialize',
      id: '1',
      params: {
        clientInfo: {
          name: 'Test Client',
          version: '1.0.0',
        },
      },
    }

    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(clientRequest)
    }

    // Clear the previous call
    vi.clearAllMocks()

    // Now simulate server sending a response message
    const serverResponse = {
      jsonrpc: '2.0' as const,
      id: '1',
      result: {
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
        serverInfo: {
          name: 'Atlassian MCP',
          version: '1.0.0',
        },
      },
    }

    // Simulate server sending a response by calling the message handler directly
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(serverResponse)
    }

    // Then the response should be forwarded to the client
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: '1',
        result: {
          capabilities: {
            tools: {
              listChanged: true,
            },
          },
          serverInfo: {
            name: 'Atlassian MCP',
            version: '1.0.0',
          },
        },
      }),
    )
  })

  it('Scenario: Close server transport when client transport closes', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when client transport closes
    if (mockTransportToClient.onclose) {
      mockTransportToClient.onclose()
    }

    // Then server transport should also be closed
    expect(mockTransportToServer.close).toHaveBeenCalled()
  })

  it('Scenario: Close client transport when server transport closes', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when server transport closes
    if (mockTransportToServer.onclose) {
      mockTransportToServer.onclose()
    }

    // Then client transport should also be closed
    expect(mockTransportToClient.close).toHaveBeenCalled()
  })

  it('Scenario: Filter tools in tools/list response when ignoredTools is configured', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy with ignored tools
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: ['delete*', 'remove*'],
    })

    // First simulate client sending a tools/list request
    const toolsListRequest = {
      jsonrpc: '2.0' as const,
      method: 'tools/list',
      id: '2',
      params: {},
    }

    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(toolsListRequest)
    }

    // Clear the previous call
    vi.clearAllMocks()

    // Now simulate server sending a tools/list response with various tools
    const serverToolsResponse = {
      jsonrpc: '2.0' as const,
      id: '2',
      result: {
        tools: [
          { name: 'createTask', description: 'Create a new task' },
          { name: 'deleteTask', description: 'Delete a task' },
          { name: 'updateTask', description: 'Update a task' },
          { name: 'removeUser', description: 'Remove a user' },
          { name: 'listTasks', description: 'List all tasks' },
        ],
      },
    }

    // Simulate server sending a response
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(serverToolsResponse)
    }

    // Then the response should be forwarded to the client with filtered tools
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: '2',
        result: {
          tools: [
            { name: 'createTask', description: 'Create a new task' },
            { name: 'updateTask', description: 'Update a task' },
            { name: 'listTasks', description: 'List all tasks' },
          ],
        },
      }),
    )
  })

  it('Scenario: Block tools/call for ignored tools with delete* filter', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy with delete* filter
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: ['delete*'],
    })

    // And when client tries to call a deleteTask tool
    const toolsCallMessage = {
      jsonrpc: '2.0' as const,
      method: 'tools/call',
      id: '3',
      params: {
        name: 'deleteTask',
        arguments: {
          taskId: '1',
        },
        _meta: {
          progressToken: 1,
        },
      },
    }

    // Simulate client sending the tools/call message
    if (mockTransportToClient.onmessage) {
      mockTransportToClient.onmessage(toolsCallMessage)
    }

    // Then the call should NOT be forwarded to the server
    expect(mockTransportToServer.send).not.toHaveBeenCalled()

    // And an error response should be sent back to the client
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: '3',
        error: expect.objectContaining({
          code: expect.any(Number),
          message: expect.stringContaining('Tool "deleteTask" is not available'),
        }),
      }),
    )
  })

  it('Scenario: Handle server-initiated requests (without corresponding client request)', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when server sends a ping message (server-initiated, no corresponding client request)
    const serverPingMessage = {
      jsonrpc: '2.0' as const,
      method: 'ping',
      id: 'server-ping-1',
    }

    // Simulate server sending the message
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(serverPingMessage)
    }

    // Then the message should be forwarded to the client without errors
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'ping',
        id: 'server-ping-1',
      }),
    )
  })

  it('Scenario: Handle server-initiated response messages without corresponding request', async () => {
    // Given mock transports for client and server
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    // When setting up the proxy
    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // And when server sends a response with an ID that has no corresponding request
    const orphanedResponse = {
      jsonrpc: '2.0' as const,
      id: 'unknown-request-id',
      result: {},
    }

    // Simulate server sending a response without a matching request
    if (mockTransportToServer.onmessage) {
      mockTransportToServer.onmessage(orphanedResponse)
    }

    // Then the response should still be forwarded to the client
    expect(mockTransportToClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'unknown-request-id',
        result: {},
      }),
    )
  })

  it('Scenario: onAuthError fires for UnauthorizedError-shaped server errors', async () => {
    // Given a proxy with an onAuthError handler
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport
    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport
    const onAuthError = vi.fn().mockResolvedValue(undefined)

    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
      onAuthError,
    })

    // When the remote transport reports an Unauthorized-shaped error
    if (mockTransportToServer.onerror) {
      mockTransportToServer.onerror(new Error('HTTP 401 Unauthorized'))
    }

    // Then onAuthError is dispatched (after the microtask tick)
    await new Promise((resolve) => setImmediate(resolve))
    expect(onAuthError).toHaveBeenCalledTimes(1)
    expect(onAuthError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Unauthorized') }))
  })

  it('Scenario: onAuthError is not called for non-auth errors', async () => {
    // Given a proxy with an onAuthError handler
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport
    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport
    const onAuthError = vi.fn().mockResolvedValue(undefined)

    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
      onAuthError,
    })

    // When the remote transport reports a non-auth error (e.g. transient network)
    if (mockTransportToServer.onerror) {
      mockTransportToServer.onerror(new Error('SSE stream disconnected: TypeError: terminated'))
    }

    // Then onAuthError is not called
    await new Promise((resolve) => setImmediate(resolve))
    expect(onAuthError).not.toHaveBeenCalled()
  })

  it('Scenario: local transport is kept open while onAuthError handler runs', async () => {
    // Given a proxy with an onAuthError handler
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport
    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport
    const onAuthError = vi.fn().mockResolvedValue(undefined)

    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
      onAuthError,
    })

    // When the remote transport errors with auth then closes
    if (mockTransportToServer.onerror) {
      mockTransportToServer.onerror(new Error('Unauthorized'))
    }
    if (mockTransportToServer.onclose) {
      mockTransportToServer.onclose()
    }

    // Then the local transport is NOT closed — the handler owns the swap
    await new Promise((resolve) => setImmediate(resolve))
    expect(mockTransportToClient.close).not.toHaveBeenCalled()
  })

  it('Scenario: heartbeat sends pings at the configured interval', async () => {
    vi.useFakeTimers()
    try {
      const mockTransportToClient = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport
      const mockTransportToServer = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport

      mcpProxy({
        transportToClient: mockTransportToClient,
        transportToServer: mockTransportToServer,
        ignoredTools: [],
        heartbeatIntervalMs: 30_000,
      })

      // Advance past two intervals — expect two pings.
      vi.advanceTimersByTime(31_000)
      expect(mockTransportToServer.send).toHaveBeenCalledTimes(1)
      expect(mockTransportToServer.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'ping', jsonrpc: '2.0', id: expect.stringMatching(/^mcp-remote-heartbeat-/) }),
      )

      vi.advanceTimersByTime(30_000)
      expect(mockTransportToServer.send).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Scenario: heartbeat pongs are filtered and not forwarded to the local client', async () => {
    vi.useFakeTimers()
    try {
      const mockTransportToClient = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport
      const mockTransportToServer = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport

      mcpProxy({
        transportToClient: mockTransportToClient,
        transportToServer: mockTransportToServer,
        ignoredTools: [],
        heartbeatIntervalMs: 1000,
      })

      vi.advanceTimersByTime(1000)
      const sentPing = (mockTransportToServer.send as any).mock.calls[0][0]
      const heartbeatId = sentPing.id

      // Server replies with the pong for that id
      if (mockTransportToServer.onmessage) {
        mockTransportToServer.onmessage({ jsonrpc: '2.0', id: heartbeatId, result: {} })
      }

      // Local client must not see the pong
      expect(mockTransportToClient.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Scenario: non-heartbeat responses are still forwarded when heartbeat is enabled', async () => {
    vi.useFakeTimers()
    try {
      const mockTransportToClient = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport
      const mockTransportToServer = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport

      mcpProxy({
        transportToClient: mockTransportToClient,
        transportToServer: mockTransportToServer,
        ignoredTools: [],
        heartbeatIntervalMs: 60_000,
      })

      // Server-initiated message with a non-heartbeat id
      if (mockTransportToServer.onmessage) {
        mockTransportToServer.onmessage({ jsonrpc: '2.0', method: 'ping', id: 'server-ping-7' })
      }

      expect(mockTransportToClient.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-ping-7' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('Scenario: heartbeat stops when the remote transport closes', async () => {
    vi.useFakeTimers()
    try {
      const mockTransportToClient = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport
      const mockTransportToServer = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport

      mcpProxy({
        transportToClient: mockTransportToClient,
        transportToServer: mockTransportToServer,
        ignoredTools: [],
        heartbeatIntervalMs: 1000,
      })

      vi.advanceTimersByTime(1000)
      expect(mockTransportToServer.send).toHaveBeenCalledTimes(1)

      // Simulate the remote transport closing
      if (mockTransportToServer.onclose) {
        mockTransportToServer.onclose()
      }

      // No more pings should fire after close
      vi.advanceTimersByTime(5000)
      expect(mockTransportToServer.send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Scenario: heartbeat is disabled when heartbeatIntervalMs is 0 or omitted', async () => {
    vi.useFakeTimers()
    try {
      const mockTransportToClient = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport
      const mockTransportToServer = {
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        onmessage: vi.fn(),
        onclose: vi.fn(),
        onerror: vi.fn(),
      } as unknown as Transport

      mcpProxy({
        transportToClient: mockTransportToClient,
        transportToServer: mockTransportToServer,
        ignoredTools: [],
        // heartbeatIntervalMs omitted
      })

      vi.advanceTimersByTime(120_000)
      expect(mockTransportToServer.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Scenario: without onAuthError, server-close still closes local transport', async () => {
    // Given a proxy with NO onAuthError handler (legacy behavior)
    const mockTransportToClient = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport
    const mockTransportToServer = {
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      onmessage: vi.fn(),
      onclose: vi.fn(),
      onerror: vi.fn(),
    } as unknown as Transport

    mcpProxy({
      transportToClient: mockTransportToClient,
      transportToServer: mockTransportToServer,
      ignoredTools: [],
    })

    // When the server transport closes (e.g. after an unhandled auth error)
    if (mockTransportToServer.onclose) {
      mockTransportToServer.onclose()
    }

    // Then the local transport is closed (preserves prior behavior)
    expect(mockTransportToClient.close).toHaveBeenCalled()
  })
})

describe('setupOAuthCallbackServerWithLongPoll', () => {
  let server: any
  let events: EventEmitter

  beforeEach(() => {
    events = new EventEmitter()
  })

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('should use custom timeout when authTimeoutMs is provided', async () => {
    const customTimeout = 5000
    const result = setupOAuthCallbackServerWithLongPoll({
      port: 0, // Use any available port
      path: '/oauth/callback',
      events,
      authTimeoutMs: customTimeout,
    })

    server = result.server

    // Test that the server was created
    expect(server).toBeDefined()
    expect(typeof result.waitForAuthCode).toBe('function')
  })

  it('should use default timeout when authTimeoutMs is not provided', async () => {
    const result = setupOAuthCallbackServerWithLongPoll({
      port: 0, // Use any available port
      path: '/oauth/callback',
      events,
    })

    server = result.server

    // Test that the server was created with defaults
    expect(server).toBeDefined()
    expect(typeof result.waitForAuthCode).toBe('function')
  })
})

describe('Feature: Lifecycle Hooks', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-remote-hook-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const hookEnv = {
    listenPort: 3334,
    callbackPort: 443,
    host: 'my-domain.com',
    scheme: 'https' as const,
    callbackPath: '/mcp/oauth/callback',
  }

  it('Scenario: No-op when no command is provided', async () => {
    // Given no hook command (undefined)
    // When runHook is called
    // Then it resolves without throwing
    await expect(runHook('pre-listen', undefined, hookEnv)).resolves.toBeUndefined()
  })

  it('Scenario: Hook receives MCP_REMOTE_* environment variables', async () => {
    // Given a hook command that writes its env to a file
    const outFile = join(tempDir, 'env.txt')
    const command = `printenv | grep '^MCP_REMOTE_' | sort > ${outFile}`

    // When the hook runs
    await runHook('pre-listen', command, hookEnv)

    // Then all expected env vars are present with the right values
    expect(existsSync(outFile)).toBe(true)
    const contents = readFileSync(outFile, 'utf8')
    expect(contents).toContain('MCP_REMOTE_HOOK_PHASE=pre-listen')
    expect(contents).toContain('MCP_REMOTE_LISTEN_PORT=3334')
    expect(contents).toContain('MCP_REMOTE_CALLBACK_PORT=443')
    expect(contents).toContain('MCP_REMOTE_CALLBACK_HOST=my-domain.com')
    expect(contents).toContain('MCP_REMOTE_CALLBACK_SCHEME=https')
    expect(contents).toContain('MCP_REMOTE_CALLBACK_PATH=/mcp/oauth/callback')
    // Default port 443 should be stripped from the redirect URI by URL normalization
    expect(contents).toContain('MCP_REMOTE_CALLBACK_REDIRECT_URI=https://my-domain.com/mcp/oauth/callback')
  })

  it('Scenario: Hook phase env var differs between phases', async () => {
    // Given the same hook command run in both phases
    const preFile = join(tempDir, 'pre.txt')
    const postFile = join(tempDir, 'post.txt')

    // When each hook runs
    await runHook('pre-listen', `echo "$MCP_REMOTE_HOOK_PHASE" > ${preFile}`, hookEnv)
    await runHook('post-auth', `echo "$MCP_REMOTE_HOOK_PHASE" > ${postFile}`, hookEnv)

    // Then each receives the matching phase
    expect(readFileSync(preFile, 'utf8').trim()).toBe('pre-listen')
    expect(readFileSync(postFile, 'utf8').trim()).toBe('post-auth')
  })

  it('Scenario: Failing hook does not throw (best-effort)', async () => {
    // Given a hook that exits non-zero
    // When the hook runs
    // Then runHook still resolves cleanly (failures are logged, not raised)
    await expect(runHook('pre-listen', 'exit 7', hookEnv)).resolves.toBeUndefined()
  })
})

describe('Feature: Server URL Hash Generation', () => {
  it('Scenario: Generate consistent hash for same config', () => {
    const hash1 = getServerUrlHash('https://example.com', 'resource1', { Auth: 'token' })
    const hash2 = getServerUrlHash('https://example.com', 'resource1', { Auth: 'token' })
    expect(hash1).toBe(hash2)
  })

  it('Scenario: Generate different hash for different resources', () => {
    const hash1 = getServerUrlHash('https://example.com', 'resource1')
    const hash2 = getServerUrlHash('https://example.com', 'resource2')
    expect(hash1).not.toBe(hash2)
  })

  it('Scenario: Generate different hash for different headers', () => {
    const hash1 = getServerUrlHash('https://example.com', '', { Auth: 'token1' })
    const hash2 = getServerUrlHash('https://example.com', '', { Auth: 'token2' })
    expect(hash1).not.toBe(hash2)
  })

  it('Scenario: Handle header key ordering consistently', () => {
    const hash1 = getServerUrlHash('https://example.com', '', { B: '2', A: '1' })
    const hash2 = getServerUrlHash('https://example.com', '', { A: '1', B: '2' })
    expect(hash1).toBe(hash2)
  })

  it('Scenario: Backward compatible with no resource or headers', () => {
    const hash1 = getServerUrlHash('https://example.com')
    const hash2 = getServerUrlHash('https://example.com', '', {})
    expect(hash1).toBe(hash2)
  })

  it('Scenario: Empty string resource same as undefined', () => {
    const hash1 = getServerUrlHash('https://example.com', '')
    const hash2 = getServerUrlHash('https://example.com')
    expect(hash1).toBe(hash2)
  })
})
