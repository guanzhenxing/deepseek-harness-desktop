import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, readFile, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import {
  describeLeaseOwner,
  LeaseError,
  parseLeaseOwner,
  serializeLeaseOwner,
  type LeaseEntrypoint,
  type LeaseOwner,
  type ProcessIdentity,
} from './owner.js'
import type { ProcessProbe } from './process-probe.js'
import {
  createNativeGuardLock,
  resolveLeaseHelperPath,
  type GuardLock,
  type GuardSession,
} from './native-helper.js'

export interface HomeLease {
  readonly home: string
  readonly generation: string
  assertHeld(): Promise<void>
  beforeSpawn(profile: string): Promise<void>
  attachHost(identity: ProcessIdentity): Promise<void>
  confirmHostExited(): Promise<void>
  release(): Promise<void>
}

const homeLeaseBrand = Symbol('dsh-desktop-home-lease')

/**
 * Structural check for genuine `acquireHomeLease` results. Consumers that
 * gate writes on "an active lease" must use this instead of trusting a plain
 * `{ home, generation }` literal.
 */
export function isHomeLease(value: unknown): value is HomeLease {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[homeLeaseBrand] === true &&
    typeof (value as HomeLease).home === 'string' &&
    typeof (value as HomeLease).generation === 'string'
  )
}

export type AcquireHomeLeaseInput = Readonly<{
  home: string
  entrypoint: LeaseEntrypoint
  profile: string
  appVersion: string
  probe: ProcessProbe
  guard?: GuardLock
}>

const RUN_DIRNAME = 'run'
const LOCK_DIRNAME = 'host.lock'
const GUARD_FILENAME = 'host-lease.guard'
const OWNER_FILENAME = 'owner.json'

type LeasePaths = Readonly<{
  run: string
  lockDir: string
  guardPath: string
  ownerPath: string
}>

function leasePaths(home: string): LeasePaths {
  const run = path.join(home, RUN_DIRNAME)
  const lockDir = path.join(run, LOCK_DIRNAME)
  return {
    run,
    lockDir,
    guardPath: path.join(run, GUARD_FILENAME),
    ownerPath: path.join(lockDir, OWNER_FILENAME),
  }
}

function validateHome(home: string): string {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new LeaseError('LEASE_UNKNOWN', 'home lease requires an explicit home')
  }
  const resolved = path.resolve(home)
  if (resolved === path.parse(resolved).root) {
    throw new LeaseError('LEASE_UNKNOWN', 'home lease must not use the filesystem root')
  }
  return resolved
}

function validateProfile(profile: string): string {
  if (
    profile === '' ||
    profile === '.' ||
    profile === '..' ||
    profile.includes('/') ||
    profile.includes('\\')
  ) {
    throw new LeaseError(
      'LEASE_PROFILE_MISMATCH',
      `invalid lease profile ${JSON.stringify(profile)}`,
    )
  }
  return profile
}

async function directoryIdentity(dirname: string, label: string): Promise<Stats> {
  const identity = await lstat(dirname)
  if (identity.isSymbolicLink())
    throw new LeaseError('LEASE_UNKNOWN', `${label} must not be a symlink`)
  if (!identity.isDirectory()) throw new LeaseError('LEASE_UNKNOWN', `${label} must be a directory`)
  return identity
}

async function syncDirectory(dirname: string): Promise<void> {
  const handle = await open(dirname, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensureHomeLayout(paths: LeasePaths): Promise<void> {
  await mkdir(path.dirname(paths.run), { recursive: true, mode: 0o700 })
  await directoryIdentity(path.dirname(paths.run), 'DSH home')
  try {
    await mkdir(paths.run, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await directoryIdentity(paths.run, 'DSH home run directory')
}

async function writeOwnerWithDurability(ownerPath: string, owner: LeaseOwner): Promise<void> {
  await writeFileAtomic(ownerPath, serializeLeaseOwner(owner), {
    mode: 0o600,
    dirMode: 0o700,
  })
  // The upstream atomic writer does not promise crash durability, so fsync the
  // committed owner file and both parent directories here.
  const handle = await open(ownerPath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(path.dirname(ownerPath))
  await syncDirectory(path.dirname(path.dirname(ownerPath)))
}

type ReadOwnerResult = Readonly<
  { kind: 'ok'; owner: LeaseOwner } | { kind: 'missing' } | { kind: 'corrupt' }
>

async function readOwner(ownerPath: string): Promise<ReadOwnerResult> {
  let identity: Stats
  try {
    identity = await lstat(ownerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (identity.isSymbolicLink() || !identity.isFile()) return { kind: 'corrupt' }
  return parseLeaseOwner(await readFile(ownerPath, 'utf8'))
}

/**
 * Acquire the whole-home writer lease. The `host.lock` directory is taken
 * atomically; every owner mutation afterwards happens inside the short
 * advisory-lock guard so two doctors can never race an acquiring wrapper.
 * Stale or unreadable owners are reported, never auto-recovered.
 */
export async function acquireHomeLease(input: AcquireHomeLeaseInput): Promise<HomeLease> {
  const home = validateHome(input.home)
  const profile = validateProfile(input.profile)
  const paths = leasePaths(home)
  await ensureHomeLayout(paths)
  const probe = input.probe
  const guard = input.guard ?? createNativeGuardLock(resolveLeaseHelperPath(process.env))

  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const run = tail.then(operation, operation)
    tail = run.catch(() => undefined)
    return run
  }
  const withGuard = <Value>(operation: () => Promise<Value>): Promise<Value> =>
    serialize(async () => {
      const parent = await directoryIdentity(paths.run, 'DSH home run directory')
      const session: GuardSession = await guard.lock({
        guardPath: paths.guardPath,
        parentDirectory: paths.run,
        parentDev: parent.dev,
        parentIno: parent.ino,
      })
      try {
        return await operation()
      } finally {
        await session.release()
      }
    })

  const contendWithExistingOwner = async (): Promise<never> => {
    const current = await readOwner(paths.ownerPath)
    if (current.kind !== 'ok') {
      throw new LeaseError(
        'LEASE_UNKNOWN',
        current.kind === 'missing'
          ? 'home lock exists without a readable owner file'
          : 'home lock owner file is corrupt',
      )
    }
    const supervisor = await probe.inspect(current.owner.supervisor)
    const host = current.owner.host === null ? 'absent' : await probe.inspect(current.owner.host)
    const summary = describeLeaseOwner(current.owner)
    if (supervisor === 'same' || host === 'same') {
      throw new LeaseError('HOME_BUSY', 'another supported entrypoint holds this home', summary)
    }
    if (supervisor === 'unknown' || host === 'unknown') {
      throw new LeaseError('LEASE_UNKNOWN', 'existing home owner cannot be identified', summary)
    }
    throw new LeaseError('HOME_STALE', 'home lock owner is no longer running', summary)
  }

  await withGuard(async (): Promise<void> => {
    try {
      await mkdir(paths.lockDir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return await contendWithExistingOwner()
      }
      throw error
    }
    const identity = await probe.current()
    const owner: LeaseOwner = Object.freeze({
      schemaVersion: 1,
      generation: randomUUID(),
      supervisor: identity,
      host: null,
      pendingSpawn: false,
      entrypoint: input.entrypoint,
      profile,
      createdAt: new Date().toISOString(),
      appVersion: input.appVersion,
    })
    await writeOwnerWithDurability(paths.ownerPath, owner)
  })

  const lockIdentity = await directoryIdentity(paths.lockDir, 'home lock directory')
  let released = false

  const readOurs = async (): Promise<LeaseOwner> => {
    const current = await readOwner(paths.ownerPath)
    if (current.kind === 'missing' || current.kind === 'corrupt') {
      throw new LeaseError(
        'LEASE_CHANGED',
        current.kind === 'missing'
          ? 'home lock owner file disappeared'
          : 'home lock owner file became corrupt',
      )
    }
    if (current.owner.generation !== supervisorGeneration) {
      throw new LeaseError(
        'LEASE_CHANGED',
        'home lease generation changed',
        describeLeaseOwner(current.owner),
      )
    }
    if ((await probe.inspect(current.owner.supervisor)) !== 'same') {
      throw new LeaseError(
        'LEASE_CHANGED',
        'home lease supervisor identity no longer matches this process',
        describeLeaseOwner(current.owner),
      )
    }
    return current.owner
  }

  const supervisorGeneration: string = await withGuard(async () => {
    const current = await readOwner(paths.ownerPath)
    if (current.kind !== 'ok') {
      throw new LeaseError('LEASE_UNKNOWN', 'freshly written owner file is unreadable')
    }
    return current.owner.generation
  })

  return Object.freeze({
    [homeLeaseBrand]: true as const,
    home,
    get generation(): string {
      return supervisorGeneration
    },
    assertHeld: () =>
      withGuard(async () => {
        if (released) throw new LeaseError('LEASE_NOT_HELD', 'home lease was already released')
        await readOurs()
      }),
    beforeSpawn: (nextProfile: string) =>
      withGuard(async () => {
        if (released) throw new LeaseError('LEASE_NOT_HELD', 'home lease was already released')
        if (nextProfile !== profile) {
          throw new LeaseError(
            'LEASE_PROFILE_MISMATCH',
            `lease covers profile ${JSON.stringify(profile)}, not ${JSON.stringify(nextProfile)}`,
          )
        }
        const owner = await readOurs()
        if (owner.pendingSpawn || owner.host !== null) {
          throw new LeaseError('LEASE_STATE', 'host spawn registration already in progress')
        }
        await writeOwnerWithDurability(paths.ownerPath, {
          ...owner,
          pendingSpawn: true,
        })
      }),
    attachHost: (identity: ProcessIdentity) =>
      withGuard(async () => {
        if (released) throw new LeaseError('LEASE_NOT_HELD', 'home lease was already released')
        if (
          typeof identity.pid !== 'number' ||
          !Number.isInteger(identity.pid) ||
          identity.pid <= 0 ||
          typeof identity.startIdentity !== 'string' ||
          identity.startIdentity.length === 0
        ) {
          throw new LeaseError('LEASE_STATE', 'host identity is malformed')
        }
        const owner = await readOurs()
        if (!owner.pendingSpawn || owner.host !== null) {
          throw new LeaseError('LEASE_STATE', 'host identity arrived without a pending spawn')
        }
        await writeOwnerWithDurability(paths.ownerPath, {
          ...owner,
          host: identity,
          pendingSpawn: false,
        })
      }),
    confirmHostExited: () =>
      withGuard(async () => {
        if (released) throw new LeaseError('LEASE_NOT_HELD', 'home lease was already released')
        const owner = await readOurs()
        if (owner.host === null && !owner.pendingSpawn) return
        await writeOwnerWithDurability(paths.ownerPath, {
          ...owner,
          host: null,
          pendingSpawn: false,
        })
      }),
    release: () =>
      withGuard(async () => {
        if (released) return
        const current = await readOwner(paths.ownerPath)
        if (current.kind === 'missing' || current.kind === 'corrupt') {
          throw new LeaseError(
            'LEASE_UNKNOWN',
            current.kind === 'missing'
              ? 'refusing to release a home lock without an owner file'
              : 'refusing to release a home lock with a corrupt owner file',
          )
        }
        if (current.owner.generation !== supervisorGeneration) {
          throw new LeaseError(
            'LEASE_CHANGED',
            'this handle predates the current home lease generation',
            describeLeaseOwner(current.owner),
          )
        }
        if (current.owner.host !== null) {
          const status = await probe.inspect(current.owner.host)
          if (status === 'same') {
            throw new LeaseError(
              'HOST_ACTIVE',
              'the recorded host process is still running',
              describeLeaseOwner(current.owner),
            )
          }
          if (status === 'unknown') {
            throw new LeaseError(
              'LEASE_UNKNOWN',
              'cannot prove the recorded host process exited',
              describeLeaseOwner(current.owner),
            )
          }
        }
        if (current.owner.pendingSpawn) {
          throw new LeaseError(
            'PENDING_SPAWN',
            'a host spawn is still being registered',
            describeLeaseOwner(current.owner),
          )
        }
        const currentIdentity = await directoryIdentity(paths.lockDir, 'home lock directory')
        if (currentIdentity.dev !== lockIdentity.dev || currentIdentity.ino !== lockIdentity.ino) {
          throw new LeaseError('LEASE_CHANGED', 'home lock directory identity changed')
        }
        await rm(paths.ownerPath, { force: false })
        try {
          await rmdir(paths.lockDir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
            throw new LeaseError(
              'LEASE_UNKNOWN',
              'home lock directory holds unexpected entries; leaving it for doctor',
            )
          }
          throw error
        }
        released = true
      }),
  })
}
