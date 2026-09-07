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
  return components.map(({ manifestDirectory, ...component }) => component)
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
