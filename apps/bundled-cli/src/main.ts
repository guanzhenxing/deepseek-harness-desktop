import { fork, type Serializable } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  LeaseError,
  resolveDesktopHome,
  type GuardLock,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'
import { PRODUCT } from '@dsh-desktop/product-config'

import { runDoctorUnlock } from './doctor.js'
import { resolveCliRuntime } from './runtime-paths.js'

const childModule = fileURLToPath(new URL('./cli-child.js', import.meta.url))

const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGKILL: 137,
  SIGTERM: 143,
}

export type CliInvocationPlan =
  | Readonly<{ kind: 'doctor-unlock' }>
  | Readonly<{ kind: 'passthrough'; profile: string | undefined }>

/**
 * Decide what the wrapper owns. Only the exact `doctor --unlock` argv is
 * intercepted; everything else is forwarded to the official CLI verbatim.
 * The profile scan mirrors the upstream launcher grammar: `web` is an alias
 * for `--profile web`, `plugin` requires `--profile`, and root launcher
 * flags come before the first inner argument.
 */
export function planCliInvocation(argv: readonly string[]): CliInvocationPlan {
  if (argv.length === 2 && argv[0] === 'doctor' && argv[1] === '--unlock') {
    return { kind: 'doctor-unlock' }
  }
  let profile: string | undefined
  if (argv[0] === 'web') {
    profile = 'web'
  } else if (argv[0] === 'plugin') {
    for (const token of argv) {
      if (token === undefined) continue
      if (token.startsWith('--profile=')) profile = token.slice('--profile='.length)
    }
    const index = argv.indexOf('--profile')
    if (index >= 0 && argv[index + 1] !== undefined) profile = argv[index + 1]
  } else {
    let expectingValue = false
    for (const token of argv) {
      if (expectingValue) {
        profile = token
        expectingValue = false
        continue
      }
      if (token === '--') break
      if (token === '--profile') {
        expectingValue = true
        continue
      }
      if (token.startsWith('--profile=')) {
        profile = token.slice('--profile='.length)
        continue
      }
      if (token.startsWith('-')) continue
      // First positional token starts the inner app arguments; launcher
      // flags cannot appear after it.
      break
    }
    if (expectingValue) profile = undefined
  }
  return { kind: 'passthrough', profile }
}

export interface CliChildHandle {
  readonly pid: number
  send(message: unknown): void
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  kill(signal?: NodeJS.Signals): void
}

export type SpawnCliChild = (
  input: Readonly<{
    argv: readonly string[]
    env: Record<string, string>
  }>,
) => CliChildHandle

function forkCliChild(
  input: Readonly<{ argv: readonly string[]; env: Record<string, string> }>,
): CliChildHandle {
  // A detached fork puts the child (and every process it spawns) into the
  // child's own process group, so the wrapper can observe and reap the whole
  // write-home tree, not just the direct child.
  const child = fork(childModule, [], {
    env: input.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    detached: true,
  })
  if (child.pid === undefined) throw new Error('forked CLI child has no PID')
  const pgid = child.pid
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const forward = (signal: NodeJS.Signals): void => {
    process.kill(-pgid, signal)
  }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGHUP', () => forward('SIGHUP'))
  return {
    pid: child.pid,
    send: (message) => child.send(message as Serializable),
    exited,
    kill: (signal = 'SIGTERM') => process.kill(-pgid, signal),
  }
}

export type RunBundledCliOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>
  osHome?: string
  cwd?: string
  probe?: ProcessProbe
  guard?: GuardLock
  spawnChild?: SpawnCliChild
  appVersion?: string
  stderr?: NodeJS.WritableStream
  /** Test hooks for the descendant process-group checks. */
  groupAlive?: (pgid: number) => boolean
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void
  descendantGraceMs?: number
  descendantEscalationMs?: number
}>

function defaultGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function defaultKillGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    /* the group may already be gone */
  }
}

/**
 * Wait for the child's whole process group — including any write-home
 * descendants — to disappear after the direct child exits. Stragglers get a
 * bounded grace period, then TERM→KILL escalation; a group that cannot be
 * proven dead keeps the lease.
 */
async function waitForDescendants(pgid: number, options: RunBundledCliOptions): Promise<boolean> {
  const groupAlive = options.groupAlive ?? defaultGroupAlive
  const killGroup = options.killGroup ?? defaultKillGroup
  const graceMs = options.descendantGraceMs ?? 10_000
  const escalationMs = options.descendantEscalationMs ?? 2_000
  if (!groupAlive(pgid)) return true
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    await sleep(Math.min(100, graceMs))
    if (!groupAlive(pgid)) return true
  }
  killGroup(pgid, 'SIGTERM')
  for (let waited = 0; waited < escalationMs; waited += Math.min(100, escalationMs)) {
    await sleep(Math.min(100, escalationMs))
    if (!groupAlive(pgid)) return true
  }
  killGroup(pgid, 'SIGKILL')
  for (let waited = 0; waited < escalationMs; waited += Math.min(100, escalationMs)) {
    await sleep(Math.min(100, escalationMs))
    if (!groupAlive(pgid)) return true
  }
  return false
}

function childEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  result.DSH_HOME = home
  return result
}

function exitCodeOf(exit: { code: number | null; signal: string | null }): number {
  if (exit.code !== null) return exit.code
  if (exit.signal !== null) return SIGNAL_EXIT_CODES[exit.signal] ?? 1
  return 1
}

/**
 * Run one `dsh-native` invocation. The wrapper holds the whole-home lease for
 * the resolved profile before the official CLI child imports its entry; the
 * child's OS identity is registered on the lease before boot authorization.
 */
export async function runBundledCli(
  argv: readonly string[],
  options: RunBundledCliOptions = {},
): Promise<number> {
  const stderr = options.stderr ?? process.stderr
  const env = options.env ?? process.env
  const osHome = options.osHome ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const spawnChild = options.spawnChild ?? forkCliChild
  const home = resolveDesktopHome({ env, osHome, cwd })

  const plan = planCliInvocation(argv)
  if (plan.kind === 'doctor-unlock') {
    return runDoctorUnlock({
      home,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.guard === undefined ? {} : { guard: options.guard }),
      stderr,
    })
  }
  const runtime = resolveCliRuntime(env)
  const probe =
    options.probe ??
    createNativeProcessProbe({
      helperPath: runtime.leaseHelper,
      entryExecutables: runtime.desktopEntryExecutables,
      excludePids: [process.pid],
    })

  if (plan.profile === undefined) {
    // Upstream prints its own help/version/error for unresolvable profiles
    // and never writes the home on those paths, so no lease is taken.
    const child = spawnChild({ argv, env: childEnvironment(env, home) })
    child.send({ kind: 'dsh-native-authorized', argv, dshBin: runtime.dshBin })
    const exit = await child.exited
    const descendantsGone = await waitForDescendants(child.pid, options)
    if (!descendantsGone) return 4
    return exitCodeOf(exit)
  }

  let lease
  try {
    lease = await acquireHomeLease({
      home,
      entrypoint: 'bundled-cli',
      profile: plan.profile,
      appVersion: options.appVersion ?? PRODUCT.cliName,
      probe,
      ...(options.guard === undefined ? {} : { guard: options.guard }),
    })
  } catch (error) {
    if (error instanceof LeaseError) {
      stderr.write(
        `dsh-native: cannot use this home (${error.code}): ${error.message}\n` +
          (error.ownerSummary !== undefined ? `dsh-native: owner ${error.ownerSummary}\n` : '') +
          'dsh-native: entries of a custom home must use the same DSH_HOME; run dsh-native doctor --unlock for stale locks\n',
      )
      return 3
    }
    throw error
  }

  let leaseKeptForDiagnosis = false
  try {
    await lease.beforeSpawn(plan.profile)
    let child: CliChildHandle | undefined
    let authorized = false
    try {
      child = spawnChild({ argv, env: childEnvironment(env, home) })
      const identity = await probe.identify(child.pid)
      await lease.attachHost(identity)
      child.send({ kind: 'dsh-native-authorized', argv, dshBin: runtime.dshBin })
      authorized = true
      const exit = await child.exited
      // Wait for write-home descendants (pnpm and anything the official CLI
      // spawned) before proving the home is writable again.
      const descendantsGone = await waitForDescendants(child.pid, options)
      if (!descendantsGone) {
        leaseKeptForDiagnosis = true
        stderr.write(
          'dsh-native: cannot prove the CLI process group exited; keeping the home lease\n' +
            'dsh-native: run dsh-native doctor --unlock once the processes are gone\n',
        )
        return 4
      }
      await lease.confirmHostExited()
      return exitCodeOf(exit)
    } catch (error) {
      // A forked child that never received authorization must be provably
      // reaped before the lease registration is cleared and released.
      if (child !== undefined && !authorized) {
        const reaped = await reapUnauthorizedChild(child)
        if (!reaped) {
          // The child may still be alive and must never be trusted to stay
          // idle: keep the lease for doctor diagnostics instead of releasing.
          leaseKeptForDiagnosis = true
          stderr.write(
            'dsh-native: cannot prove the unauthorized CLI child exited; keeping the home lease\n' +
              'dsh-native: run dsh-native doctor --unlock once the process is gone\n',
          )
          return 4
        }
      }
      await lease.confirmHostExited().catch(() => undefined)
      throw error
    }
  } finally {
    if (!leaseKeptForDiagnosis) {
      await lease.release().catch((error: unknown) => {
        stderr.write(
          `dsh-native: keeping the home lease after exit: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      })
    }
  }
}

/** Returns whether the child provably exited within the escalation budget. */
async function reapUnauthorizedChild(child: CliChildHandle): Promise<boolean> {
  let exited = false
  void child.exited.then(
    () => {
      exited = true
    },
    () => undefined,
  )
  child.kill('SIGTERM')
  await Promise.race([child.exited.catch(() => undefined), sleep(2_000)])
  if (!exited) {
    child.kill('SIGKILL')
    await Promise.race([child.exited.catch(() => undefined), sleep(500)])
  }
  return exited
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
