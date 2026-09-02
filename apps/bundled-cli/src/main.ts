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
  const child = fork(childModule, [], {
    env: input.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })
  if (child.pid === undefined) throw new Error('forked CLI child has no PID')
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal)
  }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGHUP', () => forward('SIGHUP'))
  return {
    pid: child.pid,
    send: (message) => child.send(message as Serializable),
    exited,
    kill: (signal = 'SIGTERM') => child.kill(signal),
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
}>

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
    return exitCodeOf(await child.exited)
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
      await lease.confirmHostExited()
      return exitCodeOf(exit)
    } catch (error) {
      // A forked child that never received authorization must be reaped
      // before the lease registration is cleared and released.
      if (child !== undefined && !authorized) {
        await reapUnauthorizedChild(child)
      }
      await lease.confirmHostExited().catch(() => undefined)
      throw error
    }
  } finally {
    await lease.release().catch((error: unknown) => {
      stderr.write(
        `dsh-native: keeping the home lease after exit: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
  }
}

async function reapUnauthorizedChild(child: CliChildHandle): Promise<void> {
  child.kill('SIGTERM')
  await Promise.race([child.exited, new Promise<void>((r) => setTimeout(r, 2_000))])
  child.kill('SIGKILL')
  await Promise.race([child.exited, new Promise<void>((r) => setTimeout(r, 500))])
}
