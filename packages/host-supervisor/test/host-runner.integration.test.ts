import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
    const response = await fetch(surfaceMessage.surface.url, { redirect: 'manual' })
    expect([200, 302, 303]).toContain(response.status)

    transport.dispose()
    await vi.waitFor(() => {
      expect(
        transport.messages.map((message) => parseHostEnvelope(message).message.kind),
      ).toContain('dispose-ack')
    })
    await host.disposed
  }, 60_000)
})
