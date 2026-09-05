import { lstat, readdir } from 'node:fs/promises'
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
const MAX_SESSION_PROJECTS = 32
const MAX_SESSIONS_PER_PROJECT = 32
const MAX_STORAGE_ENTRIES = 64
const MAX_PROFILE_ENTRIES = 32
/** Per-unit interior walk budget: linear, fail-closed on overflow. */
const MAX_UNIT_INTERIOR_ENTRIES = 512
const FIRST_LINE_BYTES = 4096

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Read-only home inspection for the compatibility preflight: parse only
 * well-known file headers and layouts (credentials version header, session
 * JSONL first line, storage unit headers, profile manifests). It never loads
 * DSH code or user plugins, never starts providers, and never writes. A
 * symlink planted at an inspected path counts as an unknown path — fail
 * closed.
 */
export async function inspectHomeFormats(home: string): Promise<HomeFormatState> {
  const formats: Mutable<Record<string, string>> = {}
  const unknownPaths: string[] = []

  const credentials = await credentialsFormatId(path.join(home, '.credentials.yaml'))
  if (credentials.state === 'known') formats.credentials = credentials.formatId
  if (credentials.state === 'unknown') unknownPaths.push(credentials.relative)

  const settings = await settingsFormatId(home)
  if (settings.state === 'known') formats.settings = settings.formatId
  if (settings.state === 'unknown') unknownPaths.push(settings.relative)

  const sessions = await sessionsFormatId(home)
  if (sessions.state === 'known') {
    // A slot only claims its format when every inspected item matched;
    // otherwise the offending paths drive the unknown-format refusal.
    if (sessions.unknown.length === 0) formats.sessions = sessions.formatId
    else for (const relative of sessions.unknown) unknownPaths.push(relative)
  }

  const storages = await storagesFormatId(home)
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

  const profiles = await profilesFormatId(home)
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
 * Fail-closed directory listing: ENOENT means no directory, every other
 * failure (EACCES, EMFILE, EISDIR-on-non-dir, ...) surfaces as 'unreadable'
 * so the slot can be refused instead of silently treated as empty.
 */
async function readdirSafe(directory: string): Promise<readonly string[] | 'unreadable'> {
  try {
    return await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    return 'unreadable'
  }
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
async function credentialsFormatId(file: string): Promise<SlotResult> {
  const relative = path.basename(file)
  const identity = await safeLstat(file)
  if (identity === undefined) return { state: 'absent' }
  if (identity.isSymbolicLink() || !identity.isFile()) {
    return { state: 'unknown', relative }
  }
  const text = await readBoundedText(file, CREDENTIALS_READ_CAP)
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
 * open/read reports 'unreadable'.
 */
async function readBoundedText(
  file: string,
  capBytes: number,
): Promise<string | 'too-large' | 'unreadable'> {
  // Opening a FIFO for reading blocks until a writer appears — a planted
  // named pipe would hang the boot path forever. Symlinks are followed by
  // open(), letting planted links read outside the home. Both are refused
  // before open: only real regular files are ever opened.
  const identity = await safeLstat(file)
  if (identity === undefined || identity.isSymbolicLink() || !identity.isFile()) {
    return 'unreadable'
  }
  const handle = await openFile(file)
  if (handle === undefined) return 'unreadable'
  try {
    const buffer = Buffer.alloc(capBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, capBytes + 1, 0)
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
 * version); a `.zstd` file is classified by name — this baseline wrote it
 * (multi-frame zstd), and decompressing here would violate read-only
 * header-only inspection. Unknown headers surface as unknown paths.
 */
async function sessionsFormatId(
  home: string,
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
  const projectsAll = await readdirSafe(sessionsDir)
  if (projectsAll === 'unreadable') {
    return { state: 'known', formatId: SESSION_JSONL_FORMAT_ID, unknown: ['sessions'] }
  }
  const projects = projectsAll.slice(0, MAX_SESSION_PROJECTS)
  for (const project of projects) {
    const projectDir = path.join(sessionsDir, project)
    const projectKind = await directoryKind(projectDir)
    if (projectKind === 'absent') continue
    if (projectKind === 'foreign') {
      sawAllKnown = false
      unknown.push(path.relative(home, projectDir))
      continue
    }
    const sessionIdsAll = await readdirSafe(projectDir)
    if (sessionIdsAll === 'unreadable') {
      sawAllKnown = false
      unknown.push(path.relative(home, projectDir))
      continue
    }
    const sessionIds = sessionIdsAll.slice(0, MAX_SESSIONS_PER_PROJECT)
    for (const sessionId of sessionIds) {
      const sessionDir = path.join(projectDir, sessionId)
      const sessionKind = await directoryKind(sessionDir)
      if (sessionKind === 'foreign') {
        sawAllKnown = false
        unknown.push(path.relative(home, sessionDir))
        continue
      }
      if (sessionKind === 'absent') continue
      const plain = path.join(sessionDir, 'session.jsonl')
      const zstd = path.join(sessionDir, 'session.jsonl.zstd')
      if (await regularFile(plain)) {
        sawAny = true
        if (!(await isKnownSessionHeader(plain))) {
          sawAllKnown = false
          unknown.push(path.relative(home, plain))
        }
        continue
      }
      if (await regularFile(zstd)) {
        sawAny = true
        continue
      }
      const plainIdentity = await safeLstat(plain)
      const zstdIdentity = await safeLstat(zstd)
      if (plainIdentity !== undefined || zstdIdentity !== undefined) {
        sawAllKnown = false
        unknown.push(path.relative(home, plain))
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

async function isKnownSessionHeader(file: string): Promise<boolean> {
  const handle = await openFile(file)
  if (handle === undefined) return false
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(FIRST_LINE_BYTES),
      0,
      FIRST_LINE_BYTES,
      0,
    )
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

async function openFile(file: string) {
  const fs = await import('node:fs/promises')
  return fs.open(file, 'r').catch(() => undefined)
}

/**
 * Storages: `<home>/storages/**` — a JSON file must carry a `{name,version}`
 * unit header; a directory is a per-record unit (its `global.json` is
 * header-checked). The projection-cache domain additionally pins its own
 * format id when recognized.
 */
async function storagesFormatId(home: string): Promise<
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
  const entriesAll = await readdirSafe(storagesDir)
  if (entriesAll === 'unreadable') {
    return {
      state: 'known',
      formatId: STORAGE_UNIT_FORMAT_ID,
      unknown: ['storages'],
      projcache: 'none',
    }
  }
  const entries = entriesAll.slice(0, MAX_STORAGE_ENTRIES)
  for (const entry of entries) {
    const target = path.join(storagesDir, entry)
    const identity = await safeLstat(target)
    if (identity === undefined) continue
    sawAny = true
    if (identity.isSymbolicLink()) {
      unknown.push(path.relative(home, target))
      continue
    }
    if (identity.isFile()) {
      const unit = await readUnitHeader(target)
      if (unit === undefined) {
        unknown.push(path.relative(home, target))
        continue
      }
      if (unit.name === 'session_projcache') {
        projcacheFromSingleFile = unit.version
      }
      continue
    }
    if (identity.isDirectory()) {
      // Per-record units take their identity from the directory name; the
      // version stamp lives in global.json when the domain has a global slot,
      // otherwise in the record documents themselves. The interior is walked
      // in full (bounded): the inspection's containment promise — a planted
      // symlink at an inspected data path is unknown, never followed —
      // covers the record paths this release writes, not just the unit
      // envelope.
      const global = path.join(target, 'global.json')
      if (await regularFile(global)) {
        const stamp = await readRecordStamp(global)
        if (stamp === undefined) {
          unknown.push(path.relative(home, global))
          continue
        }
        if (entry === 'session_projcache') projcacheFromDirectory = stamp
        await auditUnitInterior(target, home, unknown)
        continue
      }
      if (entry === 'session_projcache') {
        projcacheFromDirectory = await sampleRecordStamp(target)
      }
      await auditUnitInterior(target, home, unknown)
      continue
    }
    // present but neither file nor directory (fifo, socket, ...)
    unknown.push(path.relative(home, target))
  }
  // The projection-cache domain's live layout wins: a migrated home keeps a
  // stale single-unit file from an older domain version next to the current
  // per-record directory, and that leftover must not flip the slot to
  // foreign. The single file decides only when no directory exists.
  if (projcacheFromDirectory !== undefined) {
    projcache = projcacheFromDirectory === 4 ? 4 : 'foreign'
  } else if (projcacheFromSingleFile !== undefined) {
    projcache = projcacheFromSingleFile === 4 ? 4 : 'foreign'
  }
  if (!sawAny) return { state: 'absent' }
  return { state: 'known', formatId: STORAGE_UNIT_FORMAT_ID, unknown, projcache }
}

/**
 * Containment walk of a per-record storage unit's interior: every entry must
 * be a real directory (a table) or a real regular file, within the bounded
 * budget. A symlink, FIFO, socket, or any other shape anywhere inside the
 * unit — including a swapped global.json or a symlinked table/record — is
 * surfaced as an unknown path: the runtime reads and writes these exact
 * paths, so a planted link must never ride through admission hidden inside
 * the unit envelope. Overflowing the budget flags the unit instead of
 * silently leaving the tail uninspected.
 */
async function auditUnitInterior(
  unitDirectory: string,
  home: string,
  unknown: string[],
): Promise<void> {
  let walked = 0
  const tables = await readdirSafe(unitDirectory)
  if (tables === 'unreadable') {
    unknown.push(path.relative(home, unitDirectory))
    return
  }
  for (const table of tables) {
    walked += 1
    if (walked > MAX_UNIT_INTERIOR_ENTRIES) {
      unknown.push(path.relative(home, unitDirectory))
      return
    }
    const tableDir = path.join(unitDirectory, table)
    const tableIdentity = await safeLstat(tableDir)
    if (tableIdentity === undefined) continue
    if (tableIdentity.isSymbolicLink()) {
      unknown.push(path.relative(home, tableDir))
      continue
    }
    if (!tableIdentity.isDirectory()) {
      // The domain-global document is the one regular file allowed at unit
      // level (its content is classified separately); any other file — or a
      // non-regular global.json — is not part of the per-record layout.
      if (!(table === 'global.json' && tableIdentity.isFile())) {
        unknown.push(path.relative(home, tableDir))
      }
      continue
    }
    const records = await readdirSafe(tableDir)
    if (records === 'unreadable') {
      unknown.push(path.relative(home, tableDir))
      continue
    }
    for (const record of records) {
      walked += 1
      if (walked > MAX_UNIT_INTERIOR_ENTRIES) {
        unknown.push(path.relative(home, unitDirectory))
        return
      }
      const recordPath = path.join(tableDir, record)
      const recordIdentity = await safeLstat(recordPath)
      if (recordIdentity === undefined) continue
      if (recordIdentity.isSymbolicLink() || !recordIdentity.isFile()) {
        unknown.push(path.relative(home, recordPath))
      }
    }
  }
}

/**
 * Single-layout unit header: the document is `{unit:{name,version}, global,
 * tables}` (dsh-storage-json serialize()). Returns the nested unit header.
 */
async function readUnitHeader(
  file: string,
): Promise<{ name: string; version: number } | undefined> {
  const text = await readBoundedText(file, STORAGE_READ_CAP)
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
async function sampleRecordStamp(unitDirectory: string): Promise<number | undefined> {
  const names = await readdirSafe(unitDirectory)
  if (names === 'unreadable') return undefined
  const tableDirs: string[] = []
  for (const name of names.slice(0, 4)) {
    const identity = await safeLstat(path.join(unitDirectory, name))
    if (identity !== undefined && identity.isDirectory()) tableDirs.push(name)
  }
  for (const table of tableDirs) {
    const tableDir = path.join(unitDirectory, table)
    const names = await readdirSafe(tableDir)
    if (names === 'unreadable') continue
    for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, 2)) {
      const stamp = await readRecordStamp(path.join(tableDir, name))
      if (stamp !== undefined) return stamp
    }
  }
  return undefined
}

/**
 * Per-record document: `{version, record}` (dsh-storage-json
 * serializeRecord()); the unit identity is the containing directory name.
 */
async function readRecordStamp(file: string): Promise<number | undefined> {
  const text = await readBoundedText(file, RECORD_READ_CAP)
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
  const entriesAll = await readdirSafe(profilesDir)
  if (entriesAll === 'unreadable') {
    return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown: ['profiles'] }
  }
  const entries = entriesAll.slice(0, MAX_PROFILE_ENTRIES)
  for (const entry of entries) {
    if (entry.startsWith('.')) continue // runtime launch roots are not data
    const profileDir = path.join(profilesDir, entry)
    const profileKind = await directoryKind(profileDir)
    if (profileKind === 'absent') continue
    if (profileKind === 'foreign') {
      sawAny = true
      sawUnknownManifest = true
      unknown.push(path.relative(home, profileDir))
      continue
    }
    const manifest = path.join(profileDir, 'package.json')
    const identity = await safeLstat(manifest)
    if (identity === undefined) continue
    sawAny = true
    if (identity.isSymbolicLink() || !identity.isFile()) {
      sawUnknownManifest = true
      unknown.push(path.relative(home, manifest))
      continue
    }
    const text = await readBoundedText(manifest, PROFILE_READ_CAP)
    if (text === 'unreadable' || text === 'too-large') {
      sawUnknownManifest = true
      unknown.push(path.relative(home, manifest))
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
      unknown.push(path.relative(home, manifest))
    } catch {
      sawUnknownManifest = true
      unknown.push(path.relative(home, manifest))
    }
  }
  if (!sawAny) return { state: 'absent' }
  if (sawUnknownManifest) return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown }
  return { state: 'known', formatId: PROFILE_FORMAT_ID, unknown: [] }
}
