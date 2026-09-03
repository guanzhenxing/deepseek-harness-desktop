#!/usr/bin/env node
// Verify release/artifacts.json against the real artifacts on disk and
// inside the DMG:
//   - the record targets this machine's architecture (exactly one candidate);
//   - the DMG bytes still hash to the recorded SHA-256;
//   - the compatibility manifest embedded in the DMG's .app is byte-identical
//     to the manifest the record links via releaseId (mounted read-only with
//     hdiutil; the mount is detached on every path, including failures).
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function attachDmg(dmg) {
  const output = execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', dmg], {
    encoding: 'utf8',
  })
  const mountPoint = output
    .trim()
    .split('\n')
    .at(-1)
    ?.split('\t')
    .map((column) => column.trim())
    .filter((column) => column.startsWith('/'))
    .at(-1)
  if (mountPoint === undefined || !mountPoint.startsWith('/')) {
    throw new Error(`could not parse hdiutil mount point from: ${output}`)
  }
  return mountPoint
}

function detach(mountPoint) {
  spawnSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
}

export async function verifyArtifacts(artifactsFile) {
  const records = JSON.parse(await readFile(artifactsFile, 'utf8'))
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${artifactsFile} contains no artifact records`)
  }
  const errors = []
  for (const record of records) {
    const file = path.join(root, record.file)
    if (record.platform !== 'darwin') errors.push(`${record.file}: non-darwin record`)
    if (record.arch !== process.arch) {
      errors.push(`${record.file}: record arch ${record.arch} != this machine ${process.arch}`)
      continue
    }
    const bytes = await readFile(file).catch(() => undefined)
    if (bytes === undefined) {
      errors.push(`${record.file}: artifact is missing`)
      continue
    }
    if (sha256(bytes) !== record.sha256) {
      errors.push(`${record.file}: SHA-256 does not match the record`)
    }
    // The embedded manifest inside the DMG must be the one the record links.
    const mountPoint = attachDmg(file)
    try {
      const finder = spawnSync('find', [mountPoint, '-maxdepth', '1', '-name', '*.app'], {
        encoding: 'utf8',
      })
      const appBundle = finder.stdout.trim().split('\n')[0]
      if (appBundle === undefined || appBundle === '') {
        errors.push(`${record.file}: no .app bundle found in the DMG`)
        continue
      }
      const embedded = await readFile(
        path.join(appBundle, 'Contents', 'Resources', 'compatibility.json'),
        'utf8',
      ).catch(() => undefined)
      if (embedded === undefined) {
        errors.push(`${record.file}: .app carries no embedded compatibility manifest`)
        continue
      }
      const embeddedSha = sha256(Buffer.from(embedded, 'utf8'))
      if (embeddedSha !== record.compatibilityManifestSha256) {
        errors.push(
          `${record.file}: embedded manifest hash ${embeddedSha.slice(0, 12)} != recorded ${record.compatibilityManifestSha256.slice(0, 12)}`,
        )
      }
      const parsed = JSON.parse(embedded)
      if (parsed.releaseId !== record.releaseId) {
        errors.push(
          `${record.file}: embedded releaseId ${parsed.releaseId} != recorded ${record.releaseId}`,
        )
      }
    } finally {
      detach(mountPoint)
    }
  }
  return errors
}

async function main() {
  const errors = await verifyArtifacts(path.join(root, 'release', 'artifacts.json'))
  if (errors.length > 0) {
    console.error(`artifact verification failed with ${errors.length} error(s):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log('artifact verification passed (records, SHAs, and embedded manifests match)')
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()
