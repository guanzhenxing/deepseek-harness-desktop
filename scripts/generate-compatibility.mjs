#!/usr/bin/env node
// Generate the release compatibility manifest (schema 2) from pinned inputs:
//
//   docs/compatibility.json        source baseline facts (single source of
//                                  truth for DSH tag/commit/npm version)
//   build/compatibility-policy.json tested format/plugin-API policy with
//                                  machine-checkable evidence
//   build/upstream-artifacts.json  npm/toolchain provenance for the pinned
//                                  upstream artifacts
//   pnpm-lock.yaml                 full dependency closure (name, version,
//                                  integrity, virtual-store relativePath)
//   patches/manifest.json          local patch ledger (empty array = no
//                                  patches; its canonical digest enters the
//                                  manifest)
//
// Determinism: identical inputs produce byte-identical manifest content (no
// timestamps). The releaseId binds desktopVersion, platform, arch and the
// source commit; the manifest's own digests bind the inputs.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(scriptDir, '..')

export class CompatibilityInputError extends Error {}

// ---------------------------------------------------------------------------
// Lockfile closure records
// ---------------------------------------------------------------------------

/**
 * Extract the dependency closure records from a pnpm v9 lockfile: every
 * registry-resolved package with its integrity and the virtual-store
 * relativePath it occupies in a deployed tree. Sorting is by name then
 * version so the record list — and therefore its SHA-256 — is deterministic.
 *
 * Deliberately a full-lockfile view: any change to the shipped runtime
 * closure necessarily changes this set, while dev-only changes are a
 * conservative digest bump. Semantic shipped-closure checks (singleton
 * versions, DSH baseline uniformity, staged trees) live in
 * scripts/verify-dsh-closure.mjs.
 */
export function closureRecordsFromLockfile(lockfileText) {
  const lines = lockfileText.split('\n')
  const packagesHeader = lines.findIndex((line) => line === 'packages:')
  if (packagesHeader === -1) {
    throw new CompatibilityInputError('lockfile has no packages: section')
  }
  // pnpm v9 suffixes keys with their peer resolutions —
  // `name@version(peer@version)(...)`. The suffix must be stripped before the
  // name/version split, or suffixed keys parse into garbage names and (for
  // @deepseek-ai/dsh* keys) silently escape the baseline drift check. The
  // same name@version can appear both plain and suffixed; both describe one
  // installed package, so the records are deduplicated by name@version.
  const records = []
  const seen = new Set()
  let current = undefined
  for (const line of lines.slice(packagesHeader + 1)) {
    if (/^\S/.test(line)) break // next top-level section
    const entry = /^ {2}('(.*)'|[^:\s]+):$/.exec(line)
    if (entry !== null) {
      if (current !== undefined) records.push(current)
      const rawKey = entry[2] ?? entry[1]
      const paren = rawKey.indexOf('(')
      const key = paren >= 0 ? rawKey.slice(0, paren) : rawKey
      const separator = key.lastIndexOf('@')
      if (separator <= 0) {
        throw new CompatibilityInputError(`lockfile package key has no version split: ${rawKey}`)
      }
      const name = key.slice(0, separator)
      const version = key.slice(separator + 1)
      current = { name, version, seenKey: `${name}@${version}`, integrity: undefined }
      continue
    }
    if (current === undefined) continue
    const integrity = /^ {4}resolution: \{integrity: (\S+)\}$/.exec(line)
    if (integrity !== null) current.integrity = integrity[1]
  }
  if (current !== undefined) records.push(current)
  const complete = []
  for (const record of records) {
    if (record.integrity === undefined) continue // reported below via the deduped view
    if (seen.has(record.seenKey)) continue
    seen.add(record.seenKey)
    complete.push({
      name: record.name,
      version: record.version,
      integrity: record.integrity,
      relativePath: `node_modules/.pnpm/${record.name.replace('/', '+')}@${record.version}/node_modules/${record.name}`,
    })
  }
  const incomplete = records.filter((record) => record.integrity === undefined)
  if (incomplete.length > 0) {
    throw new CompatibilityInputError(
      `lockfile packages without a registry integrity: ${incomplete
        .slice(0, 5)
        .map((record) => `${record.name}@${record.version}`)
        .join(', ')}`,
    )
  }
  return complete.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  )
}

export function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// ---------------------------------------------------------------------------
// Policy evidence
// ---------------------------------------------------------------------------

const UPSTREAM_COMMIT_PATTERN = /^upstream:([0-9a-f]{40})$/

async function resolveNpmPackageFile(packageRef, relativeFile) {
  const at = packageRef.lastIndexOf('@')
  const name = packageRef.slice(0, at)
  const store = path.join(repositoryRoot, 'node_modules', '.pnpm')
  const prefix = `${name.replace('/', '+')}@${packageRef.slice(at + 1)}`
  let entries
  try {
    entries = await readdir(store)
  } catch {
    throw new CompatibilityInputError('node_modules/.pnpm is missing; run pnpm install first')
  }
  const match = entries.find((entry) => entry === prefix || entry.startsWith(`${prefix}_`))
  if (match === undefined) {
    throw new CompatibilityInputError(`evidence package ${packageRef} is not installed`)
  }
  return path.join(store, match, 'node_modules', name, relativeFile)
}

/**
 * Machine-check every evidence claim in the policy: installed package files
 * exist, fixtures hash to the pinned digest, upstream commits equal the
 * baseline, and referenced repository files exist.
 */
export async function verifyPolicyEvidence(policy, { upstreamCommit, root = repositoryRoot }) {
  for (const format of policy.formats) {
    for (const evidence of format.evidence) {
      if (evidence.startsWith('fixture:')) {
        const hash = /^fixture:(.+)#([0-9a-f]{64})$/.exec(evidence)
        if (hash === null) {
          throw new CompatibilityInputError(`malformed fixture evidence: ${evidence}`)
        }
        const bytes = await readFile(path.join(root, hash[1])).catch(() => {
          throw new CompatibilityInputError(`fixture evidence missing: ${hash[1]}`)
        })
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== hash[2]) {
          throw new CompatibilityInputError(
            `fixture ${hash[1]} hashes to ${digest}, policy pins ${hash[2]}`,
          )
        }
      } else if (evidence.startsWith('npm:')) {
        const parsed = /^npm:(.+):(.+)$/.exec(evidence)
        if (parsed === null) {
          throw new CompatibilityInputError(`malformed npm evidence: ${evidence}`)
        }
        const file = await resolveNpmPackageFile(parsed[1], parsed[2])
        if (!existsSync(file)) {
          throw new CompatibilityInputError(
            `npm evidence file does not exist: ${parsed[1]}:${parsed[2]}`,
          )
        }
      } else if (evidence.startsWith('upstream:')) {
        const claim = UPSTREAM_COMMIT_PATTERN.exec(evidence)
        if (claim === null) {
          throw new CompatibilityInputError(`malformed upstream evidence: ${evidence}`)
        }
        if (claim[1] !== upstreamCommit) {
          throw new CompatibilityInputError(
            `evidence cites upstream commit ${claim[1]}, baseline is ${upstreamCommit}`,
          )
        }
      } else if (evidence.startsWith('repo:')) {
        const file = path.join(root, evidence.slice('repo:'.length))
        if (!existsSync(file)) {
          throw new CompatibilityInputError(`repo evidence missing: ${evidence}`)
        }
      } else {
        throw new CompatibilityInputError(`unknown evidence scheme: ${evidence}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------

function refuse(condition, message) {
  if (condition) throw new CompatibilityInputError(message)
}

/**
 * Assemble the release manifest from the pinned inputs. Pure: same inputs in,
 * same manifest object out. Every input disagreement (docs vs upstream
 * artifacts vs policy) refuses here — the generator never papers over
 * divergent version facts.
 */
export function buildReleaseManifest(input) {
  const { docsCompatibility, policy, upstreamArtifacts, records, patchLedger } = input
  const dsh = docsCompatibility.dsh
  refuse(dsh === undefined, 'docs/compatibility.json has no dsh facts')
  refuse(
    upstreamArtifacts.dsh.tag !== dsh.tag ||
      upstreamArtifacts.dsh.commit !== dsh.commit ||
      upstreamArtifacts.dsh.npmVersion !== dsh.npmVersion,
    'build/upstream-artifacts.json and docs/compatibility.json disagree on the DSH baseline',
  )
  const dshPackage = upstreamArtifacts.dsh.packages.find(
    (entry) => entry.name === '@deepseek-ai/dsh',
  )
  refuse(dshPackage === undefined, 'upstream artifacts lack the @deepseek-ai/dsh entrypoint')
  refuse(
    dshPackage.version !== dsh.npmVersion,
    'upstream artifacts pin a different @deepseek-ai/dsh version than docs/compatibility.json',
  )
  refuse(
    policy.pluginApi.singletonPackages.includes('@deepseek-ai/dsh') === false,
    'policy plugin API singletons must include @deepseek-ai/dsh',
  )
  for (const format of policy.formats) {
    if (format.provider.startsWith('@deepseek-ai/dsh')) {
      refuse(
        format.providerVersion !== dsh.npmVersion,
        `format ${format.formatId} cites provider version ${format.providerVersion}, baseline is ${dsh.npmVersion}`,
      )
    }
  }
  const patchLedgerRecord =
    patchLedger === undefined ? { schemaVersion: 1, patches: [] } : patchLedger
  refuse(
    patchLedgerRecord.schemaVersion !== 1 || !Array.isArray(patchLedgerRecord.patches),
    'patches/manifest.json must be a schema-1 ledger with a patches array',
  )

  return {
    schemaVersion: 2,
    releaseId: input.releaseId,
    desktopVersion: input.desktopVersion,
    sourceCommit: input.sourceCommit,
    dsh: { tag: dsh.tag, commit: dsh.commit, npmVersion: dsh.npmVersion },
    platform: input.platform,
    arch: input.arch,
    hostControl: {
      major: docsCompatibility.hostControl.major,
      minor: docsCompatibility.hostControl.minor,
    },
    profileSchemaVersion: docsCompatibility.profile.schemaVersion,
    pluginApi: {
      strategy: policy.pluginApi.strategy,
      dshVersion: dsh.npmVersion,
      singletonPackages: [...policy.pluginApi.singletonPackages],
    },
    formats: policy.formats.map((format) => ({
      provider: format.provider,
      providerVersion: format.providerVersion,
      formatId: format.formatId,
      readable: [...format.readable],
      writable: format.writable,
      evidence: [...format.evidence],
    })),
    dataEpoch: policy.dataEpoch,
    supportedDataEpochs: [...policy.supportedDataEpochs],
    dependencyClosureSha256: canonicalSha256(records),
    patchManifestSha256: canonicalSha256(patchLedgerRecord),
  }
}

/**
 * Merge the runtime facts a staged tree knows (executable name, app id,
 * Electron/Node/pnpm versions, per-closure store digests) around the release
 * core. Extras are appended so the release facts keep their documented order.
 */
export function embedRuntimeFacts(releaseManifest, runtimeFacts) {
  return { ...releaseManifest, ...runtimeFacts }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function gatherInputs() {
  const readJson = async (relative) =>
    JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'))
  const docsCompatibility = await readJson('docs/compatibility.json')
  const policy = await readJson('build/compatibility-policy.json')
  const upstreamArtifacts = await readJson('build/upstream-artifacts.json')
  const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
  const records = closureRecordsFromLockfile(lockfile)
  const patchLedger = existsSync(path.join(repositoryRoot, 'patches', 'manifest.json'))
    ? await readJson(path.join('patches', 'manifest.json'))
    : undefined
  await verifyPolicyEvidence(policy, { upstreamCommit: docsCompatibility.dsh.commit })
  return { docsCompatibility, policy, upstreamArtifacts, records, patchLedger }
}

export async function generateReleaseManifest({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const { execFileSync } = await import('node:child_process')
  const inputs = await gatherInputs()
  const rootManifest = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  const desktopVersion = JSON.parse(rootManifest).version
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  const commitShort = sourceCommit.slice(0, 7)
  // From v0.1.0 onward the prefix IS the shipped version, not a milestone
  // label (the m4- prefix was retired at the v0.1.0 release-engineering
  // decision the rc.1 acceptance deferred here).
  const releaseId = `v${desktopVersion}-${platform}-${arch}-${commitShort}`
  return buildReleaseManifest({
    ...inputs,
    releaseId,
    desktopVersion,
    sourceCommit,
    platform,
    arch,
  })
}

export async function main() {
  const manifest = await generateReleaseManifest()
  const output = path.join(repositoryRoot, 'release', 'compatibility.json')
  await writeFile(output, `${JSON.stringify(manifest, undefined, 2)}\n`)
  console.log(`generate-compatibility: wrote ${path.relative(repositoryRoot, output)}`)
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}
