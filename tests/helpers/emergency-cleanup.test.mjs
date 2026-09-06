// Behavior tests for the emergency-cleanup registry: failed cleanups must be
// retried by a later drain, successful ones must not re-run, one failing
// cleanup must never abort the drain, and the beforeExit flush hook must be
// registered unconditionally on import (codex round-6 St4 — the round-5
// "behavior test" only ever ran in a shell and was no regression gate).
import { describe, expect, it } from 'vitest'

import { setTimeout as sleepTimer } from 'node:timers'

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

  it('retries a failed cleanup on SIGINT before exiting', async () => {
    const { spawn } = await import('node:child_process')
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const markerRoot = await mkdtemp(path.join(tmpdir(), 'r7-signal-'))
    const marker = path.join(markerRoot, 'flushed')
    try {
      const script = [
        'import { drainWithRetries, registerEmergencyCleanup } from ',
        JSON.stringify(new URL('./installed-app.mjs', import.meta.url).pathname),
        '; import { writeFile } from "node:fs/promises"; ',
        'let attempts = 0; ',
        'registerEmergencyCleanup(async () => { attempts += 1; ',
        `if (attempts < 2) throw new Error("busy mount"); `,
        `await writeFile(${JSON.stringify(marker)}, "ok"); }); `,
        "for (const signal of ['SIGINT']) {",
        'process.on(signal, () => { void drainWithRetries().finally(() => process.exit(130)) }); }',
        'setInterval(() => {}, 60000)',
      ].join('')
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: 'ignore',
      })
      const exit = await new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
        sleepTimer(() => child.kill('SIGINT'), 150)
      })
      // The signal handler exits 130 AFTER the drain retried and succeeded.
      expect(exit.code).toBe(130)
      expect(await readFile(marker, 'utf8')).toBe('ok')
    } finally {
      await rm(markerRoot, { recursive: true, force: true })
    }
  })

  it('flushes a leftover cleanup through beforeExit at normal exit', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    // A child registers a cleanup that fails ONCE (like a busy mount on the
    // first detach) and succeeds on retry, writing a marker file. The
    // beforeExit flush must run that retry after main completes; the marker
    // is the proof (a weak "the child exited" assertion proves nothing).
    const markerRoot = await mkdtemp(path.join(tmpdir(), 'r3-beforeexit-'))
    const marker = path.join(markerRoot, 'flushed')
    try {
      const script = [
        'import { registerEmergencyCleanup } from ',
        JSON.stringify(new URL('./installed-app.mjs', import.meta.url).pathname),
        '; import { writeFile } from "node:fs/promises"; ',
        'let attempts = 0; ',
        'registerEmergencyCleanup(async () => { attempts += 1; ',
        `if (attempts < 2) throw new Error("busy mount"); `,
        `await writeFile(${JSON.stringify(marker)}, "ok"); });`,
        '// An unrelated listener must not disable the flush hook.',
        'process.on("beforeExit", () => {}); ',
        'process.exitCode = 0',
      ].join('')
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        timeout: 15_000,
      })
      expect(await readFile(marker, 'utf8')).toBe('ok')
    } finally {
      await rm(markerRoot, { recursive: true, force: true })
    }
  })
})
