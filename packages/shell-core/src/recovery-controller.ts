import { LeaseError, type HomeLease } from '@dsh-desktop/home-lease'
import type { HostReady } from '@dsh-desktop/host-supervisor'

import type { StartupFailure } from './failure-policy.js'
import type { HostAttempt } from './lifecycle.js'

export type RecoveryAction = 'retry' | 'safe-mode' | 'quit'

export type RecoveryView = Readonly<{
  failure: StartupFailure
  retryAllowed: boolean
  safeModeAllowed: boolean
  doctorCommand: 'dsh-native doctor --unlock' | null
}>

export interface RecoveryController {
  getView(): RecoveryView
  act(action: RecoveryAction): Promise<void>
}

export interface RecoveryWindowPort {
  showRecoveryView(view: RecoveryView): Promise<void>
  destroySurface(): void
}

export type CreateAttempt = (lease: HomeLease) => HostAttempt

export type RecoverySessionOptions = Readonly<{
  acquireLease(): Promise<HomeLease>
  reconcile(lease: HomeLease): Promise<void>
  createAttempt: CreateAttempt
  loadSurface(ready: HostReady): Promise<void>
  window: RecoveryWindowPort
  shutdownDeadlineMs?: number
  onSessionFailure?(failure: StartupFailure): void
  onLeaseReleaseError?(error: unknown): void
  /** Marker store for the single automatic profile-recovery relaunch. */
  readRecoveryMarker?(): Promise<unknown>
  writeRecoveryMarker?(marker: Readonly<{ transactionId: string; attempt: number }>): Promise<void>
  /** Manual-retry budget: at most `maxRetries` within `retryWindowMs`. */
  maxRetries?: number
  retryWindowMs?: number
  now?(): number
}>

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_WINDOW_MS = 60_000

type SessionState = 'idle' | 'starting' | 'healthy' | 'recovery' | 'stopping' | 'stopped'

/**
 * One desktop session: the outer lease is held once, each (re)try creates a
 * fresh one-shot Host attempt, and the launcher-owned recovery view drives
 * explicit, bounded retries. Post-ready crashes never auto-restart; manual
 * retries are budgeted per rolling window; quit always wins races.
 */
export class RecoverySessionController implements RecoveryController {
  readonly #options: RecoverySessionOptions
  #state: SessionState = 'idle'
  #lease: HomeLease | undefined
  #attempt: HostAttempt | undefined
  #failure: StartupFailure | undefined
  #retryTimestamps: number[] = []
  #inFlight: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined
  #quitRequest = false
  #doctorCommand: RecoveryView['doctorCommand'] = null

  constructor(options: RecoverySessionOptions) {
    this.#options = options
  }

  get state(): SessionState {
    return this.#state
  }

  getView(): RecoveryView {
    if (this.#failure === undefined) {
      throw new Error('recovery view requested without a failure')
    }
    return Object.freeze({
      failure: this.#failure,
      retryAllowed: this.#state === 'recovery' && this.#retryBudgetRemaining() > 0,
      safeModeAllowed: false,
      doctorCommand: this.#doctorCommand,
    })
  }

  async start(): Promise<void> {
    this.#state = 'starting'
    try {
      const lease = await this.#options.acquireLease()
      this.#lease = lease
      await this.#options.reconcile(lease)
      await this.#runAttempt(lease)
    } catch (error) {
      if (error instanceof LeaseError) {
        // Lease refusal belongs to the entry lifecycle (launcher dialog or
        // CLI exit code), not to the in-app recovery window.
        this.#state = 'recovery'
        throw error
      }
      await this.#settleFailure(error)
      throw error
    }
  }

  /**
   * A post-ready Host crash moves the session into recovery without touching
   * the outer lease: the attempt is already gone, and manual retry may build
   * a fresh attempt on the same lease.
   */
  async hostCrashed(failure?: StartupFailure): Promise<void> {
    if (this.#state !== 'healthy') return
    this.#state = 'recovery'
    this.#failure = failure ?? {
      stage: 'host',
      code: 'HOST_CRASHED',
      category: 'runtime',
      summary: 'Host exited after becoming ready',
      retryable: true,
    }
    this.#options.onSessionFailure?.(this.#failure)
    this.#options.window.destroySurface()
    await this.#options.window.showRecoveryView(this.getView())
  }

  async act(action: RecoveryAction): Promise<void> {
    if (action === 'quit') this.#quitRequest = true
    const inFlight = this.#inFlight
    if (inFlight !== undefined) {
      // Concurrent clicks merge into the in-flight action; quit upgrades it.
      await inFlight.catch(() => undefined)
      if (this.#quitRequest && this.#state !== 'stopped') {
        await this.#stopAndRelease().catch(() => undefined)
      }
      return
    }
    if (this.#quitRequest) {
      await this.#stopAndRelease()
      return
    }
    if (action === 'retry' && this.#state === 'recovery') {
      if (this.#retryBudgetRemaining() <= 0) return
      const retry = this.#retry()
      this.#inFlight = retry
      await retry
      this.#inFlight = undefined
      if (this.#quitRequest) {
        await this.#stopAndRelease().catch(() => undefined)
      }
      return
    }
    if (action === 'safe-mode') {
      // Safe Mode arrives in Task 5; the view never offers it until then.
      return
    }
  }

  async #retry(): Promise<void> {
    if (this.#lease === undefined || this.#quitRequest) return
    this.#recordRetry()
    this.#state = 'starting'
    try {
      await this.#runAttempt(this.#lease)
    } catch (error) {
      await this.#settleFailure(error)
    }
  }

  async #runAttempt(lease: HomeLease): Promise<void> {
    const attempt = this.#options.createAttempt(lease)
    this.#attempt = attempt
    const ready = await attempt.start()
    this.#state = 'healthy'
    await this.#options.loadSurface(ready)
  }

  async #settleFailure(error: unknown): Promise<void> {
    // Stop the attempt (idempotent), then surface the recovery view.
    if (this.#attempt !== undefined) {
      try {
        await this.#attempt.stop('quit', this.#options.shutdownDeadlineMs ?? 5_000)
      } catch {
        /* the original failure is what the user needs to see */
      }
    }
    this.#state = 'recovery'
    this.#failure = error instanceof StartupFailureError ? error.failure : fallbackFailure(error)
    this.#options.onSessionFailure?.(this.#failure)
    this.#options.window.destroySurface()
    await this.#options.window.showRecoveryView(this.getView())
  }

  #stopAndRelease(): Promise<void> {
    this.#stopPromise ??= this.#doStopAndRelease()
    return this.#stopPromise
  }

  async #doStopAndRelease(): Promise<void> {
    this.#state = 'stopping'
    try {
      await this.#attempt?.stop('quit', this.#options.shutdownDeadlineMs ?? 5_000)
    } finally {
      if (this.#lease !== undefined) {
        try {
          await this.#lease.release()
        } catch (error) {
          this.#options.onLeaseReleaseError?.(error)
        }
      }
      this.#state = 'stopped'
    }
  }

  #retryBudgetRemaining(): number {
    const now = this.#options.now?.() ?? Date.now()
    const windowMs = this.#options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS
    const max = this.#options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.#retryTimestamps = this.#retryTimestamps.filter((stamp) => now - stamp < windowMs)
    return max - this.#retryTimestamps.length
  }

  #recordRetry(): void {
    this.#retryTimestamps.push(this.#options.now?.() ?? Date.now())
  }

  setDoctorCommand(command: RecoveryView['doctorCommand']): void {
    this.#doctorCommand = command
  }
}

/** Wraps a classified startup failure for transport through the session. */
export class StartupFailureError extends Error {
  constructor(readonly failure: StartupFailure) {
    super(failure.summary)
    this.name = 'StartupFailureError'
  }
}

function fallbackFailure(error: unknown): StartupFailure {
  const summary = error instanceof Error ? error.message : String(error)
  return Object.freeze({
    stage: 'unknown',
    code: 'UNKNOWN',
    category: 'unknown',
    summary: summary.slice(0, 1_024) || 'startup failed',
    retryable: true,
  })
}
