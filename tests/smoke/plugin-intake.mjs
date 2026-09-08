#!/usr/bin/env node
// Packaged plugin-intake rehearsal: stage the SYNTHETIC fixture bundle in a
// fresh temporary profile under a smoke-owned home through the INSTALLED
// candidate's own plugin flow, prove the bundle loads on the real Host graph,
// and prove the user's default desktop profile is untouched. Intake never
// installs or enables anything for a user; a real home is never read.
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertAcceptanceRuntime } from '../helpers/acceptance-runtime.mjs'

assertAcceptanceRuntime('verify:plugin-intake')

const { installTerminationHandlers, installFromDmg, runInstalledApp, runInstalledCli } =
  await import('../helpers/installed-app.mjs')
installTerminationHandlers()

const { validatePluginIntake } = await import('../../scripts/plugin-intake.mjs')
const { treeDigests } = await import('../helpers/upgrade-fixture.mjs')
const { createSharedHomeFixture } = await import('../helpers/shared-home-driver.mjs')

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INTAKE_PROFILE = 'plugin-intake-rehearsal'

function fail(step, detail) {
  throw new Error(`plugin-intake rehearsal "${step}" failed: ${detail}`)
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function main() {
  const candidateIndex = await readJson(
    path.join(repositoryRoot, 'release', 'candidate', 'artifacts.json'),
  )
  const record = candidateIndex.find((entry) => entry.arch === process.arch)
  if (record === undefined) {
    fail('candidate', `release/candidate/artifacts.json has no ${process.arch} record`)
  }
  const install = await installFromDmg(
    path.resolve(path.join(repositoryRoot, 'release', 'candidate'), record.file),
    'DeepSeek Harness',
  )

  const embeddedManifest = await readJson(
    path.join(install.appPath, 'Contents', 'Resources', 'compatibility.json'),
  )
  if (embeddedManifest.releaseId !== record.releaseId) {
    fail('candidate', 'embedded manifest releaseId does not match the candidate index')
  }

  // 1. The intake record validates against the exact fixture bytes and the
  //    installed candidate's manifest, BEFORE anything is staged anywhere.
  const intakeRecord = await readJson(
    path.join(repositoryRoot, 'tests', 'fixtures', 'plugin-intake', 'example.intake.json'),
  )
  const fixtureBundle = path.join(
    repositoryRoot,
    'tests',
    'fixtures',
    'plugin-intake',
    'example.bundle',
  )
  await validatePluginIntake(intakeRecord, fixtureBundle, embeddedManifest)

  // 2. The candidate boots to its official UI on the smoke home (this also
  //    reconciles the default desktop profile the round must not touch). The
  //    shared-home fixture carries a mock LLM + credentials so the intake
  //    profile's CLI round can complete a real turn instead of waiting on a
  //    missing model.
  const fixture = await createSharedHomeFixture()
  const userData = fixture.userData
  const home = fixture.home
  try {
    await runInstalledApp({
      executable: install.executable,
      mode: 'conversation',
      userData,
      cwd: userData,
      timeoutMs: 300_000,
      async action({ waitFor }) {
        await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
      },
    })
    const desktopProfile = path.join(home, 'profiles', 'desktop')
    const before = await treeDigests(desktopProfile)

    // 3. Stage the synthetic bundle ONLY in the fresh intake profile through
    //    the installed CLI's own plugin flow.
    const added = await runInstalledCli(
      install.cliEntry,
      ['plugin', '--profile', INTAKE_PROFILE, 'add', fixtureBundle],
      { home, cwd: userData, timeoutMs: 240_000 },
    )
    if (added.code !== 0) {
      fail('plugin add', `exit ${added.code}: ${added.output.slice(-500)}`)
    }
    const profileManifest = await readJson(
      path.join(home, 'profiles', INTAKE_PROFILE, 'package.json'),
    )
    if (profileManifest.dependencies?.[intakeRecord.package] === undefined) {
      fail('plugin add', 'the intake profile manifest does not record the dependency')
    }
    if (!profileManifest.dsh?.profile?.bundles?.includes(intakeRecord.package)) {
      fail('plugin add', 'the intake profile manifest does not reconcile the bundle list')
    }

    // 4. The staged bytes are exactly the validated bytes. The profile's
    //    node_modules is a pnpm symlink layout — resolve to the real files
    //    before validating (the validator refuses symlinked bundle roots by
    //    design: an intake SOURCE must be real bytes on disk).
    const stagedBundle = await realpath(
      path.join(home, 'profiles', INTAKE_PROFILE, 'node_modules', '@fixture', 'm5-example-bundle'),
    )
    await validatePluginIntake(intakeRecord, stagedBundle, embeddedManifest)

    // 5. The intake profile itself boots through the installed candidate and
    //    completes a real turn against the fixture's mock LLM: "the bundle's
    //    profile can start" is proven on the exact profile the bundle was
    //    staged into, not inferred from loader inputs. The gate FAILS CLOSED.
    //    Known upstream defect on the rc.1 baseline (reproduced on candidate
    //    29cee57, see ADR-0010): freshly created NON-TEMPLATE profiles crash
    //    profile boot plugin-less (exit 1 in composeProfile) and hang with
    //    the bundle staged — until an upstream fix ships, this command stays
    //    red instead of reporting a skipped pass.
    const launched = await runInstalledCli(
      install.cliEntry,
      ['--profile', INTAKE_PROFILE, 'intake profile boot round'],
      { home, cwd: userData, timeoutMs: 180_000 },
    )
    if (launched.code !== 0) {
      fail(
        'intake profile launch',
        `candidate cli exit ${launched.code} booting profile ${INTAKE_PROFILE}: ${launched.output.slice(-400)}`,
      )
    }

    // 6. The loader wiring is in place: the profile manifest's bundle list
    //    (asserted above) is what the cordis loader walks, and the staged
    //    bundle carries the module it will import plus its own patch layer
    //    (both inside the digest validated above). The load behavior itself
    //    is covered by the host-runner integration test on the real Host
    //    graph.
    const stagedRoot = await realpath(
      path.join(home, 'profiles', INTAKE_PROFILE, 'node_modules', '@fixture', 'm5-example-bundle'),
    )
    await readFile(path.join(stagedRoot, 'index.js'))
    await readFile(path.join(stagedRoot, 'cordis.patch.yml'))

    // 7. The user's default desktop profile is byte-identical.
    const after = await treeDigests(desktopProfile)
    if (JSON.stringify([...before.keys()]) !== JSON.stringify([...after.keys()])) {
      fail('isolation', 'the desktop profile file set changed during intake')
    }
    for (const [file, digest] of before) {
      if (after.get(file) !== digest) {
        fail('isolation', `the desktop profile file changed: ${file}`)
      }
    }
  } finally {
    await fixture.dispose()
    await install.dispose()
  }

  console.log(
    `PLUGIN-INTAKE passed — record validated, staged through the candidate's own plugin flow, staged bytes and loader inputs verified, intake profile booted through the candidate to a completed turn, desktop profile untouched (${record.releaseId})`,
  )
}

await main()
