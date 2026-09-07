import type { HomeCompatibilityMarker } from './home-admission.js'
import { parseHomeCompatibilityMarker } from './home-admission.js'
import type { HomeFormatState } from './inspect-home.js'
import type { ReleaseManifest } from './manifest.js'

export type PreflightResult =
  | { kind: 'allow'; dataEpoch: number; formats: Readonly<Record<string, string>> }
  | {
      kind: 'refuse'
      code: 'UNKNOWN_FORMAT' | 'UNREADABLE_FORMAT' | 'UNSUPPORTED_EPOCH' | 'MIGRATION_REQUIRED'
    }

/**
 * Pure upgrade preflight over (release facts × home marker × observed home
 * formats). Decision order is load-bearing and matches the protocol:
 *
 *   1. an unparsable marker is unknown data — refuse;
 *   2. a marker epoch this release does not support is newer data — refuse
 *      (a downgrade must never touch the home);
 *   3. a marker from an older epoch needs migration — refuse without
 *      auto-migrating (MIGRATION_REQUIRED; migrations need their own ADR);
 *   4. unrecognized on-disk shapes are unknown data — refuse;
 *   5. recognized shapes this release cannot read — refuse;
 *   6. a marker whose recorded formats disagree with the disk is an
 *      inconsistent home — refuse conservatively;
 *   7. everything else allows, carrying the epoch the release will write.
 */
export function preflightHome(input: {
  release: ReleaseManifest
  marker: HomeCompatibilityMarker | null
  observed: HomeFormatState
}): PreflightResult {
  const { release, marker, observed } = input

  if (marker !== null && parseHomeCompatibilityMarker(marker) === undefined) {
    return { kind: 'refuse', code: 'UNKNOWN_FORMAT' }
  }
  if (marker !== null && !release.supportedDataEpochs.includes(marker.dataEpoch)) {
    return { kind: 'refuse', code: 'UNSUPPORTED_EPOCH' }
  }
  if (marker !== null && marker.dataEpoch < release.dataEpoch) {
    return { kind: 'refuse', code: 'MIGRATION_REQUIRED' }
  }
  if (observed.unknownPaths.length > 0) {
    return { kind: 'refuse', code: 'UNKNOWN_FORMAT' }
  }
  for (const observedId of Object.values(observed.formats)) {
    if (!release.formats.some((format) => format.readable.includes(observedId))) {
      return { kind: 'refuse', code: 'UNREADABLE_FORMAT' }
    }
  }
  if (marker !== null) {
    for (const [slot, markerFormat] of Object.entries(marker.formats)) {
      const observedFormat = observed.formats[slot]
      if (observedFormat !== undefined && observedFormat !== markerFormat) {
        // Unequal marker/observed IDs are compatible only when ONE format
        // rule of THIS release declares both readable — the projection cache
        // advancing v4 → v5 inside one rule. IDs from different rules, or
        // IDs this release does not read, still refuse conservatively.
        const sameRule = release.formats.some(
          (format) =>
            format.readable.includes(markerFormat) && format.readable.includes(observedFormat),
        )
        if (!sameRule) {
          return { kind: 'refuse', code: 'UNKNOWN_FORMAT' }
        }
      }
    }
  }
  return { kind: 'allow', dataEpoch: release.dataEpoch, formats: { ...observed.formats } }
}

/** Human-readable refusal reason for diagnostics and recovery views. */
export function describePreflightRefusal(
  code: Extract<PreflightResult, { kind: 'refuse' }>['code'],
): string {
  switch (code) {
    case 'UNKNOWN_FORMAT':
      return 'this home holds data this release cannot classify'
    case 'UNREADABLE_FORMAT':
      return 'this home holds data written in a format this release cannot read'
    case 'UNSUPPORTED_EPOCH':
      return 'this home was written by a newer release; use the release that wrote it'
    case 'MIGRATION_REQUIRED':
      return 'this home needs a data migration this release does not perform automatically'
  }
}
