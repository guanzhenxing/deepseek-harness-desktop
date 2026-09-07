#!/usr/bin/env node
// Synthetic plugin-intake validation: a declarative record plus the exact
// bundle bytes, checked against the accepted release manifest before any
// staging happens. Intake is REVIEW AND VALIDATION ONLY — it never installs
// or enables a plugin for a user, and this module never writes a profile.
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const HEX40 = /^[0-9a-f]{40}$/u
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'prepack',
  'prepublishOnly',
])

function reject(code, detail) {
  throw new Error(`PLUGIN_INTAKE_${code}: ${detail}`)
}

/** Deterministic bundle digest: regular files in sorted relative-path order
 * (rejecting symlinks and special files), feeding the hasher each relative
 * path, one NUL byte, the file's lowercase hexadecimal SHA-256, and one LF
 * byte. Top-level `*.intake.json` records are excluded — a record that
 * declares its own digest must not be part of what it vouches for. The
 * result is `sha256-<base64url>`; an empty bundle digests to the well-known
 * empty-payload constant. */
export async function bundleDigest(bundleRoot) {
  const hasher = createHash('sha256')
  const digestFile = async (directory, relative) => {
    hasher.update(relative)
    hasher.update('\0')
    hasher.update(
      createHash('sha256')
        .update(await readFile(path.join(directory, relative)))
        .digest('hex'),
    )
    hasher.update('\n')
  }
  const walk = async (directory, prefix) => {
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort(
      (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const identity = await lstat(path.join(directory, relative))
      if (identity.isDirectory()) {
        await walk(directory, relative)
        continue
      }
      if (!identity.isFile()) {
        reject('UNSAFE_BUNDLE', `${relative} is not a regular file`)
      }
      if (prefix === '' && /\.intake\.json$/u.test(entry.name)) continue
      await digestFile(directory, relative)
    }
  }
  const rootIdentity = await lstat(bundleRoot).catch(() => undefined)
  if (rootIdentity === undefined || !rootIdentity.isDirectory()) {
    reject('UNSAFE_BUNDLE', `bundle root is not a directory: ${bundleRoot}`)
  }
  await walk(bundleRoot, '')
  return `sha256-${hasher.digest('base64url')}`
}

/**
 * Validate one plugin-intake record against the exact bundle bytes and the
 * accepted release manifest. Returns a frozen normalized record on success;
 * every disagreement rejects with a PLUGIN_INTAKE_* code. Pure: no profile,
 * home, or user data is touched.
 */
export async function validatePluginIntake(record, bundleRoot, releaseManifest) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    reject('RECORD_INVALID', 'record must be an object')
  }
  if (record.schemaVersion !== 1) {
    reject('RECORD_INVALID', `schemaVersion ${JSON.stringify(record.schemaVersion)} != 1`)
  }
  if (typeof record.package !== 'string' || record.package === '') {
    reject('RECORD_INVALID', 'package must be a non-empty string')
  }
  if (typeof record.version !== 'string' || record.version === '') {
    reject('RECORD_INVALID', 'version must be a non-empty string')
  }
  if (typeof record.license !== 'string' || record.license === '') {
    reject('RECORD_INVALID', 'license (SPDX declaration) is required')
  }
  if (
    !Array.isArray(record.capabilities) ||
    record.capabilities.some((entry) => typeof entry !== 'string' || entry === '')
  ) {
    reject('RECORD_INVALID', 'capabilities must be an array of non-empty strings')
  }
  if (
    typeof record.source !== 'object' ||
    record.source === null ||
    record.source.kind !== 'repository' ||
    !HEX40.test(record.source.commit ?? '')
  ) {
    reject('UNKNOWN_SOURCE', 'source must be a repository with a 40-hex commit')
  }

  const manifestBytes = await readFile(path.join(bundleRoot, 'package.json'), 'utf8')
  const bundle = JSON.parse(manifestBytes)
  if (bundle.name !== record.package) {
    reject('IDENTITY_DRIFT', `bundle name ${bundle.name} != record ${record.package}`)
  }
  if (bundle.version !== record.version) {
    reject('VERSION_DRIFT', `bundle version ${bundle.version} != record ${record.version}`)
  }
  if (bundle.dsh?.bundle?.patch === undefined) {
    reject('RECORD_INVALID', 'bundle does not declare a dsh.bundle patch (not a plugin bundle)')
  }

  const digest = await bundleDigest(bundleRoot)
  if (record.integrity !== digest) {
    reject('DIGEST_DRIFT', `record integrity ${record.integrity} != bundle bytes ${digest}`)
  }

  const singletons = releaseManifest.pluginApi?.singletonPackages ?? []
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(bundle[field] ?? {})) {
      if (singletons.includes(name)) {
        reject(
          'SINGLETON_DEPENDENCY',
          `${name} is a release singleton; a bundle must not ship its own copy`,
        )
      }
    }
  }
  for (const name of Object.keys(bundle.scripts ?? {})) {
    if (LIFECYCLE_SCRIPTS.has(name)) {
      reject('LIFECYCLE_SCRIPT', `bundle declares the install lifecycle script ${name}`)
    }
  }

  const currentPlatform = `${process.platform}-${process.arch}`
  if (
    !Array.isArray(record.validatedPlatforms) ||
    record.validatedPlatforms.length === 0 ||
    !record.validatedPlatforms.includes(currentPlatform)
  ) {
    reject('NO_PACKAGED_EVIDENCE', `no packaged evidence for ${currentPlatform}`)
  }

  return Object.freeze({
    schemaVersion: 1,
    package: record.package,
    version: record.version,
    source: Object.freeze({ kind: 'repository', commit: record.source.commit }),
    integrity: digest,
    license: record.license,
    capabilities: Object.freeze([...record.capabilities]),
    validatedPlatforms: Object.freeze([...record.validatedPlatforms]),
  })
}
