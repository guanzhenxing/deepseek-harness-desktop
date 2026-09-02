import { describe, expect, it } from 'vitest'

import { isAllowedMainFrameNavigation } from '../src/navigation.js'

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
