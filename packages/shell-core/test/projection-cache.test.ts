import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createInProcessGuardLock,
  type HomeLease,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'

import { quarantineProjectionCache } from '../src/projection-cache.js'

const homes: string[] = []

async function home(): Promise<string> {
  const userData = await mkdtemp(path.join(tmpdir(), 'dsh-projcache-'))
  homes.push(userData)
  const dir = path.join(userData, 'm0-dsh-home')
  await mkdir(dir, { mode: 0o700 })
  return dir
}

function sameProbe(): ProcessProbe {
  return {
    async current() {
      return { pid: process.pid, startIdentity: 'cache-probe' }
    },
    async identify(pid) {
      return { pid, startIdentity: 'cache-probe' }
    },
    async inspect() {
      return 'same' as const
    },
    async scanSupported() {
      return 'none' as const
    },
  }
}

async function leaseOf(dir: string): Promise<HomeLease> {
  return acquireHomeLease({
    home: dir,
    entrypoint: 'desktop',
    profile: 'desktop',
    appVersion: '0.0.0',
    probe: sameProbe(),
    guard: createInProcessGuardLock(),
  })
}

afterEach(async () => {
  for (const entry of homes.splice(0)) {
    const resolved = path.resolve(entry)
    if (
      path.dirname(resolved) === path.resolve(tmpdir()) &&
      path.basename(resolved).startsWith('dsh-projcache-')
    ) {
      await rm(resolved, { recursive: true, force: true })
    }
  }
})

async function cacheDir(dir: string): Promise<string> {
  return path.join(dir, 'storages', 'session_projcache', 'sessions')
}

async function writeCache(dir: string, sizeBytes: number): Promise<string> {
  const target = await cacheDir(dir)
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'proj-1.bin'), Buffer.alloc(sizeBytes, 1))
  return target
}

describe('quarantineProjectionCache', () => {
  it('leaves a small cache untouched', async () => {
    const dir = await home()
    await writeCache(dir, 100)
    const lease = await leaseOf(dir)
    const result = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    expect(result).toEqual({ kind: 'unchanged' })
    expect(await stat(await cacheDir(dir))).toBeTruthy()
    await lease.release()
  })

  it('moves an oversized cache to a kept backup with original bytes', async () => {
    const dir = await home()
    const sessionLog = path.join(dir, 'sessions', 'session.jsonl')
    await mkdir(path.dirname(sessionLog), { recursive: true })
    await writeFile(sessionLog, 'session-data\n')
    await writeCache(dir, 2048)
    const lease = await leaseOf(dir)
    const result = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    expect(result.kind).toBe('quarantined')
    if (result.kind !== 'quarantined') throw new Error('unreachable')
    expect(result.bytes).toBeGreaterThanOrEqual(2048)
    const backup = path.join(dir, result.relativeBackupPath)
    expect(await readFile(path.join(backup, 'proj-1.bin'))).toEqual(Buffer.alloc(2048, 1))
    await expect(stat(await cacheDir(dir))).rejects.toMatchObject({ code: 'ENOENT' })
    // Session JSONL and other storages are untouched.
    expect(await readFile(sessionLog, 'utf8')).toBe('session-data\n')
    await lease.release()
  })

  it('refuses without a matching lease', async () => {
    const dir = await home()
    await writeCache(dir, 2048)
    const other = await home()
    const lease = await leaseOf(other)
    await expect(
      quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 }),
    ).rejects.toThrow(/lease/u)
    expect(await stat(await cacheDir(dir))).toBeTruthy()
    await lease.release()
  })

  it('refuses symlinked or unrecognized layouts without moving anything', async () => {
    const dir = await home()
    const external = await home()
    await mkdir(path.join(external, 'real-sessions'), { recursive: true })
    const projRoot = path.join(dir, 'storages', 'session_projcache')
    await mkdir(projRoot, { recursive: true })
    await symlink(path.join(external, 'real-sessions'), path.join(projRoot, 'sessions'), 'dir')
    const lease = await leaseOf(dir)
    // A symlinked sessions entry is an uncertified layout: refuse, never move.
    expect(await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1 })).toEqual({
      kind: 'unknown-layout',
    })
    await lease.release()

    // Extra sibling under the storage root means an uncertified layout.
    const dir2 = await home()
    await writeCache(dir2, 2048)
    await mkdir(path.join(dir2, 'storages', 'session_projcache', 'unexpected'), {
      recursive: true,
    })
    const lease2 = await leaseOf(dir2)
    expect(
      await quarantineProjectionCache({ home: dir2, lease: lease2, thresholdBytes: 1024 }),
    ).toEqual({ kind: 'unknown-layout' })
    expect(await stat(await cacheDir(dir2))).toBeTruthy()
    await lease2.release()
  })

  it('recognizes an interrupted rename from the journal and never moves the backup', async () => {
    const dir = await home()
    await writeCache(dir, 2048)
    const lease = await leaseOf(dir)
    const first = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    if (first.kind !== 'quarantined') throw new Error('first quarantine failed')
    // A successful quarantine cleans its journal up; rebuild the crash window
    // by hand: a journal stuck at 'renamed' with the backup already moved.
    const journalFile = path.join(dir, 'run', 'projection-cache-quarantine.json')
    await writeFile(
      journalFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'interrupted-quarantine',
          sourceRelative: 'storages/session_projcache/sessions',
          backupRelative: first.relativeBackupPath,
          bytes: first.bytes,
          createdAt: new Date().toISOString(),
          phase: 'renamed',
        },
        null,
        2,
      )}\n`,
    )
    const second = await quarantineProjectionCache({ home: dir, lease, thresholdBytes: 1024 })
    expect(second).toEqual({
      kind: 'quarantined',
      relativeBackupPath: first.relativeBackupPath,
      bytes: first.bytes,
    })
    // The backup was not moved a second time and the settled journal is gone.
    expect(await stat(path.join(dir, first.relativeBackupPath))).toBeTruthy()
    await expect(readFile(journalFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await lease.release()
  })
})
