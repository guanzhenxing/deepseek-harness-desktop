import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  checkHomeAdmission,
  markerPath,
  M3_SUPPORTED_DATA_EPOCHS,
  readHomeCompatibilityMarker,
} from '../src/home-admission.js'

describe('checkHomeAdmission', () => {
  it('allows a home without a marker (M3: existing homes predate the marker)', () => {
    expect(checkHomeAdmission({ marker: null, supportedDataEpochs: [1] })).toBe('allow')
    expect(checkHomeAdmission({ marker: undefined, supportedDataEpochs: [1] })).toBe('allow')
  })

  it('allows a valid schema-1 marker on a supported data epoch', () => {
    expect(
      checkHomeAdmission({
        marker: {
          schemaVersion: 1,
          dataEpoch: 1,
          lastWriterReleaseId: 'm3-candidate',
          formats: {},
        },
        supportedDataEpochs: [1],
      }),
    ).toBe('allow')
  })

  it('rejects an unsupported data epoch', () => {
    expect(
      checkHomeAdmission({
        marker: {
          schemaVersion: 1,
          dataEpoch: 2,
          lastWriterReleaseId: 'future-test-fixture',
          formats: {},
        },
        supportedDataEpochs: [1],
      }),
    ).toBe('unsupported-data')
    expect(
      checkHomeAdmission({
        marker: {
          schemaVersion: 1,
          dataEpoch: 0,
          lastWriterReleaseId: 'future-test-fixture',
          formats: {},
        },
        supportedDataEpochs: [1],
      }),
    ).toBe('unsupported-data')
  })

  it('rejects an unknown marker schema', () => {
    expect(
      checkHomeAdmission({
        marker: {
          schemaVersion: 2,
          dataEpoch: 1,
          lastWriterReleaseId: 'future-release',
          formats: {},
        },
        supportedDataEpochs: [1],
      }),
    ).toBe('unknown-schema')
  })

  it('rejects corrupt or malformed marker content fail-closed', () => {
    expect(checkHomeAdmission({ marker: 'garbage', supportedDataEpochs: [1] })).toBe(
      'unknown-schema',
    )
    expect(checkHomeAdmission({ marker: 7, supportedDataEpochs: [1] })).toBe('unknown-schema')
    expect(checkHomeAdmission({ marker: {}, supportedDataEpochs: [1] })).toBe('unknown-schema')
    expect(
      checkHomeAdmission({ marker: { schemaVersion: 1, dataEpoch: 1 }, supportedDataEpochs: [1] }),
    ).toBe('unknown-schema')
    expect(
      checkHomeAdmission({
        marker: {
          schemaVersion: 1,
          dataEpoch: '1',
          lastWriterReleaseId: 'x',
          formats: {},
        },
        supportedDataEpochs: [1],
      }),
    ).toBe('unknown-schema')
    // Extra fields are tolerated only when every required field is well-formed
    // and typed; a wrong formats map is malformed content.
    expect(
      checkHomeAdmission({
        marker: {
          schemaVersion: 1,
          dataEpoch: 1,
          lastWriterReleaseId: 'x',
          formats: ['not', 'a', 'map'],
        },
        supportedDataEpochs: [1],
      }),
    ).toBe('unknown-schema')
  })

  it('honors the injected supported-epoch list', () => {
    expect(
      checkHomeAdmission({
        marker: {
          schemaVersion: 1,
          dataEpoch: 3,
          lastWriterReleaseId: 'x',
          formats: {},
        },
        supportedDataEpochs: [1, 3],
      }),
    ).toBe('allow')
  })

  it('ships M3 with exactly [1]', () => {
    expect(M3_SUPPORTED_DATA_EPOCHS).toEqual([1])
  })
})

describe('marker location and reading', () => {
  it('pins the marker to <home>/run/compatibility.json', () => {
    expect(markerPath('/tmp/homes/a')).toBe(path.join('/tmp/homes/a', 'run', 'compatibility.json'))
  })

  it('reads null for a missing marker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-compat-'))
    try {
      expect(await readHomeCompatibilityMarker(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a well-formed marker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-compat-'))
    try {
      await mkdir(path.join(dir, 'run'), { recursive: true })
      await writeFile(
        markerPath(dir),
        `${JSON.stringify({
          schemaVersion: 1,
          dataEpoch: 1,
          lastWriterReleaseId: 'm3-candidate',
          formats: {},
        })}\n`,
        'utf8',
      )
      expect(await readHomeCompatibilityMarker(dir)).toEqual({
        schemaVersion: 1,
        dataEpoch: 1,
        lastWriterReleaseId: 'm3-candidate',
        formats: {},
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on a symlinked marker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-compat-'))
    try {
      await mkdir(path.join(dir, 'run'), { recursive: true })
      const real = path.join(dir, 'run', 'real.json')
      await writeFile(real, '{}\n', 'utf8')
      await symlink(real, markerPath(dir))
      await expect(readHomeCompatibilityMarker(dir)).rejects.toThrow(/symlink/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on unreadable or corrupt markers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-compat-'))
    try {
      await mkdir(path.join(dir, 'run'), { recursive: true })
      await writeFile(markerPath(dir), '{not json', 'utf8')
      await expect(readHomeCompatibilityMarker(dir)).rejects.toThrow(/corrupt|unreadable/i)
      await writeFile(markerPath(dir), '"just a string"', 'utf8')
      await expect(readHomeCompatibilityMarker(dir)).rejects.toThrow(/corrupt|unreadable/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
