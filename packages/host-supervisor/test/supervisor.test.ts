import { describe, expect, it, vi } from 'vitest'

import type { HomeLease, ProcessIdentity, ProcessProbe } from '@dsh-desktop/home-lease'
import {
  createEnvelopeWriter,
  type HostEnvelope,
} from '@dsh-desktop/desktop-contracts/host-control'

import { HostSupervisor, type HostBootstrap, type ManagedHostProcess } from '../src/supervisor.js'

class FakeProcess implements ManagedHostProcess {
  readonly pid = 4321
  readonly startIdentity = 'start-123'
  readonly posted: unknown[] = []
  terminateCount = 0
  killCount = 0
  bootstrap: HostBootstrap | undefined
  #messageListeners = new Set<(message: unknown) => void>()
  #exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>()

  deliverBootstrap(bootstrap: HostBootstrap): void {
    this.bootstrap = bootstrap
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
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
    this.terminateCount += 1
  }

  kill(): void {
    this.killCount += 1
  }

  emitMessage(message: HostEnvelope): void {
    for (const listener of this.#messageListeners) listener(message)
  }

  emitExit(code: number | null = 0, signal: string | null = null): void {
    for (const listener of this.#exitListeners) listener({ code, signal })
  }
}

class RecordingLease implements HomeLease {
  readonly home = '/tmp/isolated-home'
  readonly generation = 'lease-generation-1'
  readonly calls: string[] = []
  refuseAt: 'beforeSpawn' | 'attachHost' | undefined

  async assertHeld(): Promise<void> {
    this.calls.push('assertHeld')
  }

  async beforeSpawn(profile: string): Promise<void> {
    this.calls.push(`beforeSpawn:${profile}`)
    if (this.refuseAt === 'beforeSpawn') throw new Error('lease refused the spawn')
  }

  async attachHost(identity: ProcessIdentity): Promise<void> {
    this.calls.push(`attachHost:${identity.pid}`)
    if (this.refuseAt === 'attachHost') throw new Error('lease refused the host identity')
  }

  async confirmHostExited(): Promise<void> {
    this.calls.push('confirmHostExited')
  }

  async release(): Promise<void> {
    this.calls.push('release')
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

function fixture(options: { stabilityMs?: number; startupTimeoutMs?: number } = {}) {
  const process = new FakeProcess()
  const lease = new RecordingLease()
  const events: string[] = []
  const supervisor = new HostSupervisor({
    factory: {
      async spawnWaiting() {
        events.push('spawn-waiting')
        return process
      },
    },
    stabilityMs: options.stabilityMs ?? 0,
    startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
    terminateGraceMs: 100,
    onEvent: (event) => events.push(event.kind),
  })
  return { events, lease, process, supervisor }
}

function startRequest(lease: RecordingLease) {
  return {
    home: '/tmp/isolated-home',
    profileName: 'desktop',
    mode: 'normal' as const,
    lease,
    probe: fakeProbe,
  }
}

async function startAndHello(setup: ReturnType<typeof fixture>) {
  const started = setup.supervisor.start(startRequest(setup.lease))
  void started.catch(() => undefined)
  await vi.waitFor(() => expect(setup.process.bootstrap).toBeDefined())
  const bootstrap = setup.process.bootstrap!
  const hostWriter = createEnvelopeWriter(
    'host-to-launcher',
    bootstrap.capability,
    bootstrap.leaseGeneration,
  )
  setup.process.emitMessage(
    hostWriter.next({
      kind: 'hello',
      host: { pid: setup.process.pid, startIdentity: setup.process.startIdentity },
      profile: { name: bootstrap.profileName },
      mode: bootstrap.mode,
      supportedMinor: { min: 0, max: 0 },
    }),
  )
  expect(setup.process.posted).toHaveLength(1)
  expect(setup.process.posted[0]).toMatchObject({ message: { kind: 'accept' } })
  return { bootstrap, hostWriter, started }
}

describe('HostSupervisor lease ordering', () => {
  it('persists the pending spawn, registers the OS identity, then authorizes boot', async () => {
    const setup = fixture()
    await startAndHello(setup)
    const order = [setup.lease.calls[0], setup.events[0], setup.lease.calls[1], 'bootstrap']
    expect(setup.lease.calls).toEqual(['beforeSpawn:desktop', 'attachHost:4321'])
    expect(order).toEqual(['beforeSpawn:desktop', 'spawn-waiting', 'attachHost:4321', 'bootstrap'])
    expect(setup.process.bootstrap?.leaseGeneration).toBe('lease-generation-1')
  })

  it('creates no process when the lease refuses the spawn', async () => {
    const setup = fixture()
    setup.lease.refuseAt = 'beforeSpawn'
    await expect(setup.supervisor.start(startRequest(setup.lease))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    expect(setup.events).not.toContain('spawn-waiting')
    expect(setup.process.bootstrap).toBeUndefined()
  })

  it('reaps an unauthorized child and clears the pending spawn when attach fails', async () => {
    const setup = fixture()
    setup.lease.refuseAt = 'attachHost'
    await expect(setup.supervisor.start(startRequest(setup.lease))).rejects.toMatchObject({
      code: 'BOOT_FAILED',
    })
    expect(setup.process.bootstrap).toBeUndefined()
    expect(setup.process.terminateCount).toBeGreaterThanOrEqual(1)
    expect(setup.lease.calls).toContain('confirmHostExited')
  })

  it('waits for a late child when stop races the spawn', async () => {
    const process = new FakeProcess()
    const lease = new RecordingLease()
    let releaseSpawn!: (value: FakeProcess) => void
    const spawnGate = new Promise<FakeProcess>((resolve) => {
      releaseSpawn = resolve
    })
    const supervisor = new HostSupervisor({
      factory: {
        async spawnWaiting() {
          return await spawnGate
        },
      },
      stabilityMs: 0,
      terminateGraceMs: 100,
    })
    const started = supervisor.start(startRequest(lease))
    const stopping = supervisor.stop('quit', 1_000)
    releaseSpawn(process)
    // The late child never completed the handshake, so the pending stop can
    // only terminate it — but it is still reaped, never leaked.
    await vi.waitFor(() => expect(process.terminateCount).toBeGreaterThanOrEqual(1))
    process.emitExit(0)
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
    await stopping
    expect(lease.calls).toContain('confirmHostExited')
    expect(lease.calls).not.toContain('release')
  })
})

describe('HostSupervisor', () => {
  it('bounds startup when the Host never sends hello', async () => {
    vi.useFakeTimers()
    try {
      const setup = fixture({ startupTimeoutMs: 250 })
      const started = setup.supervisor.start(startRequest(setup.lease))
      const outcome = started.catch((error: unknown) => error)
      await vi.waitFor(() => expect(setup.process.bootstrap).toBeDefined())
      await vi.advanceTimersByTimeAsync(250)
      await expect(outcome).resolves.toMatchObject({ code: 'BOOT_FAILED' })
      expect(setup.process.terminateCount).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(setup.process.killCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves only after surface, ready and the stability window', async () => {
    vi.useFakeTimers()
    try {
      const setup = fixture({ stabilityMs: 250 })
      const { hostWriter, started } = await startAndHello(setup)
      setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
      setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'surface-waiting' }))
      setup.process.emitMessage(
        hostWriter.next({
          kind: 'surface',
          surfaceId: 'surface-1',
          purpose: 'normal',
          surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=secret' },
        }),
      )
      setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
      let resolved = false
      void started.then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(started).resolves.toMatchObject({
        pid: 4321,
        surface: { kind: 'loopback' },
        origin: 'http://127.0.0.1:43123',
      })
      expect(setup.events).toContain('healthy')
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies an exit before ready as BOOT_FAILED and confirms the lease exit', async () => {
    const setup = fixture()
    const { started } = await startAndHello(setup)
    setup.process.emitExit(1)
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
    await vi.waitFor(() => expect(setup.lease.calls).toContain('confirmHostExited'))
  })

  it('keeps the supervisor alive and reports HOST_CRASHED after ready', async () => {
    const setup = fixture()
    const { hostWriter, started } = await startAndHello(setup)
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'surface-waiting' }))
    setup.process.emitMessage(
      hostWriter.next({
        kind: 'surface',
        surfaceId: 'surface-1',
        purpose: 'normal',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/' },
      }),
    )
    setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
    await started
    setup.process.emitExit(1, 'SIGKILL')
    await vi.waitFor(() => {
      expect(setup.events).toContain('crashed')
      expect(setup.supervisor.state).toBe('failed')
      expect(setup.lease.calls).toContain('confirmHostExited')
    })
  })

  it('terminates a healthy Host after a protocol violation', async () => {
    const setup = fixture()
    const { hostWriter, started } = await startAndHello(setup)
    setup.process.emitMessage(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    setup.process.emitMessage(
      hostWriter.next({
        kind: 'surface',
        surfaceId: 'surface-1',
        purpose: 'normal',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/' },
      }),
    )
    setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
    await started

    setup.process.emitMessage(hostWriter.next({ kind: 'ready', surfaceId: 'surface-1' }))
    expect(setup.supervisor.state).toBe('failed')
    expect(setup.process.terminateCount).toBe(1)
    expect(setup.events).toContain('crashed')
    setup.process.emitExit(1, 'SIGTERM')
    expect(setup.events.filter((event) => event === 'crashed')).toHaveLength(1)
  })

  it('merges stop requests and accepts dispose ack plus process exit', async () => {
    const setup = fixture()
    const { hostWriter } = await startAndHello(setup)
    const first = setup.supervisor.stop('quit', 1_000)
    const second = setup.supervisor.stop('quit', 1_000)
    await vi.waitFor(() =>
      expect(
        setup.process.posted.filter(
          (item) => (item as { message?: { kind?: string } }).message?.kind === 'dispose',
        ),
      ).toHaveLength(1),
    )
    setup.process.emitMessage(hostWriter.next({ kind: 'dispose-ack', outcome: 'disposed' }))
    setup.process.emitExit(0)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    await vi.waitFor(() => expect(setup.lease.calls).toContain('confirmHostExited'))
  })

  it('escalates from graceful dispose to terminate and force kill', async () => {
    vi.useFakeTimers()
    try {
      const setup = fixture()
      await startAndHello(setup)
      const stopped = setup.supervisor.stop('quit', 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(setup.process.terminateCount).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(setup.process.killCount).toBe(1)
      setup.process.emitExit(null, 'SIGKILL')
      await stopped
    } finally {
      vi.useRealTimers()
    }
  })
})
