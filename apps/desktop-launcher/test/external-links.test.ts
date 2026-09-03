import { describe, expect, it, vi } from 'vitest'

import {
  decideMainFrameNavigation,
  externalUrlPolicy,
  type OpenExternalAdapter,
} from '../src/external-links.js'
import { createWindowOpenGuard } from '../src/window-policy.js'

const surfaceOrigin = 'http://127.0.0.1:4000'

describe('externalUrlPolicy', () => {
  it('allows the controlled browser protocols for off-surface links', () => {
    expect(
      externalUrlPolicy({ target: 'https://example.com/help', currentOrigin: surfaceOrigin }),
    ).toBe('external')
    expect(
      externalUrlPolicy({ target: 'http://example.com/docs', currentOrigin: surfaceOrigin }),
    ).toBe('external')
    expect(
      externalUrlPolicy({ target: 'mailto:support@example.com', currentOrigin: surfaceOrigin }),
    ).toBe('external')
  })

  it('denies non-browser protocols outright', () => {
    expect(externalUrlPolicy({ target: 'file:///etc/passwd', currentOrigin: surfaceOrigin })).toBe(
      'deny',
    )
    expect(externalUrlPolicy({ target: 'data:text/html,hi', currentOrigin: surfaceOrigin })).toBe(
      'deny',
    )
    expect(externalUrlPolicy({ target: 'javascript:alert(1)', currentOrigin: surfaceOrigin })).toBe(
      'deny',
    )
    expect(externalUrlPolicy({ target: 'about:blank', currentOrigin: surfaceOrigin })).toBe('deny')
    expect(externalUrlPolicy({ target: 'chrome://settings', currentOrigin: surfaceOrigin })).toBe(
      'deny',
    )
  })

  it('denies URLs that do not parse', () => {
    expect(externalUrlPolicy({ target: 'not a url', currentOrigin: surfaceOrigin })).toBe('deny')
    expect(externalUrlPolicy({ target: '', currentOrigin: surfaceOrigin })).toBe('deny')
    expect(externalUrlPolicy({ target: 'http://', currentOrigin: surfaceOrigin })).toBe('deny')
  })

  it('denies embedded userinfo', () => {
    expect(
      externalUrlPolicy({ target: 'https://user:pass@example.com/', currentOrigin: surfaceOrigin }),
    ).toBe('deny')
    expect(
      externalUrlPolicy({ target: 'https://user@example.com/', currentOrigin: surfaceOrigin }),
    ).toBe('deny')
  })

  it('denies control characters anywhere in the target', () => {
    expect(
      externalUrlPolicy({ target: 'https://example.com/a\u0000b', currentOrigin: surfaceOrigin }),
    ).toBe('deny')
    expect(
      externalUrlPolicy({ target: 'https://example.com/a\u007fb', currentOrigin: surfaceOrigin }),
    ).toBe('deny')
    expect(
      externalUrlPolicy({ target: 'https://example.com/a\u0085b', currentOrigin: surfaceOrigin }),
    ).toBe('deny')
  })

  it('never sends the local authenticated surface to the system browser', () => {
    expect(
      externalUrlPolicy({
        target: 'http://127.0.0.1:4000/?token=secret',
        currentOrigin: surfaceOrigin,
      }),
    ).toBe('deny')
    expect(
      externalUrlPolicy({
        target: 'http://localhost:4000/?token=secret',
        currentOrigin: surfaceOrigin,
      }),
    ).toBe('deny')
    expect(
      externalUrlPolicy({
        target: 'http://[::1]:4000/?token=secret',
        currentOrigin: surfaceOrigin,
      }),
    ).toBe('deny')
    // A loopback target is denied even when the surface lives elsewhere: the
    // system browser must not become a detour around the surface guard.
    expect(
      externalUrlPolicy({ target: 'https://127.0.0.1:9443/login', currentOrigin: surfaceOrigin }),
    ).toBe('deny')
  })

  it('denies links back into the current surface origin (popups stay in-app)', () => {
    expect(
      externalUrlPolicy({
        target: 'http://127.0.0.1:4000/session/1',
        currentOrigin: surfaceOrigin,
      }),
    ).toBe('deny')
  })
})

describe('decideMainFrameNavigation', () => {
  it('allows same-origin navigation and redirects on the authenticated surface', () => {
    expect(
      decideMainFrameNavigation({
        allowedOrigin: surfaceOrigin,
        target: 'http://127.0.0.1:4000/chat?id=1',
      }),
    ).toBe('allow')
  })

  it('blocks every off-surface main-frame navigation without external handoff', () => {
    expect(
      decideMainFrameNavigation({
        allowedOrigin: surfaceOrigin,
        target: 'https://example.com/leave',
      }),
    ).toBe('deny')
    expect(
      decideMainFrameNavigation({ allowedOrigin: surfaceOrigin, target: 'file:///etc/passwd' }),
    ).toBe('deny')
    expect(
      decideMainFrameNavigation({ allowedOrigin: undefined, target: 'https://example.com/leave' }),
    ).toBe('deny')
  })
})

describe('createWindowOpenGuard', () => {
  it('always denies the popup and forwards only policy-approved URLs externally', () => {
    const openExternal = vi.fn(async () => undefined) as unknown as OpenExternalAdapter
    let origin: string | undefined = surfaceOrigin
    const guard = createWindowOpenGuard({
      policy: externalUrlPolicy,
      currentOrigin: () => origin,
      openExternal,
    })
    expect(guard({ url: 'https://example.com/open' } as never)).toEqual({ action: 'deny' })
    expect(guard({ url: 'file:///etc/passwd' } as never)).toEqual({ action: 'deny' })
    expect(guard({ url: 'http://127.0.0.1:4000/?token=x' } as never)).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/open')
    // Without a trusted origin nothing is ever forwarded.
    origin = undefined
    expect(guard({ url: 'https://example.com/open' } as never)).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
