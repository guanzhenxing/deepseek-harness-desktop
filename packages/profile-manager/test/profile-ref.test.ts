import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createProfileRef } from '../src/index.js'

describe('ProfileRef', () => {
  it('normalizes an explicit home and resolves the profile below it', () => {
    const ref = createProfileRef('./fixture-home/../fixture-home', 'desktop')
    expect(ref.home).toBe(path.resolve('fixture-home'))
    expect(ref.dir).toBe(path.join(path.resolve('fixture-home'), 'profiles', 'desktop'))
    expect(ref.name).toBe('desktop')
  })

  it.each(['', '.', '..', 'node_modules', 'a/b', 'a\\b'])(
    'rejects invalid profile name %j',
    (name) => {
      expect(() => createProfileRef('/tmp/explicit-test-home', name)).toThrow(
        /invalid profile name/u,
      )
    },
  )

  it.each(['.dsh-desktop-run-user', '.dsh-desktop-run-', '.dsh-desktop-run-abc123'])(
    'reserves the runtime launch-root prefix from profile name %j',
    (name) => {
      expect(() => createProfileRef('/tmp/explicit-test-home', name)).toThrow(
        /reserved runtime launch-root prefix/u,
      )
    },
  )

  it('allows dot-prefixed profile names outside the reserved prefix', () => {
    expect(createProfileRef('/tmp/explicit-test-home', '.prod').name).toBe('.prod')
  })

  it('requires an explicit non-root home', () => {
    expect(() => createProfileRef('', 'desktop')).toThrow(/explicit home/u)
    expect(() => createProfileRef(path.parse(process.cwd()).root, 'desktop')).toThrow(
      /filesystem root/u,
    )
  })
})
