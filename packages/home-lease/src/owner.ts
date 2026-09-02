export type ProcessIdentity = Readonly<{ pid: number; startIdentity: string }>

export type LeaseEntrypoint = 'desktop' | 'bundled-cli'

export type LeaseOwner = Readonly<{
  schemaVersion: 1
  generation: string
  supervisor: ProcessIdentity
  host: ProcessIdentity | null
  pendingSpawn: boolean
  entrypoint: LeaseEntrypoint
  profile: string
  createdAt: string
  appVersion: string
}>

export type LeaseOwnerParseResult = Readonly<
  { kind: 'ok'; owner: LeaseOwner } | { kind: 'corrupt' }
>

export type LeaseErrorCode =
  | 'HOME_BUSY'
  | 'HOME_STALE'
  | 'LEASE_UNKNOWN'
  | 'LEASE_CHANGED'
  | 'LEASE_NOT_HELD'
  | 'LEASE_STATE'
  | 'LEASE_PROFILE_MISMATCH'
  | 'HOST_ACTIVE'
  | 'PENDING_SPAWN'
  | 'GUARD_BUSY'
  | 'LEASE_HELPER_UNAVAILABLE'

export class LeaseError extends Error {
  readonly code: LeaseErrorCode
  readonly ownerSummary: string | undefined

  constructor(code: LeaseErrorCode, message: string, ownerSummary?: string) {
    super(message)
    this.name = 'LeaseError'
    this.code = code
    this.ownerSummary = ownerSummary
  }
}

export function describeLeaseOwner(owner: LeaseOwner): string {
  const host =
    owner.host === null ? 'none' : `host=${owner.host.pid}${owner.pendingSpawn ? ' pending' : ''}`
  return `entrypoint=${owner.entrypoint} profile=${owner.profile} supervisor=${owner.supervisor.pid} ${host} createdAt=${owner.createdAt}`
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startIdentity === 'string' &&
    record.startIdentity.length > 0
  )
}

const entrypoints: readonly LeaseEntrypoint[] = ['desktop', 'bundled-cli']

/** Stable on-disk representation; keep field order fixed for readable diffs. */
export function serializeLeaseOwner(owner: LeaseOwner): string {
  return `${JSON.stringify(
    {
      schemaVersion: owner.schemaVersion,
      generation: owner.generation,
      supervisor: owner.supervisor,
      host: owner.host,
      pendingSpawn: owner.pendingSpawn,
      entrypoint: owner.entrypoint,
      profile: owner.profile,
      createdAt: owner.createdAt,
      appVersion: owner.appVersion,
    },
    null,
    2,
  )}\n`
}

/** Closed-schema validation: unknown fields or shapes are corruption. */
export function parseLeaseOwner(raw: string): LeaseOwnerParseResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { kind: 'corrupt' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'corrupt' }
  }
  const record = value as Record<string, unknown>
  const expectedKeys: readonly string[] = [
    'schemaVersion',
    'generation',
    'supervisor',
    'host',
    'pendingSpawn',
    'entrypoint',
    'profile',
    'createdAt',
    'appVersion',
  ]
  const actualKeys = Object.keys(record).sort()
  if (actualKeys.length !== expectedKeys.length) return { kind: 'corrupt' }
  for (const key of expectedKeys) {
    if (!(key in record)) return { kind: 'corrupt' }
  }
  if (record.schemaVersion !== 1) return { kind: 'corrupt' }
  if (typeof record.generation !== 'string' || record.generation.length === 0) {
    return { kind: 'corrupt' }
  }
  if (!isProcessIdentity(record.supervisor)) return { kind: 'corrupt' }
  if (record.host !== null && !isProcessIdentity(record.host)) return { kind: 'corrupt' }
  if (typeof record.pendingSpawn !== 'boolean') return { kind: 'corrupt' }
  if (
    typeof record.entrypoint !== 'string' ||
    !entrypoints.includes(record.entrypoint as LeaseEntrypoint)
  ) {
    return { kind: 'corrupt' }
  }
  if (typeof record.profile !== 'string' || record.profile.length === 0) {
    return { kind: 'corrupt' }
  }
  if (typeof record.createdAt !== 'string' || record.createdAt.length === 0) {
    return { kind: 'corrupt' }
  }
  if (typeof record.appVersion !== 'string') return { kind: 'corrupt' }
  return {
    kind: 'ok',
    owner: Object.freeze({
      schemaVersion: 1,
      generation: record.generation,
      supervisor: record.supervisor,
      host: record.host,
      pendingSpawn: record.pendingSpawn,
      entrypoint: record.entrypoint as LeaseEntrypoint,
      profile: record.profile,
      createdAt: record.createdAt,
      appVersion: record.appVersion,
    }),
  }
}
