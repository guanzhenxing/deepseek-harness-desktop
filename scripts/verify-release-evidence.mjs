#!/usr/bin/env node
// Verify the unified release-evidence projection against the repository's
// authoritative facts: the artifact index, the generated compatibility
// manifest (by bytes), the DMG itself (recomputed digest), and the packaged
// smoke report. Every disagreement exits 1 with a specific EVIDENCE_* code.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyReleaseEvidence } from './release-evidence-lib.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDirectory = path.join(repositoryRoot, 'release', 'evidence')

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function main() {
  const report = await readJson(path.join(evidenceDirectory, 'release-evidence.json'))
  const artifacts = await readJson(path.join(repositoryRoot, 'release', 'artifacts.json'))
  const manifestBytes = await readFile(path.join(repositoryRoot, 'release', 'compatibility.json'))
  const manifest = JSON.parse(manifestBytes)
  const smokeBytes = await readFile(path.join(repositoryRoot, 'release', 'package-smoke.json'))

  const record = artifacts.find((entry) => entry.releaseId === report.releaseId)
  if (record === undefined) {
    throw new Error(`EVIDENCE_REPORT_INVALID: no artifact record for ${report.releaseId}`)
  }
  const dmgPath = path.resolve(repositoryRoot, record.file)
  const dmgDigest = createHash('sha256')
    .update(await readFile(dmgPath))
    .digest('hex')

  const result = verifyReleaseEvidence({
    report,
    sbom: await readFile(path.join(evidenceDirectory, report.evidence.sbom.file)),
    licenses: await readFile(path.join(evidenceDirectory, report.evidence.licenses.file)),
    packageSmoke: smokeBytes,
    artifactRecords: artifacts,
    dmgDigest,
    embeddedManifest: manifest,
  })

  if (result.ok !== true) throw new Error('EVIDENCE_REPORT_INVALID: verification returned no ok')
  if (
    report.compatibilityManifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex')
  ) {
    throw new Error('EVIDENCE_MANIFEST_MISMATCH: report digest != release/compatibility.json bytes')
  }
  if (
    record.compatibilityManifestSha256 !== undefined &&
    record.compatibilityManifestSha256 !== report.compatibilityManifestSha256
  ) {
    throw new Error('EVIDENCE_MANIFEST_MISMATCH: artifact record manifest digest != report')
  }
  console.log(
    `verify-release-evidence: ${report.releaseId} — sbom, licenses, smoke, DMG, and manifest all bind one candidate`,
  )
}

try {
  await main()
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(1)
}
