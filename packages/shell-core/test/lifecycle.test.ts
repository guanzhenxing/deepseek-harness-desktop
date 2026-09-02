import { describe, expect, it, vi } from 'vitest'

import type { HomeLease, ProcessIdentity, ProcessProbe } from '@dsh-desktop/home-lease'
import {
  createEnvelopeWriter,
  type HostEnvelope,
} from '@dsh-desktop/desktop-contracts/host-control'
import type { HostReady } from '@dsh-desktop/host-supervisor'
import {
  HostSupervisor,
  type HostBootstrap,
  type ManagedHostProcess,
} from '@dsh-desktop/host-supervisor'

import { DesktopShellController, type HostAttempt } from '../src/lifecycle.js'

const readySurface: HostReady = {
  pid: 4321,
  startIdentity: 'start-123',
  surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=secret' },
  origin: 'http://127.0.0.1:43123',
}

class HandshakeProcess implements ManagedHostProcess {
  readonly pid = 4321
  readonly startIdentity = 'start-123'
  #messageListeners = new Set<(message: unknown) => void>()
  #exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>()
  #exited = false

  constructor(readonly onBootstrap: (bootstrap: HostBootstrap) => void) {}

  deliverBootstrap(bootstrap: HostBootstrap): void {
    queueMicrotask(() => this.onBootstrap(bootstrap))
  }

  postMessage(message: unknown): void {
    const envelope = message as { message?: { kind?: string } }
    if (envelope?.message?.kind === 'dispose') {
      queueMicrotask(() => this.emitExit(0))
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener)
    return () => this.#messageListeners.delete(listener)
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }

  terminate(): void {
    if (!this.#exited) queueMicrotask(() => this.emitExit(null, 'SIGTERM'))
  }

  kill(): void {
    if (!this.#exited) queueMicrotask(() => this.emitExit(null, 'SIGKILL'))
  }

  emitMessage(message: HostEnvelope): void {
    for (const listener of this.#messageListeners) listener(message)
  }

  emitExit(code: number | null = 0, signal: string | null = null): void {
    this.#exited = true
    for (const listener of [...this.#exitListeners]) listener({ code, signal })
  }
}

const fakeProbe: ProcessProbe = {
  async current() {
    return { pid: process.pid, startIdentity: 'probe-self' }
  },
  async identify(pid) {
    return { pid, startIdentity: 'os-identity' }
  },
  async inspect() {
    return 'same' as const
  },
  async scanSupported() {
    return 'none' as const
  },
}

class RecordingLease implements HomeLease {
  readonly home = '/tmp/isolated-home'
  readonly generation = 'lease-generation-1'
  readonly calls: string[] = []
  releaseError: Error | undefined

  constructor(readonly events: string[]) {}

  async assertHeld(): Promise<void> {
    this.calls.push('assertHeld')
    this.events.push('assertHeld')
  }

  async beforeSpawn(profile: string): Promise<void> {
    this.calls.push(`beforeSpawn:${profile}`)
    this.events.push(`beforeSpawn:${profile}`)
  }

  async attachHost(identity: ProcessIdentity): Promise<void> {
    this.calls.push(`attachHost:${identity.pid}`)
    this.events.push(`attachHost:${identity.pid}`)
  }

  async confirmHostExited(): Promise<void> {
    this.calls.push('confirmHostExited')
    this.events.push('confirmHostExited')
  }

  async release(): Promise<void> {
    this.calls.push('release')
    if (this.releaseError !== undefined) throw this.releaseError
  }
}

function fixture(
  options: { acquireError?: Error; loadSurfaceError?: Error; reconcileError?: Error } = {},
) {
  const events: string[] = []
  const lease = new RecordingLease(events)
  const loadSurface = vi.fn(async () => {
    if (options.loadSurfaceError !== undefined) throw options.loadSurfaceError
  })
  const showRecovery = vi.fn(async () => undefined)
  const destroySurface = vi.fn()
  const onLeaseReleaseError = vi.fn()
  const stopHosts: ReturnType<typeof vi.fn>[] = []
  let spawned = 0

  const process = new HandshakeProcess((bootstrap) => {
    const hostWriter = createEnvelopeWriter(
      'host-to-launcher',
      bootstrap.capability,
      bootstrap.leaseGeneration,
    )
    process.emitMessage(
      hostWriter.next({
        kind: 'hello',
        host: { pid: process.pid, startIdentity: process.startIdentity },
        profile: { name: bootstrap.profileName },
        mode: bootstrap.mode,
        supportedMinor: { min: 0, max: 0 },
      }),
    )
    process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    process.emitMessage(
      hostWriter.next({
        kind: 'surface',
        surfaceId: 'surface-1',
        purpose: 'normal',
        surface: { kind: 'loopback', url: readySurface.surface.url },
      }),
    )
    process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
  })

  const createAttempt = (heldLease: HomeLease): HostAttempt => {
    expect(heldLease).toBe(lease)
    const supervisor = new HostSupervisor({
      factory: {
        async spawnWaiting() {
          spawned += 1
          events.push('spawn-waiting')
          return process
        },
      },
      stabilityMs: 0,
      terminateGraceMs: 100,
    })
    const stopHost = vi.fn((reason: 'quit' | 'restart', deadlineMs: number) =>
      supervisor.stop(reason, deadlineMs),
    )
    stopHosts.push(stopHost)
    return {
      async start() {
        const hostReady = await supervisor.start({
          home: '/tmp/isolated-home',
          profileName: 'desktop',
          mode: 'normal',
          lease: heldLease,
          probe: fakeProbe,
        })
        events.push('ready')
        return hostReady
      },
      stop: (reason, deadlineMs) => stopHost(reason, deadlineMs),
    }
  }

  const shell = new DesktopShellController({
    acquireLease: async () => {
      if (options.acquireError !== undefined) {
        events.push('lease-failed')
        throw options.acquireError
      }
      events.push('lease')
      return lease
    },
    reconcile: async () => {
      events.push('reconcile')
      if (options.reconcileError !== undefined) throw options.reconcileError
    },
    createAttempt,
    window: { loadSurface, showRecovery, destroySurface },
    onLeaseReleaseError,
  })

  return {
    createAttempt,
    destroySurface,
    stopHosts,
    events,
    lease,
    loadSurface,
    onLeaseReleaseError,
    process,
    shell,
    showRecovery,
    spawned: () => spawned,
  }
}

describe('DesktopShellController startup chain', () => {
  it('runs lease → reconcile → beforeSpawn → spawn-waiting → attachHost → bootstrap → ready', async () => {
    const setup = fixture()
    await setup.shell.start()
    expect(setup.events).toEqual([
      'lease',
      'reconcile',
      'beforeSpawn:desktop',
      'spawn-waiting',
      'attachHost:4321',
      'ready',
    ])
    expect(setup.loadSurface).toHaveBeenCalledWith(readySurface.surface, readySurface.origin)
    expect(setup.shell.state).toBe('healthy')
  })

  it('never reconciles or spawns when the home is busy', async () => {
    const setup = fixture({ acquireError: new Error('another entrypoint holds this home') })
    await expect(setup.shell.start()).rejects.toThrow('another entrypoint')
    expect(setup.events).toEqual(['lease-failed'])
    expect(setup.spawned()).toBe(0)
    expect(setup.lease.calls).toEqual([])
    expect(setup.showRecovery).toHaveBeenCalledWith('BOOT_FAILED')
    expect(setup.shell.state).toBe('recovery')
  })

  it('stops the Host and releases the lease when surface loading fails', async () => {
    const setup = fixture({ loadSurfaceError: new Error('surface failed to mount') })
    await expect(setup.shell.start()).rejects.toThrow('surface failed to mount')
    expect(setup.stopHosts).toHaveLength(1)
    expect(setup.stopHosts[0]).toHaveBeenCalledWith('quit', 5_000)
    expect(setup.lease.calls).toContain('confirmHostExited')
    expect(setup.lease.calls).toContain('release')
    expect(setup.showRecovery).toHaveBeenCalledWith('BOOT_FAILED')
    expect(setup.shell.state).toBe('recovery')
  })

  it('releases the lease when reconcile fails before any Host exists', async () => {
    const setup = fixture({ reconcileError: new Error('profile write refused') })
    await expect(setup.shell.start()).rejects.toThrow('profile write refused')
    expect(setup.spawned()).toBe(0)
    expect(setup.lease.calls).toContain('release')
    expect(setup.lease.calls).not.toContain('confirmHostExited')
    expect(setup.showRecovery).toHaveBeenCalledWith('BOOT_FAILED')
  })

  it('destroys a stale surface and keeps the shell in recovery after Host crash', async () => {
    const setup = fixture()
    await setup.shell.start()
    await setup.shell.hostCrashed()
    expect(setup.destroySurface).toHaveBeenCalledOnce()
    expect(setup.showRecovery).toHaveBeenCalledWith('HOST_CRASHED')
    expect(setup.lease.calls).not.toContain('release')
    expect(setup.shell.state).toBe('recovery')
  })

  it('stops the Host, confirms its exit, and releases the lease exactly once', async () => {
    const setup = fixture()
    await setup.shell.start()
    await Promise.all([setup.shell.stop(), setup.shell.stop()])
    expect(setup.lease.calls).toContain('confirmHostExited')
    expect(setup.lease.calls.filter((call) => call === 'release')).toHaveLength(1)
    expect(setup.onLeaseReleaseError).not.toHaveBeenCalled()
    expect(setup.shell.state).toBe('stopped')
  })

  it('keeps the lease and reports when release cannot prove the Host is gone', async () => {
    const setup = fixture()
    await setup.shell.start()
    setup.lease.releaseError = new Error('the recorded host process is still running')
    await setup.shell.stop()
    expect(setup.onLeaseReleaseError).toHaveBeenCalledOnce()
    expect(setup.shell.state).toBe('stopped')
  })
})
