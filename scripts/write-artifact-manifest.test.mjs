import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectArtifactRecords } from './write-artifact-manifest.mjs'

const EMBEDDED = {
  schemaVersion: 2,
  releaseId: 'v0.1.0-darwin-arm64-abc1234',
  desktopVersion: '0.1.0',
  arch: 'arm64',
}

async function withDist(files) {
  const dist = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-manifest-'))
  const manifest = path.join(dist, 'compatibility.json')
  await writeFile(manifest, JSON.stringify(EMBEDDED))
  for (const name of files) await writeFile(path.join(dist, name), `bytes-of-${name}`)
  return { dist, manifest }
}

test('records the current-version DMG with the embedded manifest identity', async () => {
  const { dist, manifest } = await withDist(['DeepSeek Harness-0.1.0-arm64.dmg'])
  try {
    const records = await collectArtifactRecords(dist, manifest)
    assert.equal(records.length, 1)
    assert.equal(path.basename(records[0].file), 'DeepSeek Harness-0.1.0-arm64.dmg')
    assert.equal(records[0].releaseId, EMBEDDED.releaseId)
    assert.equal(records[0].arch, EMBEDDED.arch)
  } finally {
    await rm(dist, { recursive: true, force: true })
  }
})

test('refuses a stale foreign-version DMG instead of stamping it', async () => {
  const { dist, manifest } = await withDist([
    'DeepSeek Harness-0.1.0-arm64.dmg',
    'DeepSeek Harness-0.0.0-arm64.dmg',
  ])
  try {
    await assert.rejects(
      collectArtifactRecords(dist, manifest),
      /foreign-version artifact "DeepSeek Harness-0\.0\.0-arm64\.dmg".*remove it/su,
    )
  } finally {
    await rm(dist, { recursive: true, force: true })
  }
})
