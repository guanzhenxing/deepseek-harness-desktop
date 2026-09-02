import { describe, expect, it, vi } from 'vitest'

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

function fixture(options: { stabilityMs?: number; startupTimeoutMs?: number } = {}) {
  const process = new FakeProcess()
  const events: string[] = []
  const supervisor = new HostSupervisor({
    factory: {
      async spawn(bootstrap) {
        process.bootstrap = bootstrap
        return process
      },
    },
    stabilityMs: options.stabilityMs ?? 0,
    startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
    terminateGraceMs: 100,
    onEvent: (event) => events.push(event.kind),
  })
  return { events, process, supervisor }
}

async function startAndHello(setup: ReturnType<typeof fixture>) {
  const started = setup.supervisor.start({
    home: '/tmp/isolated-home',
    profileName: 'desktop',
    mode: 'normal',
    leaseGeneration: 'lease-generation-1',
  })
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

describe('HostSupervisor', () => {
  it('bounds startup when the Host never sends hello', async () => {
    vi.useFakeTimers()
    try {
      const setup = fixture({ startupTimeoutMs: 250 })
      const started = setup.supervisor.start({
        home: '/tmp/isolated-home',
        profileName: 'desktop',
        mode: 'normal',
        leaseGeneration: 'lease-generation-1',
      })
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

  it('classifies an exit before ready as BOOT_FAILED', async () => {
    const setup = fixture()
    const { started } = await startAndHello(setup)
    setup.process.emitExit(1)
    await expect(started).rejects.toMatchObject({ code: 'BOOT_FAILED' })
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
    expect(setup.events).toContain('crashed')
    expect(setup.supervisor.state).toBe('failed')
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
    expect(
      setup.process.posted.filter(
        (item) => (item as { message?: { kind?: string } }).message?.kind === 'dispose',
      ),
    ).toHaveLength(1)
    setup.process.emitMessage(hostWriter.next({ kind: 'dispose-ack', outcome: 'disposed' }))
    setup.process.emitExit(0)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
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
