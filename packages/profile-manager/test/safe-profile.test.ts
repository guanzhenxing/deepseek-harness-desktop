import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createInProcessGuardLock,
  type HomeLease,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'

import { createProfileRef } from '../src/index.js'
import { SAFE_BUNDLE_PREFIX, SAFE_PROFILE_NAME, prepareSafeProfile } from '../src/safe-profile.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.js'

const fixtures: IsolatedHomeFixture[] = []

async function leasedHome(): Promise<{
  ref: ReturnType<typeof createProfileRef>
  lease: HomeLease
  normalDir: string
}> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const lease = await acquireHomeLease({
    home: fixture.home,
    entrypoint: 'desktop',
    profile: 'desktop',
    appVersion: '0.0.0',
    probe: sameProbe(),
    guard: createInProcessGuardLock(),
  })
  return {
    ref: createProfileRef(fixture.home, SAFE_PROFILE_NAME),
    lease,
    normalDir: path.join(fixture.home, 'profiles', 'desktop'),
  }
}

function sameProbe(): ProcessProbe {
  return {
    async current() {
      return { pid: process.pid, startIdentity: 'safe-probe' }
    },
    async identify(pid) {
      return { pid, startIdentity: 'safe-probe' }
    },
    async inspect() {
      return 'same' as const
    },
    async scanSupported() {
      return 'none' as const
    },
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe('prepareSafeProfile', () => {
  it('creates exactly the three first-party bundles and never touches the normal profile', async () => {
    const { ref, lease, normalDir } = await leasedHome()
    await mkdir(normalDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(normalDir, 'user.txt'), 'keep')
    await expect(prepareSafeProfile(ref, lease)).resolves.toBe('prepared')
    const manifest = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual([...SAFE_BUNDLE_PREFIX])
    await expect(readFile(path.join(normalDir, 'user.txt'), 'utf8')).resolves.toBe('keep')
    await lease.release()
  })

  it('refuses names other than desktop-safe-mode', async () => {
    const { lease, ref } = await leasedHome()
    const other = createProfileRef(ref.home, 'desktop')
    await expect(prepareSafeProfile(other, lease)).rejects.toThrow(/desktop-safe-mode/u)
    await lease.release()
  })

  it('never overwrites unknown user content in the safe profile', async () => {
    const { ref, lease } = await leasedHome()
    await prepareSafeProfile(ref, lease)
    const manifestPath = path.join(ref.dir, 'package.json')
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
    raw.dsh.profile.bundles.push('@fixture/third-party')
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`)
    await expect(prepareSafeProfile(ref, lease)).resolves.toBe('conflict')
    const after = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(after.dsh.profile.bundles).toContain('@fixture/third-party')
    await lease.release()
  })
})
