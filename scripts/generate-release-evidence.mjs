#!/usr/bin/env node
// Generate the deterministic release-evidence projection for the current
// staged runtime closures: the SBOM, license inventory, and unified report.
// Evidence is a projection of the staged tree + lockfile + artifact facts —
// never a second authority. Repeat runs are byte-identical (canonical JSON,
// no timestamps, no absolute paths).
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  canonicalJson,
  collectClosureComponents,
  createCycloneDx,
  createLicenseInventory,
  createReleaseEvidence,
  gatherEvidenceIdentity,
  npmPurl,
} from './release-evidence-lib.mjs'
import { closureRecordsFromLockfile, repositoryRoot } from './generate-compatibility.mjs'

const evidenceDirectory = path.join(repositoryRoot, 'release', 'evidence')

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeAtomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, file)
}

async function stagedClosureRoots() {
  const staging = path.join(repositoryRoot, 'release', 'staging')
  const roots = ['runtime-host', 'runtime-cli'].map((name) => path.join(staging, name))
  const { stat } = await import('node:fs/promises')
  const missing = []
  for (const root of roots) {
    const identity = await stat(path.join(root, 'node_modules')).catch(() => undefined)
    if (identity === undefined || !identity.isDirectory()) {
      missing.push(path.relative(repositoryRoot, root))
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `generate-release-evidence: staged closure roots missing (${missing.join(', ')}); run \`pnpm run package:dir\` first`,
    )
  }
  return roots
}

async function lockfileIntegrityByPurl() {
  const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
  const map = new Map()
  for (const record of closureRecordsFromLockfile(lockfile)) {
    if (record.integrity === undefined) continue
    map.set(npmPurl(record.name, record.version), record.integrity)
  }
  return map
}

async function main() {
  const roots = await stagedClosureRoots()
  const components = await collectClosureComponents(roots, await lockfileIntegrityByPurl())

  const require = createRequire(path.join(repositoryRoot, 'package.json'))
  const { PRODUCT } = require('./packages/product-config/lib/index.js')
  const compatibility = await readJson(path.join(repositoryRoot, 'docs', 'compatibility.json'))
  const subject = {
    type: 'application',
    name: PRODUCT.name,
    version: compatibility.desktopVersion,
  }

  const bom = createCycloneDx(components, subject)
  await writeAtomic(path.join(evidenceDirectory, 'sbom.cdx.json'), canonicalJson(bom))
  const inventory = await createLicenseInventory(components, roots)
  await writeAtomic(path.join(evidenceDirectory, 'licenses.json'), canonicalJson(inventory))
  const declared = inventory.components.filter((entry) => entry.declared !== 'NOASSERTION').length

  const evidence = await gatherEvidenceIdentity({ repositoryRoot, evidenceDirectory })
  const report = createReleaseEvidence(evidence)
  await writeAtomic(path.join(evidenceDirectory, 'release-evidence.json'), canonicalJson(report))
  console.log(
    `generate-release-evidence: wrote release/evidence/sbom.cdx.json (${components.length} components), licenses.json (${declared} declared, ${components.length - declared} NOASSERTION), release-evidence.json (${report.releaseId})`,
  )
}

await main()
