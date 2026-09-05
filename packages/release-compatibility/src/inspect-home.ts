import { lstat, readdir, readFile } from 'node:fs/promises'
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
const MAX_SESSION_PROJECTS = 32
const MAX_SESSIONS_PER_PROJECT = 32
const MAX_STORAGE_ENTRIES = 64
const MAX_PROFILE_ENTRIES = 32
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
  if (!(await regularFile(file))) return { state: 'absent' }
  const text = await readFile(file, 'utf8').catch(() => '')
  const header = /^version:[ \t]*(\d+)[ \t]*$/m.exec(text)
  if (header !== null && header[1] === '1' && /^refs:/m.test(text)) {
    return { state: 'known', formatId: `dsh-credentials-file-${header[1]}` }
  }
  return { state: 'unknown', relative }
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
  const projects = (await readdir(sessionsDir).catch(() => [])).slice(0, MAX_SESSION_PROJECTS)
  for (const project of projects) {
    const projectDir = path.join(sessionsDir, project)
    const projectIdentity = await safeLstat(projectDir)
    if (projectIdentity === undefined || !projectIdentity.isDirectory()) continue
    const sessionIds = (await readdir(projectDir).catch(() => [])).slice(
      0,
      MAX_SESSIONS_PER_PROJECT,
    )
    for (const sessionId of sessionIds) {
      const sessionDir = path.join(projectDir, sessionId)
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
  if (!sawAny) return { state: 'absent' }
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
  const entries = (await readdir(storagesDir).catch(() => [])).slice(0, MAX_STORAGE_ENTRIES)
  for (const entry of entries) {
    const target = path.join(storagesDir, entry)
    const identity = await safeLstat(target)
    if (identity === undefined) continue
    sawAny = true
    if (identity.isFile()) {
      const unit = await readUnitHeader(target)
      if (unit === undefined) {
        unknown.push(path.relative(home, target))
        continue
      }
      if (unit.name === 'session_projcache') {
        projcache = unit.version === 4 ? 4 : 'foreign'
      }
      continue
    }
    if (identity.isDirectory()) {
      const global = path.join(target, 'global.json')
      if (await regularFile(global)) {
        const stamp = await readRecordStamp(global)
        if (stamp === undefined) {
          unknown.push(path.relative(home, global))
        } else if (entry === 'session_projcache') {
          projcache = stamp === 4 ? 4 : 'foreign'
        }
      }
    }
  }
  if (!sawAny) return { state: 'absent' }
  return { state: 'known', formatId: STORAGE_UNIT_FORMAT_ID, unknown, projcache }
}

/**
 * Single-layout unit header: the document is `{unit:{name,version}, global,
 * tables}` (dsh-storage-json serialize()). Returns the nested unit header.
 */
async function readUnitHeader(
  file: string,
): Promise<{ name: string; version: number } | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
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
 * Per-record document: `{version, record}` (dsh-storage-json
 * serializeRecord()); the unit identity is the containing directory name.
 */
async function readRecordStamp(file: string): Promise<number | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
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
  const entries = (await readdir(profilesDir).catch(() => [])).slice(0, MAX_PROFILE_ENTRIES)
  for (const entry of entries) {
    if (entry.startsWith('.')) continue // runtime launch roots are not data
    const manifest = path.join(profilesDir, entry, 'package.json')
    const identity = await safeLstat(manifest)
    if (identity === undefined) continue
    sawAny = true
    const text = await readFile(manifest, 'utf8').catch(() => '')
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
