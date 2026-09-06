import { lstat } from 'node:fs/promises'
import path from 'node:path'

export type HomeFormatState = Readonly<{
  /** No well-known user-data path exists at all. */
  fresh: boolean
  /** Slot name → format id, only for shapes this release classifies. */
  formats: Readonly<Record<string, string>>
  /** Paths that exist but do not match any known format shape. */
  unknownPaths: readonly string[]
}>

const SETTINGS_FORMAT_ID = 'dsh-settings-file-0.1.2-alpha.3'
const SESSION_JSONL_FORMAT_ID = 'dsh-session-jsonl-0'
const STORAGE_UNIT_FORMAT_ID = 'dsh-storage-unit-0.1.2-alpha.3'
const PROJCACHE_FORMAT_ID = 'dsh-session-projcache-4'
const PROFILE_FORMAT_ID = 'dsh-profile-manifest-0.1.2-alpha.3'

/** Bounds keep the read-only inspection linear and cheap on large homes. */
const CREDENTIALS_READ_CAP = 1024 * 1024
const STORAGE_READ_CAP = 16 * 1024 * 1024
const RECORD_READ_CAP = 1024 * 1024
const PROFILE_READ_CAP = 1024 * 1024
const FIRST_LINE_BYTES = 4096

/**
 * Enumeration ceiling per directory (fail-closed: a listing beyond it flags
 * the directory instead of streaming unbounded). Exported for the tests.
 */
export const ENUMERATION_CEILING = 65_536

/**
 * End-to-end budget shared by ONE inspection call across all slots and
 * directory levels: total entries enumerated, total bytes read, and total
 * unknown paths recorded. Exhausting any of the three fails the inspection
 * closed (the affected slot is flagged) — no per-directory ceiling can bound
 * a nested walk by itself, so the whole walk shares one budget. Exported for
 * the budget tests.
 */
export type InspectionBudget = { entries: number; bytes: number; unknowns: number }

export function createInspectionBudget(
  overrides: Partial<InspectionBudget> = {},
): InspectionBudget {
  return { entries: 262_144, bytes: 128 * 1024 * 1024, unknowns: 8_192, ...overrides }
}

function budgetExhausted(budget: InspectionBudget): boolean {
  return budget.entries < 0 || budget.bytes < 0 || budget.unknowns < 0
}

function takeEntries(budget: InspectionBudget, count: number): boolean {
  budget.entries -= count
  return !budgetExhausted(budget)
}

function takeBytes(budget: InspectionBudget, count: number): boolean {
  budget.bytes -= count
  return !budgetExhausted(budget)
}

/** Record one unknown path against the shared budget. */
function flagUnknown(budget: InspectionBudget, unknown: string[], relative: string): void {
  budget.unknowns -= 1
  unknown.push(relative)
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Read-only home inspection for the compatibility preflight: parse only
 * well-known file headers and layouts (credentials version header, session
 * JSONL first line, zstd frame magic, storage unit headers and record
 * stamps, profile manifests). It never loads DSH code or user plugins,
 * never starts providers, and never writes.
 *
 * Containment + classification discipline: the directory walks lstat EVERY
 * listed entry at every level — a symlink or other foreign shape planted at
 * any data path, at any position, is surfaced as an unknown path and never
 * followed — and every plausible data file is content-classified (including
 * records inside per-record units and the zstd frame magic), so corrupt or
 * foreign data is refused wherever it sits. Enumeration is bounded end to
 * end: incremental opendir with a per-directory fail-closed ceiling, on top
 * of the shared entries/bytes/unknowns budget.
 */
export async function inspectHomeFormats(
  home: string,
  budget: InspectionBudget = createInspectionBudget(),
): Promise<HomeFormatState> {
  const formats: Mutable<Record<string, string>> = {}
  const unknownPaths: string[] = []

  const credentials = await credentialsFormatId(path.join(home, '.credentials.yaml'), budget)
  if (credentials.state === 'known') formats.credentials = credentials.formatId
  if (credentials.state === 'unknown') unknownPaths.push(credentials.relative)

  const settings = await settingsFormatId(home)
  if (settings.state === 'known') formats.settings = settings.formatId
  if (settings.state === 'unknown') unknownPaths.push(settings.relative)

  const sessions = await sessionsFormatId(home, budget)
  if (sessions.state === 'known') {
    // A slot only claims its format when every inspected item matched;
    // otherwise the offending paths drive the unknown-format refusal.
    if (sessions.unknown.length === 0) formats.sessions = sessions.formatId
    else for (const relative of sessions.unknown) unknownPaths.push(relative)
  }

  const storages = await storagesFormatId(home, budget)
  if (storages.state === 'known') {
    // The storages slot stays at the unit-envelope identity: domains grow
    // within one epoch (single → per-record, new domains), and a slot value
    // that flips would poison the marker/disk consistency check. The
    // projection-cache domain is its own slot; a foreign version of it is
    // data this release cannot read.
    if (storages.unknown.length === 0) formats.storages = storages.formatId
    else for (const relative of storages.unknown) unknownPaths.push(relative)
    if (storages.projcache === 4) formats.projcache = PROJCACHE_FORMAT_ID
    if (storages.projcache === 'foreign') unknownPaths.push('storages/session_projcache')
  }

  const profiles = await profilesFormatId(home, budget)
  if (profiles.state === 'known') {
    if (profiles.unknown.length === 0) formats.profiles = profiles.formatId
    else for (const relative of profiles.unknown) unknownPaths.push(relative)
  }

  const fresh =
    formats.credentials === undefined &&
    formats.settings === undefined &&
    formats.sessions === undefined &&
    formats.storages === undefined &&
    formats.profiles === undefined &&
    unknownPaths.length === 0

  return { fresh, formats, unknownPaths }
}

type SlotResult =
  | { state: 'absent' }
  | { state: 'known'; formatId: string }
  | { state: 'unknown'; relative: string }

/**
 * Fail-closed bounded listing: ENOENT means no directory, an unreadable or
 * non-directory target surfaces as 'unreadable', and a listing beyond the
 * ceiling — or beyond the shared budget — returns 'overflow'; the caller
 * must flag the directory instead of silently inspecting a prefix.
 * Iteration is incremental (opendir), so the enumeration promise is bounded
 * end to end.
 */
export async function boundedEntries(
  directory: string,
  budget: InspectionBudget,
  ceiling: number = ENUMERATION_CEILING,
): Promise<readonly string[] | 'unreadable' | 'overflow'> {
  const fs = await import('node:fs/promises')
  let handle
  try {
    handle = await fs.opendir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    return 'unreadable'
  }
  const names: string[] = []
  try {
    for (;;) {
      const entry = await handle.read()
      if (entry === null) break
      names.push(entry.name)
      if (!takeEntries(budget, 1)) return 'overflow'
      if (names.length > ceiling) return 'overflow'
    }
  } catch {
    return 'unreadable'
  } finally {
    await handle.close().catch(() => undefined)
  }
  return names
}

/**
 * Classification for a directory the inspection wants to descend into:
 * 'real-dir' (safe to follow), 'absent', or 'foreign' (a symlink or
 * non-directory planted where data lives — never followed, surfaced as
 * unknown data).
 */
async function directoryKind(directory: string): Promise<'real-dir' | 'absent' | 'foreign'> {
  const identity = await safeLstat(directory)
  if (identity === undefined) return 'absent'
  if (identity.isSymbolicLink() || !identity.isDirectory()) return 'foreign'
  return 'real-dir'
}

async function safeLstat(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

async function regularFile(file: string): Promise<boolean> {
  const identity = await safeLstat(file)
  return identity !== undefined && identity.isFile()
}

/** `.credentials.yaml`: upstream defines `version: 1` + a refs map; the
 * pre-release flat layout is a foreign shape, not this baseline's format. */
async function credentialsFormatId(file: string, budget: InspectionBudget): Promise<SlotResult> {
  const relative = path.basename(file)
  const identity = await safeLstat(file)
  if (identity === undefined) return { state: 'absent' }
  if (identity.isSymbolicLink() || !identity.isFile()) {
    return { state: 'unknown', relative }
  }
  const text = await readBoundedText(file, CREDENTIALS_READ_CAP, budget)
  if (text === 'unreadable' || text === 'too-large') return { state: 'unknown', relative }
  const header = /^version:[ \t]*(\d+)[ \t]*$/m.exec(text)
  // The baseline credentials file carries `version: 1` plus one or both of
  // the two sections this release knows: `refs:` (API-key references via
  // dsh-credentials-local) and `records:` (connection grants written by the
  // desktop Host). Either section is the known baseline format.
  if (header !== null && header[1] === '1' && (/^refs:/m.test(text) || /^records:/m.test(text))) {
    return { state: 'known', formatId: `dsh-credentials-file-${header[1]}` }
  }
  return { state: 'unknown', relative }
}

/**
 * Bounded text read: at most `capBytes` bytes are ever buffered, so a
 * planted huge file cannot DoS the inspection. Reading past the cap reports
 * 'too-large' (fail-closed callers classify it as unknown data); a failed
 * open/read — or a budget breach — reports 'unreadable'. Opening a FIFO for
 * reading blocks until a writer appears, and symlinks are followed by
 * open(): both are refused before open, only real regular files are ever
 * opened.
 */
async function readBoundedText(
  file: string,
  capBytes: number,
  budget: InspectionBudget,
): Promise<string | 'too-large' | 'unreadable'> {
  if (budgetExhausted(budget)) return 'unreadable'
  const identity = await safeLstat(file)
  if (identity === undefined || identity.isSymbolicLink() || !identity.isFile()) {
    return 'unreadable'
  }
  const handle = await openFile(file)
  if (handle === undefined) return 'unreadable'
  try {
    // Budget-first read sizing: never read past what the remaining budget
    // can account for, so a budget breach cannot over-read a whole file cap.
    const readLength = Math.min(capBytes + 1, budget.bytes + 1)
    if (readLength <= 0) return 'unreadable'
    const buffer = Buffer.alloc(readLength)
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0)
    if (!takeBytes(budget, bytesRead)) return 'unreadable'
    if (bytesRead > capBytes) return 'too-large'
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return 'unreadable'
  } finally {
    await handle.close()
  }
}

/** `settings.yaml` / `settings.json`: the provider build is the format
 * identity — upstream defines no version header to read. */
async function settingsFormatId(home: string): Promise<SlotResult> {
  const yaml = path.join(home, 'settings.yaml')
  const json = path.join(home, 'settings.json')
  if (await regularFile(yaml)) return { state: 'known', formatId: SETTINGS_FORMAT_ID }
  if (await regularFile(json)) return { state: 'known', formatId: SETTINGS_FORMAT_ID }
  for (const file of [yaml, json]) {
    const identity = await safeLstat(file)
    if (identity !== undefined) return { state: 'unknown', relative: path.basename(file) }
  }
  return { state: 'absent' }
}

/**
 * Sessions: `<home>/sessions/<encoded-cwd>/<id>/session.jsonl[.zstd]`. A
 * plaintext file is header-checked (first line `type:'session'`, known
 * version); a `.zstd` file must begin with a real zstd frame magic — the
 * extension alone proves nothing, and decompressing here would violate
 * read-only header-only inspection. Foreign shapes and unknown headers
 * surface as unknown paths at every position.
 */
async function sessionsFormatId(
  home: string,
  budget: InspectionBudget,
): Promise<{ state: 'absent' } | { state: 'known'; formatId: string; unknown: string[] }> {
  const sessionsDir = path.join(home, 'sessions')
  const dirIdentity = await safeLstat(sessionsDir)
  if (dirIdentity === undefined) return { state: 'absent' }
  if (dirIdentity.isSymbolicLink() || !dirIdentity.isDirectory()) {
    return { state: 'known', formatId: SESSION_JSONL_FORMAT_ID, unknown: ['sessions'] }
  }
  const unknown: string[] = []
  let sawAny = false
  let sawAllKnown = true
  const projectsAll = await boundedEntries(sessionsDir, budget)
  if (projectsAll === 'unreadable' || projectsAll === 'overflow') {
    return { state: 'known', formatId: SESSION_JSONL_FORMAT_ID, unknown: ['sessions'] }
  }
  for (const project of projectsAll) {
    if (budgetExhausted(budget)) {
      return { state: 'known', formatId: SESSION_JSONL_FORMAT_ID, unknown: ['sessions'] }
    }
    const projectDir = path.join(sessionsDir, project)
    const projectKind = await directoryKind(projectDir)
    if (projectKind === 'absent') continue
    if (projectKind === 'foreign') {
      sawAllKnown = false
      flagUnknown(budget, unknown, path.relative(home, projectDir))
      continue
    }
    const sessionIdsAll = await boundedEntries(projectDir, budget)
    if (sessionIdsAll === 'unreadable' || sessionIdsAll === 'overflow') {
      sawAllKnown = false
      flagUnknown(budget, unknown, path.relative(home, projectDir))
      continue
    }
    for (const sessionId of sessionIdsAll) {
      // Bounded output: stop flagging once the shared unknowns budget is
      // spent — earlier flags already refuse the slot.
      if (budgetExhausted(budget)) break
      const sessionDir = path.join(projectDir, sessionId)
      const sessionKind = await directoryKind(sessionDir)
      if (sessionKind === 'foreign') {
        sawAllKnown = false
        flagUnknown(budget, unknown, path.relative(home, sessionDir))
        continue
      }
      if (sessionKind === 'absent') continue
      const plain = path.join(sessionDir, 'session.jsonl')
      const zstd = path.join(sessionDir, 'session.jsonl.zstd')
      const plainIdentity = await safeLstat(plain)
      const zstdIdentity = await safeLstat(zstd)
      const plainRegular = plainIdentity !== undefined && plainIdentity.isFile()
      const zstdRegular = zstdIdentity !== undefined && zstdIdentity.isFile()
      if (plainRegular || zstdRegular) sawAny = true
      if (
        (plainIdentity !== undefined && !plainRegular) ||
        (zstdIdentity !== undefined && !zstdRegular)
      ) {
        // Present at the data path but not a regular file (symlink, fifo,
        // ...): a containment failure at any position.
        sawAllKnown = false
        flagUnknown(budget, unknown, path.relative(home, plain))
        continue
      }
      if (!plainRegular && !zstdRegular) continue
      if (plainRegular && zstdRegular) {
        // The upstream session backend rejects two encodings of one session
        // in the same directory; admission must not silently prefer one and
        // skip the other's classification.
        sawAllKnown = false
        flagUnknown(budget, unknown, path.relative(home, plain))
        continue
      }
      if (plainRegular) {
        if (!(await isKnownSessionHeader(plain, budget))) {
          sawAllKnown = false
          flagUnknown(budget, unknown, path.relative(home, plain))
        }
      } else if (!(await hasZstdFrameHeader(zstd, budget))) {
        sawAllKnown = false
        flagUnknown(budget, unknown, path.relative(home, zstd))
      }
    }
  }
  // Absent only when nothing was seen AND nothing was flagged: an unreadable
  // project directory with no other sessions must surface its unknown path,
  // not silently count as "no sessions".
  if (!sawAny && unknown.length === 0) return { state: 'absent' }
  if (sawAllKnown) return { state: 'known', formatId: SESSION_JSONL_FORMAT_ID, unknown: [] }
  return { state: 'known', formatId: SESSION_JSONL_FORMAT_ID, unknown }
}

async function isKnownSessionHeader(file: string, budget: InspectionBudget): Promise<boolean> {
  const handle = await openFile(file)
  if (handle === undefined) return false
  try {
    const readLength = Math.min(FIRST_LINE_BYTES, budget.bytes + 1)
    if (readLength <= 0) return false
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(readLength), 0, readLength, 0)
    if (!takeBytes(budget, bytesRead)) return false
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(firstLine)
    } catch {
      return false
    }
    if (typeof parsed !== 'object' || parsed === null) return false
    const header = parsed as Record<string, unknown>
    if (header.type !== 'session') return false
    // The baseline writes SESSION_FORMAT_VERSION=0; anything else is a
    // format this release has no evidence for.
    return header.version === 0
  } finally {
    await handle.close()
  }
}

/**
 * A compressed session is accepted only when it opens with a real zstd frame
 * header (RFC 8878): the standard frame magic 0xFD2FB528 — or a skippable
 * frame magic 0x184D2A50–0x184D2A5F, which multi-frame writers may prepend,
 * carrying a 4-byte frame size — followed by a well-formed frame-header
 * descriptor (reserved bit clear) and the window/dictionary/content-size
 * fields its descriptor declares. Magic alone proves a type, not a frame; a
 * truncated or malformed header is unknown data. Decompression stays out of
 * scope (read-only header-only inspection).
 */
async function hasZstdFrameHeader(file: string, budget: InspectionBudget): Promise<boolean> {
  const handle = await openFile(file)
  if (handle === undefined) return false
  try {
    const readLength = Math.min(18, budget.bytes + 1)
    if (readLength < 8) return false
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(readLength), 0, readLength, 0)
    if (!takeBytes(budget, bytesRead)) return false
    if (bytesRead < 5) return false
    const magic = buffer.readUInt32LE(0)
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      // Skippable frame: magic + 4-byte frame size.
      return bytesRead >= 8
    }
    if (magic !== 0xfd2fb528) return false
    const descriptor = buffer[4]
    if (descriptor === undefined) return false
    if ((descriptor & 0b0000_1000) !== 0) return false // reserved bit must be zero
    const fcsCode = (descriptor >> 6) & 0b11
    const singleSegment = (descriptor >> 5) & 0b1
    const dictCode = descriptor & 0b11
    const dictLength = [0, 1, 2, 4][dictCode] ?? 0
    const fcsLength =
      singleSegment === 1 ? ([1, 2, 4, 8][fcsCode] ?? 1) : ([0, 2, 4, 8][fcsCode] ?? 0)
    const headerLength = 5 + (singleSegment === 1 ? 0 : 1) + dictLength + fcsLength
    return bytesRead >= headerLength
  } finally {
    await handle.close()
  }
}

async function openFile(file: string) {
  const fs = await import('node:fs/promises')
  return fs.open(file, 'r').catch(() => undefined)
}

/**
 * Storages: `<home>/storages/**` — a JSON file must carry a `{name,version}`
 * unit header; a directory is a per-record unit (its `global.json` and every
 * record document are version-stamped). The projection-cache domain
 * additionally pins its own format id when recognized.
 */
async function storagesFormatId(
  home: string,
  budget: InspectionBudget,
): Promise<
  | {
      state: 'absent'
    }
  | { state: 'known'; formatId: string; unknown: string[]; projcache: 4 | 'foreign' | 'none' }
> {
  const storagesDir = path.join(home, 'storages')
  const dirIdentity = await safeLstat(storagesDir)
  if (dirIdentity === undefined) return { state: 'absent' }
  if (dirIdentity.isSymbolicLink() || !dirIdentity.isDirectory()) {
    return {
      state: 'known',
      formatId: STORAGE_UNIT_FORMAT_ID,
      unknown: ['storages'],
      projcache: 'none',
    }
  }
  const unknown: string[] = []
  let sawAny = false
  let projcache: 4 | 'foreign' | 'none' = 'none'
  let projcacheFromSingleFile: number | undefined
  let projcacheFromDirectory: number | undefined
  let projcacheInteriorFlagged = false
  const entriesAll = await boundedEntries(storagesDir, budget)
  if (entriesAll === 'unreadable' || entriesAll === 'overflow') {
    return {
      state: 'known',
      formatId: STORAGE_UNIT_FORMAT_ID,
      unknown: ['storages'],
      projcache: 'none',
    }
  }
  for (const entry of entriesAll) {
    if (budgetExhausted(budget)) {
      return {
        state: 'known',
        formatId: STORAGE_UNIT_FORMAT_ID,
        unknown: ['storages'],
        projcache: 'none',
      }
    }
    const target = path.join(storagesDir, entry)
    const identity = await safeLstat(target)
    if (identity === undefined) continue
    sawAny = true
    if (identity.isSymbolicLink()) {
      flagUnknown(budget, unknown, path.relative(home, target))
      continue
    }
    if (!identity.isFile() && !identity.isDirectory()) {
      // present but neither file nor directory (fifo, socket, ...)
      flagUnknown(budget, unknown, path.relative(home, target))
      continue
    }
    if (identity.isFile()) {
      const unit = await readUnitHeader(target, budget)
      if (unit === undefined) {
        flagUnknown(budget, unknown, path.relative(home, target))
        continue
      }
      if (unit.name === 'session_projcache') {
        projcacheFromSingleFile = unit.version
      }
      continue
    }
    // Per-record units take their identity from the directory name; the
    // version stamp lives in global.json when the domain has a global slot,
    // otherwise in the record documents themselves. The interior walk runs
    // for EVERY unit and classifies EVERY record against the unit's own
    // version: the unit stamp anchors the records, and a record stamped
    // differently is data upstream's storage backend would silently treat as
    // absent — a future-version record must never ride through admission.
    const global = path.join(target, 'global.json')
    const globalIdentity = await safeLstat(global)
    let unitVersion: number | undefined
    if (globalIdentity !== undefined) {
      if (globalIdentity.isSymbolicLink() || !globalIdentity.isFile()) {
        flagUnknown(budget, unknown, path.relative(home, global))
      } else {
        const stamp = await readRecordStamp(global, budget)
        if (stamp === undefined) {
          flagUnknown(budget, unknown, path.relative(home, global))
        } else {
          unitVersion = stamp
          if (entry === 'session_projcache') projcacheFromDirectory = stamp
        }
      }
    } else if (entry === 'session_projcache') {
      unitVersion = 4
      projcacheFromDirectory = await sampleRecordStamp(target, budget)
    }
    const interiorFlagged = await auditUnitInterior(target, home, unitVersion, unknown, budget)
    if (entry === 'session_projcache' && interiorFlagged) projcacheInteriorFlagged = true
  }
  // The projection-cache domain's live layout wins: a migrated home keeps a
  // stale single-unit file from an older domain version next to the current
  // per-record directory, and that leftover must not flip the slot to
  // foreign. The single file decides only when no directory exists — but a
  // flagged interior (corrupt or foreign-version record) makes the domain
  // foreign regardless of what its stamps sampled.
  if (projcacheInteriorFlagged) {
    projcache = 'foreign'
  } else if (projcacheFromDirectory !== undefined) {
    projcache = projcacheFromDirectory === 4 ? 4 : 'foreign'
  } else if (projcacheFromSingleFile !== undefined) {
    projcache = projcacheFromSingleFile === 4 ? 4 : 'foreign'
  }
  if (!sawAny) return { state: 'absent' }
  return { state: 'known', formatId: STORAGE_UNIT_FORMAT_ID, unknown, projcache }
}

/**
 * Containment + classification walk of a per-record storage unit's interior:
 * every entry must be a real directory (a table) or a real regular file, and
 * every regular record is version-stamp-classified against the unit's own
 * version — a corrupt record is unknown data, and a record stamped
 * differently from its unit (or from the first-anchored version when the
 * unit has no global document) is data upstream's storage backend would
 * silently treat as absent. The domain-global document is the one regular
 * file allowed at unit level (classified by the caller). A symlink, FIFO,
 * or any other shape is surfaced as an unknown path: the runtime reads and
 * writes these exact paths, so a planted link must never ride through
 * admission hidden inside the unit envelope. Enumeration uses the shared
 * bounded listing and budget; overflow — or a budget breach, which stops
 * the record loop at its next iteration — flags the unit fail-closed.
 */
async function auditUnitInterior(
  unitDirectory: string,
  home: string,
  unitVersion: number | undefined,
  unknown: string[],
  budget: InspectionBudget,
): Promise<boolean> {
  const tables = await boundedEntries(unitDirectory, budget)
  if (tables === 'unreadable' || tables === 'overflow') {
    flagUnknown(budget, unknown, path.relative(home, unitDirectory))
    return true
  }
  let flagged = false
  let anchoredVersion = unitVersion
  for (const table of tables) {
    if (budgetExhausted(budget)) {
      flagUnknown(budget, unknown, path.relative(home, unitDirectory))
      return true
    }
    const tableDir = path.join(unitDirectory, table)
    const tableIdentity = await safeLstat(tableDir)
    if (tableIdentity === undefined) continue
    if (tableIdentity.isSymbolicLink()) {
      flagUnknown(budget, unknown, path.relative(home, tableDir))
      flagged = true
      continue
    }
    if (!tableIdentity.isDirectory()) {
      // The domain-global document is the one regular file allowed at unit
      // level (its content is classified separately); any other file — or a
      // non-regular global.json — is not part of the per-record layout.
      if (!(table === 'global.json' && tableIdentity.isFile())) {
        flagUnknown(budget, unknown, path.relative(home, tableDir))
        flagged = true
      }
      continue
    }
    const records = await boundedEntries(tableDir, budget)
    if (records === 'unreadable' || records === 'overflow') {
      flagUnknown(budget, unknown, path.relative(home, tableDir))
      flagged = true
      continue
    }
    for (const record of records) {
      // The unknowns budget must bound the OUTPUT: stop the walk when it is
      // spent and collapse to one unit-level unknown.
      if (budgetExhausted(budget)) {
        flagUnknown(budget, unknown, path.relative(home, unitDirectory))
        return true
      }
      const recordPath = path.join(tableDir, record)
      const recordIdentity = await safeLstat(recordPath)
      if (recordIdentity === undefined) continue
      if (recordIdentity.isSymbolicLink() || !recordIdentity.isFile()) {
        flagUnknown(budget, unknown, path.relative(home, recordPath))
        flagged = true
        continue
      }
      // Content classification: every record document must carry a valid
      // version stamp (`{version, record}` per dsh-storage-json
      // serializeRecord()); unparseable or unstamped content is unknown, and
      // a stamp that disagrees with the unit's version (or with the first
      // record seen in an anchor-less unit) is data upstream would silently
      // drop.
      const stamp = await readRecordStamp(recordPath, budget)
      if (stamp === undefined) {
        flagUnknown(budget, unknown, path.relative(home, recordPath))
        flagged = true
        continue
      }
      if (anchoredVersion === undefined) anchoredVersion = stamp
      if (stamp === anchoredVersion) continue
      flagUnknown(budget, unknown, path.relative(home, recordPath))
      flagged = true
    }
  }
  return flagged
}

/**
 * Single-layout unit header: the document is `{unit:{name,version}, global,
 * tables}` (dsh-storage-json serialize()). Returns the nested unit header.
 */
async function readUnitHeader(
  file: string,
  budget: InspectionBudget,
): Promise<{ name: string; version: number } | undefined> {
  const text = await readBoundedText(file, STORAGE_READ_CAP, budget)
  if (text === 'unreadable' || text === 'too-large') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const document = parsed as Record<string, unknown>
    const unit = document.unit
    if (typeof unit !== 'object' || unit === null || Array.isArray(unit)) return undefined
    const header = unit as Record<string, unknown>
    if (typeof header.name !== 'string' || header.name === '') return undefined
    if (typeof header.version !== 'number' || !Number.isSafeInteger(header.version)) {
      return undefined
    }
    return { name: header.name, version: header.version }
  } catch {
    return undefined
  }
}

/**
 * Sample the first record document of a per-record unit's first table to read
 * its version stamp. Bounded to one level and a handful of files.
 */
async function sampleRecordStamp(
  unitDirectory: string,
  budget: InspectionBudget,
): Promise<number | undefined> {
  const names = await boundedEntries(unitDirectory, budget)
  if (names === 'unreadable' || names === 'overflow') return undefined
  const tableDirs: string[] = []
  for (const name of names.slice(0, 4)) {
    const identity = await safeLstat(path.join(unitDirectory, name))
    if (identity !== undefined && identity.isDirectory()) tableDirs.push(name)
  }
  for (const table of tableDirs) {
    const tableDir = path.join(unitDirectory, table)
    const recordNames = await boundedEntries(tableDir, budget)
    if (recordNames === 'unreadable' || recordNames === 'overflow') continue
    for (const name of recordNames.filter((entry) => entry.endsWith('.json')).slice(0, 2)) {
      const stamp = await readRecordStamp(path.join(tableDir, name), budget)
      if (stamp !== undefined) return stamp
    }
  }
  return undefined
}

/**
 * Per-record document: `{version, record}` (dsh-storage-json
 * serializeRecord()); the unit identity is the containing directory name.
 */
async function readRecordStamp(
  file: string,
  budget: InspectionBudget,
): Promise<number | undefined> {
  const text = await readBoundedText(file, RECORD_READ_CAP, budget)
  if (text === 'unreadable' || text === 'too-large') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const document = parsed as Record<string, unknown>
    if (typeof document.version !== 'number' || !Number.isSafeInteger(document.version)) {
      return undefined
    }
    return document.version
  } catch {
    return undefined
  }
}

/** Profiles: `<home>/profiles/<name>/package.json` with a `dsh.profile`
 * object — the shape the upstream loader and profile-manager both own. */
async function profilesFormatId(
  home: string,
  budget: InspectionBudget,
): Promise<{ state: 'absent' } | { state: 'known'; formatId: string; unknown: string[] }> {
  const profilesDir = path.join(home, 'profiles')
  const dirIdentity = await safeLstat(profilesDir)
  if (dirIdentity === undefined) return { state: 'absent' }
  if (dirIdentity.isSymbolicLink() || !dirIdentity.isDirectory()) {
    return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown: ['profiles'] }
  }
  const unknown: string[] = []
  let sawAny = false
  let sawUnknownManifest = false
  const entriesAll = await boundedEntries(profilesDir, budget)
  if (entriesAll === 'unreadable' || entriesAll === 'overflow') {
    return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown: ['profiles'] }
  }
  // The ONLY exempt entries are the runtime's own launch roots
  // (`.dsh-desktop-run-*`, mkdtemp-created by host-supervisor) when they are
  // REAL directories — a symlink wearing that name is flagged like any
  // other, and profile NAMING reserves that prefix
  // (createProfileRef), so no user profile can hide behind it. Every other
  // entry — dot-prefixed or not (`.prod` is a legal profile name) — is
  // inspected fully. A loose regular file (Finder's .DS_Store and friends)
  // is not a profile and is never loaded by the runtime; it is skipped,
  // while symlinks, FIFOs, and any other non-regular shape are flagged.
  for (const entry of entriesAll) {
    if (budgetExhausted(budget)) {
      return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown: ['profiles'] }
    }
    const profileDir = path.join(profilesDir, entry)
    const identity = await safeLstat(profileDir)
    if (identity === undefined) continue
    if (entry.startsWith('.dsh-desktop-run-') && identity.isDirectory()) continue
    if (identity.isFile()) continue
    sawAny = true
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      sawUnknownManifest = true
      flagUnknown(budget, unknown, path.relative(home, profileDir))
      continue
    }
    const manifest = path.join(profileDir, 'package.json')
    const manifestIdentity = await safeLstat(manifest)
    if (manifestIdentity === undefined) continue
    if (manifestIdentity.isSymbolicLink() || !manifestIdentity.isFile()) {
      sawUnknownManifest = true
      flagUnknown(budget, unknown, path.relative(home, manifest))
      continue
    }
    const text = await readBoundedText(manifest, PROFILE_READ_CAP, budget)
    if (text === 'unreadable' || text === 'too-large') {
      sawUnknownManifest = true
      flagUnknown(budget, unknown, path.relative(home, manifest))
      continue
    }
    try {
      const parsed: unknown = JSON.parse(text)
      // The upstream profile manifest shape is a JSON object with an OPTIONAL
      // dsh section: app-owned profiles carry dsh.profile, while third-party
      // bundles installed by the user are plain package.json manifests. Both
      // are this baseline's known profile format; only unparseable or
      // non-object content is foreign.
      if (typeof parsed === 'object' && parsed !== null) continue
      sawUnknownManifest = true
      flagUnknown(budget, unknown, path.relative(home, manifest))
    } catch {
      sawUnknownManifest = true
      flagUnknown(budget, unknown, path.relative(home, manifest))
    }
  }
  if (!sawAny) return { state: 'absent' }
  if (sawUnknownManifest) return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown }
  return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown: [] }
}
