import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('desktop bundle', () => {
  it('declares a DSH bundle patch', async () => {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  it('keeps the complete Web runtime config while transferring browser handoff', async () => {
    const patch = await readFile(path.join(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: web-runtime')
    expect(patch).toContain('openBrowser: false')
    expect(patch).toContain('printUrl: false')
    expect(patch).toContain('surfaceContext: true')
    expect(patch).toContain('trustedHosts: !!js ctx.webStartup.trustedHosts')
    expect(patch.indexOf('- id: web-runtime')).toBeLessThan(patch.indexOf('- id: desktop-surface'))
  })
})
