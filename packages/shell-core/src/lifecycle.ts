import type { HomeLease } from '@dsh-desktop/home-lease'
import type { HostReady } from '@dsh-desktop/host-supervisor'

export type DesktopShellState =
  | 'idle'
  | 'acquiring-lease'
  | 'preparing-profile'
  | 'starting-host'
  | 'loading-surface'
  | 'healthy'
  | 'recovery'
  | 'stopping'
  | 'stopped'

/** One bounded Host run; retries must create a fresh attempt, not restart one. */
export interface HostAttempt {
  start(): Promise<HostReady>
  stop(reason: 'quit' | 'restart', deadlineMs: number): Promise<void>
}

export type CreateHostAttempt = (lease: HomeLease) => HostAttempt

export interface ShellWindowPort {
  loadSurface(surface: HostReady['surface'], origin: string): Promise<void>
  showRecovery(code: 'BOOT_FAILED' | 'HOST_CRASHED'): Promise<void>
  destroySurface(): void
}

export type DesktopShellOptions = Readonly<{
  acquireLease(): Promise<HomeLease>
  reconcile(lease: HomeLease): Promise<void>
  createAttempt: CreateHostAttempt
  window: ShellWindowPort
  shutdownDeadlineMs?: number
  /** Reports lease-release failures; the lease is then intentionally kept. */
  onLeaseReleaseError?(error: unknown): void
}>

export class DesktopShellController {
  readonly #options: DesktopShellOptions
  #startPromise: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined
  #recoveryPromise: Promise<void> | undefined
  #lease: HomeLease | undefined
  #attempt: HostAttempt | undefined
  state: DesktopShellState = 'idle'

  constructor(options: DesktopShellOptions) {
    this.#options = options
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#start()
    return this.#startPromise
  }

  hostCrashed(): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') return Promise.resolve()
    this.#recoveryPromise ??= (async () => {
      this.#options.window.destroySurface()
      this.state = 'recovery'
      await this.#options.window.showRecovery('HOST_CRASHED')
    })()
    return this.#recoveryPromise
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop()
    return this.#stopPromise
  }

  async #start(): Promise<void> {
    try {
      this.state = 'acquiring-lease'
      const lease = await this.#options.acquireLease()
      this.#lease = lease
      this.state = 'preparing-profile'
      await this.#options.reconcile(lease)
      const attempt = this.#options.createAttempt(lease)
      this.#attempt = attempt
      this.state = 'starting-host'
      const ready = await attempt.start()
      this.state = 'loading-surface'
      await this.#options.window.loadSurface(ready.surface, ready.origin)
      this.state = 'healthy'
    } catch (error) {
      // A failure after the attempt exists must still stop the Host and
      // confirm its exit before the shell settles into diagnostics; the
      // lease stays held while the recovery surface is alive and is released
      // by the normal stop chain on quit.
      if (this.#attempt !== undefined) {
        try {
          await this.#attempt.stop('quit', this.#options.shutdownDeadlineMs ?? 5_000)
        } catch {
          /* the original startup failure is the diagnosis to report */
        }
      }
      this.state = 'recovery'
      await this.#options.window.showRecovery('BOOT_FAILED')
      throw error
    }
  }

  async #stop(): Promise<void> {
    this.state = 'stopping'
    try {
      await this.#attempt?.stop('quit', this.#options.shutdownDeadlineMs ?? 5_000)
    } finally {
      if (this.#lease !== undefined) {
        try {
          await this.#lease.release()
        } catch (error) {
          // Keep the lease when we cannot prove the Host is gone; the next
          // entrypoint will need doctor diagnostics, not a silent unlock.
          this.#options.onLeaseReleaseError?.(error)
        }
      }
      this.state = 'stopped'
    }
  }
}
