import { rm, rmdir } from 'node:fs/promises'

import { describeLeaseOwner } from './owner.js'
import type { ProcessProbe } from './process-probe.js'
import { createNativeGuardLock, resolveLeaseHelperPath, type GuardLock } from './native-helper.js'
import { inspectConfirmed } from './probe-confirm.js'

async function readSentinelIdentity(sentinelPath: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises')
  return readFile(sentinelPath, 'utf8').catch(() => undefined)
}
import { directoryIdentity, leasePaths, readOwner, validateHome } from './lease-fs.js'

export type UnlockResult =
  | Readonly<{ status: 'unlocked' | 'already-unlocked'; detail?: string }>
  | Readonly<{
      status: 'refused'
      code: 'ACTIVE_OWNER' | 'IDENTITY_UNKNOWN' | 'LEASE_CHANGED'
      detail: string
    }>

export type UnlockHomeInput = Readonly<{
  home: string
  probe: ProcessProbe
  guard?: GuardLock
}>

/**
 * Explicit, user-requested cleanup of a leftover home lock. Everything —
 * rereading the owner, probing identities, scanning for supported
 * entrypoints, and removing the lock — happens inside one guard critical
 * section, so a concurrent acquisition can never be deleted by an older
 * doctor. Live or unidentifiable owners are always refused; there is no
 * `--force`. Owner liveness uses the same confirmation discipline as
 * acquisition: only 'same' is believed immediately, and any other verdict
 * is re-read once before a lock is removed — a single misread of a live
 * owner must never authorize deletion.
 */
export async function unlockHome(input: UnlockHomeInput): Promise<UnlockResult> {
  const home = validateHome(input.home)
  const paths = leasePaths(home)
  const guard = input.guard ?? createNativeGuardLock(resolveLeaseHelperPath(process.env))
  let parent
  try {
    parent = await directoryIdentity(paths.run, 'DSH home run directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'already-unlocked', detail: 'the home has no lease layout at all' }
    }
    throw error
  }
  const session = await guard.lock({
    guardPath: paths.guardPath,
    parentDirectory: paths.run,
    parentDev: parent.dev,
    parentIno: parent.ino,
  })

  const refuse = (
    code: Extract<UnlockResult, { status: 'refused' }>['code'],
    detail: string,
  ): UnlockResult => ({ status: 'refused', code, detail })

  try {
    let lockIdentity
    try {
      lockIdentity = await directoryIdentity(paths.lockDir, 'home lock directory')
    } catch {
      return { status: 'already-unlocked', detail: 'no home lock directory exists' }
    }

    const current = await readOwner(paths.ownerPath)
    if (current.kind !== 'ok') {
      // A v2 sentinel carries the writer's identity: when the owner file is
      // gone but the sentinel names a LIVE supervisor, the lock is alive no
      // matter what a process scan says (scan needles bind to one
      // installation's absolute paths and miss other copies). Only a
      // provably-dead identity, or the legacy sentinel-less layout, may
      // fall through to the scan.
      const sentinelIdentity = await readSentinelIdentity(paths.sentinelPath)
      if (sentinelIdentity !== undefined) {
        if (!sentinelIdentity.match(/^\d+\n[^\n]+\n[^\n]+\n$/u)) {
          return refuse(
            'IDENTITY_UNKNOWN',
            'the lock has no readable owner and an unparseable sentinel; inspect it manually',
          )
        }
        const [pidText, startIdentity] = sentinelIdentity.split('\n')
        if (pidText === undefined || startIdentity === undefined) {
          return refuse(
            'IDENTITY_UNKNOWN',
            'the lock has no readable owner and an unparseable sentinel; inspect it manually',
          )
        }
        const status = await inspectConfirmed(input.probe, {
          pid: Number(pidText),
          startIdentity,
        })
        if (status === 'same') {
          return refuse(
            'ACTIVE_OWNER',
            'the sentinel names a supervisor that is still running (the owner file was deleted by another tool)',
          )
        }
        if (status === 'unknown') {
          return refuse(
            'IDENTITY_UNKNOWN',
            'the sentinel names a supervisor whose liveness cannot be determined',
          )
        }
      }
      // Missing or corrupt owner: fall back to scanning for supported
      // entrypoint executables before touching anything.
      const scan = await input.probe.scanSupported()
      if (scan === 'active') {
        return refuse(
          'ACTIVE_OWNER',
          'the lock is unreadable but a supported entrypoint is still running',
        )
      }
      if (scan === 'unknown') {
        return refuse(
          'IDENTITY_UNKNOWN',
          'the lock is unreadable and running entrypoints cannot be determined',
        )
      }
      await rm(paths.ownerPath, { force: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      // A foreign doctor may have deleted the owner of a v2 lock; the
      // sentinel lets THIS doctor finish the cleanup the foreign one was
      // refused (their rmdir hit ENOTEMPTY and left the directory).
      await rm(paths.sentinelPath, { force: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      try {
        await rmdir(paths.lockDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
          return refuse(
            'IDENTITY_UNKNOWN',
            'the home lock directory holds unexpected entries; inspect it manually',
          )
        }
        throw error
      }
      return {
        status: 'unlocked',
        detail:
          current.kind === 'missing'
            ? 'removed a lock directory without an owner file'
            : 'removed a lock directory with a corrupt owner file',
      }
    }

    const owner = current.owner
    const supervisor = await inspectConfirmed(input.probe, owner.supervisor)
    const host = owner.host === null ? 'absent' : await inspectConfirmed(input.probe, owner.host)
    const summary = describeLeaseOwner(owner)
    if (supervisor === 'same' || host === 'same') {
      return refuse('ACTIVE_OWNER', `the recorded owner is still running: ${summary}`)
    }
    if (supervisor === 'unknown' || host === 'unknown') {
      return refuse('IDENTITY_UNKNOWN', `the recorded owner cannot be identified: ${summary}`)
    }
    if (owner.pendingSpawn) {
      return refuse('IDENTITY_UNKNOWN', `a host spawn was never confirmed: ${summary}`)
    }
    const beforeRemove = await directoryIdentity(paths.lockDir, 'home lock directory')
    if (beforeRemove.dev !== lockIdentity.dev || beforeRemove.ino !== lockIdentity.ino) {
      return refuse('LEASE_CHANGED', 'the home lock directory was replaced during diagnosis')
    }
    if (current.kind !== 'ok') {
      return refuse('LEASE_CHANGED', 'the owner file changed during diagnosis')
    }
    await rm(paths.ownerPath, { force: false }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    // This doctor understands the v2 lock layout: clear OUR sentinel (the
    // only extra entry this release ever creates) before rmdir. Anything
    // still left after that is truly unexpected and keeps the refusal.
    await rm(paths.sentinelPath, { force: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    try {
      await rmdir(paths.lockDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        return refuse(
          'IDENTITY_UNKNOWN',
          'the home lock directory holds unexpected entries; inspect it manually',
        )
      }
      throw error
    }
    return { status: 'unlocked', detail: `removed the stale lock of ${summary}` }
  } finally {
    await session.release()
  }
}
