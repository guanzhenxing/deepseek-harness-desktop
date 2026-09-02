import { LeaseError, type HomeLease } from '@dsh-desktop/home-lease'
import type { HostReady } from '@dsh-desktop/host-supervisor'

import { shouldRollbackProfile, type StartupFailure } from './failure-policy.js'
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

export type AttemptMode = 'normal' | 'safe'

export type CreateAttempt = (lease: HomeLease, mode: AttemptMode) => HostAttempt

export type ProfilePrepareResult =
  | Readonly<{ kind: 'ready'; transactionId?: string; changed: boolean }>
  | Readonly<{ kind: 'blocked'; failure: StartupFailure }>

/**
 * The profile-manager operations the session drives. Injected as a port so
 * shell-core never depends on profile-manager; `prepare` settles interrupted
 * journals from previous runs, quarantines the rebuildable projection cache,
 * and applies the journaled reconcile before any Host boot.
 */
export interface ProfileRecoveryPort {
  prepare(lease: HomeLease): Promise<ProfilePrepareResult>
  /** Settle a pending transaction as committed: Host ready, surface mounted. */
  settleCommitted(transactionId: string, lease: HomeLease): Promise<void>
  rollback(transactionId: string, lease: HomeLease): Promise<'restored' | 'conflict'>
  retain(
    transactionId: string,
    lease: HomeLease,
    failure: Readonly<{ category: string; code: string }>,
  ): Promise<void>
  /** Switch the lease owner profile and prepare the desktop-safe-mode profile. */
  enterSafeMode(lease: HomeLease): Promise<'prepared' | 'conflict'>
  /** Restore the normal owner profile before a normal retry or release. */
  exitSafeMode(lease: HomeLease): Promise<void>
}

export type RecoverySessionOptions = Readonly<{
  acquireLease(): Promise<HomeLease>
  profile: ProfileRecoveryPort
  createAttempt: CreateAttempt
  loadSurface(ready: HostReady): Promise<void>
  window: RecoveryWindowPort
  shutdownDeadlineMs?: number
  onSessionFailure?(failure: StartupFailure): void
  onLeaseReleaseError?(error: unknown): void
  /**
   * Marker store for the single automatic profile-recovery relaunch. A marker
   * bound to the pending transaction means its budget is already spent, even
   * in a brand-new process.
   */
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
 * explicit, bounded retries. A failed boot settles its profile transaction
 * first — attributed failures roll the profile back and earn exactly one
 * automatic normal relaunch; everything else is retained untouched. Post-ready
 * crashes never auto-restart; manual retries are budgeted per rolling window;
 * quit always wins races.
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
  #pendingTransaction: string | undefined
  #changed = false
  #surfaceMounted = false
  #mode: AttemptMode = 'normal'
  #autoRestartUsed = false
  #safeModeBlocked = false

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
    // Startup actions exist only while the session still holds the lease:
    // a lease-less recovery view may offer diagnosis and quit, nothing else.
    const leaseHeld = this.#lease !== undefined
    return Object.freeze({
      failure: this.#failure,
      retryAllowed:
        leaseHeld &&
        this.#state === 'recovery' &&
        this.#failure.retryable &&
        this.#retryBudgetRemaining() > 0,
      safeModeAllowed: leaseHeld && this.#state === 'recovery' && !this.#safeModeBlocked,
      doctorCommand:
        this.#failure.stage === 'recover-transactions'
          ? ('dsh-native doctor --unlock' as const)
          : null,
    })
  }

  async start(): Promise<void> {
    this.#state = 'starting'
    // Startup joins the in-flight chain so a quit arriving mid-acquisition
    // merges with it instead of exiting before the lease exists to release.
    const run = this.#startSession()
    this.#inFlight = run
    try {
      await run
    } finally {
      if (this.#inFlight === run) this.#inFlight = undefined
    }
  }

  async #startSession(): Promise<void> {
    try {
      const lease = await this.#options.acquireLease()
      this.#lease = lease
      await this.#prepareAndRun(lease)
    } catch (error) {
      if (error instanceof LeaseError) {
        // Lease refusal belongs to the entry lifecycle (launcher dialog or
        // CLI exit code), not to the in-app recovery window.
        this.#state = 'recovery'
        throw error
      }
      await this.#failAndRecover(error)
      if (!this.#isHealthy()) throw error
    }
  }

  #isHealthy(): boolean {
    return this.#state === 'healthy'
  }

  /**
   * A post-ready Host crash moves the session into recovery without touching
   * the outer lease: the attempt is already gone, and manual retry may build a
   * fresh attempt on the same lease. The crashed boot's profile transaction
   * was already committed — a post-ready crash never justifies reopening it.
   * The surface-mounted window also counts: a crash between mount and the
   * healthy transition must not leave a dead Host behind a healthy state.
   */
  async hostCrashed(failure?: StartupFailure): Promise<void> {
    if (this.#state !== 'healthy' && !this.#surfaceMounted) return
    if (this.#state === 'stopped') return
    this.#surfaceMounted = false
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
      const retry = this.#runAct(this.#retry())
      await retry
      if (this.#quitRequest) {
        await this.#stopAndRelease().catch(() => undefined)
      }
      return
    }
    if (action === 'safe-mode' && this.#state === 'recovery' && !this.#safeModeBlocked) {
      const enter = this.#runAct(this.#enterSafeMode())
      await enter
      if (this.#quitRequest) {
        await this.#stopAndRelease().catch(() => undefined)
      }
      return
    }
  }

  /** Track an action as in-flight with guaranteed cleanup on rejection. */
  #runAct(action: Promise<void>): Promise<void> {
    this.#inFlight = action
    return action.finally(() => {
      if (this.#inFlight === action) this.#inFlight = undefined
    })
  }

  async #retry(): Promise<void> {
    if (this.#lease === undefined || this.#quitRequest) return
    this.#recordRetry()
    this.#state = 'starting'
    try {
      if (this.#mode === 'safe') {
        await this.#options.profile.exitSafeMode(this.#lease)
        this.#mode = 'normal'
      }
      await this.#prepareAndRun(this.#lease)
    } catch (error) {
      await this.#failAndRecover(error)
    }
  }

  async #enterSafeMode(): Promise<void> {
    if (this.#lease === undefined || this.#quitRequest) return
    let entered: 'prepared' | 'conflict'
    try {
      entered = await this.#options.profile.enterSafeMode(this.#lease)
    } catch (error) {
      console.error('safe-mode entry failed:', error instanceof Error ? error.message : error)
      entered = 'conflict'
    }
    if (entered === 'conflict') {
      // Unknown user content in the safe profile: never overwrite it, stay on
      // the local recovery page with the Safe Mode entry withdrawn.
      this.#safeModeBlocked = true
      await this.#options.window.showRecoveryView(this.getView())
      return
    }
    this.#mode = 'safe'
    this.#state = 'starting'
    try {
      await this.#runAttempt(this.#lease, 'safe')
    } catch (error) {
      await this.#failAndRecover(error)
    }
  }

  async #prepareAndRun(lease: HomeLease): Promise<void> {
    const prepared = await this.#options.profile.prepare(lease)
    if (prepared.kind === 'blocked') throw new StartupFailureError(prepared.failure)
    this.#pendingTransaction = prepared.transactionId
    this.#changed = prepared.changed
    await this.#runAttempt(lease, 'normal')
  }

  async #runAttempt(lease: HomeLease, mode: AttemptMode): Promise<void> {
    const attempt = this.#options.createAttempt(lease, mode)
    this.#attempt = attempt
    this.#state = 'starting'
    this.#surfaceMounted = false
    const ready = await attempt.start()
    await this.#options.loadSurface(ready)
    this.#surfaceMounted = true
    // `committed` is written only after the Host became ready and the real
    // window mounted the surface — the transaction's evidence of health.
    if (this.#pendingTransaction !== undefined) {
      await this.#options.profile.settleCommitted(this.#pendingTransaction, lease)
      this.#pendingTransaction = undefined
    }
    // A crash handled by hostCrashed() during the commit awaits already moved
    // the session to recovery; never overwrite that verdict with healthy.
    if (this.#state === 'recovery') return
    this.#state = 'healthy'
  }

  /**
   * Stop the failed attempt, settle its pending profile transaction, and show
   * the recovery view. An attributed failure with a matching journal rolls
   * the profile back and earns exactly one automatic normal relaunch; a
   * rollback conflict or a spent budget stops at the view.
   */
  async #failAndRecover(error: unknown): Promise<void> {
    for (;;) {
      const failure = error instanceof StartupFailureError ? error.failure : fallbackFailure(error)
      await this.#stopAttemptSafely()
      this.#surfaceMounted = false
      this.#state = 'recovery'
      this.#failure = failure
      this.#options.onSessionFailure?.(failure)

      if (this.#pendingTransaction !== undefined && this.#lease !== undefined) {
        const transactionId = this.#pendingTransaction
        if (
          !this.#surfaceMounted &&
          shouldRollbackProfile({ failure, changed: this.#changed, healthy: false })
        ) {
          let outcome: 'restored' | 'conflict'
          try {
            outcome = await this.#options.profile.rollback(transactionId, this.#lease)
          } catch (rollbackError) {
            console.error(
              'profile rollback failed:',
              rollbackError instanceof Error ? rollbackError.message : rollbackError,
            )
            outcome = 'conflict'
          }
          if (outcome === 'restored') {
            this.#pendingTransaction = undefined
            if (!this.#quitRequest && (await this.#mayAutoRestart(transactionId))) {
              this.#autoRestartUsed = true
              await this.#options
                .writeRecoveryMarker?.({ transactionId, attempt: 1 })
                .catch(() => undefined)
              try {
                await this.#prepareAndRun(this.#lease)
                return // healthy again: no recovery view needed
              } catch (restartError) {
                error = restartError
                continue // settle the restarted run; the budget is spent
              }
            }
            break
          }
          // Conflict: the journal records the divergence and stays untouched;
          // nothing about this transaction may be settled or rewritten later.
          this.#pendingTransaction = undefined
          break
        }
        await this.#options.profile
          .retain(transactionId, this.#lease, {
            category: failure.category,
            code: failure.code,
          })
          .catch((retainError: unknown) => {
            console.error(
              'profile transaction retain failed:',
              retainError instanceof Error ? retainError.message : retainError,
            )
          })
        this.#pendingTransaction = undefined
        break
      }
      break
    }
    this.#options.window.destroySurface()
    await this.#options.window.showRecoveryView(this.getView())
  }

  async #mayAutoRestart(transactionId: string): Promise<boolean> {
    if (this.#autoRestartUsed) return false
    const marker = await this.#options.readRecoveryMarker?.()
    if (typeof marker === 'object' && marker !== null) {
      const recorded = marker as { transactionId?: unknown }
      if (recorded.transactionId === transactionId) return false
    }
    return true
  }

  async #stopAttemptSafely(): Promise<void> {
    const attempt = this.#attempt
    this.#attempt = undefined
    if (attempt === undefined) return
    try {
      await attempt.stop('quit', this.#options.shutdownDeadlineMs ?? 5_000)
    } catch {
      /* the original failure is what the user needs to see */
    }
  }

  #stopAndRelease(): Promise<void> {
    this.#stopPromise ??= this.#doStopAndRelease()
    return this.#stopPromise
  }

  async #doStopAndRelease(): Promise<void> {
    this.#state = 'stopping'
    try {
      await this.#stopAttemptSafely()
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
