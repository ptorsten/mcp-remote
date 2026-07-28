import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { AddressInfo } from 'net'
import { parseCommandLineArgs, setupOAuthCallbackServerWithLongPoll } from './utils'

describe('--client-id-metadata-document', () => {
  it('derives the metadata path from the callback path prefix', async () => {
    const opts = await parseCommandLineArgs(
      ['http://localhost:19191/mcp', '--callback-path-prefix', '/callback/lovable', '--client-id-metadata-document'],
      'usage',
    )
    expect(opts.clientIdMetadataPath).toBe('/callback/lovable/client-id-metadata.json')
    expect(opts.callbackPath).toBe('/callback/lovable/oauth/callback')
  })

  it('is off without the flag', async () => {
    const opts = await parseCommandLineArgs(['http://localhost:19191/mcp'], 'usage')
    expect(opts.clientIdMetadataPath).toBeUndefined()
  })

  it('serves the document from the callback listener as application/json', async () => {
    const document = {
      client_id: 'https://example.test/callback/x/client-id-metadata.json',
      client_name: 'MCP CLI Proxy',
      redirect_uris: ['https://example.test/callback/x/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
    const { server } = setupOAuthCallbackServerWithLongPoll({
      port: 0,
      path: '/callback/x/oauth/callback',
      events: new EventEmitter(),
      clientIdMetadata: { path: '/callback/x/client-id-metadata.json', document },
    })
    try {
      if (!server.address()) {
        await new Promise<void>((resolve) => server.once('listening', resolve))
      }
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/callback/x/client-id-metadata.json`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual(document)
    } finally {
      server.close()
    }
  })
})
