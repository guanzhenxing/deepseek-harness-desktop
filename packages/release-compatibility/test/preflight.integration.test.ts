import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  defaultLeaseHelperPath,
} from '@dsh-desktop/home-lease'

import { markerPath } from '../src/home-admission.js'
import { runHomeCompatibilityChain } from '../src/home-marker.js'
import { BASELINE_MANIFEST } from './preflight.test.js'

const helperAvailable =
  process.platform === 'darwin' &&
  spawnSync(defaultLeaseHelperPath(), ['identity', String(process.pid)], { timeout: 5_000 })
    .status === 0

const fixtures: Array<{ dispose(): Promise<void>; home: string }> = []

async function baselineHome(): Promise<string> {
  const { createIsolatedHomeFixture } = await import('../../../tests/helpers/isolated-home.mjs')
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  await writeBaselineHome(fixture.home)
  return fixture.home
}

/** A minimal same-baseline home shape: credentials + settings + one session. */
async function writeBaselineHome(home: string): Promise<void> {
  await mkdir(path.join(home, 'sessions', '--fixture--', 's-1'), { recursive: true })
  await writeFile(
    path.join(home, '.credentials.yaml'),
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-not-a-secret\n',
  )
  await writeFile(path.join(home, 'settings.yaml'), 'llm-deepseek:\n  baseURL: https://x\n')
  await writeFile(
    path.join(home, 'sessions', '--fixture--', 's-1', 'session.jsonl'),
    '{"type":"session","version":0,"id":"s-1","createdAt":0,"delegationDepth":0}\n',
  )
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe.skipIf(!helperAvailable)('home compatibility chain (real lease)', () => {
  it('parses marker → inspects → preflights → reserves the write epoch, in order', async () => {
    const home = await baselineHome()
    const lease = await acquire(home)
    const verdict = await runHomeCompatibilityChain({
      home,
      release: BASELINE_MANIFEST,
      lease,
      reserve: true,
    })
    expect(verdict).toBe('allow')
    const marker = JSON.parse(await readFile(markerPath(home), 'utf8'))
    expect(marker).toMatchObject({
      schemaVersion: 1,
      dataEpoch: 1,
      lastWriterReleaseId: BASELINE_MANIFEST.releaseId,
    })
    expect(marker.formats).toMatchObject({
      credentials: 'dsh-credentials-file-1',
      settings: 'dsh-settings-file-0.1.2-alpha.3',
      sessions: 'dsh-session-jsonl-0',
    })
    await lease.release()
  })

  it('refuses a newer-epoch marker without writing anything', async () => {
    const home = await baselineHome()
    const runDir = path.join(home, 'run')
    await mkdir(runDir, { recursive: true })
    const foreignMarker = {
      schemaVersion: 1,
      dataEpoch: 2,
      lastWriterReleaseId: 'future-release-fixture',
      formats: {},
    }
    await writeFile(markerPath(home), JSON.stringify(foreignMarker, undefined, 2))
    const lease = await acquire(home)
    // The snapshot starts after the lease exists: acquisition metadata is
    // expected coordination output; every data file must stay untouched.
    const before = await snapshot(home)
    const verdict = await runHomeCompatibilityChain({
      home,
      release: BASELINE_MANIFEST,
      lease,
      reserve: true,
    })
    expect(verdict).toBe('unsupported-data')
    expect(await snapshot(home)).toEqual(before)
    await lease.release()
  })

  it('refuses a corrupt marker by throwing and leaves it untouched', async () => {
    const home = await baselineHome()
    const runDir = path.join(home, 'run')
    await mkdir(runDir, { recursive: true })
    await writeFile(markerPath(home), '{not json')
    const lease = await acquire(home)
    const before = await snapshot(home)
    await expect(
      runHomeCompatibilityChain({
        home,
        release: BASELINE_MANIFEST,
        lease,
        reserve: true,
      }),
    ).rejects.toMatchObject({ name: 'HomeAdmissionError', code: 'MARKER_CORRUPT' })
    expect(await snapshot(home)).toEqual(before)
    await lease.release()
  })

  it('refuses a parsable-but-invalid marker as unknown schema without writing', async () => {
    const home = await baselineHome()
    const runDir = path.join(home, 'run')
    await mkdir(runDir, { recursive: true })
    await writeFile(markerPath(home), JSON.stringify({ schemaVersion: 7, note: 'from the future' }))
    const lease = await acquire(home)
    const before = await snapshot(home)
    const verdict = await runHomeCompatibilityChain({
      home,
      release: BASELINE_MANIFEST,
      lease,
      reserve: true,
    })
    expect(verdict).toBe('unknown-schema')
    expect(await snapshot(home)).toEqual(before)
    await lease.release()
  })

  it('refuses reserving without the home lease', async () => {
    const home = await baselineHome()
    await expect(
      runHomeCompatibilityChain({
        home,
        release: BASELINE_MANIFEST,
        reserve: true,
      }),
    ).rejects.toMatchObject({ name: 'HomeAdmissionError' })
  })

  it('never reserves on the lease-less passthrough path', async () => {
    const home = await baselineHome()
    const verdict = await runHomeCompatibilityChain({
      home,
      release: BASELINE_MANIFEST,
      reserve: false,
    })
    expect(verdict).toBe('allow')
    const { stat } = await import('node:fs/promises')
    await expect(stat(markerPath(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function acquire(home: string) {
  return acquireHomeLease({
    home,
    entrypoint: 'desktop',
    profile: 'desktop',
    appVersion: '0.0.0',
    probe: createNativeProcessProbe({
      helperPath: defaultLeaseHelperPath(),
      entryExecutables: [],
    }),
  })
}

/** Byte-level home snapshot: names + sizes + contents of every file. */
async function snapshot(root: string): Promise<string> {
  const { readFile: rf, readdir, stat } = await import('node:fs/promises')
  const entries: string[] = []
  async function walk(dir: string): Promise<void> {
    const list = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of list) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        entries.push(`dir ${path.relative(root, target)}/`)
        await walk(target)
        continue
      }
      const info = await stat(target)
      const bytes = await rf(target).catch(() => Buffer.alloc(0))
      entries.push(`file ${path.relative(root, target)} ${info.size} ${bytes.toString('base64')}`)
    }
  }
  await walk(root)
  return entries.join('\n')
}
