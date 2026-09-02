import { describe, expect, it } from 'vitest'

import {
  categorizeFailure,
  shouldRollbackProfile,
  toStartupFailure,
  type StartupFailure,
} from '../src/failure-policy.js'

function failureOf(category: StartupFailure['category']): StartupFailure {
  return {
    stage: 'boot',
    code: 'BOOT_FAILED',
    category,
    summary: 'fixture failure',
    retryable: false,
  }
}

describe('shouldRollbackProfile', () => {
  const rollbackCategories = ['profile-write', 'profile-composition'] as const
  const otherCategories = [
    'lease',
    'home-config',
    'credentials',
    'network',
    'runtime',
    'renderer',
    'native-ui',
    'unknown',
  ] as const

  it.each(rollbackCategories)(
    'grants rollback for an unhealthy, changed %s failure',
    (category) => {
      expect(
        shouldRollbackProfile({ failure: failureOf(category), changed: true, healthy: false }),
      ).toBe(true)
    },
  )

  it.each(otherCategories)('refuses rollback for an unhealthy, changed %s failure', (category) => {
    expect(
      shouldRollbackProfile({ failure: failureOf(category), changed: true, healthy: false }),
    ).toBe(false)
  })

  it('refuses rollback when the profile did not change or the shell is healthy', () => {
    const failure = failureOf('profile-write')
    expect(shouldRollbackProfile({ failure, changed: false, healthy: false })).toBe(false)
    expect(shouldRollbackProfile({ failure, changed: true, healthy: true })).toBe(false)
    expect(shouldRollbackProfile({ failure, changed: false, healthy: true })).toBe(false)
  })

  it('refuses rollback for a home-config failure even when the profile changed', () => {
    expect(
      shouldRollbackProfile({
        failure: {
          stage: 'load-home-patch',
          code: 'HOME_PATCH_INVALID',
          category: 'home-config',
          summary: 'Home patch cannot be parsed',
          retryable: false,
        },
        changed: true,
        healthy: false,
      }),
    ).toBe(false)
  })
})

describe('categorizeFailure', () => {
  it('maps the launcher-owned stages deterministically', () => {
    expect(categorizeFailure({ stage: 'lease', code: 'HOME_BUSY' })).toBe('lease')
    expect(categorizeFailure({ stage: 'resolve-profile', code: 'PROFILE_INVALID' })).toBe(
      'profile-composition',
    )
    expect(categorizeFailure({ stage: 'reconcile-profile', code: 'PROFILE_WRITE_FAILED' })).toBe(
      'profile-write',
    )
    expect(categorizeFailure({ stage: 'load-home-patch', code: 'HOME_PATCH_INVALID' })).toBe(
      'home-config',
    )
    expect(categorizeFailure({ stage: 'resolve-runtime', code: 'RUNTIME_UNAVAILABLE' })).toBe(
      'runtime',
    )
    expect(categorizeFailure({ stage: 'load-surface', code: 'SURFACE_FAILED' })).toBe('renderer')
    expect(categorizeFailure({ stage: 'native-ui', code: 'MENU_FAILED' })).toBe('native-ui')
  })

  it('maps recognized boot codes and stays unknown otherwise', () => {
    expect(categorizeFailure({ stage: 'boot', code: 'MISSING_CREDENTIAL' })).toBe('credentials')
    expect(categorizeFailure({ stage: 'boot', code: 'PORT_IN_USE' })).toBe('network')
    expect(categorizeFailure({ stage: 'boot', code: 'SOME_PLUGIN_ERROR' })).toBe('unknown')
    expect(categorizeFailure({ stage: 'unheard-of', code: 'WHATEVER' })).toBe('unknown')
  })
})

describe('toStartupFailure', () => {
  it('classifies and preserves the structured fields', () => {
    const failure = toStartupFailure({
      stage: 'load-home-patch',
      code: 'HOME_PATCH_INVALID',
      summary: 'yaml is not a patch list',
      retryable: false,
    })
    expect(failure).toEqual({
      stage: 'load-home-patch',
      code: 'HOME_PATCH_INVALID',
      category: 'home-config',
      summary: 'yaml is not a patch list',
      retryable: false,
    })
  })

  it('redacts tokens and home paths, strips control characters, and caps length', () => {
    const home = '/Users/test/.dsh'
    const failure = toStartupFailure({
      stage: 'boot',
      code: 'BOOT_FAILED',
      summary:
        `boom at ${home}/profiles/desktop with token=abc123.456 and url ` +
        `http://127.0.0.1:1/?token=xyz-secret\u0000\u0007 keep\u0001me ` +
        'x'.repeat(3_000),
      retryable: true,
      home,
    })
    expect(failure.summary).not.toContain('abc123.456')
    expect(failure.summary).not.toContain('xyz-secret')
    expect(failure.summary).not.toContain('/Users/test/.dsh')
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(failure.summary).not.toMatch(/[\u0000-\u0008\u000e-\u001f]/u)
    expect(failure.summary.length).toBeLessThanOrEqual(1_024)
  })

  it('falls back to a safe summary when none is usable', () => {
    const failure = toStartupFailure({
      stage: 'boot',
      code: 'BOOT_FAILED',
      summary: '\u0000\u0001\u0002',
      retryable: true,
    })
    expect(failure.summary.length).toBeGreaterThan(0)
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(failure.summary).not.toMatch(/[\u0000-\u001f]/u)
  })

  it('never suggests creating credential copies for missing credentials', () => {
    const failure = toStartupFailure({
      stage: 'boot',
      code: 'MISSING_CREDENTIAL',
      summary: 'DEEPSEEK_API_KEY is not configured',
      retryable: false,
    })
    expect(failure.category).toBe('credentials')
    expect(failure.summary).toContain('official')
  })
})
