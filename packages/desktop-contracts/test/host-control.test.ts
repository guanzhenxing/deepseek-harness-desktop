import { describe, expect, it } from 'vitest'

import {
  HOST_CONTROL_PROTOCOL,
  LauncherProtocolSession,
  createEnvelopeWriter,
  negotiateMinor,
  parseHostEnvelope,
  redactDiagnostic,
  validateLoopbackSurface,
  type HostControlError,
} from '../src/host-control.js'
import { hostNewHello, launcherOldMinorRange } from './fixtures/host-new-launcher-old.js'
import { hostOldHello, launcherMinorRange } from './fixtures/host-old-launcher-new.js'

const capability = 'c'.repeat(43)
const leaseGeneration = 'lease-generation-1'
const host = { pid: 4321, startIdentity: 'start-123' }

function writer() {
  return createEnvelopeWriter('host-to-launcher', capability, leaseGeneration)
}

function hello(overrides: Record<string, unknown> = {}) {
  return writer().next({
    kind: 'hello',
    host,
    profile: { name: 'desktop' },
    mode: 'normal',
    supportedMinor: { min: 0, max: 0 },
    ...overrides,
  })
}

describe('Host-control envelope', () => {
  it('accepts a closed, correctly directed Host envelope', () => {
    expect(parseHostEnvelope(hello()).message.kind).toBe('hello')
  })

  it.each([
    [{ ...hello(), direction: 'launcher-to-host' }, 'INVALID_ENVELOPE'],
    [{ ...hello(), extra: true }, 'INVALID_ENVELOPE'],
    [{ ...hello(), sequence: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_ENVELOPE'],
    [{ ...hello(), protocol: { ...HOST_CONTROL_PROTOCOL, major: 2 } }, 'PROTOCOL_MISMATCH'],
  ] as const)('rejects malformed envelopes', (input, code) => {
    expect(() => parseHostEnvelope(input)).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code }),
    )
  })

  it('rejects prototype-pollution keys', () => {
    const input = JSON.parse(JSON.stringify(hello()).replace(/}$/, ',"__proto__":{"x":1}}'))
    expect(() => parseHostEnvelope(input)).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code: 'INVALID_ENVELOPE' }),
    )
  })
})

describe('minor negotiation', () => {
  it('selects the highest common minor', () => {
    expect(negotiateMinor({ min: 0, max: 2 }, { min: 0, max: 1 })).toBe(1)
  })

  it('rejects ranges without an intersection', () => {
    expect(() => negotiateMinor({ min: 2, max: 3 }, { min: 0, max: 1 })).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code: 'PROTOCOL_MISMATCH' }),
    )
  })

  it('keeps both old/new fixture directions compatible at minor zero', () => {
    expect(
      negotiateMinor(
        hostOldHello.message.kind === 'hello'
          ? hostOldHello.message.supportedMinor
          : { min: 9, max: 9 },
        launcherMinorRange,
      ),
    ).toBe(0)
    expect(
      negotiateMinor(
        hostNewHello.message.kind === 'hello'
          ? hostNewHello.message.supportedMinor
          : { min: 9, max: 9 },
        launcherOldMinorRange,
      ),
    ).toBe(0)
  })
})

describe('loopback surface', () => {
  it('returns the stable origin for an authenticated loopback URL', () => {
    expect(
      validateLoopbackSurface({ kind: 'loopback', url: 'http://127.0.0.1:3080/login?t=x' }),
    ).toBe('http://127.0.0.1:3080')
  })

  it.each([
    'http://localhost:3080/',
    'http://127.0.0.1/',
    'http://127.0.0.1:0/',
    'ftp://127.0.0.1:3080/',
    'http://user@127.0.0.1:3080/',
    'http://127.0.0.1:3080/#secret',
  ])('rejects %s', (url) => {
    expect(() => validateLoopbackSurface({ kind: 'loopback', url })).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code: 'SURFACE_REJECTED' }),
    )
  })
})

describe('launcher protocol session', () => {
  it('accepts the legal normal startup and bounded dispose flow', () => {
    const hostWriter = writer()
    const session = new LauncherProtocolSession({
      capability,
      leaseGeneration,
      expectedHost: host,
      profileName: 'desktop',
      mode: 'normal',
    })

    session.receive(
      hostWriter.next({
        kind: 'hello',
        host,
        profile: { name: 'desktop' },
        mode: 'normal',
        supportedMinor: { min: 0, max: 0 },
      }),
    )
    expect(session.accept().message).toEqual({ kind: 'accept', selectedMinor: 0 })
    session.receive(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    session.receive(hostWriter.next({ kind: 'phase', phase: 'services-ready' }))
    session.receive(
      hostWriter.next({
        kind: 'surface',
        surfaceId: 'normal-1',
        purpose: 'normal',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:3080/?token=secret' },
      }),
    )
    session.receive(hostWriter.next({ kind: 'ready', surfaceId: 'normal-1' }))
    expect(session.state).toBe('host-ready')
    expect(session.dispose('quit', 5_000).message.kind).toBe('dispose')
    session.receive(hostWriter.next({ kind: 'dispose-ack', outcome: 'disposed' }))
    expect(session.state).toBe('disposed')
  })

  it.each([
    ['capability', 'x'.repeat(43), 'INVALID_CAPABILITY'],
    ['leaseGeneration', 'different-lease', 'LEASE_MISMATCH'],
  ] as const)('rejects a wrong %s', (field, value, code) => {
    const session = new LauncherProtocolSession({
      capability,
      leaseGeneration,
      expectedHost: host,
      profileName: 'desktop',
      mode: 'normal',
    })
    const input = { ...hello(), [field]: value }
    expect(() => session.receive(input)).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code }),
    )
  })

  it('rejects skipped, repeated and reversed sequences', () => {
    for (const sequence of [2, 0]) {
      const session = new LauncherProtocolSession({
        capability,
        leaseGeneration,
        expectedHost: host,
        profileName: 'desktop',
        mode: 'normal',
      })
      expect(() => session.receive({ ...hello(), sequence })).toThrowError(
        expect.objectContaining<Partial<HostControlError>>({ code: 'INVALID_ENVELOPE' }),
      )
    }

    const repeated = new LauncherProtocolSession({
      capability,
      leaseGeneration,
      expectedHost: host,
      profileName: 'desktop',
      mode: 'normal',
    })
    const first = hello()
    repeated.receive(first)
    expect(() => repeated.receive(first)).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code: 'INVALID_ENVELOPE' }),
    )
  })

  it('rejects identity, ready-before-surface and purpose mismatches', () => {
    const badIdentity = new LauncherProtocolSession({
      capability,
      leaseGeneration,
      expectedHost: host,
      profileName: 'desktop',
      mode: 'normal',
    })
    expect(() => badIdentity.receive(hello({ host: { ...host, pid: 9 } }))).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code: 'HOST_IDENTITY_MISMATCH' }),
    )

    const hostWriter = writer()
    const session = new LauncherProtocolSession({
      capability,
      leaseGeneration,
      expectedHost: host,
      profileName: 'desktop',
      mode: 'normal',
    })
    session.receive(
      hostWriter.next({
        kind: 'hello',
        host,
        profile: { name: 'desktop' },
        mode: 'normal',
        supportedMinor: { min: 0, max: 0 },
      }),
    )
    session.accept()
    session.receive(hostWriter.next({ kind: 'phase', phase: 'booting' }))
    expect(() =>
      session.receive(hostWriter.next({ kind: 'ready', surfaceId: 'missing' })),
    ).toThrowError(
      expect.objectContaining<Partial<HostControlError>>({ code: 'INVALID_TRANSITION' }),
    )
  })
})

describe('diagnostic redaction', () => {
  it('redacts capability, authenticated URL and home path', () => {
    const message = `failed ${capability} at http://127.0.0.1:3080/?token=secret in /tmp/private-home/profile`
    const redacted = redactDiagnostic(message, { capability, home: '/tmp/private-home' })
    expect(redacted).not.toContain(capability)
    expect(redacted).not.toContain('token=secret')
    expect(redacted).not.toContain('/tmp/private-home')
    expect(redacted).toContain('[REDACTED_URL]')
  })
})
