import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('recovery bridge bundle composition', () => {
  it('disables browser opening and url printing in its patch', async () => {
    const patch = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml'),
      'utf8',
    )
    expect(patch).toContain('openBrowser: false')
    expect(patch).toContain('printUrl: false')
  })

  it('does not reference the normal desktop plugin', async () => {
    const index = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
      'utf8',
    )
    expect(index).not.toContain('desktop-plugin')
  })
})
