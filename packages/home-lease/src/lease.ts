import { randomUUID } from 'node:crypto'
import { mkdir, rm, rmdir } from 'node:fs/promises'

import {
  describeLeaseOwner,
  LeaseError,
  type LeaseEntrypoint,
  type LeaseOwner,
  type ProcessIdentity,
} from './owner.js'
import type { ProcessProbe, ProcessStatus } from './process-probe.js'
import {
  createNativeGuardLock,
  resolveLeaseHelperPath,
  type GuardLock,
  type GuardSession,
} from './native-helper.js'
import {
  directoryIdentity,
  ensureHomeLayout,
  leasePaths,
  readOwner,
  validateHome,
  writeOwnerWithDurability,
} from './lease-fs.js'

export interface HomeLease {
  readonly home: string
  readonly generation: string
  assertHeld(): Promise<void>
  beforeSpawn(profile: string): Promise<void>
  attachHost(identity: ProcessIdentity): Promise<void>
  confirmHostExited(): Promise<void>
  /**
   * Move this lease to a different profile (e.g. entering Safe Mode). The
   * owner record is updated atomically under the guard; requires that no host
   * spawn is pending or registered.
   */
  switchProfile(nextProfile: string): Promise<void>
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

/**
 * Acquire the whole-home writer lease. The `host.lock` directory is taken
 * atomically; every owner mutation afterwards happens inside the short
 * advisory-lock guard so two doctors can never race an acquiring wrapper.
 * Stale or unreadable owners are reported, never auto-recovered.
 */
/**
 * Bounded retry for identity probes: 'unknown' means the helper could not
 * look the process up (transient — e.g. system under load), unlike the
 * determinate 'same'/'absent'/'different'. Retrying a handful of times with
 * a short pause turns quit-path transients into successful releases without
 * weakening the determinate refusals.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Determinate-verdict confirmation for acquisition: a single read that does
 * not say 'same' is re-read once after a pause; only two agreeing non-'same'
 * reads (or an immediate 'different', which encodes a real identity mismatch)
 * are believed. This never weakens refusals — a genuinely dead owner stays
 * 'absent' across both reads — it only absorbs one-sample misreads of a
 * live owner.
 */
async function inspectConfirmed(
  probe: ProcessProbe,
  identity: Parameters<ProcessProbe['inspect']>[0],
  pauseMs = 100,
): Promise<ProcessStatus> {
  const first = await inspectWithRetry(probe, identity)
  if (first === 'same' || first === 'different') return first
  await sleep(pauseMs)
  return inspectWithRetry(probe, identity)
}

async function inspectWithRetry(
  probe: ProcessProbe,
  identity: Parameters<ProcessProbe['inspect']>[0],
  attempts = 3,
  pauseMs = 100,
): Promise<ProcessStatus> {
  let status: ProcessStatus = 'unknown'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = await probe.inspect(identity)
    if (status !== 'unknown') return status
    if (attempt < attempts - 1) await sleep(pauseMs)
  }
  return status
}

export async function acquireHomeLease(input: AcquireHomeLeaseInput): Promise<HomeLease> {
  const home = validateHome(input.home)
  let profile = validateProfile(input.profile)
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
    // A live owner can be transiently misread (proc_pidinfo failures under
    // load surface as 'unknown', and in rarer windows as 'absent'). Declaring
    // a live home stale on one bad read would strand the user behind a lock
    // that doctor would happily "clean" while the app is still running, so
    // every non-'same' verdict is confirmed by a second read after a short
    // pause before it is believed. 'same' is trusted immediately.
    const supervisor = await inspectConfirmed(probe, current.owner.supervisor)
    const host =
      current.owner.host === null ? 'absent' : await inspectConfirmed(probe, current.owner.host)
    const summary = describeLeaseOwner(current.owner)
    if (supervisor === 'same' || host === 'same') {
      throw new LeaseError('HOME_BUSY', 'another supported entrypoint holds this home', summary)
    }
    if (supervisor === 'unknown' || host === 'unknown') {
      throw new LeaseError('LEASE_UNKNOWN', 'existing home owner cannot be identified', summary)
    }
    throw new LeaseError('HOME_STALE', 'home lock owner is no longer running', summary)
  }

  // Acquisition maps guard contention to HOME_BUSY: many simultaneous
  // entries are exactly the "another entrypoint is using this home" case,
  // whatever layer refused first.
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
  }).catch((error: unknown) => {
    if (error instanceof LeaseError && error.code === 'GUARD_BUSY') {
      throw new LeaseError(
        'HOME_BUSY',
        'the home lock critical section is contended by another entrypoint',
      )
    }
    throw error
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
    switchProfile: (nextProfile: string) =>
      withGuard(async () => {
        if (released) throw new LeaseError('LEASE_NOT_HELD', 'home lease was already released')
        const validated = validateProfile(nextProfile)
        const owner = await readOurs()
        if (owner.pendingSpawn || owner.host !== null) {
          throw new LeaseError(
            'LEASE_STATE',
            'the lease profile can only change while no host is registered',
          )
        }
        if (validated === owner.profile) return
        await writeOwnerWithDurability(paths.ownerPath, { ...owner, profile: validated })
        profile = validated
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
        // Re-verify the supervisor identity inside the guard: a matching
        // generation alone must never authorize removal. A determinate
        // non-match refuses; a transient 'unknown' (the helper cannot look
        // the process up under load) is retried a bounded number of times —
        // refusing on a transient would strand a perfectly healthy session
        // with a stale lock.
        const supervisorStatus = await inspectWithRetry(probe, current.owner.supervisor, 5, 500)
        if (supervisorStatus !== 'same') {
          // The probe verdict is part of the message: 'different' (identity
          // mismatch) and a persistent 'unknown' (helper could not look the
          // process up) are different failures wearing one code. For
          // 'different' — which identity math says is impossible for the
          // recording process — the current process identity is attached so
          // the next occurrence diagnoses itself (same pid + different
          // identity = kernel-level misread; different pid = the lock was
          // recorded by another process).
          let selfDiagnosis = ''
          if (supervisorStatus === 'different') {
            const currentSelf = await probe.current().catch(() => undefined)
            if (currentSelf !== undefined) {
              selfDiagnosis = `; self pid ${currentSelf.pid} identity ${currentSelf.startIdentity}, owner pid ${current.owner.supervisor.pid}`
            }
          }
          throw new LeaseError(
            'LEASE_CHANGED',
            `the recorded supervisor identity is not this process (probe: ${supervisorStatus}${selfDiagnosis})`,
            describeLeaseOwner(current.owner),
          )
        }
        if (current.owner.host !== null) {
          const status = await inspectWithRetry(probe, current.owner.host)
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
