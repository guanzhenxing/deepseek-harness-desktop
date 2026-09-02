import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LeaseError, type ProcessIdentity } from './owner.js'
import type { ProcessProbe, ProcessScanResult, ProcessStatus } from './process-probe.js'

export type HelperJson = Readonly<Record<string, unknown>>

export function defaultLeaseHelperPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/.build/lease-helper')
}

export function resolveLeaseHelperPath(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.DSH_DESKTOP_LEASE_HELPER
  if (override !== undefined && override.trim().length > 0) return path.resolve(override)
  return defaultLeaseHelperPath()
}

function firstJsonLine(chunk: string): HelperJson | undefined {
  const newline = chunk.indexOf('\n')
  if (newline < 0) return undefined
  const line = chunk.slice(0, newline).trim()
  if (line === '') return undefined
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease helper printed a non-object response')
  }
  return parsed as HelperJson
}

async function runHelper(
  helperPath: string,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<HelperJson> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      settle()
    }
    const timer = setTimeout(
      () =>
        finish(() => reject(new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease helper timed out'))),
      timeoutMs,
    )
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      try {
        const parsed = firstJsonLine(stdout)
        if (parsed !== undefined) {
          resolve(parsed)
          finish(() => undefined)
        }
      } catch (error) {
        finish(() => reject(error))
      }
    })
    child.on('error', (error) =>
      finish(() =>
        reject(
          new LeaseError(
            'LEASE_HELPER_UNAVAILABLE',
            `lease helper could not run: ${(error as NodeJS.ErrnoException).code ?? error.message}`,
          ),
        ),
      ),
    )
    child.on('close', () =>
      finish(() => {
        if (stdout.trim() === '') {
          reject(new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease helper exited without output'))
        } else {
          try {
            const parsed = firstJsonLine(stdout)
            if (parsed !== undefined) resolve(parsed)
            else reject(new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease helper output truncated'))
          } catch (error) {
            reject(error)
          }
        }
      }),
    )
  })
}

function requireOk(parsed: HelperJson, operation: string): HelperJson {
  if (parsed.ok !== true) {
    throw new LeaseError(
      'LEASE_HELPER_UNAVAILABLE',
      `lease helper refused ${operation}: ${String(parsed.error ?? 'unspecified')}`,
    )
  }
  return parsed
}

export interface GuardSession {
  release(): Promise<void>
}

export interface GuardLockInput {
  readonly guardPath: string
  readonly parentDirectory: string
  readonly parentDev: number
  readonly parentIno: number
  readonly retryMs?: number
}

export interface GuardLock {
  lock(input: GuardLockInput): Promise<GuardSession>
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Holds flock(LOCK_EX) through the native helper until `release()`. */
export function createNativeGuardLock(helperPath: string): GuardLock {
  return {
    async lock(input) {
      const child = spawn(
        helperPath,
        [
          'lock',
          input.guardPath,
          input.parentDirectory,
          String(input.parentDev),
          String(input.parentIno),
          String(input.retryMs ?? 1_500),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let stdout = ''
      const first = await new Promise<HelperJson>((resolve, reject) => {
        let settled = false
        const finish = (settle: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          settle()
        }
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease guard helper timed out')),
            ),
          10_000,
        )
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
          try {
            const parsed = firstJsonLine(stdout)
            if (parsed !== undefined) {
              resolve(parsed)
              finish(() => undefined)
            }
          } catch (error) {
            finish(() => reject(error))
          }
        })
        child.on('error', (error) =>
          finish(() =>
            reject(
              new LeaseError(
                'LEASE_HELPER_UNAVAILABLE',
                `lease guard helper could not run: ${(error as NodeJS.ErrnoException).code ?? error.message}`,
              ),
            ),
          ),
        )
        child.on('close', () =>
          finish(() => {
            if (stdout.trim() === '') {
              reject(new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease guard helper exited early'))
            } else {
              try {
                const parsed = firstJsonLine(stdout)
                if (parsed !== undefined) resolve(parsed)
                else
                  reject(new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease guard output truncated'))
              } catch (error) {
                reject(error)
              }
            }
          }),
        )
      })
      if (first.ok !== true) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        if (first.error === 'busy') {
          throw new LeaseError('GUARD_BUSY', 'another lease critical section is active')
        }
        throw new LeaseError('LEASE_UNKNOWN', `lease guard was refused: ${String(first.error)}`)
      }
      let released = false
      return {
        async release(): Promise<void> {
          if (released) return
          released = true
          try {
            child.stdin.write('release\n')
            child.stdin.end()
          } catch {
            /* the helper may already be gone; the OS releases flock on exit */
          }
          await waitForExit(child, 2_000)
        },
      }
    },
  }
}

/** Single-process serialization for tests without the native helper. */
export function createInProcessGuardLock(): GuardLock {
  const tails = new Map<string, Promise<void>>()
  return {
    async lock(input) {
      const key = path.resolve(input.guardPath)
      const previous = tails.get(key) ?? Promise.resolve()
      let signal!: () => void
      const gate = new Promise<void>((resolve) => {
        signal = resolve
      })
      tails.set(
        key,
        previous.then(
          () => gate,
          () => gate,
        ),
      )
      await previous.catch(() => undefined)
      return {
        async release() {
          signal()
        },
      }
    },
  }
}

export interface NativeProbeOptions {
  readonly helperPath: string
  readonly entryExecutables: readonly string[]
  readonly excludePids?: readonly number[]
}

async function identifyPid(helperPath: string, pid: number): Promise<ProcessIdentity> {
  const parsed = requireOk(await runHelper(helperPath, ['identity', String(pid)]), 'identity')
  if (
    typeof parsed.pid !== 'number' ||
    Number.isInteger(parsed.pid) === false ||
    typeof parsed.start !== 'string' ||
    parsed.start.length === 0
  ) {
    throw new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease helper returned a malformed identity')
  }
  return Object.freeze({ pid: parsed.pid, startIdentity: parsed.start })
}

/**
 * ProcessProbe backed by the compiled macOS helper. It only reports
 * structured identity/status values — never argv, env, or file descriptors of
 * other processes.
 */
export function createNativeProcessProbe(options: NativeProbeOptions): ProcessProbe {
  const entryCsv = options.entryExecutables.join(',')
  const excludeCsv = (options.excludePids ?? []).join(',')
  return {
    async current() {
      return identifyPid(options.helperPath, process.pid)
    },
    async identify(pid) {
      return identifyPid(options.helperPath, pid)
    },
    async inspect(identity): Promise<ProcessStatus> {
      const parsed = requireOk(
        await runHelper(options.helperPath, [
          'probe',
          String(identity.pid),
          identity.startIdentity,
        ]),
        'probe',
      )
      const status = parsed.status
      if (
        status === 'same' ||
        status === 'absent' ||
        status === 'different' ||
        status === 'unknown'
      ) {
        return status
      }
      throw new LeaseError('LEASE_HELPER_UNAVAILABLE', 'lease helper returned a malformed status')
    },
    async scanSupported(): Promise<ProcessScanResult> {
      try {
        const parsed = requireOk(
          await runHelper(options.helperPath, ['scan', excludeCsv, entryCsv]),
          'scan',
        )
        const result = parsed.result
        if (result === 'none' || result === 'active') return result
        return 'unknown'
      } catch {
        return 'unknown'
      }
    },
  }
}
