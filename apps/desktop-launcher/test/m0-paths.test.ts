import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveSmokeUserData } from '../src/m0-paths.js'

describe('M0 smoke userData override', () => {
  it('rejects an override outside smoke mode', async () => {
    await expect(resolveSmokeUserData(undefined, '/tmp/arbitrary-home')).rejects.toThrow(/smoke/u)
  })

  it('rejects non-temporary smoke roots', async () => {
    await expect(resolveSmokeUserData('ui', '/Users/shared-data')).rejects.toThrow(/temporary/u)
  })

  it('accepts only a real smoke directory and rejects a symlink', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-'))
    const linked = `${root}-link`
    try {
      expect(await resolveSmokeUserData('ui', root)).toBe(root)
      expect(await resolveSmokeUserData('loading', root)).toBe(root)
      await symlink(root, linked, 'dir')
      await expect(resolveSmokeUserData('ui', linked)).rejects.toThrow(/symlink/u)
    } finally {
      await rm(linked, { force: true })
      // This test owns the unchanged mkdtemp root; the resolver validates it again.
      await resolveSmokeUserData('ui', root)
      await rm(root, { recursive: true })
    }
  })
})
