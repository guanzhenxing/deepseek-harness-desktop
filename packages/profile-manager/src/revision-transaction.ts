import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { HomeLease } from '@dsh-desktop/home-lease'

import type { ProfileRef } from './profile-ref.js'
import { sha256Of } from './reconcile-plan.js'
import type { FileRevision, ManagedProfilePath, ProfileReconcilePlan } from './reconcile-plan.js'

export type RevisionTransactionState =
  | 'prepared'
  | 'applying'
  | 'applied'
  | 'committed'
  | 'retained'
  | 'rolling-back'
  | 'rolled-back'
  | 'conflict'

export type RevisionTransaction = Readonly<{
  id: string
  ref: ProfileRef
  state: RevisionTransactionState
}>

type JournalWrite = Readonly<{
  path: ManagedProfilePath
  before: FileRevision
  candidateSha256: string
  applied: boolean
}>

type JournalRecord = Readonly<{
  schemaVersion: 1
  id: string
  ref: { home: string; name: string; dir: string }
  state: RevisionTransactionState
  createdAt: string
  writes: readonly JournalWrite[]
  failure?: { category: string; code: string } | undefined
}>

export const RETAINED_TRANSACTION_LIMIT = 20

function transactionsRoot(home: string): string {
  return path.join(home, 'run', 'profile-transactions')
}

function transactionDir(home: string, id: string): string {
  return path.join(transactionsRoot(home), id)
}

function journalPath(home: string, id: string): string {
  return path.join(transactionDir(home, id), 'transaction.json')
}

async function syncDirectory(dirname: string): Promise<void> {
  const handle = await open(dirname, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeJournalDurable(home: string, record: JournalRecord): Promise<void> {
  await writeAtomicDurable(
    journalPath(home, record.id),
    encoder.encode(`${JSON.stringify(record, null, 2)}\n`),
  )
}

const encoder = new TextEncoder()

/** fsync'd temp file + atomic rename; readers see old or new, never partial. */
async function writeAtomicDurable(filename: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, filename)
  const written = await open(filename, 'r')
  try {
    await written.sync()
  } finally {
    await written.close()
  }
  await unlink(temporary).catch(() => undefined)
  await syncDirectory(path.dirname(filename))
}

export async function readJournal(
  home: string,
  id: string,
): Promise<JournalRecord | 'corrupt' | 'missing'> {
  const file = journalPath(home, id)
  try {
    const identity = await lstat(file)
    if (identity.isSymbolicLink() || !identity.isFile()) return 'corrupt'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return 'corrupt'
  }
  if (typeof value !== 'object' || value === null) return 'corrupt'
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return 'corrupt'
  if (typeof record.id !== 'string' || record.id !== id) return 'corrupt'
  if (typeof record.state !== 'string') return 'corrupt'
  if (typeof record.createdAt !== 'string') return 'corrupt'
  if (!Array.isArray(record.writes)) return 'corrupt'
  for (const write of record.writes) {
    if (typeof write !== 'object' || write === null) return 'corrupt'
    const entry = write as Record<string, unknown>
    if (
      typeof entry.path !== 'string' ||
      !['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'].includes(entry.path) ||
      typeof entry.candidateSha256 !== 'string' ||
      typeof entry.applied !== 'boolean' ||
      typeof entry.before !== 'object' ||
      entry.before === null ||
      typeof (entry.before as Record<string, unknown>).exists !== 'boolean'
    ) {
      return 'corrupt'
    }
  }
  return record as unknown as JournalRecord
}

async function beforeSnapshotPath(
  home: string,
  id: string,
  relative: ManagedProfilePath,
): Promise<string> {
  return path.join(transactionDir(home, id), 'before', relative)
}

async function writeBeforeSnapshot(
  home: string,
  id: string,
  relative: ManagedProfilePath,
  bytes: Uint8Array,
): Promise<void> {
  const target = await beforeSnapshotPath(home, id, relative)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const handle = await open(target, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(path.dirname(target))
}

async function writeCandidate(filename: string, bytes: Uint8Array): Promise<void> {
  await writeAtomicDurable(filename, bytes)
}

async function currentSha(
  filename: string,
): Promise<{ sha: string | null; inode: { dev: number; ino: number } | null }> {
  try {
    const identity = await lstat(filename)
    if (!identity.isFile()) return { sha: null, inode: null }
    return {
      sha: sha256Of(new Uint8Array(await readFile(filename))),
      inode: { dev: identity.dev, ino: identity.ino },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sha: null, inode: null }
    throw error
  }
}

function assertLeaseMatches(lease: HomeLease, ref: ProfileRef): void {
  if (lease.home !== ref.home) {
    throw new Error('profile transaction requires a lease bound to the transaction home')
  }
}

/**
 * Persist the journal (prepared) with before snapshots, then apply each
 * planned write and record per-file progress. Every side effect is preceded
 * by a durable intent so a crash at any boundary is recoverable from disk
 * facts alone.
 */
export async function applyProfileTransaction(
  plan: ProfileReconcilePlan,
  lease: HomeLease,
): Promise<RevisionTransaction> {
  assertLeaseMatches(lease, plan.ref)
  if (plan.ref.dir !== path.join(plan.ref.home, 'profiles', plan.ref.name)) {
    throw new Error('ProfileRef directory does not match its home')
  }
  const home = plan.ref.home
  const id = randomUUID()
  await mkdir(transactionDir(home, id), { recursive: true, mode: 0o700 })
  await mkdir(path.join(transactionDir(home, id), 'before'), { recursive: true, mode: 0o700 })

  let record: JournalRecord = {
    schemaVersion: 1,
    id,
    ref: { home: plan.ref.home, name: plan.ref.name, dir: plan.ref.dir },
    state: 'prepared',
    createdAt: new Date().toISOString(),
    writes: plan.writes.map((write) => ({
      path: write.path,
      before: write.before,
      candidateSha256: write.candidateSha256,
      applied: false,
    })),
  }
  await writeJournalDurable(home, record)

  for (const write of plan.writes) {
    if (write.beforeBytes !== null) {
      await writeBeforeSnapshot(home, id, write.path, write.beforeBytes)
    }
  }

  record = { ...record, state: 'applying' }
  await writeJournalDurable(home, record)
  await lease.assertHeld()

  await mkdirProfileDirectory(plan.ref)
  for (const write of plan.writes) {
    const filename = path.join(plan.ref.dir, write.path)
    const { sha } = await currentSha(filename)
    if (sha === write.candidateSha256) {
      // A previous interrupted application already landed this exact content.
      record = {
        ...record,
        writes: record.writes.map((entry) =>
          entry.path === write.path ? { ...entry, applied: true } : entry,
        ),
      }
      await writeJournalDurable(home, record)
      continue
    }
    if (sha !== (write.before.sha256 ?? null)) {
      record = { ...record, state: 'conflict' }
      await writeJournalDurable(home, record)
      return { id, ref: plan.ref, state: 'conflict' }
    }
    await writeCandidate(filename, write.candidateBytes)
    record = {
      ...record,
      writes: record.writes.map((entry) =>
        entry.path === write.path ? { ...entry, applied: true } : entry,
      ),
    }
    await writeJournalDurable(home, record)
    await lease.assertHeld()
  }

  record = { ...record, state: 'applied' }
  await writeJournalDurable(home, record)
  return { id, ref: plan.ref, state: 'applied' }
}

async function mkdirProfileDirectory(ref: ProfileRef): Promise<void> {
  await mkdir(ref.dir, { recursive: true, mode: 0o700 }).catch(() => undefined)
}

export async function commitProfileTransaction(id: string, lease: HomeLease): Promise<void> {
  const journal = await readJournal(lease.home, id)
  if (journal === 'missing' || journal === 'corrupt') {
    throw new Error(`cannot commit transaction ${id}: journal ${journal}`)
  }
  await lease.assertHeld()
  if (journal.state !== 'applied') {
    throw new Error(`cannot commit transaction ${id} from state ${journal.state}`)
  }
  await writeJournalDurable(lease.home, {
    ...journal,
    state: 'committed',
  })
  await pruneRetainedTransactions(lease.home)
}

/** Record an explicit decision not to roll back (with the failure category). */
export async function retainProfileTransaction(
  id: string,
  lease: HomeLease,
  failure: Readonly<{ category: string; code: string }>,
): Promise<void> {
  const journal = await readJournal(lease.home, id)
  if (journal === 'missing' || journal === 'corrupt') {
    throw new Error(`cannot retain transaction ${id}: journal ${journal}`)
  }
  await lease.assertHeld()
  await writeJournalDurable(lease.home, {
    ...journal,
    state: 'retained',
    failure,
  })
  await pruneRetainedTransactions(lease.home)
}

export async function rollbackProfileTransaction(
  id: string,
  lease: HomeLease,
): Promise<'restored' | 'conflict'> {
  const journal = await readJournal(lease.home, id)
  if (journal === 'missing' || journal === 'corrupt') {
    throw new Error(`cannot roll back transaction ${id}: journal ${journal}`)
  }
  await lease.assertHeld()
  if (journal.state === 'rolled-back') return 'restored'
  if (
    journal.state === 'committed' ||
    journal.state === 'retained' ||
    journal.state === 'conflict'
  ) {
    return 'conflict'
  }

  const ref = journal.ref as ProfileRef
  // Phase 1: verify every affected file is exactly at before or candidate.
  const checked: { write: JournalWrite; sha: string | null }[] = []
  for (const write of journal.writes) {
    const filename = path.join(ref.dir, write.path)
    const { sha } = await currentSha(filename)
    const allowed: (string | null)[] = [write.candidateSha256, write.before.sha256]
    if (write.before.exists === false) allowed.push(null)
    if (!allowed.includes(sha)) {
      await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
      return 'conflict'
    }
    checked.push({ write, sha })
  }

  await writeJournalDurable(lease.home, { ...journal, state: 'rolling-back' })

  // Phase 2: idempotently move each file back to before.
  for (const { write, sha } of checked) {
    const filename = path.join(ref.dir, write.path)
    if (write.before.exists === false) {
      if (sha === null) continue
      if (sha === write.candidateSha256) {
        await unlink(filename)
        await syncDirectory(path.dirname(filename))
        continue
      }
      continue
    }
    if (sha === write.before.sha256) continue
    if (sha === write.candidateSha256) {
      const snapshot = await beforeSnapshotPath(lease.home, id, write.path)
      const snapshotIdentity = await stat(snapshot)
      if (snapshotIdentity.isFile() !== true) {
        await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
        return 'conflict'
      }
      const bytes = new Uint8Array(await readFile(snapshot))
      if (sha256Of(bytes) !== write.before.sha256) {
        await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
        return 'conflict'
      }
      await writeCandidate(filename, bytes)
      continue
    }
    await writeJournalDurable(lease.home, { ...journal, state: 'conflict' })
    return 'conflict'
  }

  await writeJournalDurable(lease.home, { ...journal, state: 'rolled-back' })
  await pruneRetainedTransactions(lease.home)
  return 'restored'
}

/** Drop terminal transaction directories beyond the retention window. */
export async function pruneRetainedTransactions(home: string): Promise<void> {
  const root = transactionsRoot(home)
  const entries = await readdirSafe(root)
  const records: { id: string; createdAt: string }[] = []
  for (const id of entries) {
    const journal = await readJournal(home, id)
    if (journal === 'missing' || journal === 'corrupt') continue
    if (
      journal.state === 'committed' ||
      journal.state === 'rolled-back' ||
      journal.state === 'retained'
    ) {
      records.push({ id: journal.id, createdAt: journal.createdAt })
    }
  }
  if (records.length <= RETAINED_TRANSACTION_LIMIT) return
  records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const excess = records.slice(0, records.length - RETAINED_TRANSACTION_LIMIT)
  for (const record of excess) {
    await rm(transactionDir(home, record.id), { recursive: true, force: true })
  }
  await syncDirectory(root)
}

async function readdirSafe(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    return await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export { transactionsRoot, transactionDir, journalPath }

/** Directory ids of all recorded transactions, oldest-first irrelevant. */
export async function readdirTransactionIds(home: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    return await readdir(transactionsRoot(home))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export type { JournalRecord, JournalWrite }
