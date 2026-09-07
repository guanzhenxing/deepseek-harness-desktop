import type { Stats } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import {
  LeaseError,
  parseLeaseOwner,
  serializeLeaseOwner,
  type LeaseOwner,
  type ProcessIdentity,
} from './owner.js'

export const RUN_DIRNAME = 'run'
export const LOCK_DIRNAME = 'host.lock'
export const GUARD_FILENAME = 'host-lease.guard'
export const OWNER_FILENAME = 'owner.json'
/**
 * Lock-directory sentinel: every release of THIS layout keeps one extra
 * file inside <home>/run/host.lock/. All doctor implementations — including
 * frozen older artifacts — refuse to rmdir a non-empty lock directory
 * (ENOTEMPTY), so a foreign doctor that misreads the newer identity format
 * can delete owner.json but can never remove a LIVE v2 lock. Only this
 * release's own release/doctor remove the sentinel before rmdir.
 */
export const SENTINEL_FILENAME = '.dsh-writer-sentinel'

export type LeasePaths = Readonly<{
  run: string
  lockDir: string
  guardPath: string
  ownerPath: string
  sentinelPath: string
}>

export type ReadOwnerResult = Readonly<
  { kind: 'ok'; owner: LeaseOwner } | { kind: 'missing' } | { kind: 'corrupt' }
>

/**
 * A crash-safe mirror of the writer identities. It remains when a frozen
 * doctor deletes owner.json, so a current doctor can still prove that the
 * supervisor or an already-authorized Host is alive before it removes the
 * lock directory.
 */
export type LeaseSentinel = Readonly<{
  schemaVersion: 1
  generation: string
  supervisor: ProcessIdentity
  host: ProcessIdentity | null
  pendingSpawn: boolean
}>

export type ReadSentinelResult = Readonly<
  { kind: 'ok'; sentinel: LeaseSentinel } | { kind: 'missing' } | { kind: 'corrupt' }
>

const SENTINEL_READ_CAP = 16 * 1024
const OWNER_READ_CAP = 64 * 1024

export function leasePaths(home: string): LeasePaths {
  const run = path.join(home, RUN_DIRNAME)
  const lockDir = path.join(run, LOCK_DIRNAME)
  return {
    run,
    lockDir,
    guardPath: path.join(run, GUARD_FILENAME),
    ownerPath: path.join(lockDir, OWNER_FILENAME),
    sentinelPath: path.join(lockDir, SENTINEL_FILENAME),
  }
}

export function validateHome(home: string): string {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new LeaseError('LEASE_UNKNOWN', 'home lease requires an explicit home')
  }
  const resolved = path.resolve(home)
  if (resolved === path.parse(resolved).root) {
    throw new LeaseError('LEASE_UNKNOWN', 'home lease must not use the filesystem root')
  }
  return resolved
}

export async function directoryIdentity(dirname: string, label: string): Promise<Stats> {
  const identity = await lstat(dirname)
  if (identity.isSymbolicLink())
    throw new LeaseError('LEASE_UNKNOWN', `${label} must not be a symlink`)
  if (!identity.isDirectory()) throw new LeaseError('LEASE_UNKNOWN', `${label} must be a directory`)
  return identity
}

export async function syncDirectory(dirname: string): Promise<void> {
  const handle = await open(dirname, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function ensureHomeLayout(paths: LeasePaths): Promise<void> {
  await mkdir(path.dirname(paths.run), { recursive: true, mode: 0o700 })
  await directoryIdentity(path.dirname(paths.run), 'DSH home')
  try {
    await mkdir(paths.run, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await directoryIdentity(paths.run, 'DSH home run directory')
  // Tighten pre-existing inodes to the protocol modes; a wider run directory
  // or guard file would leak lease metadata to other local users. Tightening
  // is fd-based (open with O_NOFOLLOW then fchmod) so a path swapped for a
  // symlink between lookups can never make chmod touch a foreign inode.
  await tightenByDescriptor(paths.run, 0o700, 'DSH home run directory', true)
  await tightenByDescriptor(paths.guardPath, 0o600, 'host-lease.guard', false)
}

async function tightenByDescriptor(
  target: string,
  mode: number,
  label: string,
  requireDirectory: boolean,
): Promise<void> {
  const flags =
    fsConstants.O_RDONLY |
    fsConstants.O_NONBLOCK |
    fsConstants.O_NOFOLLOW |
    (requireDirectory ? fsConstants.O_DIRECTORY : 0)
  let handle
  try {
    handle = await open(target, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    if (code === 'ELOOP') {
      throw new LeaseError('LEASE_UNKNOWN', `${label} must not be a symlink`)
    }
    throw error
  }
  try {
    const identity = await handle.stat()
    if (requireDirectory && !identity.isDirectory()) {
      throw new LeaseError('LEASE_UNKNOWN', `${label} must be a directory`)
    }
    if (!requireDirectory && !identity.isFile()) {
      throw new LeaseError('LEASE_UNKNOWN', `${label} must be a regular file`)
    }
    if ((identity.mode & 0o777) !== mode) await handle.chmod(mode)
  } finally {
    await handle.close()
  }
}

export async function writeOwnerWithDurability(
  ownerPath: string,
  owner: LeaseOwner,
): Promise<void> {
  await writeFileAtomic(ownerPath, serializeLeaseOwner(owner), {
    mode: 0o600,
    dirMode: 0o700,
  })
  // The upstream atomic writer does not promise crash durability, so fsync the
  // committed owner file and both parent directories here.
  await syncRegularFile(ownerPath, 'home lease owner')
  await syncDirectory(path.dirname(ownerPath))
  await syncDirectory(path.dirname(path.dirname(ownerPath)))
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startIdentity === 'string' &&
    record.startIdentity.length > 0
  )
}

function sentinelFromOwner(owner: LeaseOwner): LeaseSentinel {
  return Object.freeze({
    schemaVersion: 1,
    generation: owner.generation,
    supervisor: owner.supervisor,
    host: owner.host,
    pendingSpawn: owner.pendingSpawn,
  })
}

function serializeLeaseSentinel(owner: LeaseOwner): string {
  return `${JSON.stringify(sentinelFromOwner(owner))}\n`
}

function parseLeaseSentinel(raw: string): LeaseSentinel | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const expected = ['schemaVersion', 'generation', 'supervisor', 'host', 'pendingSpawn']
  if (Object.keys(record).length !== expected.length || !expected.every((key) => key in record)) {
    return undefined
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.generation !== 'string' ||
    record.generation.length === 0 ||
    !isProcessIdentity(record.supervisor) ||
    (record.host !== null && !isProcessIdentity(record.host)) ||
    typeof record.pendingSpawn !== 'boolean'
  ) {
    return undefined
  }
  return Object.freeze({
    schemaVersion: 1,
    generation: record.generation,
    supervisor: record.supervisor,
    host: record.host,
    pendingSpawn: record.pendingSpawn,
  })
}

async function syncRegularFile(filename: string, label: string): Promise<void> {
  const flags = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
  const handle = await open(filename, flags)
  try {
    if (!(await handle.stat()).isFile()) {
      throw new LeaseError('LEASE_UNKNOWN', `${label} must be a regular file`)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Atomically replace the sentinel itself, never a symlink referent. */
export async function writeSentinelWithDurability(
  sentinelPath: string,
  owner: LeaseOwner,
): Promise<void> {
  await writeFileAtomic(sentinelPath, serializeLeaseSentinel(owner), {
    mode: 0o600,
    dirMode: 0o700,
  })
  await syncRegularFile(sentinelPath, 'home lease sentinel')
  await syncDirectory(path.dirname(sentinelPath))
  await syncDirectory(path.dirname(path.dirname(sentinelPath)))
}

async function readBoundedRegularText(
  filename: string,
  cap: number,
  label: string,
): Promise<string | undefined> {
  const flags = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
  let handle
  try {
    handle = await open(filename, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP') throw new LeaseError('LEASE_UNKNOWN', `${label} must not be a symlink`)
    throw error
  }
  try {
    const identity = await handle.stat()
    if (!identity.isFile() || !Number.isSafeInteger(identity.size) || identity.size > cap) {
      throw new LeaseError('LEASE_UNKNOWN', `${label} must be a bounded regular file`)
    }
    const buffer = Buffer.alloc(identity.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== identity.size) {
      throw new LeaseError('LEASE_UNKNOWN', `${label} changed while being read`)
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function readLeaseSentinel(sentinelPath: string): Promise<ReadSentinelResult> {
  const raw = await readBoundedRegularText(sentinelPath, SENTINEL_READ_CAP, 'home lease sentinel')
  if (raw === undefined) return { kind: 'missing' }
  const sentinel = parseLeaseSentinel(raw)
  return sentinel === undefined ? { kind: 'corrupt' } : { kind: 'ok', sentinel }
}

export async function readOwner(ownerPath: string): Promise<ReadOwnerResult> {
  try {
    const raw = await readBoundedRegularText(ownerPath, OWNER_READ_CAP, 'home lease owner')
    if (raw === undefined) return { kind: 'missing' }
    return parseLeaseOwner(raw)
  } catch {
    // A malformed, linked, non-regular, unreadable, or path-swapped owner
    // is never evidence that a lease is absent. The caller follows its
    // existing corrupt-owner refusal/recovery path under the native guard.
    return { kind: 'corrupt' }
  }
}
