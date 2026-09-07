#!/usr/bin/env node
// Full release verification chain (M4): aggregates every gate a v1 candidate
// must pass before it can be recorded as `candidate-verified`. Fast day-to-day
// work uses `pnpm check`; `pnpm verify:release` is the heavyweight chain run
// before recording acceptance evidence.
//
// Steps run sequentially; the first failure stops the chain (later steps
// depend on earlier artifacts).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertAcceptanceRuntime } from '../tests/helpers/acceptance-runtime.mjs'

assertAcceptanceRuntime('verify:release')

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const steps = [
  { name: 'check (format/lint/types/unit/docs)', command: ['run', 'check'] },
  { name: 'generate:compatibility', command: ['run', 'generate:compatibility'] },
  { name: 'verify:dsh-closure', command: ['run', 'verify:dsh-closure'] },
  { name: 'verify:patches', command: ['run', 'verify:patches'] },
  { name: 'test:integration', command: ['run', 'test:integration'] },
  { name: 'test:shared-home', command: ['run', 'test:shared-home'] },
  // package:dir rebuilds the staging tree at the CURRENT head and runs the
  // in-line gates (verify-runtime-tree, verify:dsh-closure, verify:patches,
  // verify-compatibility) against it; packaging straight to dmg would wrap a
  // stale staging tree whenever HEAD moved since the last stage. The
  // standalone verify:compatibility re-check runs only after staging is fresh
  // — before that, a stale staging tree would false-fail the comparison.
  { name: 'package:dir', command: ['run', 'package:dir'] },
  { name: 'verify:compatibility (fresh staging)', command: ['run', 'verify:compatibility'] },
  { name: 'package:dmg', command: ['run', 'package:dmg'] },
  { name: 'verify:artifacts', command: ['run', 'verify:artifacts'] },
  { name: 'smoke:package', command: ['run', 'smoke:package'] },
  {
    name: 'archive candidate + rehearse:upgrade',
    run() {
      // The rehearsal needs explicit previous/candidate indexes: the previous
      // candidate is the frozen M4 baseline when present (rc.1 qualification
      // rehearses M4 → rc.1); release/previous (M3) stays as the historical
      // fallback for chains that predate the freeze.
      const m4Baseline = path.join(
        repositoryRoot,
        'release',
        'baselines',
        'm4-caa5c51',
        'artifacts.json',
      )
      const previousIndex = existsSync(m4Baseline)
        ? m4Baseline
        : path.join(repositoryRoot, 'release', 'previous', 'artifacts.json')
      const candidateIndex = path.join(repositoryRoot, 'release', 'candidate', 'artifacts.json')
      const candidateDir = path.join(repositoryRoot, 'release', 'candidate')
      if (!existsSync(previousIndex)) {
        throw new Error(
          'release/previous/artifacts.json is missing; archive the previous healthy DMG first',
        )
      }
      const dist = path.join(repositoryRoot, 'release', 'dist')
      const dmg = readdirSync(dist).find((file) => file.endsWith('.dmg'))
      if (dmg === undefined) throw new Error('release/dist has no DMG; package:dmg must run first')
      mkdirSync(candidateDir, { recursive: true })
      for (const file of readdirSync(candidateDir)) {
        rmSync(path.join(candidateDir, file), { force: true, recursive: true })
      }
      copyFileSync(path.join(dist, dmg), path.join(candidateDir, dmg))
      // The archived index must pin the ARCHIVED copy (index-relative), never
      // the shared release/dist path — a later build would silently overwrite
      // it. The copy's digest is re-verified against the just-built artifact
      // record before the index is written, so the rehearsal that follows
      // proves the archived bytes, not the dist bytes.
      const expected = JSON.parse(
        readFileSync(path.join(repositoryRoot, 'release', 'artifacts.json'), 'utf8'),
      ).find((record) => record.arch === process.arch)
      const copied = createHash('sha256')
        .update(readFileSync(path.join(candidateDir, dmg)))
        .digest('hex')
      if (copied !== expected.sha256) {
        throw new Error(
          `archived candidate copy digest ${copied} does not match the built artifact ${expected.sha256}`,
        )
      }
      writeFileSync(
        candidateIndex,
        `${JSON.stringify([{ ...expected, file: dmg }], undefined, 2)}\n`,
      )
      spawnPnpm([
        'run',
        'rehearse:upgrade',
        '--',
        '--previous',
        path.relative(repositoryRoot, previousIndex),
        '--candidate',
        path.relative(repositoryRoot, candidateIndex),
      ])
    },
  },
]

function spawnPnpm(args) {
  const result = spawnSync(pnpm, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Keep every substep on the exact runtime the pinned entry validated:
      // a PATH-resolved pnpm may otherwise run its scripts (and their node
      // children) under a completely different Node installation.
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  })
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} exited with ${result.status}`)
  }
}

// The plan's gate list closes with a whitespace/conflict-marker sweep over
// the working tree — appended as a final inline step rather than a pnpm
// script because it checks git state, not a build.
steps.push({
  name: 'git diff --check',
  run() {
    const result = spawnSync('git', ['diff', '--check'], { cwd: repositoryRoot })
    if (result.status !== 0) {
      throw new Error(`git diff --check exited with ${result.status}`)
    }
  },
})

const results = []
for (const step of steps) {
  console.log(`\n=== verify:release — ${step.name} ===`)
  try {
    if (step.command !== undefined) {
      spawnPnpm(step.command)
    } else {
      await step.run()
    }
    results.push({ name: step.name, ok: true })
    console.log(`--- OK: ${step.name} ---`)
  } catch (error) {
    results.push({ name: step.name, ok: false, error: String(error.message ?? error) })
    break
  }
}

const failed = results.filter((entry) => !entry.ok)
if (failed.length > 0) {
  console.error(`\nverify:release FAILED at: ${failed[0].name}`)
  console.error(failed[0].error)
  process.exit(1)
}
console.log(`\nverify:release passed (${results.length}/${steps.length} steps)`)
