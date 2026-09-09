import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeSurfaceUrlFile } from '../src/surface-url-file.js'

async function withTempUserData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'dsh-surface-url-'))
}

describe('writeSurfaceUrlFile', () => {
  it('writes the URL into a regular 0600 file', async () => {
    const userData = await withTempUserData()
    try {
      await writeSurfaceUrlFile(userData, 'http://127.0.0.1:1/?token=secret')
      const target = path.join(userData, 'surface-url')
      const stats = await lstat(target)
      expect(stats.isFile()).toBe(true)
      expect(stats.mode & 0o777).toBe(0o600)
      expect(await readFile(target, 'utf8')).toBe('http://127.0.0.1:1/?token=secret\n')
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('tightens the permissions of a pre-existing wide file', async () => {
    const userData = await withTempUserData()
    try {
      const target = path.join(userData, 'surface-url')
      await writeFile(target, 'stale\n')
      await chmod(target, 0o644)
      await writeSurfaceUrlFile(userData, 'http://127.0.0.1:2/?token=next')
      expect((await lstat(target)).mode & 0o777).toBe(0o600)
      expect(await readFile(target, 'utf8')).toBe('http://127.0.0.1:2/?token=next\n')
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('refuses to write through a pre-planted symlink', async () => {
    const userData = await withTempUserData()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-surface-url-outside-'))
    try {
      const canary = path.join(outside, 'canary.txt')
      await writeFile(canary, 'untouched\n')
      await symlink(canary, path.join(userData, 'surface-url'))
      await expect(
        writeSurfaceUrlFile(userData, 'http://127.0.0.1:3/?token=leak'),
      ).rejects.toThrow()
      expect(await readFile(canary, 'utf8')).toBe('untouched\n')
      expect((await lstat(path.join(userData, 'surface-url'))).isSymbolicLink()).toBe(true)
    } finally {
      await rm(userData, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
