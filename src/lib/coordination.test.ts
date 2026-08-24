import { describe, it, expect, afterEach } from 'vitest'
import { waitForAuthentication, MAX_CONSECUTIVE_POLL_FAILURES } from './coordination'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

const listen = (app: express.Express): Promise<number> =>
  new Promise((resolve) => {
    server = app.listen(0, () => resolve((server!.address() as AddressInfo).port))
  })

describe('Feature: Secondary-instance auth polling takeover', () => {
  it('Scenario: Auth completed by the primary resolves true', async () => {
    // Given a primary whose wait-for-auth endpoint reports completion
    const app = express()
    app.get('/wait-for-auth', (_req, res) => {
      res.status(200).send('done')
    })
    const port = await listen(app)

    // When the secondary polls it
    // Then it reports success
    await expect(waitForAuthentication(port)).resolves.toBe(true)
  })

  it('Scenario: A dead primary pid ends the wait on the first failed poll', async () => {
    // Given a port nobody listens on and a pid that is certainly not running
    const app = express()
    const port = await listen(app)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    const deadPid = 2 ** 22 - 1 // beyond default pid_max ranges

    // When the secondary polls with the primary's pid known
    const start = Date.now()
    const result = await waitForAuthentication(port, deadPid)

    // Then it gives up immediately instead of looping on connection-refused
    expect(result).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('Scenario: Repeated connection failures without a pid end the wait after the bounded retries', async () => {
    // Given a port nobody listens on and no pid to check
    const app = express()
    const port = await listen(app)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined

    // When the secondary polls it
    const result = await waitForAuthentication(port)

    // Then it concludes the primary is gone after the failure budget
    expect(result).toBe(false)
  }, 30_000)

  it('Scenario: Pending auth keeps polling through a transient failure', async () => {
    // Given a primary that is briefly unreachable, then pending, then complete
    let calls = 0
    const app = express()
    app.get('/wait-for-auth', (_req, res) => {
      calls++
      if (calls === 1) {
        res.socket?.destroy() // transient failure — must not end the wait
      } else if (calls < 4) {
        res.status(202).send('pending')
      } else {
        res.status(200).send('done')
      }
    })
    const port = await listen(app)

    // When the secondary polls it
    const result = await waitForAuthentication(port, process.pid)

    // Then the transient failure resets on recovery and auth completes
    expect(result).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(4)
  }, 30_000)

  it('Scenario: The failure budget is a small bounded constant', () => {
    expect(MAX_CONSECUTIVE_POLL_FAILURES).toBeGreaterThan(1)
    expect(MAX_CONSECUTIVE_POLL_FAILURES).toBeLessThanOrEqual(10)
  })
})
