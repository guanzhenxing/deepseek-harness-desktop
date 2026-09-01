import { createHash, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

export const HOST_CONTROL_PROTOCOL = {
  name: 'dsh-desktop/host-control',
  major: 1,
  minor: 0,
} as const

export type HostControlErrorCode =
  | 'PROTOCOL_MISMATCH'
  | 'INVALID_ENVELOPE'
  | 'INVALID_CAPABILITY'
  | 'LEASE_MISMATCH'
  | 'HOST_IDENTITY_MISMATCH'
  | 'INVALID_TRANSITION'
  | 'SURFACE_REJECTED'
  | 'BOOT_FAILED'
  | 'HOST_CRASHED'
  | 'DISPOSE_TIMEOUT'

export class HostControlError extends Error {
  readonly code: HostControlErrorCode

  constructor(code: HostControlErrorCode, message: string) {
    super(message)
    this.name = 'HostControlError'
    this.code = code
  }
}

const boundedString = z.string().min(1).max(256)
const protocolSchema = z
  .object({
    name: z.literal(HOST_CONTROL_PROTOCOL.name),
    major: z.literal(HOST_CONTROL_PROTOCOL.major),
    minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

const hostIdentitySchema = z
  .object({ pid: z.number().int().positive().safe(), startIdentity: boundedString })
  .strict()

const minorRangeSchema = z
  .object({ min: z.number().int().min(0).safe(), max: z.number().int().min(0).safe() })
  .strict()
  .refine((range) => range.min <= range.max)

const loopbackSurfaceSchema = z
  .object({ kind: z.literal('loopback'), url: z.string().min(1).max(4096) })
  .strict()

const hostMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('hello'),
      host: hostIdentitySchema,
      profile: z.object({ name: boundedString }).strict(),
      mode: z.enum(['normal', 'safe']),
      supportedMinor: minorRangeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('phase'),
      phase: z.enum(['booting', 'services-ready', 'surface-waiting', 'draining']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('surface'),
      surfaceId: boundedString,
      purpose: z.enum(['normal', 'recovery']),
      surface: loopbackSurfaceSchema,
    })
    .strict(),
  z.object({ kind: z.literal('ready'), surfaceId: boundedString }).strict(),
  z
    .object({ kind: z.literal('dispose-ack'), outcome: z.enum(['disposed', 'already-disposed']) })
    .strict(),
  z
    .object({
      kind: z.literal('fatal'),
      stage: boundedString,
      code: boundedString,
      summary: z.string().min(1).max(1024),
      retryable: z.boolean(),
    })
    .strict(),
])

const launcherMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept'), selectedMinor: z.literal(0) }).strict(),
  z
    .object({
      kind: z.literal('dispose'),
      reason: z.enum(['quit', 'restart', 'profile-switch', 'update']),
      deadlineMs: z.number().int().min(1000).max(30_000),
    })
    .strict(),
])

function envelopeSchema<Schema extends z.ZodType>(
  direction: 'launcher-to-host' | 'host-to-launcher',
  message: Schema,
) {
  return z
    .object({
      protocol: protocolSchema,
      direction: z.literal(direction),
      capability: z.string().min(32).max(128),
      leaseGeneration: z.string().min(8).max(128),
      sequence: z.number().int().positive().safe(),
      message,
    })
    .strict()
}

const hostEnvelopeSchema = envelopeSchema('host-to-launcher', hostMessageSchema)
const launcherEnvelopeSchema = envelopeSchema('launcher-to-host', launcherMessageSchema)

export type HostIdentity = z.infer<typeof hostIdentitySchema>
export type LoopbackSurface = z.infer<typeof loopbackSurfaceSchema>
export type HostToLauncherMessage = z.infer<typeof hostMessageSchema>
export type LauncherToHostMessage = z.infer<typeof launcherMessageSchema>
export type HostEnvelope = z.infer<typeof hostEnvelopeSchema>
export type LauncherEnvelope = z.infer<typeof launcherEnvelopeSchema>
export type MinorRange = z.infer<typeof minorRangeSchema>

function protocolMismatch(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || !('protocol' in input)) return false
  const protocol = input.protocol
  if (typeof protocol !== 'object' || protocol === null) return false
  const record = protocol as Record<string, unknown>
  return record.name !== HOST_CONTROL_PROTOCOL.name || record.major !== HOST_CONTROL_PROTOCOL.major
}

function parseEnvelope<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  if (protocolMismatch(input))
    throw new HostControlError('PROTOCOL_MISMATCH', 'Host-control protocol is incompatible')
  const result = schema.safeParse(input)
  if (!result.success)
    throw new HostControlError('INVALID_ENVELOPE', 'Host-control envelope is invalid')
  return result.data
}

export function parseHostEnvelope(input: unknown): HostEnvelope {
  return parseEnvelope(hostEnvelopeSchema, input)
}

export function parseLauncherEnvelope(input: unknown): LauncherEnvelope {
  return parseEnvelope(launcherEnvelopeSchema, input)
}

export function negotiateMinor(
  host: MinorRange,
  launcher: MinorRange = { min: 0, max: 0 },
): number {
  const parsedHost = minorRangeSchema.safeParse(host)
  const parsedLauncher = minorRangeSchema.safeParse(launcher)
  if (!parsedHost.success || !parsedLauncher.success) {
    throw new HostControlError('PROTOCOL_MISMATCH', 'Host-control minor range is invalid')
  }
  const selected = Math.min(parsedHost.data.max, parsedLauncher.data.max)
  if (selected < Math.max(parsedHost.data.min, parsedLauncher.data.min)) {
    throw new HostControlError('PROTOCOL_MISMATCH', 'Host-control minor versions do not overlap')
  }
  return selected
}

export function validateLoopbackSurface(surface: LoopbackSurface): string {
  const parsed = loopbackSurfaceSchema.safeParse(surface)
  if (!parsed.success)
    throw new HostControlError('SURFACE_REJECTED', 'Surface descriptor is invalid')
  let url: URL
  try {
    url = new URL(parsed.data.url)
  } catch {
    throw new HostControlError('SURFACE_REJECTED', 'Surface URL is invalid')
  }
  const portMatch = /^(?:https?):\/\/127\.0\.0\.1:(\d+)(?:[/?#]|$)/u.exec(parsed.data.url)
  const port = portMatch?.[1] === undefined ? Number.NaN : Number(portMatch[1])
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new HostControlError('SURFACE_REJECTED', 'Surface must be an explicit loopback origin')
  }
  return url.origin
}

type Direction = 'launcher-to-host' | 'host-to-launcher'
type DirectionMessage<Selected extends Direction> = Selected extends 'host-to-launcher'
  ? HostToLauncherMessage
  : LauncherToHostMessage
type DirectionEnvelope<Selected extends Direction> = Selected extends 'host-to-launcher'
  ? HostEnvelope
  : LauncherEnvelope

export function createEnvelopeWriter<Selected extends Direction>(
  direction: Selected,
  capability: string,
  leaseGeneration: string,
) {
  let sequence = 0
  return {
    next(message: DirectionMessage<Selected>): DirectionEnvelope<Selected> {
      sequence += 1
      return {
        protocol: HOST_CONTROL_PROTOCOL,
        direction,
        capability,
        leaseGeneration,
        sequence,
        message,
      } as DirectionEnvelope<Selected>
    },
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

export type LauncherProtocolState =
  | 'channel-created'
  | 'hello-received'
  | 'accepted'
  | 'booting'
  | 'services-ready'
  | 'surface-waiting'
  | 'surface-received'
  | 'host-ready'
  | 'draining'
  | 'disposed'
  | 'failed'

export type LauncherProtocolOptions = {
  capability: string
  leaseGeneration: string
  expectedHost: HostIdentity
  profileName: string
  mode: 'normal' | 'safe'
  supportedMinor?: MinorRange
}

const phaseOrder = ['booting', 'services-ready', 'surface-waiting', 'draining'] as const

export class LauncherProtocolSession {
  #expectedSequence = 1
  #surfaceId: string | undefined
  #selectedMinor: number | undefined
  #disposeEnvelope: LauncherEnvelope | undefined
  readonly #writer
  readonly #options: LauncherProtocolOptions
  state: LauncherProtocolState = 'channel-created'

  constructor(options: LauncherProtocolOptions) {
    this.#options = options
    this.#writer = createEnvelopeWriter(
      'launcher-to-host',
      options.capability,
      options.leaseGeneration,
    )
  }

  receive(input: unknown): HostToLauncherMessage {
    const envelope = parseHostEnvelope(input)
    if (!constantTimeEqual(envelope.capability, this.#options.capability)) {
      this.state = 'failed'
      throw new HostControlError('INVALID_CAPABILITY', 'Host capability does not match')
    }
    if (!constantTimeEqual(envelope.leaseGeneration, this.#options.leaseGeneration)) {
      this.state = 'failed'
      throw new HostControlError('LEASE_MISMATCH', 'Host lease generation does not match')
    }
    if (envelope.sequence !== this.#expectedSequence) {
      this.state = 'failed'
      throw new HostControlError('INVALID_ENVELOPE', 'Host message sequence is not contiguous')
    }
    this.#expectedSequence += 1
    this.#transition(envelope.message)
    return envelope.message
  }

  accept(): LauncherEnvelope {
    if (this.state !== 'hello-received' || this.#selectedMinor !== 0) this.#invalidTransition()
    this.state = 'accepted'
    return this.#writer.next({ kind: 'accept', selectedMinor: 0 })
  }

  dispose(
    reason: Extract<LauncherToHostMessage, { kind: 'dispose' }>['reason'],
    deadlineMs: number,
  ): LauncherEnvelope {
    if (this.#disposeEnvelope !== undefined) return this.#disposeEnvelope
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1_000 || deadlineMs > 30_000) {
      throw new HostControlError(
        'INVALID_ENVELOPE',
        'Dispose deadline is outside the protocol bounds',
      )
    }
    if (
      ![
        'accepted',
        'booting',
        'services-ready',
        'surface-waiting',
        'surface-received',
        'host-ready',
      ].includes(this.state)
    ) {
      this.#invalidTransition()
    }
    this.state = 'draining'
    this.#disposeEnvelope = this.#writer.next({ kind: 'dispose', reason, deadlineMs })
    return this.#disposeEnvelope
  }

  #transition(message: HostToLauncherMessage): void {
    if (this.state === 'disposed' || this.state === 'failed') this.#invalidTransition()
    switch (message.kind) {
      case 'hello': {
        if (this.state !== 'channel-created') this.#invalidTransition()
        if (
          message.host.pid !== this.#options.expectedHost.pid ||
          message.host.startIdentity !== this.#options.expectedHost.startIdentity
        ) {
          this.state = 'failed'
          throw new HostControlError(
            'HOST_IDENTITY_MISMATCH',
            'Host process identity does not match',
          )
        }
        if (
          message.profile.name !== this.#options.profileName ||
          message.mode !== this.#options.mode
        ) {
          this.state = 'failed'
          throw new HostControlError(
            'HOST_IDENTITY_MISMATCH',
            'Host launch identity does not match',
          )
        }
        this.#selectedMinor = negotiateMinor(message.supportedMinor, this.#options.supportedMinor)
        this.state = 'hello-received'
        return
      }
      case 'phase': {
        if (this.state === 'draining' && message.phase === 'draining') return
        const currentIndex = phaseOrder.indexOf(this.state as (typeof phaseOrder)[number])
        const nextIndex = phaseOrder.indexOf(message.phase)
        if (
          this.state === 'accepted' ? nextIndex < 0 : currentIndex < 0 || nextIndex <= currentIndex
        ) {
          this.#invalidTransition()
        }
        this.state = message.phase
        return
      }
      case 'surface': {
        if (
          !['booting', 'services-ready', 'surface-waiting'].includes(this.state) ||
          this.#surfaceId !== undefined
        ) {
          this.#invalidTransition()
        }
        const expectedPurpose = this.#options.mode === 'normal' ? 'normal' : 'recovery'
        if (message.purpose !== expectedPurpose) {
          this.state = 'failed'
          throw new HostControlError('SURFACE_REJECTED', 'Surface purpose does not match Host mode')
        }
        validateLoopbackSurface(message.surface)
        this.#surfaceId = message.surfaceId
        this.state = 'surface-received'
        return
      }
      case 'ready':
        if (this.state !== 'surface-received' || message.surfaceId !== this.#surfaceId)
          this.#invalidTransition()
        this.state = 'host-ready'
        return
      case 'dispose-ack':
        if (this.state !== 'draining') this.#invalidTransition()
        this.state = 'disposed'
        return
      case 'fatal':
        this.state = 'failed'
        return
    }
  }

  #invalidTransition(): never {
    this.state = 'failed'
    throw new HostControlError(
      'INVALID_TRANSITION',
      'Host-control message is invalid in the current state',
    )
  }
}

export function redactDiagnostic(
  message: string,
  secrets: { capability?: string; home?: string } = {},
): string {
  let output = message.replace(/https?:\/\/[^\s]+/gu, '[REDACTED_URL]')
  if (secrets.capability !== undefined && secrets.capability !== '') {
    output = output.replaceAll(secrets.capability, '[REDACTED_CAPABILITY]')
  }
  if (secrets.home !== undefined && secrets.home !== '') {
    output = output.replaceAll(secrets.home, '[REDACTED_HOME]')
  }
  return output
}
