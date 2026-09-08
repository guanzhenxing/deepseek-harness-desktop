#!/usr/bin/env node
// Verify the unified release-evidence projection against the repository's
// authoritative facts. The compatibility manifest is extracted FROM THE DMG
// itself (mounted read-only): the release/ tree alone cannot prove which
// manifest shipped. Evidence files are read by their schema constants —
// never by report-supplied paths. Runtime versions are re-measured, not
// trusted from the report. Every disagreement exits 1 with an EVIDENCE_* code.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRODUCT } from '../packages/product-config/lib/index.js'
import { verifyReleaseEvidence } from './release-evidence-lib.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDirectory = path.join(repositoryRoot, 'release', 'evidence')
const EVIDENCE_FILES = {
  sbom: 'sbom.cdx.json',
  licenses: 'licenses.json',
  packageSmoke: path.join(repositoryRoot, 'release', 'package-smoke.json'),
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Mount the DMG read-only and return the embedded compatibility manifest
 * bytes. The mount is always detached and the temporary mount directory
 * removed, including on failure paths. */
async function extractEmbeddedManifest(dmgPath) {
  const mountPoint = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-mount-'))
  let detachError
  let embeddedBytes
  try {
    execFileSync(
      'hdiutil',
      ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath],
      {
        stdio: 'ignore',
      },
    )
    // Pin the product-named bundle and refuse decoys: a first-match .app
    // would let a pristine decoy vouch for a tampered product bundle.
    const apps = (await readdir(mountPoint)).filter((name) => name.endsWith('.app'))
    const expectedApp = `${PRODUCT.name}.app`
    if (apps.length !== 1 || apps[0] !== expectedApp) {
      throw new Error(
        `EVIDENCE_REPORT_INVALID: the DMG root must carry exactly ${JSON.stringify(expectedApp)} ` +
          `(found: ${apps.length === 0 ? 'no .app' : apps.join(', ')})`,
      )
    }
    embeddedBytes = await readFile(
      path.join(mountPoint, expectedApp, 'Contents', 'Resources', 'compatibility.json'),
    )
  } finally {
    // Always attempt the detach by mount point — an attach that errored may
    // still have mounted before failing. Only a detached (or provably never
    // mounted, i.e. empty) mount point may be deleted; never rm through an
    // active mount. hdiutil can transiently refuse while Finder has the
    // volume open, so retry a few times before surfacing the failure.
    let detached = false
    for (let attempt = 0; attempt < 3 && !detached; attempt += 1) {
      try {
        execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
        detached = true
        detachError = undefined
      } catch (error) {
        detachError = error
      }
    }
    if (detached) {
      await rm(mountPoint, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } else {
      const leftovers = await readdir(mountPoint).catch(() => undefined)
      if (leftovers !== undefined && leftovers.length === 0) {
        // Nothing ever mounted here; the scratch directory is safe to remove.
        await rm(mountPoint, { recursive: true, force: true })
      }
    }
  }
  if (detachError !== undefined) throw detachError
  return embeddedBytes
}

async function main() {
  const report = await readJson(path.join(evidenceDirectory, 'release-evidence.json'))
  const artifacts = await readJson(path.join(repositoryRoot, 'release', 'artifacts.json'))
  const smokeBytes = await readFile(EVIDENCE_FILES.packageSmoke)

  const record = artifacts.find((entry) => entry.releaseId === report.releaseId)
  if (record === undefined) {
    throw new Error(`EVIDENCE_REPORT_INVALID: no artifact record for ${report.releaseId}`)
  }
  const dmgPath = path.resolve(repositoryRoot, record.file)
  const dmgDigest = sha256(await readFile(dmgPath))

  const embeddedBytes = await extractEmbeddedManifest(dmgPath)
  if (sha256(embeddedBytes) !== report.compatibilityManifestSha256) {
    throw new Error(
      'EVIDENCE_MANIFEST_MISMATCH: report digest != the manifest extracted from the DMG',
    )
  }
  if (
    record.compatibilityManifestSha256 !== undefined &&
    record.compatibilityManifestSha256 !== report.compatibilityManifestSha256
  ) {
    throw new Error('EVIDENCE_MANIFEST_MISMATCH: artifact record manifest digest != report')
  }
  const embeddedManifest = JSON.parse(embeddedBytes)

  const launcher = await readJson(
    path.join(repositoryRoot, 'apps', 'desktop-launcher', 'package.json'),
  )
  const nodeVersion = execFileSync(
    path.join(repositoryRoot, 'release', 'staging', 'runtime-cli', 'node', 'bin', 'node'),
    ['--version'],
  )
    .toString()
    .trim()
    .replace(/^v/u, '')

  verifyReleaseEvidence({
    report,
    sbom: await readFile(path.join(evidenceDirectory, EVIDENCE_FILES.sbom)),
    licenses: await readFile(path.join(evidenceDirectory, EVIDENCE_FILES.licenses)),
    packageSmoke: smokeBytes,
    artifactRecords: artifacts,
    dmgDigest,
    embeddedManifest,
    expectedRuntimes: { node: nodeVersion, electron: launcher.devDependencies.electron },
  })

  console.log(
    `verify-release-evidence: ${report.releaseId} — sbom, licenses, smoke, DMG, and the DMG-embedded manifest all bind one candidate`,
  )
}

try {
  await main()
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(1)
}
