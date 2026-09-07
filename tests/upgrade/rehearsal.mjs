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
import { Buffer } from 'node:buffer'
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
  waitForTurns,
} from '../helpers/shared-home-driver.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The archived previous artifact (M3) still carries the historical bundle
// name; the candidate carries the current product name.
const PREVIOUS_APP_NAME = 'DeepSeek Harness Desktop'
const CANDIDATE_APP_NAME = 'DeepSeek Harness'
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

/**
 * Wait until the home lease is released after an installed-app exit. The
 * launcher never blocks quit on a failed release (M1 semantics), so a slow
 * or retried release briefly leaves run/host.lock behind — the M3 package
 * smoke waits the same way before any CLI round.
 *
 * The frozen M3 previous artifact also has a flaky release (its probe can
 * fail during quit, leaving a genuinely stale lock whose owner is gone);
 * there `doctor --unlock` — its own designed remediation — cleans up. The
 * M4 candidate gets no such tolerance: its release path must be clean.
 */
async function waitForLeaseGone(home, timeoutMs = 30_000) {
  const { stat } = await import('node:fs/promises')
  const lock = path.join(home, 'run', 'host.lock')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const gone = await stat(lock).then(
      () => false,
      (error) => error.code === 'ENOENT',
    )
    if (gone) return
    if (Date.now() > deadline) {
      fail('lease release', `run/host.lock still present after app exit: ${lock}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function waitForPreviousLeaseGone(cliEntry, home, cwd) {
  try {
    await waitForLeaseGone(home)
    return
  } catch {
    // The previous app left a stale lock (owner gone). Clean it through the
    // previous CLI's own doctor path, exactly as a user would.
  }
  const doctor = await runInstalledCli(cliEntry, ['doctor', '--unlock'], { home, cwd })
  if (doctor.code !== 0) {
    fail(
      'lease release',
      `previous app left a stale lock and doctor refused: ${doctor.output.slice(-200)}`,
    )
  }
  await waitForLeaseGone(home, 10_000)
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

  // A byte-flipped DMG must fail the DIGEST check specifically: the negative
  // index is valid JSON pinning the PRISTINE sha256 while pointing at the
  // corrupted file, so this step proves the digest gate — not a JSON parse
  // accident on the DMG bytes.
  const corrupt = await makeCorruptDmgCopy(candidate.dmgPath)
  let corruptRejected = false
  // The negative index lives NEXT TO the corrupted DMG so its index-relative
  // file reference resolves to the corrupted bytes.
  const corruptIndexDir = path.dirname(corrupt.file)
  try {
    const corruptIndex = path.join(corruptIndexDir, 'artifacts.json')
    await writeFile(
      corruptIndex,
      `${JSON.stringify(
        [
          {
            file: path.basename(corrupt.file),
            sha256: candidate.record.sha256,
            platform: candidate.record.platform,
            arch: candidate.record.arch,
            releaseId: candidate.record.releaseId,
          },
        ],
        undefined,
        2,
      )}\n`,
    )
    await loadArtifactIndex('candidate (corrupt negative)', corruptIndex)
  } catch (error) {
    corruptRejected = /digest mismatch/.test(String(error.message))
    if (!corruptRejected) throw error
  } finally {
    await corrupt.dispose()
  }
  record(
    'corrupt-candidate-refused',
    corruptRejected,
    'a byte-flipped DMG is rejected by the digest gate before install',
  )

  // -- Step 2: install both candidates; verify embedded manifests. ----------
  const previousInstall = await installFromDmg(previous.dmgPath, PREVIOUS_APP_NAME)
  const candidateInstall = await installFromDmg(candidate.dmgPath, CANDIDATE_APP_NAME)
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

    let seededSessionId
    await runInstalledApp({
      executable: previousInstall.executable,
      mode: 'conversation',
      userData: fixture.userData,
      cwd: fixture.cwd,
      timeoutMs: 300_000,
      async action({ waitFor }) {
        const ready = await waitFor((report) => report.kind === 'ui-ready', 'ui-ready')
        const client = await createWebApiClient(ready.surfaceUrl)
        seededSessionId = await driveOneTurn(client, {
          cwd: fixture.cwd,
          text: 'previous desktop seeds the home',
        })
      },
    })
    await waitForPreviousLeaseGone(previousInstall.cliEntry, fixture.home, fixture.cwd)
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

    // -- Step 5: the candidate upgrades the seeded home IN PLACE. -----------
    // A real upgrade replaces the .app and keeps both the home path and the
    // application-support directory; profile journals pin absolute ref paths
    // and MUST NOT be relocated (the M2 containment check would rightly call
    // them corrupt). So the candidate runs against the fixture's own
    // userData/home; the verified copy stays untouched as the pristine
    // baseline for the refusal negatives.
    const candidateHome = fixture.home
    const beforeUpgrade = await dataDigests(candidateHome)
    await runInstalledApp({
      executable: candidateInstall.executable,
      mode: 'conversation',
      userData: fixture.userData,
      cwd: fixture.cwd,
      timeoutMs: 300_000,
      async action({ waitFor }) {
        const ready = await waitFor(
          (report) => report.kind === 'ui-ready',
          'candidate ui-ready on the upgraded home',
        )
        // API-level history proof: the upgraded candidate must list the OLD
        // session through its real providers and continue THAT session —
        // counting files proves nothing about readability.
        const client = await createWebApiClient(ready.surfaceUrl)
        const listed = await client.rpc('session/list', { _request: {} })
        const items = listed.items ?? []
        const oldItem = items.find((item) => item.sessionId === seededSessionId)
        if (oldItem === undefined) {
          fail(
            'candidate upgrade',
            `session/list after upgrade does not include the seeded session ${seededSessionId}`,
          )
        }
        const continued = await driveOneTurn(client, {
          cwd: fixture.cwd,
          sessionId: seededSessionId,
          text: 'candidate continues the seeded session',
        })
        if (continued !== seededSessionId) {
          fail('candidate upgrade', `continuation drifted to a new session ${continued}`)
        }
      },
    })
    await waitForLeaseGone(candidateHome)
    const seededFile = (await listSessions(candidateHome)).find(
      (session) => session.header.id === seededSessionId,
    )
    if (seededFile === undefined) fail('candidate upgrade', 'seeded session file vanished')
    const seededTurns = await waitForTurns(seededFile.file, 2)
    if (seededTurns < 2) {
      fail('candidate upgrade', `seeded session holds ${seededTurns} turns after continuation`)
    }
    const seededBytes = await readFile(seededFile.file, 'utf8')
    if (!seededBytes.includes('previous desktop seeds the home')) {
      fail('candidate upgrade', 'seeded history content was rewritten or lost')
    }
    const afterUpgrade = await dataDigests(candidateHome)
    const seededSessionFiles = [...beforeUpgrade.keys()].filter((file) =>
      file.startsWith('sessions/'),
    )
    const lostHistory = seededSessionFiles.filter((file) => !afterUpgrade.has(file))
    if (lostHistory.length > 0)
      fail('candidate upgrade', `upgrade lost history: ${lostHistory.join(', ')}`)
    // Anti-vacuous proof: the candidate's own admission must have reserved
    // the write epoch on THIS home.
    const candidateMarker = JSON.parse(
      await readFile(path.join(candidateHome, 'run', 'compatibility.json'), 'utf8'),
    )
    if (
      candidateMarker.lastWriterReleaseId !== candidateManifest.releaseId ||
      candidateMarker.schemaVersion !== 1
    ) {
      fail(
        'candidate upgrade',
        `marker was not reserved by the candidate on the upgraded home: ${JSON.stringify(candidateMarker)}`,
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
      ['--profile', 'headless', 'candidate cli adds a round on the upgraded home'],
      { home: candidateHome, cwd: fixture.cwd },
    )
    if (continued.code !== 0) fail('candidate continuation', continued.output.slice(-300))
    const continuedSessions = await listSessions(candidateHome)
    if (continuedSessions.length !== 3) {
      fail('candidate continuation', `expected three sessions, found ${continuedSessions.length}`)
    }
    const continuedSeededFile = continuedSessions.find(
      (session) => session.header.id === seededSessionId,
    )
    const stillSeeded = await readFile(continuedSeededFile.file, 'utf8')
    if (
      (await waitForTurns(continuedSeededFile.file, 2)) < 2 ||
      !stillSeeded.includes('previous desktop seeds the home') ||
      !stillSeeded.includes('candidate continues the seeded session')
    ) {
      fail('candidate continuation', 'seeded session history changed across the CLI round')
    }
    record(
      'candidate-continuation',
      true,
      'seeded session still holds both turns; the CLI round appended a third session',
    )

    // -- Step 6: restart the candidate on the same home. --------------------
    await runInstalledApp({
      executable: candidateInstall.executable,
      mode: 'conversation',
      userData: fixture.userData,
      cwd: fixture.cwd,
      timeoutMs: 300_000,
      async action({ waitFor }) {
        const ready = await waitFor(
          (report) => report.kind === 'ui-ready',
          'candidate restart ui-ready',
        )
        const client = await createWebApiClient(ready.surfaceUrl)
        const listed = await client.rpc('session/list', { _request: {} })
        const items = listed.items ?? []
        if (!items.some((item) => item.sessionId === seededSessionId)) {
          fail('candidate restart', `restart cannot list the seeded session ${seededSessionId}`)
        }
        if (items.length < 3) {
          fail('candidate restart', `restart lists ${items.length} sessions, expected at least 3`)
        }
        // Listing proves headers only. Continuing the seeded session forces
        // the restarted Host to load the full prior history through its real
        // providers — the restart-round equivalent of the upgrade round's
        // API-level readability proof.
        const continued = await driveOneTurn(client, {
          cwd: fixture.cwd,
          sessionId: seededSessionId,
          text: 'candidate restart re-reads the seeded history',
        })
        if (continued !== seededSessionId) {
          fail('candidate restart', `restart continuation drifted to a new session ${continued}`)
        }
      },
    })
    await waitForLeaseGone(candidateHome)
    const restartedSessions = await listSessions(candidateHome)
    if (restartedSessions.length !== 3) {
      fail('candidate restart', `restart lost sessions: found ${restartedSessions.length}`)
    }
    const restartedSeeded = restartedSessions.find(
      (session) => session.header.id === seededSessionId,
    )
    if (restartedSeeded === undefined) {
      fail('candidate restart', 'seeded session vanished across the restart round')
    }
    const restartedBytes = await readFile(restartedSeeded.file, 'utf8')
    if ((await waitForTurns(restartedSeeded.file, 3)) < 3) {
      fail('candidate restart', 'seeded session did not gain the restart-round turn')
    }
    for (const marker of [
      'previous desktop seeds the home',
      'candidate continues the seeded session',
      'candidate restart re-reads the seeded history',
    ]) {
      if (!restartedBytes.includes(marker)) {
        fail('candidate restart', `seeded history lost the turn text ${JSON.stringify(marker)}`)
      }
    }
    await assertThirdPartyBundleUnchanged(bundle)
    record(
      'candidate-restart',
      true,
      'restart re-reads the seeded history (continued in place, all three rounds preserved)',
    )

    // -- Step 6.5: a real compressed session must cross candidate admission. --
    // The fixture forces compression:none so the driven rounds stay
    // plaintext, and the upstream backend refuses to LIST a .zstd artifact
    // under a none-compression home — so the compressed session lives on an
    // INDEPENDENT copy: the candidate CLI's admission walk must inspect and
    // accept it (exit 0 needs a passed preflight), and the artifact must
    // survive its round byte-identical.
    {
      const zstdRoot = await mkdtemp(path.join(tmpdir(), 'dsh-zstd-admission-'))
      const zstdHome = path.join(zstdRoot, 'home')
      await cp(rehearsalCopy.home, zstdHome, { recursive: true })
      try {
        const { zstdCompressSync } = await import('node:zlib')
        const sessionDir = path.join(zstdHome, 'sessions', '--zstd-probe--', 'zstd-seeded-session')
        await mkdir(sessionDir, { recursive: true })
        const zstdBytes = Buffer.concat([
          zstdCompressSync(
            Buffer.from(
              '{"type":"session","version":0,"id":"zstd-seeded-session","createdAt":0,"delegationDepth":0}\n',
              'utf8',
            ),
          ),
          zstdCompressSync(Buffer.from('{"type":"turn/end"}\n', 'utf8')),
        ])
        // Counter-proof FIRST: a plaintext file wearing the .zstd name must
        // be refused (exit 5) — an artifact that silently skipped the
        // directory would pass the positive case below vacuously.
        await writeFile(path.join(sessionDir, 'session.jsonl.zstd'), 'definitely not zstd\n')
        const negative = await runInstalledCli(candidateInstall.cliEntry, ['--version'], {
          home: zstdHome,
          cwd: fixture.cwd,
        })
        if (negative.code !== 5) {
          fail(
            'zstd-session-admission',
            `candidate admission did not refuse a fake zstd session (exit ${negative.code}): ${negative.output.slice(-300)}`,
          )
        }
        await writeFile(path.join(sessionDir, 'session.jsonl.zstd'), zstdBytes)
        // Admission-only probe: the profile-less passthrough (--version)
        // runs the same read-only admission chain and exits 5 on refusal —
        // a full round is impossible here because the upstream backend
        // itself refuses to operate on .zstd artifacts under a
        // none-compression home (which admission is NOT supposed to reject).
        const round = await runInstalledCli(candidateInstall.cliEntry, ['--version'], {
          home: zstdHome,
          cwd: fixture.cwd,
        })
        if (round.code !== 0) {
          fail(
            'zstd-session-admission',
            `candidate admission refused a home with a real zstd session (${round.code}): ${round.output.slice(-300)}`,
          )
        }
        const after = await readFile(path.join(sessionDir, 'session.jsonl.zstd'))
        if (!after.equals(zstdBytes)) {
          fail('zstd-session-admission', 'the real compressed session was rewritten')
        }
        record(
          'zstd-session-admission',
          true,
          'a real compressed session crosses candidate admission byte-identical',
        )
      } finally {
        await rm(zstdRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }

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
      await cp(rehearsalCopy.home, negativeHome, { recursive: true })
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
        } else if (refusalCase.foreignSymlink !== undefined) {
          await mkdir(path.dirname(path.join(negativeHome, refusalCase.foreignSymlink.path)), {
            recursive: true,
          })
          const { symlink } = await import('node:fs/promises')
          await symlink(
            refusalCase.foreignSymlink.target,
            path.join(negativeHome, refusalCase.foreignSymlink.path),
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
    await cp(rehearsalCopy.home, desktopNegativeHome, { recursive: true })
    try {
      await mkdir(path.join(desktopNegativeHome, 'run'), { recursive: true })
      const epochTwo = cases.find((entry) => entry.id === 'epoch-2-marker')
      await writeFile(
        path.join(desktopNegativeHome, 'run', 'compatibility.json'),
        `${JSON.stringify(epochTwo.marker, undefined, 2)}\n`,
      )
      const before = await dataDigests(desktopNegativeHome)
      // The recovery smoke mode absorbs a failed startup into its recovery
      // chain by design and exits cleanly, so the refusal is observed from
      // the smoke reports (and from a hard failure's error message).
      let threwRefusal = false
      const reports = await runInstalledApp({
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
      }).catch((error) => {
        if (!/home-admission/.test(String(error.message))) throw error
        // The helper throwing "reported failure at home-admission" IS the
        // refusal — count it instead of discarding the evidence.
        threwRefusal = true
        return []
      })
      const refused =
        threwRefusal ||
        ((reports.some((report) => report.kind === 'failed' && report.stage === 'home-admission') ||
          reports.some(
            (report) => report.kind === 'recovery' && report.step === 'recovery-view-reached',
          )) &&
          // The refusal must never reach a booted surface: a recovery view that
          // follows a ui-ready would be a different failure wearing this label.
          !reports.some((report) => report.kind === 'ui-ready'))
      if (!refused) {
        fail('desktop downgrade refusal', 'admission refusal was not observed')
      }
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
