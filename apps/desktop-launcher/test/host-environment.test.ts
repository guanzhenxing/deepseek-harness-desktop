import { describe, expect, it } from 'vitest'

import { sanitizeHostEnvironment } from '../src/host-environment.js'

describe('Host utility-process environment', () => {
  it('preserves ordinary values and removes launcher/runtime control variables', () => {
    expect(
      sanitizeHostEnvironment({
        PATH: '/usr/bin',
        DEEPSEEK_API_KEY: 'user-owned-value',
        DSH_HOME: '/unexpected/home',
        DSH_DESKTOP_SMOKE: 'ui',
        DSH_DESKTOP_M0_USER_DATA: '/tmp/test-data',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        NODE_PATH: '/unexpected/modules',
        UNDEFINED_VALUE: undefined,
      }),
    ).toEqual({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'user-owned-value',
    })
  })
})
