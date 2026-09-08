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
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * bytes. The mount is always detached, including on failure. */
async function extractEmbeddedManifest(dmgPath) {
  const mountPoint = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-mount-'))
  execFileSync(
    'hdiutil',
    ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath],
    {
      stdio: 'ignore',
    },
  )
  try {
    const app = (await readdir(mountPoint)).find((name) => name.endsWith('.app'))
    if (app === undefined)
      throw new Error('EVIDENCE_REPORT_INVALID: the DMG carries no .app bundle')
    return await readFile(path.join(mountPoint, app, 'Contents', 'Resources', 'compatibility.json'))
  } finally {
    execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
  }
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
