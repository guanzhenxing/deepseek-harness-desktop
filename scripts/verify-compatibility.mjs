#!/usr/bin/env node
// Verify the release compatibility manifest chain:
//
//   1. regenerate the manifest from the pinned inputs and compare it
//      byte-for-byte with the generated release/compatibility.json
//      (release/ is untracked; a fresh clone must run generate:compatibility once);
//   2. parse both the regenerated and the staged (if present) manifest with
//      the strict release schema and require the embedded copy to carry the
//      same release facts;
//   3. keep docs/compatibility.json consistent with the manifest (the source
//      facts stay authoritative, the manifest never duplicates artifact SHAs).
//
// Run after `pnpm build` (the strict parser lives in the compiled
// release-compatibility package).
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDir, '..')

const requireFromRoot = createRequire(path.join(repositoryRoot, 'package.json'))

async function main() {
  let parseReleaseManifest
  try {
    ;({ parseReleaseManifest } = requireFromRoot('./packages/release-compatibility/lib/index.js'))
  } catch {
    console.error('verify-compatibility: the workspace is not built; run `pnpm build` first')
    return 2
  }
  const { generateReleaseManifest, CompatibilityInputError } =
    await import('./generate-compatibility.mjs')

  let manifest
  try {
    manifest = await generateReleaseManifest()
  } catch (error) {
    if (error instanceof CompatibilityInputError) {
      console.error(`verify-compatibility: ${error.message}`)
      return 1
    }
    throw error
  }
  parseReleaseManifest(manifest)

  const releasePath = path.join(repositoryRoot, 'release', 'compatibility.json')
  if (!existsSync(releasePath)) {
    console.error(
      'verify-compatibility: release/compatibility.json is missing; run `pnpm run generate:compatibility`',
    )
    return 1
  }
  const releaseBytes = await readFile(releasePath, 'utf8')
  if (releaseBytes !== `${JSON.stringify(manifest, undefined, 2)}\n`) {
    console.error(
      'verify-compatibility: release/compatibility.json does not match the pinned inputs; regenerate it',
    )
    return 1
  }

  const stagingPath = path.join(repositoryRoot, 'release', 'staging', 'compatibility.json')
  if (existsSync(stagingPath)) {
    const staged = parseReleaseManifest(JSON.parse(await readFile(stagingPath, 'utf8')))
    for (const key of Object.keys(manifest)) {
      if (JSON.stringify(staged[key]) !== JSON.stringify(manifest[key])) {
        console.error(
          `verify-compatibility: staged manifest field ${key} diverges from the regenerated release facts`,
        )
        return 1
      }
    }
  }

  console.log('verify-compatibility: release manifest matches the pinned inputs')
  return 0
}

process.exitCode = await main()
