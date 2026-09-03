#!/usr/bin/env node
// Write release/artifacts.json + release/SHA256SUMS for the packaged DMG.
//
// The DMG's own SHA is never embedded inside the DMG (that would be a
// self-referential hash); instead each record links the DMG to the embedded
// compatibility manifest by releaseId and that manifest's SHA-256.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'release', 'dist')
const stagingManifestPath = path.join(root, 'release', 'staging', 'compatibility.json')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Collect the DMG candidates of this build into manifest records. */
export async function collectArtifactRecords(distDirectory, embeddedManifestPath) {
  const embedded = JSON.parse(await readFile(embeddedManifestPath, 'utf8'))
  const compatibilityManifestSha256 = sha256(await readFile(embeddedManifestPath))
  const records = []
  for (const entry of await readdir(distDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.dmg')) continue
    const file = path.join(distDirectory, entry.name)
    records.push({
      file: path.relative(root, file),
      sha256: sha256(await readFile(file)),
      platform: 'darwin',
      arch: embedded.arch,
      releaseId: embedded.releaseId,
      compatibilityManifestSha256,
    })
  }
  return records
}

async function main() {
  const records = await collectArtifactRecords(dist, stagingManifestPath)
  if (records.length === 0) {
    throw new Error(`no DMG found under ${dist}; run package:dmg first`)
  }
  await writeFile(
    path.join(root, 'release', 'artifacts.json'),
    `${JSON.stringify(records, undefined, 2)}\n`,
  )
  const sums = records.map((record) => `${record.sha256}  ${record.file}`).join('\n')
  await writeFile(path.join(root, 'release', 'SHA256SUMS'), `${sums}\n`)
  for (const record of records) {
    console.log(
      `artifact: ${record.file} (${record.platform}-${record.arch}, ${record.sha256.slice(0, 12)}…)`,
    )
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()
