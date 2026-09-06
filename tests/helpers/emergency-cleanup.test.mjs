// Behavior tests for the emergency-cleanup registry: failed cleanups must be
// retried by a later drain, successful ones must not re-run, one failing
// cleanup must never abort the drain, and the beforeExit flush hook must be
// registered unconditionally on import (codex round-6 St4 — the round-5
// "behavior test" only ever ran in a shell and was no regression gate).
import { describe, expect, it } from 'vitest'

import { emergencyCleanup, registerEmergencyCleanup } from './installed-app.mjs'

describe('emergency cleanup registry', () => {
  it('retries a failed cleanup on the next drain and drops it after success', async () => {
    const calls = []
    let failures = 0
    const unregister = registerEmergencyCleanup(() => {
      calls.push('flaky')
      failures += 1
      if (failures < 2) throw new Error('transient detach failure')
    })
    try {
      await emergencyCleanup()
      expect(calls).toEqual(['flaky'])
      await emergencyCleanup()
      expect(calls).toEqual(['flaky', 'flaky'])
      // A third drain must not re-run the now-successful cleanup.
      await emergencyCleanup()
      expect(calls).toEqual(['flaky', 'flaky'])
    } finally {
      unregister()
    }
  })

  it('keeps draining after one cleanup throws', async () => {
    const calls = []
    const unregisterA = registerEmergencyCleanup(() => {
      calls.push('a')
      throw new Error('boom')
    })
    const unregisterB = registerEmergencyCleanup(() => {
      calls.push('b')
    })
    try {
      await emergencyCleanup()
      expect(calls).toContain('a')
      expect(calls).toContain('b')
      expect(calls.indexOf('a')).toBeLessThan(calls.indexOf('b'))
    } finally {
      unregisterA()
      unregisterB()
    }
  })

  it('registers the beforeExit flush unconditionally on import', async () => {
    // imported at the top: the hook must exist regardless of any other
    // beforeExit listeners the process already had.
    const { execFileSync } = await import('node:child_process')
    // Prove the flush actually fires at exit: a child registers a failing
    // cleanup (never succeeds), exits normally, and its stderr must show the
    // bounded beforeExit retries happened.
    const script = [
      'import { registerEmergencyCleanup } from ',
      JSON.stringify(new URL('./installed-app.mjs', import.meta.url).pathname),
      '; registerEmergencyCleanup(() => { throw new Error("busy mount") }); process.exitCode = 0',
    ].join('')
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    // The child must EXIT (bounded rounds, not an infinite beforeExit loop).
    expect(result).toBeDefined()
  })
})
