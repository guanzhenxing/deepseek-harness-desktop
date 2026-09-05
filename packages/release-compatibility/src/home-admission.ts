import { lstat, open } from 'node:fs/promises'
import path from 'node:path'

export type HomeCompatibilityMarker = Readonly<{
  schemaVersion: 1
  dataEpoch: number
  lastWriterReleaseId: string
  formats: Readonly<Record<string, string>>
}>

/** The only data epoch this release's write paths understand. M3 embeds [1]. */
export const M3_SUPPORTED_DATA_EPOCHS: readonly number[] = [1]

export type HomeAdmissionVerdict = 'allow' | 'unknown-schema' | 'unsupported-data'

/**
 * Pure admission decision over a (possibly absent) compatibility marker.
 * A missing marker allows the home (M3 homes predate the marker); anything
 * that is present but not a well-formed schema-1 marker, or whose data epoch
 * this release does not support, is refused fail-closed.
 */
export function checkHomeAdmission(input: {
  marker: unknown | null
  supportedDataEpochs: readonly number[]
}): HomeAdmissionVerdict {
  if (input.marker === null || input.marker === undefined) return 'allow'
  const marker = parseHomeCompatibilityMarker(input.marker)
  if (marker === undefined) return 'unknown-schema'
  if (!input.supportedDataEpochs.includes(marker.dataEpoch)) return 'unsupported-data'
  return 'allow'
}

export function parseHomeCompatibilityMarker(raw: unknown): HomeCompatibilityMarker | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Record<string, unknown>
  if (candidate.schemaVersion !== 1) return undefined
  if (!isSafeInteger(candidate.dataEpoch)) return undefined
  if (typeof candidate.lastWriterReleaseId !== 'string' || candidate.lastWriterReleaseId === '') {
    return undefined
  }
  if (
    typeof candidate.formats !== 'object' ||
    candidate.formats === null ||
    Array.isArray(candidate.formats)
  ) {
    return undefined
  }
  for (const value of Object.values(candidate.formats as Record<string, unknown>)) {
    if (typeof value !== 'string') return undefined
  }
  return {
    schemaVersion: 1,
    dataEpoch: candidate.dataEpoch,
    lastWriterReleaseId: candidate.lastWriterReleaseId,
    formats: candidate.formats as Record<string, string>,
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** The marker lives at a fixed location inside the shared home. */
export function markerPath(home: string): string {
  return path.join(home, 'run', 'compatibility.json')
}

/**
 * Read-only marker access: missing file yields null; a symlink marker, an
 * unreadable file, or content that is not a JSON object all fail closed with
 * an error the caller must treat as a refusal.
 */
export async function readHomeCompatibilityMarker(home: string): Promise<unknown | null> {
  const file = markerPath(home)
  const identity = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw new HomeAdmissionError(
      'MARKER_UNREADABLE',
      `compatibility marker cannot be inspected: ${error.code}`,
    )
  })
  if (identity === undefined) return null
  if (identity.isSymbolicLink()) {
    throw new HomeAdmissionError('MARKER_SYMLINK', 'compatibility marker must not be a symlink')
  }
  if (!identity.isFile()) {
    throw new HomeAdmissionError('MARKER_UNREADABLE', 'compatibility marker is not a regular file')
  }
  // Bounded read: the marker is always tiny; an implausibly large file at the
  // marker path is not our marker and refuses fail-closed instead of
  // buffering arbitrary bytes into the boot path.
  const MARKER_READ_CAP = 64 * 1024
  const handle = await open(file, 'r').catch((error: unknown) => {
    throw new HomeAdmissionError(
      'MARKER_UNREADABLE',
      `compatibility marker cannot be read: ${String(error)}`,
    )
  })
  let bytes: string
  try {
    const buffer = Buffer.alloc(MARKER_READ_CAP + 1)
    const { bytesRead } = await handle.read(buffer, 0, MARKER_READ_CAP + 1, 0)
    if (bytesRead > MARKER_READ_CAP) {
      throw new HomeAdmissionError(
        'MARKER_CORRUPT',
        'compatibility marker is implausibly large; refusing',
      )
    }
    bytes = buffer.subarray(0, bytesRead).toString('utf8')
  } catch (error) {
    if (error instanceof HomeAdmissionError) throw error
    throw new HomeAdmissionError(
      'MARKER_UNREADABLE',
      `compatibility marker cannot be read: ${String(error)}`,
    )
  } finally {
    await handle.close()
  }
  try {
    const parsed: unknown = JSON.parse(bytes)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HomeAdmissionError(
        'MARKER_CORRUPT',
        'compatibility marker content is corrupt (not a JSON object)',
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof HomeAdmissionError) throw error
    throw new HomeAdmissionError('MARKER_CORRUPT', 'compatibility marker content is corrupt')
  }
}

/**
 * Combined read-only admission for a supported entrypoint: read the marker
 * (fail-closed) and decide against the supported epochs. Callers must invoke
 * this after acquiring the home lease and before any profile/cache/Host
 * write; a refusal must surface a local diagnostic and release the lease.
 */
export async function admitHome(
  input: Readonly<{
    home: string
    supportedDataEpochs?: readonly number[]
  }>,
): Promise<HomeAdmissionVerdict> {
  const marker = await readHomeCompatibilityMarker(input.home)
  return checkHomeAdmission({
    marker,
    supportedDataEpochs: input.supportedDataEpochs ?? M3_SUPPORTED_DATA_EPOCHS,
  })
}

export class HomeAdmissionError extends Error {
  constructor(
    readonly code: 'MARKER_UNREADABLE' | 'MARKER_CORRUPT' | 'MARKER_SYMLINK',
    message: string,
  ) {
    super(message)
    this.name = 'HomeAdmissionError'
  }
}
