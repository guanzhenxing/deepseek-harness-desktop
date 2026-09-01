import { describe, expect, it, vi } from 'vitest'

import { createDesktopSurfacePublisher } from '../src/runtime.js'

describe('desktop surface publisher', () => {
  it('authenticates and schedules the loopback surface exactly once', () => {
    const schedule = vi.fn()
    const authenticatedUrl = vi.fn((url: string) => `${url}/?token=secret`)
    const publisher = createDesktopSurfacePublisher()
    const services = {
      connection: { authenticatedUrl },
      webServer: { host: '127.0.0.1', port: 43123 },
      desktopSurface: { schedule },
    }

    expect(publisher.publish(services)).toBe('scheduled')
    expect(publisher.publish(services)).toBe('already-scheduled')
    expect(authenticatedUrl).toHaveBeenCalledOnce()
    expect(schedule).toHaveBeenCalledOnce()
    expect(schedule).toHaveBeenCalledWith({
      kind: 'loopback',
      url: 'http://127.0.0.1:43123/?token=secret',
    })
  })

  it('degrades readably when no launcher surface exists', () => {
    const warn = vi.fn()
    const publisher = createDesktopSurfacePublisher({ warn })
    const result = publisher.publish({
      connection: { authenticatedUrl: vi.fn() },
      webServer: { host: '127.0.0.1', port: 43123 },
    })

    expect(result).toBe('degraded')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).not.toContain('http://')
  })

  it('rejects a non-loopback bind before publishing', () => {
    const schedule = vi.fn()
    const publisher = createDesktopSurfacePublisher()
    expect(() =>
      publisher.publish({
        connection: { authenticatedUrl: vi.fn() },
        webServer: { host: '0.0.0.0', port: 43123 },
        desktopSurface: { schedule },
      }),
    ).toThrow(/loopback/u)
    expect(schedule).not.toHaveBeenCalled()
  })
})
