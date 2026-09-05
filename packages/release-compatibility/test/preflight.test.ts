import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { inspectHomeFormats } from '../src/inspect-home.js'
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
