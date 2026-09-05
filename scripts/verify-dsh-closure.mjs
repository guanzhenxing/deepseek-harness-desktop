#!/usr/bin/env node
// Enforce the DSH dependency closure on the sources the packaging pipeline
// consumes (lockfile + workspace manifests + policy declarations):
//
//   - every @deepseek-ai/dsh* package in the lockfile resolves to exactly the
//     declared baseline npm version — one DSH baseline, no drift;
//   - workspace dependency specifiers on DSH packages are exact pins (a
//     floating range that no override pins would silently drift);
//   - the watched singletons (React, Cordis, dsh) have exactly one version in
//     the whole closure — a second Cordis/React would fork the Host runtime;
//   - independently versioned packages (Cordis et al.) match the version their
//     provenance declaration records — they are never inferred from the
//     @deepseek-ai scope;
//   - workspace overrides touching @deepseek-ai packages pin exact versions;
//   - the release manifest's dependencyClosureSha256 (when the manifest has
//     been generated) is bound to the current lockfile records.
//
// The staged reality (singletons per closure, anchor resolution from the Host
// runner / normal / safe bundles / CLI entry, symlink escapes, native ABI,
// web assets) is enforced by scripts/verify-runtime-tree.mjs at packaging
// time; this module is its lockfile-side counterpart and needs no staging.
//
// Usage: node scripts/verify-dsh-closure.mjs
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canonicalSha256,
  closureRecordsFromLockfile,
  repositoryRoot,
} from './generate-compatibility.mjs'

const DSH_SCOPE = '@deepseek-ai/dsh'

function isDshRuntimePackage(name) {
  return name === DSH_SCOPE || name.startsWith(`${DSH_SCOPE}-`)
}

/** Exact-pin shape: starts with a digit, no range/wildcard/workspace syntax. */
function isExactVersion(specifier) {
  return /^[0-9]/.test(specifier) && !/[\s|^><*]/.test(specifier)
}

export function findDshBaselineDrift(records, baselineNpmVersion) {
  return records
    .filter((entry) => isDshRuntimePackage(entry.name) && entry.version !== baselineNpmVersion)
    .map((entry) => ({ name: entry.name, version: entry.version }))
}

export function findFloatingDshSpecifiers(workspaceManifests) {
  const floating = []
  for (const manifest of workspaceManifests) {
    for (const [dependency, specifier] of Object.entries(manifest.dependencies ?? {})) {
      if (!isDshRuntimePackage(dependency)) continue
      if (!isExactVersion(specifier)) {
        floating.push({
          file: manifest.file,
          name: manifest.name,
          dependency,
          specifier,
        })
      }
    }
  }
  return floating.sort((left, right) => left.file.localeCompare(right.file))
}

export function findMultipleSingletonVersions(records, names) {
  const duplicates = []
  for (const name of names) {
    const versions = [
      ...new Set(records.filter((entry) => entry.name === name).map((entry) => entry.version)),
    ]
    if (versions.length > 1) duplicates.push({ name, versions: versions.sort() })
  }
  return duplicates
}

export function findIndependentPackageConflicts(records, independentPackages) {
  const conflicts = []
  for (const declared of independentPackages) {
    const found = records
      .filter((entry) => entry.name === declared.name)
      .map((entry) => entry.version)
    if (found.some((version) => version !== declared.version) || found.length === 0) {
      conflicts.push({ name: declared.name, expected: declared.version, found: found.sort() })
    }
  }
  return conflicts
}

export function findOverrideRangeViolations(workspaceYamlText, protectedNames) {
  const violations = []
  const lines = workspaceYamlText.split('\n')
  const overridesIndex = lines.findIndex((line) => line === 'overrides:')
  if (overridesIndex === -1) return violations
  for (const line of lines.slice(overridesIndex + 1)) {
    if (/^\S/.test(line)) break
    const entry = /^ {2}'?([^:']+)'?: (.+)$/.exec(line)
    if (entry === null) continue
    const protectedEntry = entry[1].startsWith('@deepseek-ai/') || protectedNames.includes(entry[1])
    if (protectedEntry && !isExactVersion(entry[2])) {
      violations.push({ name: entry[1], specifier: entry[2] })
    }
  }
  return violations
}

/** Bind the generated manifest's closure digest to the current lockfile. */
export function assertClosureManifestLink(manifestClosureSha256, records) {
  const current = canonicalSha256(records)
  if (manifestClosureSha256 !== current) {
    throw new Error(
      `release/compatibility.json dependencyClosureSha256 ${manifestClosureSha256} does not match the current lockfile closure ${current}; regenerate the manifest`,
    )
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function collectWorkspaceManifests() {
  const manifests = []
  for (const group of ['apps', 'packages']) {
    const directory = path.join(repositoryRoot, group)
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = path.join(group, entry.name, 'package.json')
      const manifest = await readJson(path.join(repositoryRoot, file)).catch(() => undefined)
      if (manifest === undefined) continue
      // dependencies + devDependencies both matter: a floating range in either
      // lets the next install drift the closure. devDependencies win over
      // dependencies on name collisions — both must be exact pins anyway.
      const dependencies = {
        ...manifest.devDependencies,
        ...manifest.dependencies,
      }
      manifests.push({ file, name: manifest.name, dependencies })
    }
  }
  return manifests
}

export async function collectClosureFailures() {
  const failures = []
  const docsCompatibility = await readJson(path.join(repositoryRoot, 'docs', 'compatibility.json'))
  const baselineNpmVersion = docsCompatibility.dsh.npmVersion
  const upstreamArtifacts = await readJson(
    path.join(repositoryRoot, 'build', 'upstream-artifacts.json'),
  )
  const workspaceYaml = await readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
  const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
  const records = closureRecordsFromLockfile(lockfile)

  for (const drift of findDshBaselineDrift(records, baselineNpmVersion)) {
    failures.push(
      `dsh package ${drift.name}@${drift.version} drifted off the baseline ${baselineNpmVersion}`,
    )
  }
  for (const floating of findFloatingDshSpecifiers(await collectWorkspaceManifests())) {
    failures.push(
      `floating dsh specifier ${floating.dependency}: "${floating.specifier}" in ${floating.file} (${floating.name}); pin an exact version`,
    )
  }
  const watched = upstreamArtifacts.dsh.watchedSingletons.map((entry) => entry.name)
  for (const duplicate of findMultipleSingletonVersions(records, watched)) {
    failures.push(
      `singleton ${duplicate.name} has ${duplicate.versions.length} versions in the closure: ${duplicate.versions.join(', ')}`,
    )
  }
  for (const conflict of findIndependentPackageConflicts(
    records,
    upstreamArtifacts.dsh.independentPackages ?? [],
  )) {
    failures.push(
      `independently versioned ${conflict.name} does not match its declared version ${conflict.expected} (found: ${conflict.found.join(', ') || 'nothing'})`,
    )
  }
  for (const violation of findOverrideRangeViolations(workspaceYaml, watched)) {
    failures.push(
      `workspace override ${violation.name}: "${violation.specifier}" must pin an exact version`,
    )
  }

  const releaseManifestPath = path.join(repositoryRoot, 'release', 'compatibility.json')
  if (existsSync(releaseManifestPath)) {
    try {
      const releaseManifest = await readJson(releaseManifestPath)
      assertClosureManifestLink(releaseManifest.dependencyClosureSha256, records)
    } catch (error) {
      failures.push(`closure manifest link: ${error.message}`)
    }
  }

  return { failures, recordCount: records.length }
}

export async function main() {
  const { failures, recordCount } = await collectClosureFailures()
  if (failures.length > 0) {
    console.error(`dsh closure verification failed with ${failures.length} error(s):`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`dsh closure verification passed (${recordCount} lockfile records checked).`)
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}
