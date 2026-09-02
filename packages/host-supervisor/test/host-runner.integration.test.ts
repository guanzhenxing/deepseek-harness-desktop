import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createEnvelopeWriter,
  parseHostEnvelope,
  type LauncherEnvelope,
} from '@dsh-desktop/desktop-contracts'
import {
  createIsolatedHomeAuthority,
  createProfileRef,
  reconcileDesktopProfile,
} from '@dsh-desktop/profile-manager'

import { runDshHost, type HostControlTransport } from '../src/host-runner.js'
import { HostSupervisor, type HostBootstrap, type ManagedHostProcess } from '../src/supervisor.js'

const homes: string[] = []

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true })
})

class LoopbackTransport implements HostControlTransport {
  readonly messages: unknown[] = []
  #listener: ((message: unknown) => void) | undefined
  readonly #launcherWriter

  constructor(
    readonly capability: string,
    readonly leaseGeneration: string,
  ) {
    this.#launcherWriter = createEnvelopeWriter('launcher-to-host', capability, leaseGeneration)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
    const envelope = parseHostEnvelope(message)
    if (envelope.message.kind === 'hello') {
      queueMicrotask(() =>
        this.emit(this.#launcherWriter.next({ kind: 'accept', selectedMinor: 0 })),
      )
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#listener = listener
    return () => {
      this.#listener = undefined
    }
  }

  emit(message: LauncherEnvelope): void {
    this.#listener?.(message)
  }

  dispose(reason: 'quit' | 'restart' | 'profile-switch' | 'update' = 'quit'): void {
    this.emit(this.#launcherWriter.next({ kind: 'dispose', reason, deadlineMs: 5_000 }))
  }
}

class NodeManagedHostProcess implements ManagedHostProcess {
  readonly pid: number
  readonly startIdentity: string
  readonly #child: ChildProcess

  constructor(child: ChildProcess, startIdentity: string) {
    if (child.pid === undefined) throw new Error('forked Host has no PID')
    this.#child = child
    this.pid = child.pid
    this.startIdentity = startIdentity
  }

  postMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      throw new Error('Node Host test transport accepts only structured messages')
    }
    this.#child.send(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#child.on('message', listener)
    return () => this.#child.off('message', listener)
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    this.#child.on('exit', listener)
    return () => this.#child.off('exit', listener)
  }

  terminate(): void {
    this.#child.kill('SIGTERM')
  }

  kill(): void {
    this.#child.kill('SIGKILL')
  }
}

async function readOfficialBootGraph(surfaceUrl: string): Promise<{
  entries: { id: string }[]
  batches: { phase: string; entries: string[] }[]
}> {
  const login = await fetch(surfaceUrl, { redirect: 'manual' })
  expect([302, 303]).toContain(login.status)
  const location = login.headers.get('location')
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
  if (location === null || cookie === undefined)
    throw new Error('authenticated surface did not establish a session')
  const page = await fetch(new URL(location, surfaceUrl), { headers: { cookie } })
  expect(page.status).toBe(200)
  const html = await page.text()
  const bootMatch = /globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/u.exec(html)
  if (bootMatch?.[1] === undefined) throw new Error('official page did not inject a boot graph')
  return JSON.parse(bootMatch[1]) as {
    entries: { id: string }[]
    batches: { phase: string; entries: string[] }[]
  }
}

function expectCompleteOfficialBootGraph(
  bootGraph: Awaited<ReturnType<typeof readOfficialBootGraph>>,
): void {
  expect(bootGraph.entries.map((entry) => entry.id)).toContain('@deepseek-ai/dsh-client-modules')
  expect(bootGraph.entries.map((entry) => entry.id)).toContain('@deepseek-ai/dsh-client-ui-sidebar')
  expect(bootGraph.batches).toContainEqual(
    expect.objectContaining({
      phase: 'bootstrap',
      entries: expect.arrayContaining(['@deepseek-ai/dsh-client-modules']),
    }),
  )
}

describe('real DSH Host runner', () => {
  it('boots the desktop profile and publishes an authenticated official Web surface', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-host-runner-'))
    homes.push(home)
    const ref = createProfileRef(home, 'desktop')
    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home))
    const capability = 'c'.repeat(43)
    const leaseGeneration = 'lease-generation-1'
    const transport = new LoopbackTransport(capability, leaseGeneration)

    const host = await runDshHost({
      home,
      profileName: 'desktop',
      mode: 'normal',
      capability,
      leaseGeneration,
      hostIdentity: { pid: process.pid, startIdentity: 'integration-host' },
      transport,
    })

    const envelopes = transport.messages.map((message) => parseHostEnvelope(message))
    expect(envelopes.map((envelope) => envelope.message.kind)).toEqual([
      'hello',
      'phase',
      'phase',
      'surface',
      'ready',
    ])
    const surfaceMessage = envelopes.find(
      (envelope) => envelope.message.kind === 'surface',
    )?.message
    expect(surfaceMessage).toMatchObject({
      kind: 'surface',
      purpose: 'normal',
      surface: { kind: 'loopback' },
    })
    if (surfaceMessage?.kind !== 'surface') throw new Error('surface was not published')
    expectCompleteOfficialBootGraph(await readOfficialBootGraph(surfaceMessage.surface.url))

    transport.dispose()
    await vi.waitFor(() => {
      expect(
        transport.messages.map((message) => parseHostEnvelope(message).message.kind),
      ).toContain('dispose-ack')
    })
    await host.disposed
  }, 60_000)

  it('boots the complete official Web graph from an independent Node Host process', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dsh-node-host-runner-'))
    homes.push(home)
    await reconcileDesktopProfile(
      createProfileRef(home, 'desktop'),
      createIsolatedHomeAuthority(home),
    )
    let child: ChildProcess | undefined
    const supervisor = new HostSupervisor({
      stabilityMs: 0,
      startupTimeoutMs: 30_000,
      factory: {
        async spawn(bootstrap: HostBootstrap): Promise<ManagedHostProcess> {
          const startIdentity = randomUUID()
          child = fork(fileURLToPath(new URL('./fixtures/node-host.mjs', import.meta.url)), [], {
            cwd: fileURLToPath(new URL('../../../apps/desktop-launcher', import.meta.url)),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          })
          const managed = new NodeManagedHostProcess(child, startIdentity)
          setImmediate(() => child?.send({ ...bootstrap, startIdentity }))
          return managed
        },
      },
    })

    const ready = await supervisor.start({
      home,
      profileName: 'desktop',
      mode: 'normal',
      leaseGeneration: randomUUID(),
    })
    expect(ready.pid).not.toBe(process.pid)
    expectCompleteOfficialBootGraph(await readOfficialBootGraph(ready.surface.url))

    await supervisor.stop('quit', 5_000)
    await vi.waitFor(() => expect(child?.exitCode).toBe(0))
  }, 60_000)
})
