import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  boundedEntries,
  createInspectionBudget,
  ENUMERATION_CEILING,
  inspectHomeFormats,
} from '../src/inspect-home.js'
import { preflightHome } from '../src/preflight.js'
import type { ReleaseManifest } from '../src/manifest.js'

export const BASELINE_MANIFEST: ReleaseManifest = {
  schemaVersion: 2,
  releaseId: 'm4-0.0.0-darwin-arm64-test000',
  desktopVersion: '0.0.0',
  sourceCommit: 'a'.repeat(40),
  dsh: {
    tag: 'dsh-v0.1.2-alpha.3',
    commit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
    npmVersion: '0.1.2-alpha.3',
  },
  platform: 'darwin',
  arch: 'arm64',
  hostControl: { major: 1, minor: 0 },
  profileSchemaVersion: 1,
  pluginApi: {
    strategy: 'verified-exact-baseline',
    dshVersion: '0.1.2-alpha.3',
    singletonPackages: ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh'],
  },
  formats: [
    {
      provider: '@deepseek-ai/dsh-credentials-local',
      providerVersion: '0.1.2-alpha.3',
      formatId: 'dsh-credentials-file-1',
      readable: ['dsh-credentials-file-1'],
      writable: 'dsh-credentials-file-1',
      evidence: ['fixture:test'],
    },
    {
      provider: '@deepseek-ai/dsh-settings-file',
      providerVersion: '0.1.2-alpha.3',
      formatId: 'dsh-settings-file-0.1.2-alpha.3',
      readable: ['dsh-settings-file-0.1.2-alpha.3'],
      writable: 'dsh-settings-file-0.1.2-alpha.3',
      evidence: ['fixture:test'],
    },
    {
      provider: '@deepseek-ai/dsh-session-persistence-jsonl',
      providerVersion: '0.1.2-alpha.3',
      formatId: 'dsh-session-jsonl-0',
      readable: ['dsh-session-jsonl-0'],
      writable: 'dsh-session-jsonl-0',
      evidence: ['fixture:test'],
    },
    {
      provider: '@deepseek-ai/dsh-storage-json',
      providerVersion: '0.1.2-alpha.3',
      formatId: 'dsh-storage-unit-0.1.2-alpha.3',
      readable: ['dsh-storage-unit-0.1.2-alpha.3'],
      writable: 'dsh-storage-unit-0.1.2-alpha.3',
      evidence: ['fixture:test'],
    },
    {
      provider: '@deepseek-ai/dsh-session-projection-cache',
      providerVersion: '0.1.2-alpha.3',
      formatId: 'dsh-session-projcache-4',
      readable: ['dsh-session-projcache-4'],
      writable: 'dsh-session-projcache-4',
      evidence: ['fixture:test'],
    },
    {
      provider: '@deepseek-ai/dsh',
      providerVersion: '0.1.2-alpha.3',
      formatId: 'dsh-profile-manifest-0.1.2-alpha.3',
      readable: ['dsh-profile-manifest-0.1.2-alpha.3'],
      writable: 'dsh-profile-manifest-0.1.2-alpha.3',
      evidence: ['fixture:test'],
    },
  ],
  dataEpoch: 1,
  supportedDataEpochs: [1],
  dependencyClosureSha256: 'c'.repeat(64),
  patchManifestSha256: 'd'.repeat(64),
}

function mkfifoSync(file: string): void {
  execFileSync('mkfifo', [file])
}

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'dsh-preflight-'))
}

describe('preflightHome', () => {
  it('allows a fresh home with no marker', () => {
    expect(
      preflightHome({
        release: BASELINE_MANIFEST,
        marker: null,
        observed: { fresh: true, formats: {}, unknownPaths: [] },
      }),
    ).toEqual({
      kind: 'allow',
      dataEpoch: 1,
      formats: {},
    })
  })

  it('allows a marker-less pre-M4 home whose observed formats are all readable', () => {
    const observed = {
      fresh: false,
      formats: {
        credentials: 'dsh-credentials-file-1',
        settings: 'dsh-settings-file-0.1.2-alpha.3',
      },
      unknownPaths: [],
    }
    const result = preflightHome({
      release: BASELINE_MANIFEST,
      marker: null,
      observed,
    })
    expect(result).toEqual({
      kind: 'allow',
      dataEpoch: 1,
      formats: observed.formats,
    })
  })

  it('refuses a newer-epoch marker before any write can happen', () => {
    expect(
      preflightHome({
        release: BASELINE_MANIFEST,
        marker: {
          schemaVersion: 1,
          dataEpoch: 2,
          lastWriterReleaseId: 'future-release',
          formats: {},
        },
        observed: { fresh: false, formats: {}, unknownPaths: [] },
      }),
    ).toEqual({ kind: 'refuse', code: 'UNSUPPORTED_EPOCH' })
  })

  it('refuses unknown paths as unknown format', () => {
    expect(
      preflightHome({
        release: BASELINE_MANIFEST,
        marker: null,
        observed: {
          fresh: false,
          formats: {},
          unknownPaths: ['storages/custom-provider.db'],
        },
      }),
    ).toEqual({ kind: 'refuse', code: 'UNKNOWN_FORMAT' })
  })

  it('refuses an observed format this release cannot read', () => {
    expect(
      preflightHome({
        release: BASELINE_MANIFEST,
        marker: null,
        observed: {
          fresh: false,
          formats: { credentials: 'dsh-credentials-file-2' },
          unknownPaths: [],
        },
      }),
    ).toEqual({ kind: 'refuse', code: 'UNREADABLE_FORMAT' })
  })

  it('refuses a marker/disk format mismatch conservatively', () => {
    expect(
      preflightHome({
        release: BASELINE_MANIFEST,
        marker: {
          schemaVersion: 1,
          dataEpoch: 1,
          lastWriterReleaseId: 'm4-0.0.0-darwin-arm64-test000',
          formats: { credentials: 'dsh-credentials-file-1' },
        },
        observed: {
          fresh: false,
          formats: {
            credentials: 'dsh-credentials-file-1',
            settings: 'dsh-settings-file-0.1.2-alpha.3',
          },
          unknownPaths: [],
        },
      }),
    ).toMatchObject({ kind: 'allow' })

    expect(
      preflightHome({
        release: BASELINE_MANIFEST,
        marker: {
          schemaVersion: 1,
          dataEpoch: 1,
          lastWriterReleaseId: 'm4-0.0.0-darwin-arm64-test000',
          formats: { credentials: 'dsh-credentials-file-1' },
        },
        observed: {
          fresh: false,
          formats: { credentials: 'dsh-credentials-file-2' },
          unknownPaths: [],
        },
      }),
    ).toEqual({ kind: 'refuse', code: 'UNREADABLE_FORMAT' })
  })

  it('refuses an invalid marker as unknown format', () => {
    expect(
      preflightHome({
        release: BASELINE_MANIFEST,
        marker: { schemaVersion: 9 } as unknown as null,
        observed: { fresh: false, formats: {}, unknownPaths: [] },
      }),
    ).toEqual({ kind: 'refuse', code: 'UNKNOWN_FORMAT' })
  })

  it('refuses an older-epoch writer as migration required (no silent auto-migration)', () => {
    const older = {
      ...BASELINE_MANIFEST,
      supportedDataEpochs: [1, 2],
      dataEpoch: 2,
    }
    expect(
      preflightHome({
        release: older,
        marker: { schemaVersion: 1, dataEpoch: 1, lastWriterReleaseId: 'm4-old', formats: {} },
        observed: { fresh: false, formats: {}, unknownPaths: [] },
      }),
    ).toEqual({ kind: 'refuse', code: 'MIGRATION_REQUIRED' })
  })
})

describe('inspectHomeFormats', () => {
  it('reports a fresh, empty home', async () => {
    const home = await tempHome()
    try {
      const observed = await inspectHomeFormats(home)
      expect(observed.fresh).toBe(true)
      expect(observed.formats).toEqual({})
      expect(observed.unknownPaths).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('classifies a baseline-shaped home', async () => {
    const home = await tempHome()
    try {
      await writeFile(
        path.join(home, '.credentials.yaml'),
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-not-a-secret\n',
      )
      await writeFile(path.join(home, 'settings.yaml'), 'llm-deepseek:\n  baseURL: https://x\n')
      const sessionDir = path.join(home, 'sessions', '--fixture--', 's-1')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(
        path.join(sessionDir, 'session.jsonl'),
        '{"type":"session","version":0,"id":"s-1","createdAt":0,"delegationDepth":0}\n',
      )
      const profileDir = path.join(home, 'profiles', 'desktop')
      await mkdir(profileDir, { recursive: true })
      await writeFile(
        path.join(profileDir, 'package.json'),
        JSON.stringify({
          name: 'dsh-profile-desktop',
          private: true,
          dsh: { profile: { bundles: [] } },
        }),
      )
      const storageDir = path.join(home, 'storages', 'fixture-domain')
      await mkdir(storageDir, { recursive: true })
      await writeFile(path.join(storageDir, 'global.json'), '{"version":1,"record":null}')
      const observed = await inspectHomeFormats(home)
      expect(observed.fresh).toBe(false)
      expect(observed.unknownPaths).toEqual([])
      expect(observed.formats).toEqual({
        credentials: 'dsh-credentials-file-1',
        settings: 'dsh-settings-file-0.1.2-alpha.3',
        sessions: 'dsh-session-jsonl-0',
        profiles: 'dsh-profile-manifest-0.1.2-alpha.3',
        storages: 'dsh-storage-unit-0.1.2-alpha.3',
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('accepts third-party bundle manifests without a dsh section', async () => {
    const home = await tempHome()
    try {
      const bundleDir = path.join(home, 'profiles', 'user-plugin')
      await mkdir(bundleDir, { recursive: true })
      await writeFile(
        path.join(bundleDir, 'package.json'),
        JSON.stringify({ name: 'example-user-plugin', version: '1.0.0', main: './index.js' }),
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toEqual([])
      expect(observed.formats.profiles).toBe('dsh-profile-manifest-0.1.2-alpha.3')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('prefers the live per-record domain layout over a stale single-unit file', async () => {
    const home = await tempHome()
    try {
      const domain = path.join(home, 'storages', 'session_projcache', 'sessions')
      await mkdir(domain, { recursive: true })
      await writeFile(path.join(domain, 'session-1.json'), '{"version":4,"record":{"watermark":7}}')
      // A migrated home keeps the old single-unit document around; the live
      // layout is the per-record directory.
      await writeFile(
        path.join(home, 'storages', 'session_projcache.json'),
        '{"unit":{"name":"session_projcache","version":3},"global":null,"tables":{}}',
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toEqual([])
      expect(observed.formats.projcache).toBe('dsh-session-projcache-4')
      expect(observed.formats.storages).toBe('dsh-storage-unit-0.1.2-alpha.3')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('classifies the Host-written records: credentials section as the baseline format', async () => {
    const home = await tempHome()
    try {
      await writeFile(
        path.join(home, '.credentials.yaml'),
        'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n',
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toEqual([])
      expect(observed.formats.credentials).toBe('dsh-credentials-file-1')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('surfaces an unreadable sessions project directory instead of counting it absent', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--locked--')
      await mkdir(projectDir, { recursive: true })
      await chmod(projectDir, 0o000)
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--locked--')
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await chmod(path.join(home, 'sessions', '--locked--'), 0o700).catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('never follows or opens planted symlinks and named pipes', async () => {
    const home = await tempHome()
    try {
      // A symlinked profile directory pointing at a valid manifest outside
      // the home must not be followed.
      const outside = await tempHome()
      try {
        const outsideProfile = path.join(outside, 'profiles', 'imposter')
        await mkdir(outsideProfile, { recursive: true })
        await writeFile(
          path.join(outsideProfile, 'package.json'),
          JSON.stringify({ name: 'imposter' }),
        )
        const profilesDir = path.join(home, 'profiles')
        await mkdir(profilesDir, { recursive: true })
        await symlink(outsideProfile, path.join(profilesDir, 'imposter'))
        // A named pipe where a profile manifest belongs must not hang the
        // inspection (open on a FIFO blocks): it surfaces as unknown.
        const fifoProfile = path.join(profilesDir, 'piped')
        await mkdir(fifoProfile, { recursive: true })
        mkfifoSync(path.join(fifoProfile, 'package.json'))
        // A symlinked storage entry is unknown, never silently skipped.
        await mkdir(path.join(home, 'storages'), { recursive: true })
        await symlink(outside, path.join(home, 'storages', 'linked-unit'))
        const observed = await inspectHomeFormats(home)
        expect(observed.unknownPaths).toContain('profiles/imposter')
        expect(observed.unknownPaths).toContain('profiles/piped/package.json')
        expect(observed.unknownPaths).toContain('storages/linked-unit')
        expect(observed.formats.profiles).toBeUndefined()
        expect(observed.formats.storages).toBeUndefined()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('flags symlinks planted INSIDE a per-record storage unit, not only at its top level', async () => {
    const home = await tempHome()
    try {
      const outside = await tempHome()
      try {
        await writeFile(path.join(outside, 'escape.json'), '{"version":1,"record":null}')
        await mkdir(path.join(outside, 'escape-table'), { recursive: true })

        const domain = path.join(home, 'storages', 'fixture-domain')
        await mkdir(path.join(domain, 'sessions'), { recursive: true })
        await writeFile(
          path.join(domain, 'sessions', 'session-1.json'),
          '{"version":1,"record":null}',
        )
        // global.json swapped for a symlink out of the home.
        await symlink(path.join(outside, 'escape.json'), path.join(domain, 'global.json'))
        const observed = await inspectHomeFormats(home)
        expect(observed.unknownPaths).toContain('storages/fixture-domain/global.json')
        expect(observed.formats.storages).toBeUndefined()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('flags a symlinked table directory inside a storage unit', async () => {
    const home = await tempHome()
    try {
      const outside = await tempHome()
      try {
        await mkdir(path.join(outside, 'escape-table'), { recursive: true })
        await writeFile(
          path.join(outside, 'escape-table', 'record.json'),
          '{"version":1,"record":null}',
        )
        const domain = path.join(home, 'storages', 'fixture-domain')
        await mkdir(domain, { recursive: true })
        await symlink(path.join(outside, 'escape-table'), path.join(domain, 'sessions'))
        const observed = await inspectHomeFormats(home)
        expect(observed.unknownPaths).toContain('storages/fixture-domain/sessions')
        expect(observed.formats.storages).toBeUndefined()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('flags a symlinked record file inside a storage unit table', async () => {
    const home = await tempHome()
    try {
      const outside = await tempHome()
      try {
        await writeFile(path.join(outside, 'escape-record.json'), '{"version":1,"record":null}')
        const table = path.join(home, 'storages', 'fixture-domain', 'sessions')
        await mkdir(table, { recursive: true })
        await symlink(path.join(outside, 'escape-record.json'), path.join(table, 'session-1.json'))
        const observed = await inspectHomeFormats(home)
        expect(observed.unknownPaths).toContain('storages/fixture-domain/sessions/session-1.json')
        expect(observed.formats.storages).toBeUndefined()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('flags a named pipe planted inside a storage unit directory', async () => {
    const home = await tempHome()
    try {
      const domain = path.join(home, 'storages', 'fixture-domain')
      await mkdir(domain, { recursive: true })
      mkfifoSync(path.join(domain, 'global.json'))
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('storages/fixture-domain/global.json')
      expect(observed.formats.storages).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('flags a symlink inside the projcache domain instead of silently sampling nothing', async () => {
    const home = await tempHome()
    try {
      const outside = await tempHome()
      try {
        await writeFile(path.join(outside, 'escape-record.json'), '{"version":4,"record":null}')
        const table = path.join(home, 'storages', 'session_projcache', 'sessions')
        await mkdir(table, { recursive: true })
        await symlink(path.join(outside, 'escape-record.json'), path.join(table, 'session-1.json'))
        const observed = await inspectHomeFormats(home)
        expect(observed.unknownPaths).toContain(
          'storages/session_projcache/sessions/session-1.json',
        )
        expect(observed.formats.storages).toBeUndefined()
        expect(observed.formats.projcache).toBeUndefined()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('classifies corrupt storage-unit content beyond any historical sampling cap', async () => {
    const home = await tempHome()
    try {
      // Corrupt EVERY unit and assert EVERY one is flagged: a reintroduced
      // sampler (old cap 64) would flag only its prefix, so this assertion
      // is order-independent and must fail under sampling.
      for (let index = 0; index < 72; index += 1) {
        const domain = path.join(home, 'storages', `domain-${index}`)
        await mkdir(domain, { recursive: true })
        await writeFile(path.join(domain, 'global.json'), '{not json')
      }
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toHaveLength(72)
      for (let index = 0; index < 72; index += 1) {
        expect(observed.unknownPaths).toContain(`storages/domain-${index}/global.json`)
      }
      expect(observed.formats.storages).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it('refuses record documents that carry a stamp but no record envelope', async () => {
    const home = await tempHome()
    try {
      const table = path.join(home, 'storages', 'workspace', 'records')
      await mkdir(table, { recursive: true })
      await writeFile(
        path.join(home, 'storages', 'workspace', 'global.json'),
        '{"version":1,"record":null}',
      )
      await writeFile(path.join(table, 'stamp-only.json'), '{"version":1}')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('storages/workspace/records/stamp-only.json')
      expect(observed.formats.storages).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a truncated skippable frame declaring more payload than the file holds', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--fixture--')
      const sessionDir = path.join(projectDir, 'liar-skip')
      await mkdir(sessionDir, { recursive: true })
      // Skippable magic (0x184D2A50) declaring 0xffffffff payload in an
      // 8-byte file: the length claim must be checked against the real size.
      await writeFile(
        path.join(sessionDir, 'session.jsonl.zstd'),
        Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0xff, 0xff, 0xff, 0xff]),
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--fixture--/liar-skip/session.jsonl.zstd')
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('accepts a complete skippable prefix only when a standard frame follows', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--fixture--')
      const { zstdCompressSync } = await import('node:zlib')
      // Honest skippable prefix (declared size = real payload) + a real
      // standard frame after it.
      const payload = Buffer.from('metadata')
      const honest = path.join(projectDir, 'honest-skip')
      await mkdir(honest, { recursive: true })
      const skipHeader = Buffer.alloc(8)
      skipHeader.writeUInt32LE(0x184d2a50, 0)
      skipHeader.writeUInt32LE(payload.length, 4)
      await writeFile(
        path.join(honest, 'session.jsonl.zstd'),
        Buffer.concat([
          skipHeader,
          payload,
          zstdCompressSync(
            Buffer.from(
              '{"type":"session","version":0,"id":"s","createdAt":0,"delegationDepth":0}\n',
              'utf8',
            ),
          ),
        ]),
      )
      // Skippable-only stream (nothing after the prefix) is not a session.
      const skipOnly = path.join(projectDir, 'skip-only')
      await mkdir(skipOnly, { recursive: true })
      await writeFile(
        path.join(skipOnly, 'session.jsonl.zstd'),
        Buffer.concat([skipHeader, payload]),
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--fixture--/skip-only/session.jsonl.zstd')
      expect(observed.unknownPaths).not.toContain(
        'sessions/--fixture--/honest-skip/session.jsonl.zstd',
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a truncated 5-byte standard zstd frame', async () => {
    const home = await tempHome()
    try {
      const sessionDir = path.join(home, 'sessions', '--p--', 'truncated5')
      await mkdir(sessionDir, { recursive: true })
      // FHD 0x00 declares a 6-byte header; the file is 5 bytes.
      await writeFile(
        path.join(sessionDir, 'session.jsonl.zstd'),
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]),
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--p--/truncated5/session.jsonl.zstd')
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('fails anchor-less storage domains closed instead of self-anchoring', async () => {
    const home = await tempHome()
    try {
      // Two CONSISTENT version:99 records in a domain with no global
      // document: without an anchor they must not self-certify as known.
      const table = path.join(home, 'storages', 'future-domain', 'rows')
      await mkdir(table, { recursive: true })
      await writeFile(path.join(table, 'a.json'), '{"version":99,"record":null}')
      await writeFile(path.join(table, 'b.json'), '{"version":99,"record":null}')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('storages/future-domain')
      expect(observed.formats.storages).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('never reads an exhausted budget as clean, even with nothing recorded', async () => {
    const home = await tempHome()
    try {
      // The ONLY finding is a directory wearing the settings name, and the
      // unknowns budget is zero from the start: exhausted-with-empty-output
      // must still refuse, not report a fresh home.
      await mkdir(path.join(home, 'settings.yaml'), { recursive: true })
      const observed = await inspectHomeFormats(home, createInspectionBudget({ unknowns: 0 }))
      expect(observed.fresh).toBe(false)
      expect(observed.unknownPaths.length).toBeGreaterThan(0)
      expect(observed.formats.settings).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('bounds the unknown-paths output by the shared budget', async () => {
    const home = await tempHome()
    try {
      const table = path.join(home, 'storages', 'workspace', 'records')
      await mkdir(table, { recursive: true })
      for (let index = 0; index < 20; index += 1) {
        await writeFile(path.join(table, `bad-${index}.json`), '{not json')
      }
      const budget = createInspectionBudget({ unknowns: 1 })
      const observed = await inspectHomeFormats(home, budget)
      // Output bound: at most `unknowns` recorded paths plus the single
      // fixed 'home' exhaustion marker (explicitly outside the per-path
      // budget).
      expect(observed.unknownPaths.length).toBeLessThanOrEqual(2)
      expect(observed.unknownPaths).toContain('home')
      expect(budget.unknowns).toBeGreaterThanOrEqual(0)
      expect(observed.formats.storages).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('classifies storage RECORDS inside unit tables (corrupt and foreign version)', async () => {
    const home = await tempHome()
    try {
      // A non-projcache domain with a corrupt record: its content was
      // previously only shape-checked, never parsed.
      const corruptTable = path.join(home, 'storages', 'fixture-domain', 'sessions')
      await mkdir(corruptTable, { recursive: true })
      await writeFile(path.join(corruptTable, 'session-1.json'), '{"version":1,"record":null}')
      await writeFile(path.join(corruptTable, 'session-2.json'), '{bad json')
      // projcache with a version:99 record beyond any sampling position.
      const projTable = path.join(home, 'storages', 'session_projcache', 'sessions')
      await mkdir(projTable, { recursive: true })
      for (let index = 0; index < 20; index += 1) {
        await writeFile(
          path.join(projTable, `session-${index}.json`),
          '{"version":4,"record":{"watermark":7}}',
        )
      }
      await writeFile(path.join(projTable, 'session-future.json'), '{"version":99,"record":null}')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('storages/fixture-domain/sessions/session-2.json')
      expect(observed.unknownPaths).toContain(
        'storages/session_projcache/sessions/session-future.json',
      )
      expect(observed.formats.storages).toBeUndefined()
      expect(observed.formats.projcache).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses plain text disguised as a compressed session', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--fixture--')
      const sessionDir = path.join(projectDir, 'fake-zstd')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(path.join(sessionDir, 'session.jsonl.zstd'), 'definitely not zstd\n')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--fixture--/fake-zstd/session.jsonl.zstd')
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('accepts a .zstd session carrying a real zstd frame header', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--fixture--')
      const sessionDir = path.join(projectDir, 'framed')
      await mkdir(sessionDir, { recursive: true })
      // Minimal RFC 8878 frame: magic 28 B5 2F FD + FHD 0x20 (single-segment,
      // FCS code 0 → 1 content-size byte) + one FCS byte. Header-only
      // inspection validates the frame header structure, not the blocks.
      await writeFile(
        path.join(sessionDir, 'session.jsonl.zstd'),
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00]),
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toEqual([])
      expect(observed.formats.sessions).toBe('dsh-session-jsonl-0')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a .zstd session whose frame header is malformed or truncated', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--fixture--')
      // magic + FHD 0xC0 (FCS code 3, non-single-segment → header length 14)
      // with only ten bytes total: truncated. And a reserved-bit FHD:
      // malformed by spec.
      const truncated = path.join(projectDir, 'truncated')
      await mkdir(truncated, { recursive: true })
      await writeFile(
        path.join(truncated, 'session.jsonl.zstd'),
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00]),
      )
      const reserved = path.join(projectDir, 'reserved-bit')
      await mkdir(reserved, { recursive: true })
      await writeFile(
        path.join(reserved, 'session.jsonl.zstd'),
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x08, 0x00, 0x00, 0x00]),
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--fixture--/truncated/session.jsonl.zstd')
      expect(observed.unknownPaths).toContain(
        'sessions/--fixture--/reserved-bit/session.jsonl.zstd',
      )
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('accepts sessions compressed by the real upstream zstd writer', async () => {
    const home = await tempHome()
    try {
      // node:zlib zstdCompressSync is what the upstream session persistence
      // uses (frames appended per turn). A hand-built header could drift
      // from what real writers emit; this pins the real bytes.
      const { zstdCompressSync } = await import('node:zlib')
      const projectDir = path.join(home, 'sessions', '--real--')
      const multi = path.join(projectDir, 'multi-frame')
      await mkdir(multi, { recursive: true })
      const frames = [
        '{"type":"session","version":0,"id":"s","createdAt":0,"delegationDepth":0}\n',
        '{"type":"turn/end"}\n',
      ].map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')))
      await writeFile(path.join(multi, 'session.jsonl.zstd'), Buffer.concat(frames))
      const firstFrame = frames[0]
      if (firstFrame === undefined) throw new Error('test bug: empty frame list')
      const single = path.join(projectDir, 'single-frame')
      await mkdir(single, { recursive: true })
      await writeFile(path.join(single, 'session.jsonl.zstd'), firstFrame)
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toEqual([])
      expect(observed.formats.sessions).toBe('dsh-session-jsonl-0')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses plain and compressed encodings coexisting in one session directory', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--fixture--')
      const sessionDir = path.join(projectDir, 'both-encodings')
      await mkdir(sessionDir, { recursive: true })
      // A perfectly valid plaintext session — but a damaged .zstd sits next
      // to it, and the upstream backend rejects dual encodings.
      await writeFile(
        path.join(sessionDir, 'session.jsonl'),
        '{"type":"session","version":0,"id":"s","createdAt":0,"delegationDepth":0}\n',
      )
      await writeFile(path.join(sessionDir, 'session.jsonl.zstd'), 'definitely not zstd\n')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--fixture--/both-encodings/session.jsonl')
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('binds storage records to their unit version in ordinary domains', async () => {
    const home = await tempHome()
    try {
      // A plain domain anchored at version 1 by its global document: a
      // version-99 record is data upstream would silently treat as absent.
      const domain = path.join(home, 'storages', 'workspace')
      const table = path.join(domain, 'records')
      await mkdir(table, { recursive: true })
      await writeFile(path.join(domain, 'global.json'), '{"version":1,"record":null}')
      await writeFile(path.join(table, 'current.json'), '{"version":1,"record":{"k":1}}')
      await writeFile(path.join(table, 'future.json'), '{"version":99,"record":{"k":2}}')
      // And an anchor-less unit whose records disagree with each other.
      const anchorless = path.join(home, 'storages', 'mixed-domain', 'rows')
      await mkdir(anchorless, { recursive: true })
      await writeFile(path.join(anchorless, 'a.json'), '{"version":2,"record":null}')
      await writeFile(path.join(anchorless, 'b.json'), '{"version":3,"record":null}')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('storages/workspace/records/future.json')
      expect(observed.unknownPaths).toContain('storages/mixed-domain/rows/b.json')
      expect(observed.formats.storages).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('classifies sessions beyond any historical sampling cap', async () => {
    const home = await tempHome()
    try {
      // Corrupt EVERY session and assert EVERY one is flagged (old cap 32
      // per project); order-independent, must fail under sampling.
      const projectDir = path.join(home, 'sessions', '--fixture--')
      for (let index = 0; index < 40; index += 1) {
        const sessionDir = path.join(projectDir, `s-${index}`)
        await mkdir(sessionDir, { recursive: true })
        await writeFile(
          path.join(sessionDir, 'session.jsonl'),
          '{"type":"session","version":99,"id":"f","createdAt":0,"delegationDepth":0}\\n',
        )
      }
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toHaveLength(40)
      for (let index = 0; index < 40; index += 1) {
        expect(observed.unknownPaths).toContain(`sessions/--fixture--/s-${index}/session.jsonl`)
      }
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it('classifies profile manifests beyond any historical sampling cap', async () => {
    const home = await tempHome()
    try {
      // Corrupt EVERY manifest and assert EVERY one is flagged (old cap 32);
      // order-independent, must fail under sampling.
      for (let index = 0; index < 40; index += 1) {
        const profileDir = path.join(home, 'profiles', `p-${index}`)
        await mkdir(profileDir, { recursive: true })
        await writeFile(path.join(profileDir, 'package.json'), '{not json')
      }
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toHaveLength(40)
      for (let index = 0; index < 40; index += 1) {
        expect(observed.unknownPaths).toContain(`profiles/p-${index}/package.json`)
      }
      expect(observed.formats.profiles).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it('flags dot-prefixed profiles: createProfileRef accepts names like .prod', async () => {
    const home = await tempHome()
    try {
      const outside = await tempHome()
      try {
        await mkdir(path.join(home, 'profiles'), { recursive: true })
        await mkdir(path.join(outside, 'escape-profile'), { recursive: true })
        // A symlink wearing a dot-prefixed profile name must be flagged.
        await symlink(path.join(outside, 'escape-profile'), path.join(home, 'profiles', '.prod'))
        // A dot-prefixed profile DIRECTORY with a corrupt manifest too.
        const corruptDot = path.join(home, 'profiles', '.staging')
        await mkdir(corruptDot, { recursive: true })
        await writeFile(path.join(corruptDot, 'package.json'), '{not json')
        const observed = await inspectHomeFormats(home)
        expect(observed.unknownPaths).toContain('profiles/.prod')
        expect(observed.unknownPaths).toContain('profiles/.staging/package.json')
        expect(observed.formats.profiles).toBeUndefined()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('exempts only real .dsh-desktop-run-* launch roots, not lookalikes', async () => {
    const home = await tempHome()
    try {
      const outside = await tempHome()
      try {
        // A real launch root with runtime junk inside is not data.
        const runRoot = path.join(home, 'profiles', '.dsh-desktop-run-abc123')
        await mkdir(path.join(runRoot, 'bin'), { recursive: true })
        await writeFile(path.join(runRoot, 'bin', 'dsh'), '#!/bin/sh\n')
        // Finder noise: loose regular files are not profiles.
        await writeFile(path.join(home, 'profiles', '.DS_Store'), 'noise')
        // A symlink WEARING the launch-root name is flagged.
        await symlink(
          path.join(outside, 'escape'),
          path.join(home, 'profiles', '.dsh-desktop-run-evil'),
        )
        const observed = await inspectHomeFormats(home)
        expect(observed.unknownPaths).toEqual(['profiles/.dsh-desktop-run-evil'])
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('bounds enumeration and fails closed on overflow', async () => {
    const home = await tempHome()
    try {
      const dir = path.join(home, 'many')
      await mkdir(dir, { recursive: true })
      for (let index = 0; index < 5; index += 1) {
        await writeFile(path.join(dir, `entry-${index}`), 'x')
      }
      const roomy = createInspectionBudget({ entries: 100 })
      expect(await boundedEntries(dir, roomy, 10)).toHaveLength(5)
      expect(await boundedEntries(dir, roomy, 5)).toHaveLength(5)
      expect(await boundedEntries(dir, createInspectionBudget({ entries: 100 }), 4)).toBe(
        'overflow',
      )
      // Per-directory ceiling is not the only bound: the SHARED budget ends
      // the walk too.
      expect(await boundedEntries(dir, createInspectionBudget({ entries: 3 }), 10)).toBe('overflow')
      expect(await boundedEntries(path.join(home, 'missing'), roomy, 10)).toEqual([])
      await writeFile(path.join(home, 'plain'), 'x')
      expect(await boundedEntries(path.join(home, 'plain'), roomy, 10)).toBe('unreadable')
      // The ceiling constant stays far above real homes.
      expect(ENUMERATION_CEILING).toBeGreaterThan(10_000)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('fails closed when the shared end-to-end budget is exhausted', async () => {
    const home = await tempHome()
    try {
      // Entries budget smaller than the fixture: the walk must flag the slot
      // instead of silently inspecting a prefix — and the budget is shared
      // ACROSS slots (the credentials file alone eats most of it here).
      const budget = createInspectionBudget({ entries: 10, unknowns: 8_192 })
      const projectDir = path.join(home, 'sessions', '--fixture--')
      await mkdir(projectDir, { recursive: true })
      await writeFile(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  K: v\n')
      for (let index = 0; index < 12; index += 1) {
        const sessionDir = path.join(projectDir, `s-${index}`)
        await mkdir(sessionDir, { recursive: true })
        await writeFile(
          path.join(sessionDir, 'session.jsonl'),
          '{"type":"session","version":0,"id":"s","createdAt":0,"delegationDepth":0}\n',
        )
      }
      const observed = await inspectHomeFormats(home, budget)
      expect(budget.entries).toBeLessThan(0)
      // The walk bails at the deepest enumeration it was running — the
      // project listing here — and flags that directory fail-closed.
      expect(observed.unknownPaths).toContain('sessions/--fixture--')
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('flags a pre-release flat credentials file as an unknown path', async () => {
    const home = await tempHome()
    try {
      await writeFile(path.join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: flat-layout\n')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toEqual(['.credentials.yaml'])
      expect(observed.formats.credentials).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('flags a session header from a newer format as unreadable', async () => {
    const home = await tempHome()
    try {
      const sessionDir = path.join(home, 'sessions', '--fixture--', 's-1')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(
        path.join(sessionDir, 'session.jsonl'),
        '{"type":"session","version":99,"id":"s-1","createdAt":0,"delegationDepth":0}\n',
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.formats.sessions).toBeUndefined()
      expect(observed.unknownPaths).toContain('sessions/--fixture--/s-1/session.jsonl')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
