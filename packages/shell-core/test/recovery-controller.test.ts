import { describe, expect, it, vi } from 'vitest'

import type { HomeLease } from '@dsh-desktop/home-lease'
import type { HostReady } from '@dsh-desktop/host-supervisor'

import { StartupFailureError } from '../src/recovery-controller.js'
import { RecoverySessionController } from '../src/recovery-controller.js'
import type { HostAttempt } from '../src/lifecycle.js'
import type { StartupFailure } from '../src/failure-policy.js'

const ready: HostReady = {
  pid: 4321,
  startIdentity: 'start-1',
  surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=x' },
  origin: 'http://127.0.0.1:43123',
}

const failure: StartupFailure = {
  stage: 'boot',
  code: 'BOOT_FAILED',
  category: 'runtime',
  summary: 'host boot failed',
  retryable: true,
}

class RecordingLease implements HomeLease {
  readonly home = '/tmp/recovery-home'
  readonly generation = 'gen-1'
  readonly calls: string[] = []
  releaseError: Error | undefined

  async assertHeld(): Promise<void> {
    this.calls.push('assertHeld')
  }
  async beforeSpawn(): Promise<void> {
    this.calls.push('beforeSpawn')
  }
  async attachHost(): Promise<void> {
    this.calls.push('attachHost')
  }
  async confirmHostExited(): Promise<void> {
    this.calls.push('confirmHostExited')
  }
  async release(): Promise<void> {
    this.calls.push('release')
    if (this.releaseError !== undefined) throw this.releaseError
  }
}

function fixture(options: { attemptStart?: () => Promise<HostReady> } = {}) {
  const lease = new RecordingLease()
  const attempts: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = []
  const views: unknown[] = []
  const onSessionFailure = vi.fn()
  const clock = { now: 0 }
  const controller = new RecoverySessionController({
    acquireLease: async () => lease,
    reconcile: async () => undefined,
    createAttempt: () => {
      const start = vi.fn(options.attemptStart ?? (async () => ready))
      const stop = vi.fn(async () => undefined)
      attempts.push({ start, stop })
      return { start, stop } as unknown as HostAttempt
    },
    loadSurface: async () => undefined,
    window: {
      showRecoveryView: async (view) => {
        views.push(view)
      },
      destroySurface: () => undefined,
    },
    onSessionFailure,
    now: () => clock.now,
  })
  return { attempts, clock, controller, lease, onSessionFailure, views }
}

describe('RecoverySessionController', () => {
  it('starts healthy without a recovery view', async () => {
    const setup = fixture()
    await setup.controller.start()
    expect(setup.controller.state).toBe('healthy')
    expect(setup.views).toHaveLength(0)
    expect(setup.attempts).toHaveLength(1)
  })

  it('classifies startup failures and shows the bounded recovery view', async () => {
    const setup = fixture({
      attemptStart: () => Promise.reject(new StartupFailureError(failure)),
    })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    expect(setup.controller.state).toBe('recovery')
    expect(setup.views).toHaveLength(1)
    const view = setup.views[0] as { retryAllowed: boolean; safeModeAllowed: boolean }
    expect(view.retryAllowed).toBe(true)
    expect(view.safeModeAllowed).toBe(false)
    expect(setup.attempts[0]?.stop).toHaveBeenCalledWith('quit', 5_000)
  })

  it('merges concurrent retries into exactly one attempt', async () => {
    const setup = fixture({
      attemptStart: () => Promise.reject(new StartupFailureError(failure)),
    })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    await Promise.all([setup.controller.act('retry'), setup.controller.act('retry')])
    // First retry creates attempt #2; the second click merged into it.
    expect(setup.attempts).toHaveLength(2)
  })

  it('budgets manual retries to three per rolling window', async () => {
    const setup = fixture({
      attemptStart: () => Promise.reject(new StartupFailureError(failure)),
    })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    await setup.controller.act('retry')
    await setup.controller.act('retry')
    await setup.controller.act('retry')
    expect(setup.attempts).toHaveLength(4)
    await setup.controller.act('retry')
    expect(setup.attempts).toHaveLength(4)
    const view = setup.controller.getView()
    expect(view.retryAllowed).toBe(false)
    // After the window passes the budget recovers.
    setup.clock.now = 60_001
    expect(setup.controller.getView().retryAllowed).toBe(true)
  })

  it('quit wins a race against retry and releases the lease once', async () => {
    const setup = fixture({
      attemptStart: () => Promise.reject(new StartupFailureError(failure)),
    })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    await Promise.all([setup.controller.act('retry'), setup.controller.act('quit')])
    expect(setup.controller.state).toBe('stopped')
    expect(setup.lease.calls.filter((call) => call === 'release')).toHaveLength(1)
    expect(setup.attempts.length).toBeGreaterThan(0)
  })

  it('reports lease release failures but still completes the stop chain', async () => {
    const setup = fixture({
      attemptStart: () => Promise.reject(new StartupFailureError(failure)),
    })
    const reported: unknown[] = []
    const controller = new RecoverySessionController({
      acquireLease: async () => setup.lease,
      reconcile: async () => undefined,
      createAttempt: () => {
        const attempt = setup.attempts[0]
        if (attempt !== undefined) return attempt as unknown as HostAttempt
        const stub = {
          start: vi.fn(async () => Promise.reject(new StartupFailureError(failure))),
          stop: vi.fn(async () => undefined),
        }
        setup.attempts.push(stub)
        return stub as unknown as HostAttempt
      },
      loadSurface: async () => undefined,
      window: {
        showRecoveryView: async () => undefined,
        destroySurface: () => undefined,
      },
      onLeaseReleaseError: (error) => reported.push(error),
    })
    await expect(controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    setup.lease.releaseError = new Error('host identity unknown')
    await controller.act('quit')
    expect(reported).toHaveLength(1)
    expect(controller.state).toBe('stopped')
  })

  it('maps unknown thrown errors to a sanitized fallback failure', async () => {
    const setup = fixture({ attemptStart: () => Promise.reject(new Error('boom')) })
    await expect(setup.controller.start()).rejects.toThrow('boom')
    const view = setup.controller.getView()
    expect(view.failure.category).toBe('unknown')
    expect(view.failure.stage).toBe('unknown')
    expect(view.failure.summary).toContain('boom')
  })
})
