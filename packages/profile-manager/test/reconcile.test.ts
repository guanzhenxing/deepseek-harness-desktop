import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DESKTOP_BUNDLE_PREFIX,
  createIsolatedHomeAuthority,
  createProfileRef,
  reconcileDesktopProfile,
} from '../src/index.js'

const homes: string[] = []

async function testHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-profile-manager-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true })
})

describe('reconcileDesktopProfile', () => {
  it('initializes a missing desktop profile in an isolated home', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'desktop')
    const result = await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home))

    const manifest = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile).toEqual({ bundles: DESKTOP_BUNDLE_PREFIX, patchReload: 'live' })
    expect(await readFile(path.join(ref.dir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(await readFile(path.join(ref.dir, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'nodeLinker: hoisted',
    )
    expect(result.changed).toBe(true)
    expect(result.beforeRevision).toBeUndefined()
    expect(result.afterRevision).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('repairs only the owned prefix and preserves third-party order and metadata', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'desktop')
    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home))
    const manifestPath = path.join(ref.dir, 'package.json')
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: 'custom-name',
          private: true,
          scripts: { note: 'keep-me' },
          dependencies: { third: '1.2.3' },
          dsh: {
            extension: { keep: true },
            profile: {
              bundles: [
                'third-a',
                '@deepseek-ai/dsh-web-app',
                'third-b',
                '@dsh-desktop/desktop-plugin',
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-base',
              ],
              patchReload: 'startup',
            },
          },
        },
        undefined,
        2,
      )}\n`,
    )

    const result = await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual([...DESKTOP_BUNDLE_PREFIX, 'third-a', 'third-b'])
    expect(manifest.dsh.profile.patchReload).toBe('startup')
    expect(manifest.dsh.extension).toEqual({ keep: true })
    expect(manifest.scripts).toEqual({ note: 'keep-me' })
    expect(manifest.dependencies).toEqual({ third: '1.2.3' })
    expect(result.changed).toBe(true)
    expect(result.beforeRevision).not.toBe(result.afterRevision)
  })

  it('is idempotent and leaves unrelated profiles unchanged', async () => {
    const home = await testHome()
    const ref = createProfileRef(home, 'desktop')
    const unrelated = createProfileRef(home, 'web')
    await mkdir(unrelated.dir, { recursive: true })
    const unrelatedPath = path.join(unrelated.dir, 'package.json')
    await writeFile(unrelatedPath, '{"name":"unrelated"}\n')
    const unrelatedBefore = await readFile(unrelatedPath, 'utf8')

    await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home))
    const second = await reconcileDesktopProfile(ref, createIsolatedHomeAuthority(home))

    expect(second.changed).toBe(false)
    expect(second.beforeRevision).toBe(second.afterRevision)
    expect(await readFile(unrelatedPath, 'utf8')).toBe(unrelatedBefore)
  })

  it('rejects write authority for another home before creating files', async () => {
    const home = await testHome()
    const otherHome = await testHome()
    const ref = createProfileRef(home, 'desktop')
    await expect(
      reconcileDesktopProfile(ref, createIsolatedHomeAuthority(otherHome)),
    ).rejects.toThrow(/authority/u)
    await expect(readFile(path.join(ref.dir, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
