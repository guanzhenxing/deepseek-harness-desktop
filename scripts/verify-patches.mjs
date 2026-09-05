#!/usr/bin/env node
// Enforce the local patch ledger (patches/manifest.json). This project pins
// official upstream artifacts and carries zero local patches; the ledger
// makes that claim checkable instead of folklore:
//
//   - schemaVersion 1 with a patches array (an explicit empty array when
//     there are no patches — never an absent file);
//   - every patch records id/file/upstreamCommit/reason/testCommand/status
//     and its upstreamCommit must equal the current baseline commit;
//   - the patch file itself must exist in the repository;
//   - status is one of active | upstream-included | dropped, and every entry
//     is subject to the three-question review recorded in
//     docs/upstream-baseline.md (has upstream fixed it? does it still apply
//     cleanly? does removing it reproduce the failure?).
//
// Usage: node scripts/verify-patches.mjs
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PATCH_STATUSES = new Set(['active', 'upstream-included', 'dropped'])

/**
 * Validate the ledger against the baseline commit. Returns { patches,
 * problems } so tests (and the CLI) can render the conclusions instead of
 * only receiving an exit code.
 */
export function validatePatchLedger(ledger, baselineCommit) {
  const problems = []
  if (typeof ledger !== 'object' || ledger === null || Array.isArray(ledger)) {
    return { patches: [], problems: ['patches/manifest.json must be a JSON object'] }
  }
  if (ledger.schemaVersion !== 1) {
    problems.push(`unsupported patch ledger schemaVersion ${JSON.stringify(ledger.schemaVersion)}`)
  }
  if (!Array.isArray(ledger.patches)) {
    problems.push('patch ledger must carry a patches array (explicit empty array when none)')
    return { patches: [], problems }
  }
  for (const patch of ledger.patches) {
    const label = typeof patch.id === 'string' && patch.id !== '' ? patch.id : '<unnamed patch>'
    for (const field of ['id', 'file', 'upstreamCommit', 'reason', 'testCommand', 'status']) {
      const value = patch[field]
      if (typeof value !== 'string' || value === '') {
        problems.push(`patch ${label} is missing a non-empty ${field}`)
      }
    }
    if (typeof patch.upstreamCommit === 'string' && patch.upstreamCommit !== baselineCommit) {
      problems.push(
        `patch ${label} cites upstream commit ${patch.upstreamCommit}, which is not the baseline ${baselineCommit}; re-derive the patch or drop it`,
      )
    }
    if (typeof patch.status === 'string' && !PATCH_STATUSES.has(patch.status)) {
      problems.push(
        `patch ${label} has status ${patch.status}; expected one of ${[...PATCH_STATUSES].join(', ')}`,
      )
    }
  }
  return { patches: ledger.patches, problems }
}

async function main() {
  const docsCompatibility = JSON.parse(
    await readFile(path.join(repositoryRoot, 'docs', 'compatibility.json'), 'utf8'),
  )
  const baselineCommit = docsCompatibility.dsh.commit
  const ledgerPath = path.join(repositoryRoot, 'patches', 'manifest.json')
  if (!existsSync(ledgerPath)) {
    console.error(
      'verify-patches: patches/manifest.json is missing; an empty ledger is still required',
    )
    process.exitCode = 1
    return
  }
  let ledger
  try {
    ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
  } catch (error) {
    console.error(`verify-patches: patches/manifest.json is not valid JSON: ${error.message}`)
    process.exitCode = 1
    return
  }
  const { patches, problems } = validatePatchLedger(ledger, baselineCommit)
  for (const problem of problems) console.error(`- ${problem}`)
  if (problems.length > 0) {
    console.error(`verify-patches: ${problems.length} ledger problem(s)`)
    process.exitCode = 1
    return
  }
  for (const patch of patches) {
    if (!existsSync(path.join(repositoryRoot, patch.file))) {
      console.error(`verify-patches: patch ${patch.id} file ${patch.file} does not exist`)
      process.exitCode = 1
      return
    }
  }
  if (patches.length === 0) {
    console.log(
      'verify-patches: no local patches (explicit empty ledger) — the runtime ships pure official upstream artifacts',
    )
    return
  }
  console.log(
    `verify-patches: ${patches.length} patch(es) validated against baseline ${baselineCommit.slice(0, 7)}`,
  )
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}
