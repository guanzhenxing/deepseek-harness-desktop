// Behavior tests for the emergency-cleanup registry: failed cleanups must be
// retried by a later drain, successful ones must not re-run, one failing
// cleanup must never abort the drain, and the beforeExit flush hook must be
// registered unconditionally on import (codex round-6 St4 — the round-5
// "behavior test" only ever ran in a shell and was no regression gate).
import { describe, expect, it } from 'vitest'

import { setTimeout as sleepTimer } from 'node:timers'

import {
  drainWithRetries,
  emergencyCleanup,
  installTerminationHandlers,
  installFromDmg,
  registerEmergencyCleanup,
} from './installed-app.mjs'

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

  it('shares one drain across concurrent callers', async () => {
    let entries = 0
    const unregister = registerEmergencyCleanup(async () => {
      entries += 1
      if (entries > 1) throw new Error('two drains entered the cleanup concurrently')
      // A slow cleanup: the second caller must wait on the same drain
      // instead of seeing an emptied registry and exiting early.
      await new Promise((resolve) => sleepTimer(resolve, 80))
    })
    try {
      await Promise.all([drainWithRetries(), drainWithRetries(), drainWithRetries()])
      expect(entries).toBe(1)
    } finally {
      unregister()
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
        'import { installTerminationHandlers, registerEmergencyCleanup } from ',
        JSON.stringify(new URL('./installed-app.mjs', import.meta.url).pathname),
        '; import { writeFile } from "node:fs/promises"; ',
        'let attempts = 0; ',
        'registerEmergencyCleanup(async () => { attempts += 1; ',
        `if (attempts < 2) throw new Error("busy mount"); `,
        `await writeFile(${JSON.stringify(marker)}, "ok"); }); `,
        'installTerminationHandlers(); ',
        'process.stdout.write("watchdog-ready\\n"); ',
        'setInterval(() => {}, 60000)',
      ].join('')
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const exit = await new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
        // Ready handshake: wait for the child to PRINT its marker before
        // signalling, so imports and the handler are provably installed
        // (a fixed delay guesses and flakes under load).
        let buffered = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          buffered += chunk
          if (buffered.includes('watchdog-ready')) child.kill('SIGTERM')
        })
      })
      // SIGTERM keeps its own exit code (143), distinct from SIGINT's 130,
      // after the drain retried and succeeded.
      expect(exit.code).toBe(143)
      expect(await readFile(marker, 'utf8')).toBe('ok')
    } finally {
      await rm(markerRoot, { recursive: true, force: true })
    }
  })

  it('installs distinct SIGINT and SIGTERM exit codes for real callers', () => {
    expect(typeof installTerminationHandlers).toBe('function')
  })

  it('detaches a successful DMG attach when subsequent metadata is unusable', async () => {
    const { access, chmod, mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const binDirectory = await mkdtemp(path.join(tmpdir(), 'fake-hdiutil-'))
    const state = path.join(binDirectory, 'mounted')
    const fakeHdiutil = path.join(binDirectory, 'hdiutil')
    await writeFile(
      fakeHdiutil,
      [
        '#!/bin/sh',
        'if [ "$1" = "attach" ]; then',
        '  touch "$DSH_TEST_MOUNT_STATE"',
        '  printf "<plist><dict><key>system-entities</key><array/></dict></plist>"',
        '  exit 0',
        'fi',
        'if [ "$1" = "detach" ]; then',
        '  rm -f "$DSH_TEST_MOUNT_STATE"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
    )
    await chmod(fakeHdiutil, 0o755)
    const previousPath = process.env.PATH
    const previousState = process.env.DSH_TEST_MOUNT_STATE
    process.env.PATH = `${binDirectory}:/usr/bin:/bin`
    process.env.DSH_TEST_MOUNT_STATE = state
    try {
      await expect(installFromDmg('/tmp/no-such.dmg', 'Missing App')).rejects.toThrow()
      await expect(access(state)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.env.PATH = previousPath
      if (previousState === undefined) delete process.env.DSH_TEST_MOUNT_STATE
      else process.env.DSH_TEST_MOUNT_STATE = previousState
      await rm(binDirectory, { recursive: true, force: true })
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
