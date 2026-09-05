// Upgrade rehearsal: drive a real previous candidate and a real candidate
// through install → seed → copy → upgrade → restart → refusal negatives, with
// every data touch verified against digests. The rehearsal never reads or
// writes a real ~/.dsh, never runs against the original fixture (only the
// verified copy), and never guesses artifact paths: both artifact indexes are
// explicit arguments.
//
// Usage (via scripts/rehearse-upgrade.mjs):
//   pnpm rehearse:upgrade -- \
//     --previous release/previous/artifacts.json \
//     --candidate release/candidate/artifacts.json
import { spawn } from 'node:child_process'
import { clearTimeout, setTimeout } from 'node:timers'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installFromDmg, runInstalledApp, runInstalledCli } from '../helpers/installed-app.mjs'
import {
  assertThirdPartyBundleUnchanged,
  copyHomeWithProof,
  digestDiff,
  makeCorruptDmgCopy,
  seedThirdPartyBundle,
  sha256File,
  treeDigests,
} from '../helpers/upgrade-fixture.mjs'
import {
  createSharedHomeFixture,
  createWebApiClient,
  driveOneTurn,
  listSessions,
} from '../helpers/shared-home-driver.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PRODUCT_NAME = 'DeepSeek Harness Desktop'
const UPSTREAM_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
const CURRENT_BASELINE = { tag: 'dsh-v0.1.2-alpha.3', npmVersion: '0.1.2-alpha.3' }

function fail(step, message) {
  throw new Error(`rehearsal step "${step}" failed: ${message}`)
}

async function loadArtifactIndex(kind, indexPath) {
  if (!existsSync(indexPath)) {
    fail(kind, `artifact index not found: ${indexPath}`)
  }
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const records = index.filter?.((record) => record.arch === process.arch) ?? []
  if (records.length !== 1) {
    fail(kind, `expected exactly one ${process.arch} artifact record in ${indexPath}`)
  }
  const record = records[0]
  // Records may reference their DMG relative to the index directory (archived
  // indexes) or relative to the repository root (release/artifacts.json).
  let dmgPath = path.resolve(path.dirname(indexPath), record.file)
  if (!existsSync(dmgPath)) dmgPath = path.resolve(repositoryRoot, record.file)
  if (!existsSync(dmgPath)) fail(kind, `artifact file missing: ${record.file}`)
  const actualSha = await sha256File(dmgPath)
  if (actualSha !== record.sha256) {
    fail(kind, `artifact digest mismatch: index pins ${record.sha256}, file hashes ${actualSha}`)
  }
  return { kind, record, dmgPath, indexPath }
}

async function verifyEmbeddedManifest(install, artifact) {
  const manifestPath = path.join(install.appPath, 'Contents', 'Resources', 'compatibility.json')
  if (!existsSync(manifestPath))
    fail(artifact.kind, 'installed app lacks the embedded compatibility manifest')
  const bytes = await readFile(manifestPath)
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (
    artifact.record.compatibilityManifestSha256 !== undefined &&
    digest !== artifact.record.compatibilityManifestSha256
  ) {
    fail(
      artifact.kind,
      `embedded manifest digest ${digest} does not match the artifact index ${artifact.record.compatibilityManifestSha256}`,
    )
  }
  const manifest = JSON.parse(bytes)
  if (manifest.releaseId !== artifact.record.releaseId) {
    fail(
      artifact.kind,
      `embedded releaseId ${manifest.releaseId} does not match the index ${artifact.record.releaseId}`,
    )
  }
  return manifest
}

/** Refusal snapshot: everything except lease coordination must be identical. */
function dataDigests(root) {
  return treeDigests(root)
}

function isLeaseCoordination(relative) {
  return (
    relative === 'run/host-lease.guard' ||
    relative.startsWith('run/host.lock') ||
    relative.startsWith('run/host.lock/')
  )
}

async function assertOnlyCoordinationChanged(step, home, before) {
  const after = await treeDigests(home)
  const changed = digestDiff(before, after).filter((file) => !isLeaseCoordination(file))
  if (changed.length > 0) {
    fail(step, `refusal path touched home data: ${changed.join(', ')}`)
  }
}

async function seedSessionWithCli(cliEntry, fixture, text) {
  const created = await runInstalledCli(cliEntry, ['--profile', 'headless', text], {
    home: fixture.home,
    cwd: fixture.cwd,
  })
  if (created.code !== 0) {
    fail(
      'seed sessions',
      `installed cli round failed (${created.code}): ${created.output.slice(-300)}`,
    )
  }
}

async function observeUpstreamTags() {
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-remote', '--tags', UPSTREAM_REPO], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('lookup-failed')
    }, 20_000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('lookup-failed')
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve('lookup-failed')
      const tags = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('refs/tags/dsh-'))
        .map((line) => line.split('refs/tags/')[1])
        .filter((tag) => tag !== undefined && !tag.endsWith('^{}'))
        .sort()
      resolve(tags)
    })
  })
}

export async function runUpgradeRehearsal(input) {
  const results = []
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }

  // -- Step 1: artifact verification (explicit indexes, digest-pinned). ------
  const previous = await loadArtifactIndex('previous', input.previousIndexPath)
  const candidate = await loadArtifactIndex('candidate', input.candidateIndexPath)
  record(
    'artifact-digests',
    true,
    `previous ${previous.record.releaseId}, candidate ${candidate.record.releaseId}`,
  )

  const corrupt = await makeCorruptDmgCopy(candidate.dmgPath)
  let corruptRejected = false
  try {
    await loadArtifactIndex('candidate (corrupt negative)', corrupt.file)
  } catch {
    corruptRejected = true
  } finally {
    await corrupt.dispose()
  }
  record(
    'corrupt-candidate-refused',
    corruptRejected,
    'a byte-flipped DMG is rejected before install',
  )

  // -- Step 2: install both candidates; verify embedded manifests. ----------
  const previousInstall = await installFromDmg(previous.dmgPath, PRODUCT_NAME)
  const candidateInstall = await installFromDmg(candidate.dmgPath, PRODUCT_NAME)
  const previousManifest = await verifyEmbeddedManifest(previousInstall, previous)
  const candidateManifest = await verifyEmbeddedManifest(candidateInstall, candidate)
  record(
    'embedded-manifests',
    previousManifest.schemaVersion === 1 && candidateManifest.schemaVersion === 2,
    `previous schema ${previousManifest.schemaVersion} (M3 reader-only), candidate schema ${candidateManifest.schemaVersion}`,
  )

  let fixture
  let rehearsalCopy
  try {
    // -- Step 3: seed the fixture home from the PREVIOUS artifact. ----------
    fixture = await createSharedHomeFixture()
    const bundle = await seedThirdPartyBundle(fixture.home)

    await runInstalledApp({
      executable: previousInstall.executable,
      mode: 'conversation',
      userData: fixture.userData,
      cwd: fixture.cwd,
      timeoutMs: 300_000,
      async action({ waitFor }) {
        const ready = await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
        const client = await createWebApiClient(ready.surfaceUrl)
        await driveOneTurn(client, { cwd: fixture.cwd, text: 'previous desktop seeds the home' })
      },
    })
    record(
      'previous-desktop-boot',
      true,
      `sessions after desktop round: ${(await listSessions(fixture.home)).length}`,
    )

    await seedSessionWithCli(previousInstall.cliEntry, fixture, 'previous cli seeds the home')
    const seededSessions = await listSessions(fixture.home)
    if (seededSessions.length !== 2) {
      fail('seed sessions', `expected two synthetic sessions, found ${seededSessions.length}`)
    }
    record('previous-cli-round', true, 'two synthetic sessions from the previous artifact')

    // -- Step 4: verify the copy, then retire the original for the day. -----
    rehearsalCopy = await copyHomeWithProof(fixture.home)
    record(
      'home-copy-verified',
      true,
      'byte-identical copy; the rehearsal continues on the copy only',
    )

    // -- Step 5: the candidate upgrades the copy. ---------------------------
    // Desktop smoke modes resolve their home as <userData>/home (main.ts
    // resolveSmokeHome) and ignore DSH_HOME, so the verified copy is cloned
    // into the candidate's smoke userData — the CLI keeps addressing the same
    // directory through DSH_HOME.
    const beforeUpgrade = await dataDigests(rehearsalCopy.home)
    const candidateUserData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-upgrade-'))
    const candidateHome = path.join(candidateUserData, 'home')
    await cp(rehearsalCopy.home, candidateHome, { recursive: true })
    const cloneDigest = digestDiff(beforeUpgrade, await dataDigests(candidateHome))
    if (cloneDigest.length > 0) {
      fail('candidate upgrade', `clone into userData diverged: ${cloneDigest.join(', ')}`)
    }
    await runInstalledApp({
      executable: candidateInstall.executable,
      mode: 'conversation',
      userData: candidateUserData,
      cwd: fixture.cwd,
      timeoutMs: 300_000,
      async action({ waitFor }) {
        await waitFor(
          (report) => report.kind === 'ui-ready',
          'candidate ui-ready on the upgraded copy',
        )
      },
    })
    const afterUpgrade = await dataDigests(candidateHome)
    const seededSessionFiles = [...beforeUpgrade.keys()].filter((file) =>
      file.startsWith('sessions/'),
    )
    const lostHistory = seededSessionFiles.filter((file) => !afterUpgrade.has(file))
    if (lostHistory.length > 0)
      fail('candidate upgrade', `upgrade lost history: ${lostHistory.join(', ')}`)
    // Anti-vacuous proof: the candidate's own admission must have reserved
    // the write epoch on THIS home (not on some other userData/home).
    const candidateMarker = JSON.parse(
      await readFile(path.join(candidateHome, 'run', 'compatibility.json'), 'utf8'),
    )
    if (
      candidateMarker.lastWriterReleaseId !== candidateManifest.releaseId ||
      candidateMarker.schemaVersion !== 1
    ) {
      fail(
        'candidate upgrade',
        `marker was not reserved by the candidate on the upgraded copy: ${JSON.stringify(candidateMarker)}`,
      )
    }
    await assertThirdPartyBundleUnchanged(bundle)
    record(
      'candidate-upgrade-boot',
      true,
      `history preserved, marker reserved by ${candidateMarker.lastWriterReleaseId}, third-party bundle intact`,
    )

    const continued = await runInstalledCli(
      candidateInstall.cliEntry,
      ['--profile', 'headless', 'candidate cli adds a round on the copy'],
      { home: candidateHome, cwd: fixture.cwd },
    )
    if (continued.code !== 0) fail('candidate continuation', continued.output.slice(-300))
    const continuedSessions = await listSessions(candidateHome)
    if (continuedSessions.length !== 3) {
      fail('candidate continuation', `expected three sessions, found ${continuedSessions.length}`)
    }
    record('candidate-continuation', true, 'candidate reads history and appends new content')

    // -- Step 6: restart the candidate on the same copy. --------------------
    await runInstalledApp({
      executable: candidateInstall.executable,
      mode: 'conversation',
      userData: candidateUserData,
      cwd: fixture.cwd,
      timeoutMs: 300_000,
      async action({ waitFor }) {
        await waitFor((report) => report.kind === 'ui-ready', 'candidate restart ui-ready')
      },
    })
    const restartedSessions = await listSessions(candidateHome)
    if (restartedSessions.length !== 3) {
      fail('candidate restart', `restart lost sessions: found ${restartedSessions.length}`)
    }
    await assertThirdPartyBundleUnchanged(bundle, candidateHome)
    record('candidate-restart', true, 'restart re-reads history and new content')

    // -- Step 7: refusal negatives against the real installed artifacts. ----
    const cases = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'tests', 'upgrade', 'fixtures', 'manifest-cases.json'),
        'utf8',
      ),
    ).cases
    for (const refusalCase of cases) {
      const negativeRoot = await mkdtemp(path.join(tmpdir(), 'dsh-negative-'))
      const negativeHome = path.join(negativeRoot, 'home')
      await cp(rehearsalCopy.home, negativeHome)
      try {
        await mkdir(path.join(negativeHome, 'run'), { recursive: true })
        if (refusalCase.rawMarker !== undefined) {
          await writeFile(
            path.join(negativeHome, 'run', 'compatibility.json'),
            refusalCase.rawMarker,
          )
        } else if (refusalCase.marker !== undefined) {
          await writeFile(
            path.join(negativeHome, 'run', 'compatibility.json'),
            `${JSON.stringify(refusalCase.marker, undefined, 2)}\n`,
          )
        } else if (refusalCase.foreignFile !== undefined) {
          await mkdir(path.dirname(path.join(negativeHome, refusalCase.foreignFile.path)), {
            recursive: true,
          })
          await writeFile(
            path.join(negativeHome, refusalCase.foreignFile.path),
            refusalCase.foreignFile.content,
          )
        }
        const before = await dataDigests(negativeHome)

        if (refusalCase.appliesTo.includes('previous')) {
          const refused = await runInstalledCli(
            previousInstall.cliEntry,
            ['--profile', 'headless', 'must be refused'],
            { home: negativeHome, cwd: fixture.cwd },
          )
          if (refused.code !== 5) {
            fail(
              `negative ${refusalCase.id}`,
              `previous cli exit ${refused.code}: ${refused.output.slice(-200)}`,
            )
          }
        }
        const candidateRefused = await runInstalledCli(
          candidateInstall.cliEntry,
          ['--profile', 'headless', 'must be refused'],
          { home: negativeHome, cwd: fixture.cwd },
        )
        if (candidateRefused.code !== 5) {
          fail(
            `negative ${refusalCase.id}`,
            `candidate cli exit ${candidateRefused.code}: ${candidateRefused.output.slice(-200)}`,
          )
        }

        await assertOnlyCoordinationChanged(`negative ${refusalCase.id}`, negativeHome, before)
        record(`refusal-${refusalCase.id}`, true, refusalCase.description)
      } finally {
        await rm(negativeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }

    // -- Step 8: Desktop-side downgrade refusal on the real previous app. ---
    // The poisoned home goes inside the previous app's smoke userData, the
    // same <userData>/home resolution the app will actually use.
    const negativeUserData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-negative-'))
    const desktopNegativeHome = path.join(negativeUserData, 'home')
    await cp(rehearsalCopy.home, desktopNegativeHome)
    try {
      await mkdir(path.join(desktopNegativeHome, 'run'), { recursive: true })
      const epochTwo = cases.find((entry) => entry.id === 'epoch-2-marker')
      await writeFile(
        path.join(desktopNegativeHome, 'run', 'compatibility.json'),
        `${JSON.stringify(epochTwo.marker, undefined, 2)}\n`,
      )
      const before = await dataDigests(desktopNegativeHome)
      let sawRefusal = false
      try {
        await runInstalledApp({
          executable: previousInstall.executable,
          mode: 'recovery',
          userData: negativeUserData,
          cwd: fixture.cwd,
          timeoutMs: 300_000,
          async action({ waitFor }) {
            await waitFor(
              (report) =>
                (report.kind === 'failed' && report.stage === 'home-admission') ||
                (report.kind === 'recovery' && report.step === 'recovery-view-reached'),
              'desktop downgrade refusal',
            )
          },
        })
        // A clean run with no failed report means the refusal never happened.
        fail('desktop downgrade refusal', 'previous app booted a newer-epoch home without refusing')
      } catch (error) {
        if (!/home-admission/.test(String(error.message))) throw error
        sawRefusal = true
      }
      if (!sawRefusal) fail('desktop downgrade refusal', 'admission refusal was not observed')
      await assertOnlyCoordinationChanged('desktop downgrade refusal', desktopNegativeHome, before)
      record(
        'refusal-desktop-epoch-2',
        true,
        'previous app refuses a newer-epoch home in its admission chain, before any write',
      )
    } finally {
      await rm(desktopNegativeHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      })
    }

    // -- Step 9: record the upgrade reality (no invented version jumps). ----
    const tags = await observeUpstreamTags()
    const newerTags = Array.isArray(tags)
      ? tags.filter((tag) => tag !== CURRENT_BASELINE.tag)
      : tags
    const upgradeType =
      previousManifest.dsh?.npmVersion === candidateManifest.dsh?.npmVersion
        ? 'same-baseline-reinstall'
        : 'cross-version-upgrade'
    record(
      'upgrade-type-recorded',
      true,
      `${upgradeType}; upstream tags observed: ${
        Array.isArray(newerTags)
          ? newerTags.length > 0
            ? newerTags.join(', ')
            : 'none'
          : newerTags
      } — a real cross-version upgrade requires its own codex/upgrade-dsh-<tag> branch`,
    )
  } finally {
    if (rehearsalCopy !== undefined) await rehearsalCopy.dispose()
    if (fixture !== undefined) await fixture.dispose()
    await candidateInstall.dispose()
    await previousInstall.dispose()
  }

  const failed = results.filter((entry) => !entry.ok)
  return { results, failed }
}
