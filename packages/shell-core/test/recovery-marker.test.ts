import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createRecoveryMarkerStore } from '../src/recovery-marker.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const fixtures: IsolatedHomeFixture[] = []

/** A store plus the concrete file path its userData digest rule produces. */
async function storeWithFile(): Promise<{
  store: ReturnType<typeof createRecoveryMarkerStore>
  file: string
}> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const store = createRecoveryMarkerStore(fixture.userData, fixture.home)
  const digest = createHash('sha256').update(fixture.home).digest('hex').slice(0, 16)
  const file = path.join(fixture.userData, 'recovery', `${digest}.json`)
  return { store, file }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe('createRecoveryMarkerStore', () => {
  it('round-trips a versioned marker and clears it after read', async () => {
    const { store } = await storeWithFile()
    expect(await store.read()).toBeUndefined()
    await store.write({ transactionId: 'tx-1', attempt: 1 })
    expect(await store.read()).toMatchObject({ transactionId: 'tx-1', attempt: 1 })
    await store.clear()
    expect(await store.read()).toBeUndefined()
  })

  it('treats a corrupt marker file as spent budget and never overwrites or deletes it', async () => {
    const { store, file } = await storeWithFile()
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, '{corrupt bytes', { mode: 0o600 })

    expect(await store.read()).toEqual({ schemaVersion: 'unknown' })
    await store.write({ transactionId: 'tx-2', attempt: 1 })
    await store.clear()
    expect(await readFile(file, 'utf8')).toBe('{corrupt bytes')
  })

  it('treats a future schema version as spent budget and leaves it untouched', async () => {
    const { store, file } = await storeWithFile()
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const future = `${JSON.stringify({ schemaVersion: 2, anything: true }, null, 2)}\n`
    await writeFile(file, future, { mode: 0o600 })

    expect(await store.read()).toEqual({ schemaVersion: 'unknown' })
    await store.clear()
    expect(await readFile(file, 'utf8')).toBe(future)
  })

  it('treats malformed v1 fields as foreign data', async () => {
    const { store, file } = await storeWithFile()
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const malformed = `${JSON.stringify({
      schemaVersion: 1,
      transactionId: '',
      attempt: 0.5,
    })}\n`
    await writeFile(file, malformed, { mode: 0o600 })
    expect(await store.read()).toEqual({ schemaVersion: 'unknown' })
    await store.clear()
    expect(await readFile(file, 'utf8')).toBe(malformed)
  })
})
