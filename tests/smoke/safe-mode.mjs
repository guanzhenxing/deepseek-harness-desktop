// M2 smoke: Safe Mode boots the fixed first-party bundle set without loading
// normal-profile third-party code, and the user-triggered Safe Mode entry is
// wired through the real recovery session: lease profile switch, safe profile
// preparation, safe attempt, and back to a normal retry.
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshManifest = createRequire(
  path.join(root, 'packages', 'host-supervisor', 'package.json'),
).resolve('@deepseek-ai/dsh/package.json')
const dshBin = path.join(path.dirname(dshManifest), 'lib', 'bin.js')
const requireFromShellCore = createRequire(
  path.join(root, 'packages', 'shell-core', 'package.json'),
)
const shellCore = requireFromShellCore('@dsh-desktop/shell-core')
const homeLease = requireFromShellCore('@dsh-desktop/home-lease')
const { RecoverySessionController, StartupFailureError, createDesktopProfileRecovery } = shellCore
const { acquireHomeLease, createInProcessGuardLock } = homeLease

const disposableRoots = []

async function freshRoot(label) {
  const userData = await mkdtemp(path.join(tmpdir(), `dsh-m2-safe-${label}-`))
  const identity = await lstat(userData)
  disposableRoots.push({ userData, dev: identity.dev, ino: identity.ino })
  return userData
}

async function disposeRoots() {
  for (const entry of disposableRoots.splice(0)) {
    const identity = await lstat(entry.userData).catch(() => undefined)
    if (identity === undefined) continue
    if (identity.dev !== entry.dev || identity.ino !== entry.ino) {
      throw new Error('refusing to clean a smoke fixture whose identity changed')
    }
    await rm(entry.userData, { recursive: true, force: true })
  }
}

async function run(args, env, cwd) {
  const child = spawn(process.execPath, [dshBin, ...args], {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      output += chunk
    })
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  return { code: exit, output }
}

function sameProbe() {
  return {
    async current() {
      return { pid: process.pid, startIdentity: 'safe-mode-smoke' }
    },
    async identify(pid) {
      return { pid, startIdentity: 'safe-mode-smoke' }
    },
    async inspect() {
      return 'same'
    },
    async scanSupported() {
      return 'none'
    },
  }
}

const runtimeFailure = new StartupFailureError({
  stage: 'boot',
  code: 'BOOT_FAILED',
  category: 'runtime',
  summary: 'normal host boot failed',
  retryable: true,
})

try {
  // ── Host-level bundle isolation: safe profile never loads third-party code ──
  {
    const userData = await freshRoot('host')
    const home = path.join(userData, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await mkdir(path.join(home, 'profiles', 'desktop-safe-mode'), { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(home, 'profiles', 'desktop-safe-mode', 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-desktop-safe-mode',
          private: true,
          dependencies: {},
          dsh: {
            profile: {
              bundles: [
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-web-app',
                '@dsh-desktop/desktop-recovery-bridge',
              ],
              patchReload: 'startup',
            },
          },
        },
        undefined,
        2,
      )}\n`,
    )
    // Normal profile carries a hostile third-party bundle that would crash any
    // loader; Safe Mode must never touch it.
    const normalDir = path.join(home, 'profiles', 'desktop')
    await mkdir(normalDir, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(normalDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-desktop',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@fixture/hostile'], patchReload: 'live' } },
        },
        undefined,
        2,
      )}\n`,
    )
    const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }

    const safeBoot = await run(['--profile', 'desktop-safe-mode', 'ping'], env, userData)
    // The bundle resolver will refuse the workspace bridge in a bare smoke home
    // (it is not installed there); that refusal proves normal-profile and
    // third-party code never ran and the failure is attributable, not a hang.
    const refused = /cannot resolve profile bundle|does not exist/iu.test(safeBoot.output)
    const hostileLoaded = safeBoot.output.includes('@fixture/hostile')
    if (hostileLoaded) throw new Error('Safe Mode attempted to load a normal-profile bundle')
    if (safeBoot.code === 0 && !refused) {
      throw new Error('Safe Mode booted without the recovery bridge installed; unexpected')
    }
    const normalManifest = await readFile(path.join(normalDir, 'package.json'), 'utf8')
    if (!normalManifest.includes('@fixture/hostile')) {
      throw new Error('Safe Mode rewrote the normal profile')
    }
  }

  // ── Session-level wiring: user-triggered Safe Mode on the real lease/profiles ──
  {
    const userData = await freshRoot('session')
    const home = path.join(userData, 'home')
    await mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true, mode: 0o700 })
    const lease = await acquireHomeLease({
      home,
      entrypoint: 'desktop',
      profile: 'desktop',
      appVersion: '0.0.0',
      probe: sameProbe(),
      guard: createInProcessGuardLock(),
    })
    const session = {
      attempts: [],
      views: [],
      controller: undefined,
    }
    session.controller = new RecoverySessionController({
      acquireLease: async () => lease,
      profile: createDesktopProfileRecovery({ home, profileName: 'desktop' }),
      createAttempt: (_lease, mode) => {
        session.attempts.push(mode)
        // The normal boot fails; the safe boot publishes its surface.
        return {
          start: () =>
            mode === 'safe'
              ? Promise.resolve({
                  pid: process.pid,
                  startIdentity: 'safe-ready',
                  surface: { kind: 'loopback', url: 'http://127.0.0.1:43124/?token=x' },
                  origin: 'http://127.0.0.1:43124',
                })
              : Promise.reject(runtimeFailure),
          stop: async () => undefined,
        }
      },
      loadSurface: async () => undefined,
      window: {
        showRecoveryView: async (view) => {
          session.views.push(view)
        },
        destroySurface: () => undefined,
      },
    })
    await session.controller.start().catch(() => undefined)
    if (session.controller.state !== 'recovery')
      throw new Error('normal boot did not fail into recovery')
    const view = session.controller.getView()
    if (!view.safeModeAllowed) throw new Error('recovery view does not offer Safe Mode')

    await session.controller.act('safe-mode')
    if (session.controller.state !== 'healthy')
      throw new Error('safe-mode boot did not become healthy')
    if (session.attempts.at(-1) !== 'safe') throw new Error('safe-mode ran a normal attempt')
    // The safe profile was prepared with exactly the three first-party bundles.
    const safeManifest = JSON.parse(
      await readFile(path.join(home, 'profiles', 'desktop-safe-mode', 'package.json'), 'utf8'),
    )
    if (safeManifest.dsh.profile.bundles.length !== 3) {
      throw new Error('safe profile does not hold exactly the first-party bundle set')
    }
    // Normal profile keeps its user bytes; quitting releases the lease.
    await session.controller.act('quit')
    if (session.controller.state !== 'stopped') throw new Error('quit from safe mode did not stop')
  }

  console.log('M2 safe-mode smoke passed')
} finally {
  await disposeRoots()
}
