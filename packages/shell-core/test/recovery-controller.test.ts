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

const profileWriteFailure: StartupFailure = {
  stage: 'resolve-profile',
  code: 'PROFILE_INVALID',
  category: 'profile-composition',
  summary: 'composed profile is invalid',
  retryable: false,
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
  async switchProfile(nextProfile: string): Promise<void> {
    this.calls.push(`switchProfile:${nextProfile}`)
  }
  async release(): Promise<void> {
    this.calls.push('release')
    if (this.releaseError !== undefined) throw this.releaseError
  }
}

type ProfilePortCalls = {
  committed: string[]
  rolledBack: string[]
  retained: { id: string; category: string; code: string }[]
  enteredSafeMode: number[]
  exitedSafeMode: number[]
  markers: { transactionId: string; attempt: number }[]
}

function fixture(options: { attemptStart?: () => Promise<HostReady> } = {}) {
  const lease = new RecordingLease()
  const attempts: {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    mode: string
  }[] = []
  const views: unknown[] = []
  const onSessionFailure = vi.fn()
  const portCalls: ProfilePortCalls = {
    committed: [],
    rolledBack: [],
    retained: [],
    enteredSafeMode: [],
    exitedSafeMode: [],
    markers: [],
  }
  let marker: { transactionId: string; attempt: number } | undefined
  const clock = { now: 0 }
  let nextTransaction = 0
  const controller = new RecoverySessionController({
    acquireLease: async () => lease,
    profile: {
      prepare: async () => {
        nextTransaction += 1
        return { kind: 'ready', transactionId: `tx-${nextTransaction}`, changed: true }
      },
      settleCommitted: async (transactionId) => {
        portCalls.committed.push(transactionId)
      },
      rollback: async (transactionId) => {
        portCalls.rolledBack.push(transactionId)
        return 'restored'
      },
      retain: async (transactionId, leaseForRetain, failureForRetain) => {
        void leaseForRetain
        portCalls.retained.push({
          id: transactionId,
          category: failureForRetain.category,
          code: failureForRetain.code,
        })
      },
      enterSafeMode: async () => {
        portCalls.enteredSafeMode.push(clock.now)
        return 'prepared'
      },
      exitSafeMode: async () => {
        portCalls.exitedSafeMode.push(clock.now)
      },
    },
    readRecoveryMarker: async () => marker,
    writeRecoveryMarker: async (entry) => {
      marker = entry
      portCalls.markers.push(entry)
    },
    createAttempt: (_lease, mode) => {
      const start = vi.fn(options.attemptStart ?? (async () => ready))
      const stop = vi.fn(async () => undefined)
      attempts.push({ start, stop, mode })
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
  return {
    attempts,
    clock,
    controller,
    lease,
    onSessionFailure,
    portCalls,
    views,
    setMarker: (value: { transactionId: string; attempt: number } | undefined) => (marker = value),
  }
}

describe('RecoverySessionController', () => {
  it('starts healthy, commits the transaction, and shows no recovery view', async () => {
    const setup = fixture()
    await setup.controller.start()
    expect(setup.controller.state).toBe('healthy')
    expect(setup.views).toHaveLength(0)
    expect(setup.attempts).toHaveLength(1)
    expect(setup.portCalls.committed).toEqual(['tx-1'])
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
    expect(view.safeModeAllowed).toBe(true)
    expect(setup.attempts[0]?.stop).toHaveBeenCalledWith('quit', 5_000)
    // runtime failures are not attributable to the profile: retained, not rolled back
    expect(setup.portCalls.rolledBack).toHaveLength(0)
    expect(setup.portCalls.retained).toEqual([
      { id: 'tx-1', category: 'runtime', code: 'BOOT_FAILED' },
    ])
  })

  it('rolls back on an attributed failure and auto-restarts exactly once', async () => {
    let boot = 0
    const setup = fixture({
      attemptStart: () => {
        boot += 1
        return boot <= 3
          ? Promise.reject(new StartupFailureError(profileWriteFailure))
          : Promise.resolve(ready)
      },
    })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    // first failure: rollback tx-1, one automatic relaunch, which failed again
    // (tx-2 rolled back), and the relaunch budget is spent.
    expect(setup.portCalls.rolledBack).toEqual(['tx-1', 'tx-2'])
    expect(setup.portCalls.markers).toEqual([{ transactionId: 'tx-1', attempt: 1 }])
    expect(setup.attempts).toHaveLength(2)
    expect(setup.views).toHaveLength(1)
    expect(setup.controller.state).toBe('recovery')
    // A manual retry that fails again must not earn another auto-restart.
    await setup.controller.act('retry')
    expect(setup.attempts).toHaveLength(3)
    expect(setup.portCalls.rolledBack).toEqual(['tx-1', 'tx-2', 'tx-3'])
    expect(setup.views).toHaveLength(2)
  })

  it('recovers to healthy without a recovery view when the relaunch succeeds', async () => {
    let boot = 0
    const setup = fixture({
      attemptStart: () => {
        boot += 1
        return boot === 1
          ? Promise.reject(new StartupFailureError(profileWriteFailure))
          : Promise.resolve(ready)
      },
    })
    await setup.controller.start()
    expect(setup.controller.state).toBe('healthy')
    expect(setup.views).toHaveLength(0)
    expect(setup.portCalls.rolledBack).toEqual(['tx-1'])
    expect(setup.portCalls.committed).toEqual(['tx-2'])
    expect(setup.attempts).toHaveLength(2)
  })

  it('a persisted marker for the pending transaction spends the relaunch budget', async () => {
    const setup = fixture({
      attemptStart: () => Promise.reject(new StartupFailureError(profileWriteFailure)),
    })
    setup.setMarker({ transactionId: 'tx-1', attempt: 1 })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    expect(setup.portCalls.rolledBack).toEqual(['tx-1'])
    expect(setup.portCalls.markers).toHaveLength(0)
    expect(setup.attempts).toHaveLength(1)
    expect(setup.views).toHaveLength(1)
  })

  it('a rollback conflict keeps the journal, blocks retry, and never poisons safe mode', async () => {
    const lease = new RecordingLease()
    const views: unknown[] = []
    let nextTransaction = 0
    const rolledBack: string[] = []
    const retained: { id: string }[] = []
    const committed: string[] = []
    const controller = new RecoverySessionController({
      acquireLease: async () => lease,
      profile: {
        prepare: async () => {
          nextTransaction += 1
          return { kind: 'ready', transactionId: `tx-${nextTransaction}`, changed: true }
        },
        settleCommitted: async (transactionId) => {
          committed.push(transactionId)
        },
        rollback: async (transactionId) => {
          rolledBack.push(transactionId)
          return 'conflict'
        },
        retain: async (transactionId) => {
          retained.push({ id: transactionId })
        },
        enterSafeMode: async () => 'prepared',
        exitSafeMode: async () => undefined,
      },
      createAttempt: (_lease, mode) =>
        ({
          start:
            mode === 'safe'
              ? async () => ready
              : () => Promise.reject(new StartupFailureError(profileWriteFailure)),
          stop: async () => undefined,
        }) as unknown as HostAttempt,
      loadSurface: async () => undefined,
      window: {
        showRecoveryView: async (view) => {
          views.push(view)
        },
        destroySurface: () => undefined,
      },
    })
    await expect(controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    expect(rolledBack).toEqual(['tx-1'])
    expect(controller.state).toBe('recovery')
    expect(views).toHaveLength(1)
    // The conflict journal is never settled or rewritten: no retain, and a
    // later safe-mode boot must not try to commit the conflicted transaction.
    expect(retained).toHaveLength(0)
    await controller.act('safe-mode')
    expect(controller.state).toBe('healthy')
    expect(committed).toHaveLength(0)
  })

  it('hides retry for non-retryable failures but still rolls back once', async () => {
    const setup = fixture({
      attemptStart: () =>
        Promise.reject(
          new StartupFailureError({
            stage: 'resolve-profile',
            code: 'PROFILE_INVALID',
            category: 'profile-composition',
            summary: 'bad profile',
            retryable: false,
          }),
        ),
    })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    const view = setup.controller.getView()
    expect(view.retryAllowed).toBe(false)
    expect(view.safeModeAllowed).toBe(true)
    // Non-retryable profile-composition still rolls back and relaunches once;
    // the still-failing relaunch rolls its own fresh transaction back too.
    expect(setup.portCalls.rolledBack).toEqual(['tx-1', 'tx-2'])
  })

  it('clears the in-flight action even when the recovery view port throws', async () => {
    const setup = fixture({
      attemptStart: () => Promise.reject(new StartupFailureError(failure)),
    })
    void setup
    const views: unknown[] = []
    let portThrows = true
    const controller = new RecoverySessionController({
      acquireLease: async () => new RecordingLease(),
      profile: {
        prepare: async () => ({ kind: 'ready', changed: false }),
        settleCommitted: async () => undefined,
        rollback: async () => 'restored',
        retain: async () => undefined,
        enterSafeMode: async () => 'prepared',
        exitSafeMode: async () => undefined,
      },
      createAttempt: () =>
        ({
          start: () => Promise.reject(new StartupFailureError(failure)),
          stop: async () => undefined,
        }) as unknown as HostAttempt,
      loadSurface: async () => undefined,
      window: {
        showRecoveryView: async (view) => {
          views.push(view)
          if (portThrows) {
            portThrows = false
            throw new Error('view port exploded')
          }
        },
        destroySurface: () => undefined,
      },
    })
    await expect(controller.start()).rejects.toThrow('view port exploded')
    // The leaked-rejection guard: a later act() must still run a real retry
    // instead of merging into a stale in-flight promise forever.
    await controller.act('retry')
    expect(views).toHaveLength(2)
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
      profile: {
        prepare: async () => ({ kind: 'ready', changed: false }),
        settleCommitted: async () => undefined,
        rollback: async () => 'restored',
        retain: async () => undefined,
        enterSafeMode: async () => 'prepared',
        exitSafeMode: async () => undefined,
      },
      createAttempt: () => {
        const stub = {
          start: vi.fn(async () => Promise.reject(new StartupFailureError(failure))),
          stop: vi.fn(async () => undefined),
        }
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

  it('enters safe mode from recovery and exits it before a normal retry', async () => {
    let boot = 0
    const setup = fixture({
      attemptStart: () => {
        boot += 1
        return boot === 1
          ? Promise.reject(new StartupFailureError(failure))
          : Promise.resolve(ready)
      },
    })
    await expect(setup.controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    await setup.controller.act('safe-mode')
    expect(setup.controller.state).toBe('healthy')
    expect(setup.attempts.at(-1)?.mode).toBe('safe')
    expect(setup.portCalls.enteredSafeMode).toHaveLength(1)
    // Safe mode became healthy: its boot carries no profile transaction.
    expect(setup.portCalls.committed).toHaveLength(0)
  })

  it('withdraws the safe-mode entry when the safe profile conflicts', async () => {
    const lease = new RecordingLease()
    const views: unknown[] = []
    const controller = new RecoverySessionController({
      acquireLease: async () => lease,
      profile: {
        prepare: async () => ({ kind: 'ready', changed: false }),
        settleCommitted: async () => undefined,
        rollback: async () => 'restored',
        retain: async () => undefined,
        enterSafeMode: async () => 'conflict',
        exitSafeMode: async () => undefined,
      },
      createAttempt: () =>
        ({
          start: () => Promise.reject(new StartupFailureError(failure)),
          stop: async () => undefined,
        }) as unknown as HostAttempt,
      loadSurface: async () => undefined,
      window: {
        showRecoveryView: async (view) => {
          views.push(view)
        },
        destroySurface: () => undefined,
      },
    })
    await expect(controller.start()).rejects.toBeInstanceOf(StartupFailureError)
    await controller.act('safe-mode')
    expect(controller.state).toBe('recovery')
    const view = controller.getView() as { safeModeAllowed: boolean }
    expect(view.safeModeAllowed).toBe(false)
    expect(views).toHaveLength(2)
  })
})
