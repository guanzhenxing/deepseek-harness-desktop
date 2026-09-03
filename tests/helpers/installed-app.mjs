import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearTimeout as cancelTimer, setTimeout as sleepTimer } from 'node:timers'

import { waitUntilDead } from './shared-home-driver.mjs'

/**
 * Emergency teardown registry: every launched process group and temporary
 * install tree registers its cleanup here. Signal handlers (and normal
 * process exit) drain the registry, so an interrupted smoke run never leaves
 * installed-app processes, temp install directories, or DMG mounts behind on
 * the user's machine.
 */
const liveCleanups = new Set()

export async function emergencyCleanup() {
  const pending = [...liveCleanups]
  liveCleanups.clear()
  for (const cleanup of pending) {
    await cleanup().catch(() => undefined)
  }
}

function registerCleanup(cleanup) {
  liveCleanups.add(cleanup)
  return () => liveCleanups.delete(cleanup)
}

/**
 * Install the packaged app the way a user would, minus /Applications and
 * Gatekeeper: mount the candidate DMG read-only with hdiutil, copy the .app
 * into a throwaway install directory, unmount, and hand back the copy. The
 * mount is always detached, including on failure paths.
 */
export async function installFromDmg(dmgPath, productName) {
  const output = execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', dmgPath], {
    encoding: 'utf8',
  })
  const mountPoint = output
    .trim()
    .split('\n')
    .at(-1)
    ?.split('\t')
    .map((column) => column.trim())
    .filter((column) => column.startsWith('/'))
    .at(-1)
  if (mountPoint === undefined || !mountPoint.startsWith('/')) {
    throw new Error(`could not parse hdiutil mount point from: ${output}`)
  }
  const installDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-installed-app-'))
  try {
    const appBundle = path.join(mountPoint, `${productName}.app`)
    const identity = await lstat(appBundle)
    if (!identity.isDirectory()) throw new Error(`${appBundle} is not an app bundle`)
    // ditto is Apple's tool for copying .app bundles: it preserves the
    // relative symlink trees (Electron Framework, the pnpm closures) AND the
    // code-signature resources — a plain cp leaves the copied bundle with an
    // invalid signature, which the kernel then kills at launch.
    execFileSync('/usr/bin/ditto', [appBundle, path.join(installDirectory, `${productName}.app`)])
  } catch (error) {
    execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
    await rm(installDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw error
  }
  execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
  const appPath = path.join(installDirectory, `${productName}.app`)
  const resources = path.join(appPath, 'Contents', 'Resources')
  const unregister = registerCleanup(() => rm(installDirectory, { recursive: true, force: true }))
  return {
    installDirectory,
    appPath,
    executable: path.join(appPath, 'Contents', 'MacOS', productName),
    cliEntry: path.join(resources, 'runtime-cli', 'bin', 'dsh-native'),
    async dispose() {
      unregister()
      const identity = await lstat(installDirectory)
      if (
        identity.isSymbolicLink() ||
        !identity.isDirectory() ||
        path.dirname(await realpath(installDirectory)) !== (await realpath(tmpdir())) ||
        !path.basename(installDirectory).startsWith('dsh-installed-app-')
      ) {
        throw new Error(`refusing to clean an unexpected install directory: ${installDirectory}`)
      }
      await rm(installDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

/**
 * Launch the installed app executable in a driver-owned smoke mode with a
 * scrubbed environment (no NODE_PATH/NODE_OPTIONS, minimal PATH, neutral cwd
 * outside the repository). Resolves the captured smoke reports when the app
 * exits; rejects on non-zero exits or a 'failed' report.
 */
export async function runInstalledApp(input) {
  const {
    executable,
    mode,
    userData,
    home,
    action,
    cwd,
    timeoutMs = 240_000,
    graceMs = 90_000,
  } = input
  const reports = []
  const child = spawn(executable, [], {
    cwd,
    detached: true,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME,
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      DSH_DESKTOP_SMOKE: mode,
      DSH_DESKTOP_M0_USER_DATA: userData,
      ...(home === undefined ? {} : { DSH_HOME: home }),
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const unregisterGroup = registerCleanup(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    return Promise.resolve()
  })
  const consumeLines = (stream, onLine) => {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim() !== '') onLine(line)
      }
    })
  }
  consumeLines(child.stdout, (line) => {
    if (line.startsWith('DSH_DESKTOP_SMOKE ')) {
      reports.push(JSON.parse(line.slice('DSH_DESKTOP_SMOKE '.length)))
    } else {
      process.stdout.write(`${line}\n`)
    }
  })
  consumeLines(child.stderr, (line) => process.stderr.write(`${line}\n`))
  const timeout = sleepTimer(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  timeout.unref?.()
  try {
    if (action !== undefined) {
      await action({
        reports,
        async waitFor(predicate, label, waitMs = 180_000) {
          const deadline = Date.now() + waitMs
          for (;;) {
            const found = reports.find(predicate)
            if (found !== undefined) return found
            if (Date.now() > deadline) {
              throw new Error(`timed out waiting for ${label ?? 'an app report'}`)
            }
            await new Promise((resolve) => sleepTimer(resolve, 200))
          }
        },
      })
    }
  } finally {
    cancelTimer(timeout)
    // Driver-owned modes quit through their own before-quit chain; give that
    // chain a real grace window before escalating to signals (a SIGTERM mid-
    // quit would report the run as a signal kill and hide the real exit code).
    await Promise.race([exited, new Promise((resolve) => sleepTimer(resolve, graceMs))])
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  exited.then(
    () => unregisterGroup(),
    () => unregisterGroup(),
  )
  const exit = await Promise.race([
    exited,
    new Promise((resolve) => {
      const killTimer = sleepTimer(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
        resolve({ code: null, signal: 'SIGKILL' })
      }, 30_000)
      killTimer.unref?.()
    }),
  ])
  if (exit.code !== 0) {
    throw new Error(`installed app exited with code ${exit.code} signal ${exit.signal}`)
  }
  // In recovery mode the poisoned boot settles through the recovery chain by
  // design: start() rejects (reported as failed/startup) before the scripted
  // sequence takes over. Only the sequence's own failure flag counts there.
  const failed = reports.find(
    (report) => report.kind === 'failed' && !(mode === 'recovery' && report.stage === 'startup'),
  )
  if (failed !== undefined) {
    throw new Error(`installed app reported failure at ${failed.stage}`)
  }
  for (const report of reports) {
    for (const pid of [report.launcherPid, report.hostPid]) {
      if (Number.isSafeInteger(pid)) await waitUntilDead(pid, 20_000)
    }
  }
  return reports
}

/**
 * Run the installed CLI shim with the same scrubbed environment semantics.
 * argv forwards verbatim; resolve/PATH never touch the repository.
 */
export async function runInstalledCli(cliEntry, argv, options = {}) {
  const child = spawn(cliEntry, argv, {
    cwd: options.cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME,
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_HOME: options.home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => output.push(chunk))
  }
  const exit = await new Promise((resolve, reject) => {
    const timer = sleepTimer(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      reject(
        new Error(`installed cli ${argv[0]} timed out after ${options.timeoutMs ?? 240_000}ms`),
      )
    }, options.timeoutMs ?? 240_000)
    child.once('error', (error) => {
      cancelTimer(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cancelTimer(timer)
      resolve({ code, signal })
    })
  })
  return { ...exit, output: output.join('') }
}
