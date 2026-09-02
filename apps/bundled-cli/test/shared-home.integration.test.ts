import { spawnSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { defaultLeaseHelperPath } from '@dsh-desktop/home-lease'

import {
  createSharedHomeFixture,
  runDshNative,
  runSharedHomeScenario,
  withCliWeb,
} from '../../../tests/helpers/shared-home-driver.mjs'

const helperAvailable =
  process.platform === 'darwin' &&
  spawnSync(defaultLeaseHelperPath(), ['identity', String(process.pid)], { timeout: 5_000 })
    .status === 0

const createdFixtures: Awaited<ReturnType<typeof createSharedHomeFixture>>[] = []
let fixture: Awaited<ReturnType<typeof createSharedHomeFixture>>

beforeAll(async () => {
  if (!helperAvailable) return
  fixture = await createSharedHomeFixture()
  createdFixtures.push(fixture)
})

afterAll(async () => {
  for (const entry of createdFixtures.splice(0)) await entry.dispose()
})

describe.skipIf(!helperAvailable)('sequential shared home (real DSH graph)', () => {
  it('lets the CLI create a session and the Desktop continue it', async () => {
    const result = await runSharedHomeScenario('cli-to-desktop')
    expect(result.persistedTurns).toBe(2)
    expect(result.sessionId).toMatch(/^session-/u)
  }, 300_000)

  it('lets the Desktop create a session and the CLI continue it', async () => {
    const result = await runSharedHomeScenario('desktop-to-cli')
    expect(result.persistedTurns).toBe(2)
    expect(result.sessionId).toMatch(/^session-/u)
  }, 300_000)

  it('rejects the CLI while another entry holds the same home, across profiles', async () => {
    if (fixture === undefined) return
    await withCliWeb(fixture.home, fixture.cwd, async () => {
      const headless = await runDshNative(['--profile', 'headless', 'must be rejected'], {
        home: fixture.home,
        cwd: fixture.cwd,
      })
      expect(headless.code).toBe(3)
      expect(headless.output).toContain('HOME_BUSY')
      const plugin = await runDshNative(
        ['plugin', '--profile', 'desktop', 'add', '@example/unavailable'],
        { home: fixture.home, cwd: fixture.cwd },
      )
      expect(plugin.code).toBe(3)
      expect(plugin.output).toContain('HOME_BUSY')
      expect(plugin.output).toContain('doctor --unlock')
    })
    // After the holder exits cleanly the home is usable again.
    const next = await runDshNative(['--profile', 'headless', 'usable again'], {
      home: fixture.home,
      cwd: fixture.cwd,
    })
    expect(next.code).toBe(0)
    await expect(stat(path.join(fixture.home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }, 300_000)
})
