import { describe, expect, it } from 'vitest'

import { isAllowedMainFrameNavigation, isLoopbackHost } from '../src/navigation.js'

describe('main-frame navigation policy', () => {
  it('allows only the exact authenticated surface origin', () => {
    const origin = 'http://127.0.0.1:43123'
    expect(isAllowedMainFrameNavigation(origin, 'http://127.0.0.1:43123/chat?id=1')).toBe(true)
    expect(isAllowedMainFrameNavigation(origin, 'http://127.0.0.1:43124/')).toBe(false)
    expect(isAllowedMainFrameNavigation(origin, 'http://localhost:43123/')).toBe(false)
    expect(isAllowedMainFrameNavigation(origin, 'https://127.0.0.1:43123/')).toBe(false)
    expect(isAllowedMainFrameNavigation(origin, 'file:///tmp/page.html')).toBe(false)
    expect(isAllowedMainFrameNavigation(origin, 'not a URL')).toBe(false)
  })
})

describe('loopback host classification', () => {
  it('recognizes every spelling a browser connects to the local surface', () => {
    const loopback = [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'app.localhost',
      '127.0.0.1',
      '127.0.0.2',
      '127.1',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      '0.0.0.0',
      '127.0.0.1.',
      '::1',
      '[::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '::ffff:127.0.0.1',
      '[::127.0.0.1]',
      '[::]',
    ]
    for (const host of loopback) expect(isLoopbackHost(host), host).toBe(true)
  })

  it('does not flag remote hosts in any spelling', () => {
    const remote = [
      'example.com',
      'example.com.',
      '1.1.1.1',
      '8.8.8.8',
      '126.0.0.1',
      '128.0.0.1',
      '[::ffff:8.8.8.8]',
      '[fe80::1]',
      'localhost.evil.com',
      '256.1.1.1',
      '',
    ]
    for (const host of remote) expect(isLoopbackHost(host), host).toBe(false)
  })
})
