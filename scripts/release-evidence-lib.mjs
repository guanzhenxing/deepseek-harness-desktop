#!/usr/bin/env node
// Deterministic release-evidence primitives: closure component collection,
// directory digests, canonical JSON, and the CycloneDX projection. Pure
// build-time derivation — this module is never a second compatibility or
// artifact authority (those stay in the policy/lockfile/artifact index).
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

/** The workspace scope: repo-authored packages ship without lockfile
 * integrity (they are not registry artifacts) and are digested from their
 * deployed files instead. */
const WORKSPACE_SCOPE = '@dsh-desktop/'

/** Codepoint order, not locale order: '%40' must sort before letters. */
function byCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function npmPurl(name, version) {
  return `pkg:npm/${name.replace(/^@/u, '%40').replace(/\//gu, '%2F')}@${version}`
}

/** Recursively key-sorted JSON with exactly one trailing newline. */
export function canonicalJson(value) {
  const serialize = (input) => {
    if (Array.isArray(input)) return `[${input.map(serialize).join(',')}]`
    if (input !== null && typeof input === 'object') {
      const keys = Object.keys(input).sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(input[key])}`).join(',')}}`
    }
    return JSON.stringify(input)
  }
  return `${serialize(value)}\n`
}

async function isRealDirectory(target) {
  const identity = await lstat(target).catch(() => undefined)
  return identity !== undefined && identity.isDirectory()
}

async function* walkFiles(root) {
  const names = (await readdir(root).catch(() => [])).sort(byCodepoints)
  for (const name of names) {
    const target = path.join(root, name)
    const identity = await lstat(target).catch(() => undefined)
    if (identity === undefined) continue
    if (identity.isDirectory()) {
      yield* walkFiles(target)
      continue
    }
    if (!identity.isFile()) {
      throw new Error(`release-evidence: ${path.relative(root, target)} is not a regular file`)
    }
    yield target
  }
}

/**
 * Deterministic directory digest: enumerate regular files in sorted
 * relative-path order, reject symlinks and special files, then feed the
 * hasher each relative path, one NUL byte, that file's lowercase hexadecimal
 * SHA-256, and one LF byte. Two byte-identical directories (by content and
 * layout) always hash equally; no timestamps or absolute paths participate.
 */
export async function directoryDigestHex(directory) {
  if (!(await isRealDirectory(directory))) {
    throw new Error(`release-evidence: not a directory: ${directory}`)
  }
  const hasher = createHash('sha256')
  for await (const file of walkFiles(directory)) {
    hasher.update(path.relative(directory, file))
    hasher.update('\0')
    hasher.update(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    )
    hasher.update('\n')
  }
  return hasher.digest('hex')
}

/**
 * A pnpm deploy closure keeps direct dependencies at node_modules top level
 * and the transitive closure under node_modules/.pnpm/<install
 * key>/node_modules/<name>. Both layers are enumerated; deduplication by
 * name@version happens in the collector (peer-suffixed install keys of one
 * package yield one component).
 */
async function* packageManifests(closureRoot) {
  const modulesRoot = path.join(closureRoot, 'node_modules')
  for (const name of await listPackageSlots(modulesRoot, '.pnpm')) {
    yield path.join(modulesRoot, name, 'package.json')
  }
  const store = path.join(modulesRoot, '.pnpm')
  for (const installKey of (await readdir(store).catch(() => [])).sort(byCodepoints)) {
    const innerRoot = path.join(store, installKey, 'node_modules')
    for (const name of await listPackageSlots(innerRoot, undefined)) {
      yield path.join(innerRoot, name, 'package.json')
    }
  }
}

/** One-level package slots ("<name>" or "<@scope>/<name>") of a node_modules
 * directory, sorted, with dot entries (and `exclude`) skipped. */
async function listPackageSlots(directory, exclude) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const slots = []
  const sorted = entries
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== exclude)
    .sort((left, right) => byCodepoints(left.name, right.name))
  for (const entry of sorted) {
    if (entry.name.startsWith('@')) {
      const inner = await readdir(path.join(directory, entry.name), {
        withFileTypes: true,
      }).catch(() => [])
      for (const nested of inner
        .filter((child) => !child.name.startsWith('.'))
        .sort((left, right) => byCodepoints(left.name, right.name))) {
        slots.push(path.join(entry.name, nested.name))
      }
      continue
    }
    slots.push(entry.name)
  }
  return slots
}

/**
 * Collect the deduplicated dependency components of the staged closure
 * roots. Registry components MUST carry lockfile integrity (joined by purl —
 * a staged package the lockfile cannot vouch for is refused); workspace
 * components are digested from their deployed files. A package instance
 * shared by both closures appears once; conflicting metadata for one purl is
 * refused; every symlinked package directory must resolve back inside one of
 * the closure roots.
 */
export async function collectClosureComponents(closureRoots, integrityByPurl) {
  const realRoots = await Promise.all(closureRoots.map((root) => realpath(root)))
  const insideAnyRoot = (resolved) =>
    realRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))

  const byPurl = new Map()
  for (const root of closureRoots) {
    for await (const manifestPath of packageManifests(root)) {
      const identity = await lstat(manifestPath).catch(() => undefined)
      if (identity === undefined) continue
      const resolved = await realpath(manifestPath)
      if (!insideAnyRoot(resolved)) {
        throw new Error(
          `release-evidence: package symlink escapes the closure roots: ${manifestPath}`,
        )
      }
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (
        typeof parsed?.name !== 'string' ||
        parsed.name === '' ||
        typeof parsed?.version !== 'string' ||
        parsed.version === ''
      ) {
        throw new Error(`release-evidence: package manifest without name/version: ${manifestPath}`)
      }
      const purl = npmPurl(parsed.name, parsed.version)
      const license =
        typeof parsed.license === 'string' && parsed.license !== '' ? parsed.license : 'NOASSERTION'
      const existing = byPurl.get(purl)
      if (existing !== undefined) {
        if (existing.license !== license) {
          throw new Error(`release-evidence: conflicting metadata for ${purl}`)
        }
        continue
      }
      byPurl.set(purl, {
        purl,
        name: parsed.name,
        version: parsed.version,
        license,
        manifestDirectory: path.dirname(resolved),
        source: parsed.name.startsWith(WORKSPACE_SCOPE) ? 'workspace' : 'registry',
        integrity: integrityByPurl.get(purl),
      })
    }
  }

  const components = [...byPurl.values()].sort((left, right) => byCodepoints(left.purl, right.purl))
  for (const component of components) {
    if (component.integrity === undefined) {
      if (component.source !== 'workspace') {
        throw new Error(
          `release-evidence: registry component without lockfile integrity: ${component.purl}`,
        )
      }
      component.integrity = `sha256-${await directoryDigestHex(component.manifestDirectory)}`
    }
  }
  return components
}

/**
 * Minimal deterministic CycloneDX 1.6 document: no timestamps, no absolute
 * paths, components sorted by purl (the caller passes them pre-sorted).
 */
export function createCycloneDx(components, subject) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: subject },
    components: [...components]
      .sort((left, right) => byCodepoints(left.purl, right.purl))
      .map((component) => ({
        type: 'library',
        'bom-ref': component.purl,
        name: component.name,
        version: component.version,
        purl: component.purl,
        licenses: [{ expression: component.license }],
        hashes: [hashOf(component.integrity)],
      })),
  }
}

function hashOf(integrity) {
  const separator = integrity.indexOf('-')
  const algorithm = integrity.slice(0, separator)
  const digest = integrity.slice(separator + 1)
  if (algorithm === 'sha512') {
    return { alg: 'SHA-512', content: Buffer.from(digest, 'base64').toString('hex') }
  }
  if (algorithm === 'sha256') {
    return { alg: 'SHA-256', content: digest }
  }
  throw new Error(`release-evidence: unsupported integrity algorithm: ${algorithm}`)
}

const LICENSE_FILE_PATTERN =
  /^(licen[cs]e|copying(?:\.[^.]+)?|notice(?:\.[^.]+)?|unlicense(?:\.[^.]+)?)$/iu

/**
 * Reviewable license inventory for the collected closure components: purl,
 * declared SPDX expression (or NOASSERTION), the sorted in-package license
 * filenames, and each file's SHA-256. Full license text is never embedded
 * and no license is ever inferred from a package name — an undeclared
 * license is NOASSERTION, full stop. A license entry that is a symlink (or
 * anything but a regular file) is refused: the digest must be of bytes that
 * actually shipped inside the package.
 */
export async function createLicenseInventory(components, closureRoots) {
  const realRoots = await Promise.all(closureRoots.map((root) => realpath(root)))
  const insideAnyRoot = (resolved) =>
    realRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))

  const entries = []
  for (const component of components) {
    const files = []
    const digests = {}
    const names = (await readdir(component.manifestDirectory).catch(() => [])).sort(byCodepoints)
    for (const name of names) {
      if (!LICENSE_FILE_PATTERN.test(name)) continue
      const target = path.join(component.manifestDirectory, name)
      const identity = await lstat(target)
      if (!identity.isFile()) {
        throw new Error(
          `release-evidence: license entry is a symlink: ${name} in ${component.purl}`,
        )
      }
      const resolved = await realpath(target)
      if (!insideAnyRoot(resolved)) {
        throw new Error(`release-evidence: license path escapes the closure roots: ${name}`)
      }
      files.push(name)
      digests[name] = createHash('sha256')
        .update(await readFile(target))
        .digest('hex')
    }
    entries.push({
      purl: component.purl,
      declared: component.license,
      files,
      sha256: digests,
    })
  }
  entries.sort((left, right) => byCodepoints(left.purl, right.purl))
  return { schemaVersion: 1, components: entries }
}

const REPORT_KEYS = [
  'schemaVersion',
  'releaseId',
  'sourceCommit',
  'artifact',
  'compatibilityManifestSha256',
  'runtimes',
  'evidence',
]
const HEX64 = /^[0-9a-f]{64}$/u
const HEX40 = /^[0-9a-f]{40}$/u

function failEvidence(code, detail) {
  throw new Error(`EVIDENCE_${code}: ${detail}`)
}

function assertExactKeys(value, keys, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failEvidence('REPORT_INVALID', `${where} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    failEvidence(
      'REPORT_INVALID',
      `${where} fields ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    )
  }
}

function scanForAbsolutePaths(value, where) {
  if (typeof value === 'string') {
    if (value.startsWith('/')) {
      failEvidence('REPORT_INVALID', `absolute path in ${where}: ${value}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForAbsolutePaths(entry, `${where}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) scanForAbsolutePaths(entry, `${where}.${key}`)
  }
}

/** Assemble the unified release-evidence report. The shape is closed: this
 * constructor is the only producer, and verifyReleaseEvidence rejects any
 * field it does not know. */
export function createReleaseEvidence(input) {
  return {
    schemaVersion: 1,
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    artifact: {
      sha256: input.artifact.sha256,
      platform: input.artifact.platform,
      arch: input.artifact.arch,
    },
    compatibilityManifestSha256: input.compatibilityManifestSha256,
    runtimes: {
      node: input.runtimes.node,
      electron: input.runtimes.electron,
      dsh: input.runtimes.dsh,
    },
    evidence: {
      sbom: { file: 'sbom.cdx.json', sha256: input.sbomSha256 },
      licenses: { file: 'licenses.json', sha256: input.licensesSha256 },
      packageSmoke: {
        file: '../package-smoke.json',
        sha256: input.packageSmoke.sha256,
        passed: input.packageSmoke.passed,
        scenarioCount: input.packageSmoke.scenarioCount,
      },
    },
  }
}

/**
 * Verify that one release-evidence report and its referenced inputs all
 * describe the SAME candidate: release id, source commit, DMG digest,
 * platform/architecture, embedded compatibility manifest, runtime versions,
 * smoke result, and the digests of every evidence file. Any disagreement
 * throws with a specific EVIDENCE_* code; a clean pass returns {ok: true}.
 */
export function verifyReleaseEvidence(input) {
  const report = input.report
  assertExactKeys(report, REPORT_KEYS, 'report')
  if (report.schemaVersion !== 1) {
    failEvidence('REPORT_INVALID', `schemaVersion ${report.schemaVersion} != 1`)
  }
  scanForAbsolutePaths(report, 'report')
  assertExactKeys(report.artifact, ['sha256', 'platform', 'arch'], 'artifact')
  assertExactKeys(report.runtimes, ['node', 'electron', 'dsh'], 'runtimes')
  assertExactKeys(report.evidence, ['sbom', 'licenses', 'packageSmoke'], 'evidence')
  assertExactKeys(report.evidence.sbom, ['file', 'sha256'], 'evidence.sbom')
  assertExactKeys(report.evidence.licenses, ['file', 'sha256'], 'evidence.licenses')
  assertExactKeys(
    report.evidence.packageSmoke,
    ['file', 'sha256', 'passed', 'scenarioCount'],
    'evidence.packageSmoke',
  )
  for (const digest of [
    report.artifact.sha256,
    report.compatibilityManifestSha256,
    report.evidence.sbom.sha256,
    report.evidence.licenses.sha256,
    report.evidence.packageSmoke.sha256,
  ]) {
    if (!HEX64.test(digest)) failEvidence('REPORT_INVALID', `digest is not sha256 hex: ${digest}`)
  }
  if (!HEX40.test(report.sourceCommit)) {
    failEvidence('REPORT_INVALID', `sourceCommit is not a 40-hex commit: ${report.sourceCommit}`)
  }
  if (!report.releaseId.endsWith(`-${report.sourceCommit.slice(0, 7)}`)) {
    failEvidence(
      'REPORT_INVALID',
      `releaseId ${report.releaseId} does not bind sourceCommit ${report.sourceCommit}`,
    )
  }

  const manifest = input.embeddedManifest
  if (manifest.releaseId !== report.releaseId) {
    failEvidence(
      'REPORT_INVALID',
      `embedded manifest releaseId ${manifest.releaseId} != ${report.releaseId}`,
    )
  }
  if (manifest.sourceCommit !== report.sourceCommit) {
    failEvidence('REPORT_INVALID', `embedded manifest sourceCommit != report sourceCommit`)
  }
  if (report.runtimes.dsh !== manifest.dsh.npmVersion) {
    failEvidence(
      'REPORT_INVALID',
      `runtimes.dsh ${report.runtimes.dsh} != manifest ${manifest.dsh.npmVersion}`,
    )
  }

  const record = input.artifactRecords.find((entry) => entry.releaseId === report.releaseId)
  if (record === undefined) {
    failEvidence('REPORT_INVALID', `artifact index has no record for ${report.releaseId}`)
  }
  if (record.arch !== report.artifact.arch || record.platform !== report.artifact.platform) {
    failEvidence(
      'ARCH_MISMATCH',
      `report ${report.artifact.platform}/${report.artifact.arch} vs artifact ${record.platform}/${record.arch}`,
    )
  }
  if (record.sha256 !== report.artifact.sha256 || input.dmgDigest !== record.sha256) {
    failEvidence(
      'ARTIFACT_DIGEST_MISMATCH',
      `DMG digest does not match the record for ${report.releaseId}`,
    )
  }

  const smoke = input.packageSmoke
  if (smoke.candidate.releaseId !== report.releaseId) {
    failEvidence(
      'SMOKE_RELEASE_MISMATCH',
      `smoke report binds ${smoke.candidate.releaseId}, evidence binds ${report.releaseId}`,
    )
  }
  if (!report.evidence.packageSmoke.passed || smoke.results.some((entry) => entry.ok !== true)) {
    failEvidence('SMOKE_FAILED', 'the packaged smoke report holds a failed scenario')
  }
  if (report.evidence.packageSmoke.scenarioCount !== smoke.results.length) {
    failEvidence(
      'REPORT_INVALID',
      `scenarioCount ${report.evidence.packageSmoke.scenarioCount} != ${smoke.results.length}`,
    )
  }

  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const smokeBytes = Buffer.isBuffer(smoke) ? smoke : Buffer.from(canonicalJson(smoke).trimEnd())
  for (const [name, bytes] of [
    ['sbom', input.sbom],
    ['licenses', input.licenses],
    ['packageSmoke', smokeBytes],
  ]) {
    if (bytes === undefined) {
      failEvidence('COMPONENT_MISSING', `evidence component absent: ${name}`)
    }
    if (sha256(bytes) !== report.evidence[name].sha256) {
      failEvidence('COMPONENT_DIGEST_MISMATCH', `evidence component digest mismatch: ${name}`)
    }
  }
  return { ok: true }
}

/**
 * Gather the identity inputs for the unified report from the repository's
 * authoritative facts: the artifact index record for this machine's arch,
 * the generated compatibility manifest, the launcher's pinned Electron, the
 * bundled Node binary, and the packaged smoke report. Pure derivation — no
 * fact is invented here.
 */
export async function gatherEvidenceIdentity(input) {
  const { repositoryRoot, evidenceDirectory } = input
  const { readFile } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

  const artifacts = await readJson(path.join(repositoryRoot, 'release', 'artifacts.json'))
  const record = artifacts.find((entry) => entry.arch === process.arch)
  if (record === undefined) {
    throw new Error(
      `release-evidence: no ${process.arch} artifact record in release/artifacts.json`,
    )
  }
  const manifest = await readJson(path.join(repositoryRoot, 'release', 'compatibility.json'))
  const launcher = await readJson(
    path.join(repositoryRoot, 'apps', 'desktop-launcher', 'package.json'),
  )
  const nodeVersion = execFileSync(
    path.join(repositoryRoot, 'release', 'staging', 'runtime-cli', 'node', 'bin', 'node'),
    ['--version'],
  )
    .toString()
    .trim()

  const smokeBytes = await readFile(path.join(repositoryRoot, 'release', 'package-smoke.json'))
  const smoke = JSON.parse(smokeBytes)
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

  return {
    releaseId: record.releaseId,
    sourceCommit: manifest.sourceCommit,
    artifact: { sha256: record.sha256, platform: record.platform, arch: record.arch },
    compatibilityManifestSha256: record.compatibilityManifestSha256,
    runtimes: {
      node: nodeVersion.replace(/^v/u, ''),
      electron: launcher.devDependencies.electron,
      dsh: manifest.dsh.npmVersion,
    },
    sbomSha256: sha256(await readFile(path.join(evidenceDirectory, 'sbom.cdx.json'))),
    licensesSha256: sha256(await readFile(path.join(evidenceDirectory, 'licenses.json'))),
    packageSmoke: {
      sha256: sha256(smokeBytes),
      passed: smoke.results.every((entry) => entry.ok === true),
      scenarioCount: smoke.results.length,
    },
  }
}
