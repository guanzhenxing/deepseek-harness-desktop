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

  it('requires an explicit non-root home', () => {
    expect(() => createProfileRef('', 'desktop')).toThrow(/explicit home/u)
    expect(() => createProfileRef(path.parse(process.cwd()).root, 'desktop')).toThrow(
      /filesystem root/u,
    )
  })
})
