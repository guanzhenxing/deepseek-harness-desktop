import { readFileSync } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HomeLease } from '@dsh-desktop/home-lease'

import {
  HomeAdmissionError,
  markerPath,
  parseHomeCompatibilityMarker,
  readHomeCompatibilityMarker,
  type HomeCompatibilityMarker,
} from './home-admission.js'
import { inspectHomeFormats, type HomeFormatState } from './inspect-home.js'
import { parseReleaseManifest, type ReleaseManifest } from './manifest.js'
import { preflightHome, type PreflightResult } from './preflight.js'

export { describePreflightRefusal } from './preflight.js'
export type { PreflightResult } from './preflight.js'

/** The unified verdict every supported entrypoint acts on. */
export type HomePreflightVerdict =
  | 'allow'
  | 'unknown-schema'
  | 'unsupported-data'
  | 'unknown-format'
  | 'unreadable-format'
  | 'migration-required'

async function syncDirectory(dirname: string): Promise<void> {
  const handle = await open(dirname, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * fsync'd temp file + atomic rename, mirroring the shell-core/profile-manager
 * durable-write discipline (this package cannot depend on shell-core — the
 * dependency edge points the other way — so the pattern is repeated here on
 * purpose).
 */
async function writeAtomicDurable(filename: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filename)
  } catch (error) {
    // Never leak the temp file when the atomic swap itself fails.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  const written = await open(filename, 'r')
  try {
    await written.sync()
  } finally {
    await written.close()
  }
  await syncDirectory(path.dirname(filename))
}

/**
 * Reserve the release's write epoch on the home BEFORE any new-format write:
 * the schema-1 marker records the candidate epoch, this releaseId, and the
 * observed format signatures. Failing afterwards never rewinds the epoch —
 * a crash mid-write must make later releases suspect partial new-format data,
 * not silently treat the home as old.
 *
 * The lease must be the one held for this home's session; reserving without
 * holding the home lease is refused. A symlinked run/ directory or an
 * existing marker that is not a regular file refuses (fail closed).
 */
export async function reserveHomeWrite(input: {
  home: string
  lease: HomeLease
  release: ReleaseManifest
  decision: Extract<PreflightResult, { kind: 'allow' }>
}): Promise<void> {
  if (input.lease.home !== input.home) {
    throw new HomeAdmissionError(
      'MARKER_UNREADABLE',
      'write reservation requires the lease of the same home',
    )
  }
  // A matching home path alone must not authorize the reservation: the lease
  // must still be held by this session (a released handle predates the
  // current owner and must not write).
  await input.lease.assertHeld()
  const run = path.join(input.home, 'run')
  const runIdentity = await lstat(run).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (runIdentity !== undefined && (runIdentity.isSymbolicLink() || !runIdentity.isDirectory())) {
    throw new HomeAdmissionError('MARKER_SYMLINK', 'run/ must be a real directory')
  }
  await mkdir(run, { recursive: true })
  const marker: HomeCompatibilityMarker = {
    schemaVersion: 1,
    dataEpoch: input.decision.dataEpoch,
    lastWriterReleaseId: input.release.releaseId,
    formats: { ...input.decision.formats },
  }
  await writeAtomicDurable(
    markerPath(input.home),
    Buffer.from(`${JSON.stringify(marker, undefined, 2)}\n`, 'utf8'),
  )
}

/**
 * The full admission chain every supported entrypoint runs in a fixed order:
 * parse marker → inspect (read-only) → preflight → reserveHomeWrite. Call it
 * after the lease is acquired (or with `reserve: false` on the lease-less
 * read-only passthrough paths) and before any profile/cache/Host write.
 * Read failures throw `HomeAdmissionError` and must be treated as refusals.
 */
export async function runHomeCompatibilityChain(input: {
  home: string
  release: ReleaseManifest
  lease?: HomeLease
  /** True when this entrypoint is about to write the home. */
  reserve: boolean
}): Promise<HomePreflightVerdict> {
  if (input.reserve && input.lease === undefined) {
    throw new HomeAdmissionError(
      'MARKER_UNREADABLE',
      'reserving a write epoch requires the home lease',
    )
  }
  const raw = await readHomeCompatibilityMarker(input.home)
  if (raw !== null && parseHomeCompatibilityMarker(raw) === undefined) {
    return 'unknown-schema'
  }
  const marker =
    raw === null ? null : (parseHomeCompatibilityMarker(raw) as HomeCompatibilityMarker)
  const observed: HomeFormatState = await inspectHomeFormats(input.home)
  const result = preflightHome({ release: input.release, marker, observed })
  if (result.kind === 'refuse') {
    switch (result.code) {
      case 'UNSUPPORTED_EPOCH':
        return 'unsupported-data'
      case 'UNKNOWN_FORMAT':
        return 'unknown-format'
      case 'UNREADABLE_FORMAT':
        return 'unreadable-format'
      case 'MIGRATION_REQUIRED':
        return 'migration-required'
    }
  }
  if (input.reserve) {
    await reserveHomeWrite({
      home: input.home,
      lease: input.lease!,
      release: input.release,
      decision: result,
    })
  }
  return 'allow'
}

/**
 * Load this release's manifest. Packaged builds read the embedded manifest
 * from the resources directory; development assembles the release facts from
 * the package constants (gate-bound to the authored policy) plus the
 * repository baseline document, marking the releaseId as development source.
 * Both paths end in the strict parser, so a corrupt embedded manifest refuses
 * to boot rather than degrading.
 */
export function loadReleaseManifest(input: {
  /** Directory holding the embedded compatibility.json (packaged). */
  resourcesDir?: string
  /** Repository root (development). */
  repositoryRoot?: string
}): ReleaseManifest {
  if (input.resourcesDir !== undefined) {
    const embedded = path.join(input.resourcesDir, 'compatibility.json')
    const parsed: unknown = JSON.parse(readFileSync(embedded, 'utf8'))
    return parseReleaseManifest(parsed)
  }
  const root = input.repositoryRoot ?? defaultRepositoryRoot()
  // Development assembles the manifest from the same authored sources the
  // generator consumes — docs/compatibility.json (baseline facts) and the
  // compatibility policy (formats/epochs) — so no second version truth can
  // drift in. The strict parser validates the result like any embedded copy.
  const readJson = (relative: string): unknown =>
    JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
  const docsCompatibility = readJson('docs/compatibility.json') as {
    dsh?: unknown
    hostControl?: unknown
    profile?: { schemaVersion?: unknown }
  }
  const policy = readJson('build/compatibility-policy.json') as {
    dataEpoch?: unknown
    supportedDataEpochs?: unknown
    pluginApi?: { strategy?: unknown; singletonPackages?: unknown }
    formats?: unknown
  }
  const dsh = docsCompatibility.dsh
  const dshNpmVersion =
    typeof (dsh as { npmVersion?: unknown } | undefined)?.npmVersion === 'string'
      ? (dsh as { npmVersion: string }).npmVersion
      : 'development'
  return parseReleaseManifest({
    schemaVersion: 2,
    releaseId: 'dev-source',
    desktopVersion: '0.0.0',
    sourceCommit: '0'.repeat(40),
    dsh,
    // The strict parser refuses anything but darwin — a development loader on
    // an unsupported platform is an error, not a lie in the marker.
    platform: process.platform as ReleaseManifest['platform'],
    arch: process.arch === 'x64' ? 'x64' : 'arm64',
    hostControl: docsCompatibility.hostControl,
    profileSchemaVersion: docsCompatibility.profile?.schemaVersion,
    pluginApi: {
      strategy: policy.pluginApi?.strategy,
      dshVersion: dshNpmVersion,
      singletonPackages: policy.pluginApi?.singletonPackages,
    },
    formats: policy.formats,
    dataEpoch: policy.dataEpoch,
    supportedDataEpochs: policy.supportedDataEpochs,
    // Development manifests carry no closure/patch digests — those belong to
    // generated release manifests (generate:compatibility) and are verified
    // there. The zeros make the "no claim" state explicit and parse-stable.
    dependencyClosureSha256: '0'.repeat(64),
    patchManifestSha256: '0'.repeat(64),
  })
}

function defaultRepositoryRoot(): string {
  // <root>/packages/release-compatibility/lib/home-marker.js → <root>
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}
