import { describe, expect, it } from 'vitest'

import {
  DESKTOP_RENDERER_PARTITION,
  DESKTOP_WEB_PREFERENCES,
  denyWindowOpen,
} from '../src/window-policy.js'

describe('Desktop BrowserWindow policy', () => {
  it('uses a persistent dedicated partition with no renderer privileges', () => {
    expect(DESKTOP_RENDERER_PARTITION).toBe('persist:dsh-desktop-renderer')
    expect(DESKTOP_WEB_PREFERENCES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      partition: DESKTOP_RENDERER_PARTITION,
      sandbox: true,
      webSecurity: true,
    })
  })

  it('denies renderer-created windows', () => {
    expect(denyWindowOpen()).toEqual({ action: 'deny' })
  })
})
