import { describe, expect, it } from 'vitest'

import { createRecoverySurfacePublisher } from '../src/runtime.js'

const ctx = { logger: { info(): void {} } } as unknown as Parameters<
  typeof createRecoverySurfacePublisher
>[0]

describe('recovery surface publisher', () => {
  it('schedules exactly once for a loopback web server', () => {
    const publisher = createRecoverySurfacePublisher(ctx)
    const calls: string[] = []
    const services = {
      connection: {
        authenticatedUrl: (base: string) => {
          calls.push(base)
          return `${base}/?token=t`
        },
      },
      webServer: { host: '127.0.0.1', port: 43123 },
    }
    expect(publisher.publish(services)).toBe('scheduled')
    expect(publisher.publish(services)).toBe('scheduled')
    expect(calls).toEqual(['http://127.0.0.1:43123'])
  })

  it('refuses a non-loopback bind', () => {
    const publisher = createRecoverySurfacePublisher(ctx)
    expect(() =>
      publisher.publish({
        connection: { authenticatedUrl: (base: string) => base },
        webServer: { host: '0.0.0.0', port: 43123 },
      }),
    ).toThrow(/loopback/u)
  })
})
