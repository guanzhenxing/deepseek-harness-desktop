import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ENUMERATION_CEILING, boundedEntries, inspectHomeFormats } from '../src/inspect-home.js'
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

  it('classifies EVERY storage unit regardless of position (no sampling)', async () => {
    const home = await tempHome()
    try {
      // 65 legit units + one corrupt JSON unit created LAST — with full
      // classification its position in the readdir order is irrelevant.
      for (let index = 0; index < 65; index += 1) {
        const domain = path.join(home, 'storages', `domain-${index}`)
        await mkdir(domain, { recursive: true })
        await writeFile(path.join(domain, 'global.json'), '{"version":1,"record":null}')
      }
      await mkdir(path.join(home, 'storages', 'corrupt-unit'), { recursive: true })
      await writeFile(path.join(home, 'storages', 'corrupt-unit', 'global.json'), '{not json')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('storages/corrupt-unit/global.json')
      expect(observed.formats.storages).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('classifies EVERY session regardless of position (no sampling)', async () => {
    const home = await tempHome()
    try {
      const projectDir = path.join(home, 'sessions', '--fixture--')
      for (let index = 0; index < 40; index += 1) {
        const sessionDir = path.join(projectDir, `s-${index}`)
        await mkdir(sessionDir, { recursive: true })
        await writeFile(
          path.join(sessionDir, 'session.jsonl'),
          '{"type":"session","version":0,"id":"s","createdAt":0,"delegationDepth":0}\n',
        )
      }
      // A foreign-version header created LAST must still be flagged.
      const foreign = path.join(projectDir, 's-future')
      await mkdir(foreign, { recursive: true })
      await writeFile(
        path.join(foreign, 'session.jsonl'),
        '{"type":"session","version":99,"id":"f","createdAt":0,"delegationDepth":0}\n',
      )
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('sessions/--fixture--/s-future/session.jsonl')
      expect(observed.formats.sessions).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('classifies EVERY profile manifest regardless of position (no sampling)', async () => {
    const home = await tempHome()
    try {
      for (let index = 0; index < 40; index += 1) {
        const profileDir = path.join(home, 'profiles', `p-${index}`)
        await mkdir(profileDir, { recursive: true })
        await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))
      }
      const corrupt = path.join(home, 'profiles', 'p-corrupt')
      await mkdir(corrupt, { recursive: true })
      await writeFile(path.join(corrupt, 'package.json'), '{not json')
      const observed = await inspectHomeFormats(home)
      expect(observed.unknownPaths).toContain('profiles/p-corrupt/package.json')
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
      expect(await boundedEntries(dir, 10)).toHaveLength(5)
      expect(await boundedEntries(dir, 5)).toHaveLength(5)
      expect(await boundedEntries(dir, 4)).toBe('overflow')
      expect(await boundedEntries(path.join(home, 'missing'), 10)).toEqual([])
      await writeFile(path.join(home, 'plain'), 'x')
      expect(await boundedEntries(path.join(home, 'plain'), 10)).toBe('unreadable')
      // The ceiling constant stays far above real homes.
      expect(ENUMERATION_CEILING).toBeGreaterThan(10_000)
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
