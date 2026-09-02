import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import type { HomeLease } from '@dsh-desktop/home-lease'

export type CacheQuarantineResult =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'unknown-layout' }>
  | Readonly<{ kind: 'quarantined'; relativeBackupPath: string; bytes: number }>

const CACHE_RELATIVE = 'storages/session_projcache/sessions'
const CACHE_ROOT_RELATIVE = 'storages/session_projcache'
const QUARANTINE_PREFIX = 'session_projcache.quarantine-'
const JOURNAL_RELATIVE = 'run/projection-cache-quarantine.json'

type QuarantineJournal = Readonly<{
  schemaVersion: 1
  id: string
  sourceRelative: string
  backupRelative: string
  bytes: number
  createdAt: string
  phase: 'intent' | 'renamed' | 'done'
}>

async function syncDirectory(dirname: string): Promise<void> {
  const handle = await open(dirname, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeJournalDurable(home: string, journal: QuarantineJournal): Promise<void> {
  const file = path.join(home, JOURNAL_RELATIVE)
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  await syncDirectory(path.dirname(file))
}

async function readJournal(home: string): Promise<QuarantineJournal | undefined> {
  try {
    const raw = await readFile(path.join(home, JOURNAL_RELATIVE), 'utf8')
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (record.schemaVersion !== 1) return undefined
    if (typeof record.backupRelative !== 'string') return undefined
    return record as unknown as QuarantineJournal
  } catch {
    return undefined
  }
}

async function directorySize(root: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  let total = 0
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) total += await directorySize(target)
    else if (entry.isFile()) {
      const identity = await stat(target).catch(() => undefined)
      total += identity?.size ?? 0
    }
  }
  return total
}

/**
 * Quarantine an oversized, rebuildable projection cache while holding the
 * home lease and with no running Host. Only the fixed baseline layout is
 * ever moved; anything unexpected reports unknown-layout without touching
 * disk. The move is a same-filesystem rename with an intent journal so a
 * crash at either boundary is recognizable, and the backup is kept.
 */
export async function quarantineProjectionCache(
  input: Readonly<{
    home: string
    lease: HomeLease
    thresholdBytes: number
  }>,
): Promise<CacheQuarantineResult> {
  if (input.lease.home !== input.home) {
    throw new Error('projection-cache quarantine requires a lease bound to this home')
  }
  await input.lease.assertHeld()

  // Resolve the previous run's journal first: a crash after rename but before
  // the done marker must never move the backup a second time.
  const previous = await readJournal(input.home)
  if (previous !== undefined && previous.phase !== 'done') {
    const backupDir = path.join(input.home, previous.backupRelative)
    const sourceDir = path.join(input.home, previous.sourceRelative)
    const backupExists = await stat(backupDir).then(
      () => true,
      () => false,
    )
    const sourceExists = await stat(sourceDir).then(
      () => true,
      () => false,
    )
    if (backupExists && sourceExists) {
      // The source was rebuilt after the crash: finish the journal.
      await writeJournalDurable(input.home, { ...previous, phase: 'done' })
      return {
        kind: 'quarantined',
        relativeBackupPath: previous.backupRelative,
        bytes: previous.bytes,
      }
    }
    if (backupExists && !sourceExists) {
      // Rename may or may not have happened; the backup is intact either way.
      await writeJournalDurable(input.home, { ...previous, phase: 'done' })
      return {
        kind: 'quarantined',
        relativeBackupPath: previous.backupRelative,
        bytes: previous.bytes,
      }
    }
    // Neither exists: treat as a stale journal and continue with a fresh scan.
  }

  const sourceRelative = CACHE_RELATIVE
  const sourceDir = path.join(input.home, sourceRelative)
  const storagesDir = path.join(input.home, CACHE_ROOT_RELATIVE)
  const sourceIdentity = await lstat(sourceDir).catch(() => undefined)
  if (sourceIdentity === undefined) return { kind: 'unchanged' }
  if (sourceIdentity.isSymbolicLink() || !sourceIdentity.isDirectory()) {
    return { kind: 'unknown-layout' }
  }
  // The fixed layout is exactly one `sessions` directory under the storage
  // root; extra siblings mean a layout we did not certify.
  const { readdir } = await import('node:fs/promises')
  const siblings = await readdir(storagesDir).catch(() => undefined)
  if (siblings === undefined || siblings.some((name) => name !== 'sessions')) {
    return { kind: 'unknown-layout' }
  }
  const bytes = await directorySize(sourceDir)
  if (bytes < input.thresholdBytes) return { kind: 'unchanged' }

  const id = randomUUID()
  const backupRelative = `${CACHE_ROOT_RELATIVE.replace(/\//gu, '-')}/${QUARANTINE_PREFIX}${id}`
  void backupRelative
  const backupRelativePath = path.join(input.home, 'storages', `${QUARANTINE_PREFIX}${id}`)
  const backupRelativeForJournal = `storages/${QUARANTINE_PREFIX}${id}`

  await writeJournalDurable(input.home, {
    schemaVersion: 1,
    id,
    sourceRelative,
    backupRelative: backupRelativeForJournal,
    bytes,
    createdAt: new Date().toISOString(),
    phase: 'intent',
  })
  // Same-filesystem rename only; never copy-then-delete.
  await rename(sourceDir, backupRelativePath)
  await writeJournalDurable(input.home, {
    schemaVersion: 1,
    id,
    sourceRelative,
    backupRelative: backupRelativeForJournal,
    bytes,
    createdAt: new Date().toISOString(),
    phase: 'renamed',
  })
  await writeJournalDurable(input.home, {
    schemaVersion: 1,
    id,
    sourceRelative,
    backupRelative: backupRelativeForJournal,
    bytes,
    createdAt: new Date().toISOString(),
    phase: 'done',
  })
  await syncDirectory(path.dirname(backupRelativePath))
  return {
    kind: 'quarantined',
    relativeBackupPath: backupRelativeForJournal,
    bytes,
  }
}

export const PROJECTION_CACHE_LAYOUT = {
  cacheRelative: CACHE_RELATIVE,
  quarantinePrefix: QUARANTINE_PREFIX,
  hashOf: (content: string): string => createHash('sha256').update(content).digest('hex'),
} as const

export async function cleanupQuarantineJournal(home: string): Promise<void> {
  await rm(path.join(home, JOURNAL_RELATIVE), { force: true }).catch(() => undefined)
  void mkdir
}
