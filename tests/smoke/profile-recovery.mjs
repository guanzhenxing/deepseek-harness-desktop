// M2 smoke: the real RecoverySessionController over the real profile-manager,
// home lease, and transaction journals on a throwaway home. An attributable
// profile failure rolls the journaled reconcile back byte-exact, relaunches
// exactly once, and lands in the recovery view; a drifted candidate surfaces
// conflict without overwriting; a healthy boot commits; home sentinel files
// never change.
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const requireFromShellCore = createRequire(
  path.join(root, 'packages', 'shell-core', 'package.json'),
)
const shellCore = requireFromShellCore('@dsh-desktop/shell-core')
const homeLease = requireFromShellCore('@dsh-desktop/home-lease')

const { RecoverySessionController, StartupFailureError, createDesktopProfileRecovery } = shellCore
const { acquireHomeLease, createInProcessGuardLock } = homeLease

const disposableHomes = []

// A throwaway home with the same refusal rules as the shared test fixture:
// never the real home, never inside the repo, and identity-reverified cleanup.
async function freshHome(label) {
  const userData = await mkdtemp(path.join(tmpdir(), `dsh-m2-${label}-`))
  const home = path.join(userData, 'home')
  await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true, mode: 0o700 })
  const identity = await lstat(userData)
  disposableHomes.push({ userData, dev: identity.dev, ino: identity.ino })
  return home
}

async function disposeHomes() {
  for (const entry of disposableHomes.splice(0)) {
    const identity = await lstat(entry.userData).catch(() => undefined)
    if (identity === undefined) continue
    if (identity.dev !== entry.dev || identity.ino !== entry.ino) {
      throw new Error('refusing to clean a home fixture whose identity changed')
    }
    await rm(entry.userData, { recursive: true, force: true })
  }
}

function sameProbe() {
  return {
    async current() {
      return { pid: process.pid, startIdentity: 'profile-recovery-smoke' }
    },
    async identify(pid) {
      return { pid, startIdentity: 'profile-recovery-smoke' }
    },
    async inspect() {
      return 'same'
    },
    async scanSupported() {
      return 'none'
    },
  }
}

async function leasedSession(home, options) {
  const lease = await acquireHomeLease({
    home,
    entrypoint: 'desktop',
    profile: 'desktop',
    appVersion: '0.0.0',
    probe: sameProbe(),
    guard: createInProcessGuardLock(),
  })
  const marker = { value: undefined }
  const session = {
    attempts: [],
    views: [],
    surfaces: [],
    controller: undefined,
  }
  session.controller = new RecoverySessionController({
    acquireLease: async () => lease,
    profile: createDesktopProfileRecovery({ home, profileName: 'desktop' }),
    readRecoveryMarker: async () => marker.value,
    writeRecoveryMarker: async (entry) => {
      marker.value = entry
    },
    createAttempt: (_lease, mode) => {
      session.attempts.push(mode)
      return {
        start: () => options.boot(session.attempts.length, mode),
        stop: async () => undefined,
      }
    },
    loadSurface: async (ready) => {
      session.surfaces.push(ready.origin)
    },
    window: {
      showRecoveryView: async (view) => {
        session.views.push(view)
      },
      destroySurface: () => undefined,
    },
  })
  return session
}

const attributedFailure = new StartupFailureError({
  stage: 'resolve-profile',
  code: 'PROFILE_INVALID',
  category: 'profile-composition',
  summary: 'composed profile cannot be resolved',
  retryable: false,
})

const runtimeFailure = new StartupFailureError({
  stage: 'boot',
  code: 'BOOT_FAILED',
  category: 'runtime',
  summary: 'host runtime failed',
  retryable: true,
})

const sentinel = (name) => `# sentinel ${name}\n`

async function seedSentinels(home) {
  await writeFile(path.join(home, '.credentials.yaml'), sentinel('credentials'), { mode: 0o600 })
  await writeFile(path.join(home, 'settings.yaml'), sentinel('settings'), { mode: 0o600 })
  await writeFile(path.join(home, 'cordis.patch.yml'), sentinel('home-patch'), { mode: 0o600 })
}

async function assertSentinels(home) {
  for (const [name, file] of [
    ['credentials', '.credentials.yaml'],
    ['settings', 'settings.yaml'],
    ['home-patch', 'cordis.patch.yml'],
  ]) {
    const bytes = await readFile(path.join(home, file), 'utf8')
    if (bytes !== sentinel(name)) throw new Error(`home sentinel ${file} was modified`)
  }
}

async function journalStates(home) {
  const txRoot = path.join(home, 'run', 'profile-transactions')
  const ids = await readdir(txRoot).catch(() => [])
  const states = []
  for (const id of ids) {
    const journal = JSON.parse(await readFile(path.join(txRoot, id, 'transaction.json'), 'utf8'))
    states.push(journal.state)
  }
  return states
}

try {
  // ── Failure chain: attributed failure → rollback → one relaunch → view ──
  {
    const home = await freshHome('failure')
    await seedSentinels(home)
    const session = await leasedSession(home, {
      // Both normal boots fail with an attributable profile-composition error.
      boot: () => Promise.reject(attributedFailure),
    })
    await session.controller.start().catch(() => undefined)
    if (session.controller.state !== 'recovery') {
      throw new Error(`expected recovery state, got ${session.controller.state}`)
    }
    // Exactly one automatic relaunch after the rollback.
    if (session.attempts.filter((mode) => mode === 'normal').length !== 2) {
      throw new Error(`expected exactly 2 normal boots (1 auto-relaunch), got ${session.attempts}`)
    }
    if (session.views.length !== 1) throw new Error('expected exactly one recovery view')
    if (session.views[0].failure.category !== 'profile-composition') {
      throw new Error(`unexpected failure category ${session.views[0].failure.category}`)
    }
    // The reconcile created the three managed files; both transactions rolled
    // back and removed them again.
    const manifest = path.join(home, 'profiles', 'desktop', 'package.json')
    await readFile(manifest).then(
      () => {
        throw new Error('rollback left a transaction-created manifest behind')
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
    const states = await journalStates(home)
    if (states.length !== 2 || states.some((state) => state !== 'rolled-back')) {
      throw new Error(`expected two rolled-back journals, got ${JSON.stringify(states)}`)
    }
    await assertSentinels(home)
    await session.controller.act('quit')
  }

  // ── Conflict chain: the candidate drifts before rollback → view, no overwrite ──
  {
    const home = await freshHome('conflict')
    await seedSentinels(home)
    const drifted = '{"userChanged":true}\n'
    const session = await leasedSession(home, {
      boot: async () => {
        // The transaction applied; the user rewrites the candidate before the
        // failure is settled.
        await writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), drifted)
        throw attributedFailure
      },
    })
    await session.controller.start().catch(() => undefined)
    if (session.controller.state !== 'recovery') throw new Error('conflict run not in recovery')
    const manifest = await readFile(path.join(home, 'profiles', 'desktop', 'package.json'), 'utf8')
    if (manifest !== drifted) throw new Error('conflict rollback overwrote user bytes')
    const states = await journalStates(home)
    if (!states.includes('conflict')) {
      throw new Error(`expected a conflict journal, got ${JSON.stringify(states)}`)
    }
    await assertSentinels(home)
    await session.controller.act('quit')

    // A conflict must not poison the session: after relaunching into the
    // blocked recovery view, Safe Mode still boots without ever touching the
    // conflicting journal.
    const statesBeforeSafe = await journalStates(home)
    const replay = await leasedSession(home, {
      boot: (index, mode) =>
        mode === 'safe'
          ? Promise.resolve({
              pid: process.pid,
              startIdentity: 'safe-ready',
              surface: { kind: 'loopback', url: 'http://127.0.0.1:43125/?token=x' },
              origin: 'http://127.0.0.1:43125',
            })
          : Promise.reject(attributedFailure),
    })
    await replay.controller.start().catch(() => undefined)
    if (replay.controller.state !== 'recovery') throw new Error('replay did not reach recovery')
    const view = replay.controller.getView()
    if (view.retryAllowed) throw new Error('conflict-blocked view still offers retry')
    if (view.doctorCommand === null) throw new Error('conflict-blocked view hides the doctor hint')
    await replay.controller.act('safe-mode')
    if (replay.controller.state !== 'healthy') {
      throw new Error('safe mode after conflict did not become healthy')
    }
    const statesAfterSafe = await journalStates(home)
    if (JSON.stringify(statesAfterSafe) !== JSON.stringify(statesBeforeSafe)) {
      throw new Error('safe mode after conflict rewrote the conflicting journal')
    }
    await replay.controller.act('quit')
  }

  // ── Healthy chain: surface mounts, transaction commits, no view ──
  {
    const home = await freshHome('healthy')
    await seedSentinels(home)
    const session = await leasedSession(home, {
      boot: async () => ({
        pid: process.pid,
        startIdentity: 'smoke-ready',
        surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=x' },
        origin: 'http://127.0.0.1:43123',
      }),
    })
    await session.controller.start()
    if (session.controller.state !== 'healthy')
      throw new Error('healthy run did not become healthy')
    if (session.views.length !== 0) throw new Error('healthy run showed a recovery view')
    if (session.surfaces.length !== 1) throw new Error('healthy run never mounted the surface')
    const states = await journalStates(home)
    if (states.length !== 1 || states[0] !== 'committed') {
      throw new Error(`expected one committed journal, got ${JSON.stringify(states)}`)
    }
    await assertSentinels(home)
    await session.controller.act('quit')
  }

  // ── Retention: terminal journals stay bounded at 20 ──
  {
    const home = await freshHome('retention')
    await seedSentinels(home)
    const manifestPath = path.join(home, 'profiles', 'desktop', 'package.json')
    for (let round = 0; round < 24; round++) {
      // Each round leaves the manifest one third-party bundle away from the
      // desired state, so every boot plans and retains a fresh transaction —
      // without this the reconcile is a no-op after the first round.
      const raw = await readFile(manifestPath, 'utf8').catch(() => null)
      const manifest = raw === null ? { dsh: { profile: { bundles: [] } } } : JSON.parse(raw)
      manifest.dsh.profile.bundles = [
        `@fixture/retention-${round}`,
        ...manifest.dsh.profile.bundles.filter(
          (bundle) => !String(bundle).startsWith('@fixture/retention-'),
        ),
      ]
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const session = await leasedSession(home, {
        boot: () => Promise.reject(runtimeFailure),
      })
      await session.controller.start().catch(() => undefined)
      await session.controller.act('quit')
    }
    // 24 retained transactions pruned to exactly the 20 most recent.
    const states = await journalStates(home)
    if (states.length !== 20) {
      throw new Error(`journal retention did not settle at 20: ${states.length}`)
    }
    if (states.some((state) => state !== 'retained')) {
      throw new Error(`non-terminal journals left behind: ${JSON.stringify(states)}`)
    }
  }

  console.log('M2 profile-recovery smoke passed')
} finally {
  await disposeHomes()
}
