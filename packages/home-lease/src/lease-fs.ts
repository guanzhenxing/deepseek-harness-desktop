import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import { LeaseError, parseLeaseOwner, serializeLeaseOwner, type LeaseOwner } from './owner.js'

export const RUN_DIRNAME = 'run'
export const LOCK_DIRNAME = 'host.lock'
export const GUARD_FILENAME = 'host-lease.guard'
export const OWNER_FILENAME = 'owner.json'

export type LeasePaths = Readonly<{
  run: string
  lockDir: string
  guardPath: string
  ownerPath: string
}>

export type ReadOwnerResult = Readonly<
  { kind: 'ok'; owner: LeaseOwner } | { kind: 'missing' } | { kind: 'corrupt' }
>

export function leasePaths(home: string): LeasePaths {
  const run = path.join(home, RUN_DIRNAME)
  const lockDir = path.join(run, LOCK_DIRNAME)
  return {
    run,
    lockDir,
    guardPath: path.join(run, GUARD_FILENAME),
    ownerPath: path.join(lockDir, OWNER_FILENAME),
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
  // or guard file would leak lease metadata to other local users.
  const runMode = (await lstat(paths.run)).mode & 0o777
  if (runMode !== 0o700) await chmod(paths.run, 0o700)
  try {
    const guardMode = (await lstat(paths.guardPath)).mode & 0o777
    if (guardMode !== 0o600) await chmod(paths.guardPath, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
  const handle = await open(ownerPath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(path.dirname(ownerPath))
  await syncDirectory(path.dirname(path.dirname(ownerPath)))
}

export async function readOwner(ownerPath: string): Promise<ReadOwnerResult> {
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
