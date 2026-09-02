import type { HostReady } from '@dsh-desktop/host-supervisor'

export type DesktopShellState =
  | 'idle'
  | 'preparing-profile'
  | 'starting-host'
  | 'loading-surface'
  | 'healthy'
  | 'recovery'
  | 'stopping'
  | 'stopped'

export interface ShellHostPort {
  start(): Promise<HostReady>
  stop(reason: 'quit', deadlineMs: number): Promise<void>
}

export interface ShellWindowPort {
  loadSurface(surface: HostReady['surface'], origin: string): Promise<void>
  showRecovery(code: 'BOOT_FAILED' | 'HOST_CRASHED'): Promise<void>
  destroySurface(): void
}

export type DesktopShellOptions = Readonly<{
  prepareProfile(): Promise<void>
  host: ShellHostPort
  window: ShellWindowPort
  shutdownDeadlineMs?: number
}>

export class DesktopShellController {
  readonly #options: DesktopShellOptions
  #startPromise: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined
  #recoveryPromise: Promise<void> | undefined
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
    this.#stopPromise ??= (async () => {
      this.state = 'stopping'
      await this.#options.host.stop('quit', this.#options.shutdownDeadlineMs ?? 5_000)
      this.state = 'stopped'
    })()
    return this.#stopPromise
  }

  async #start(): Promise<void> {
    try {
      this.state = 'preparing-profile'
      await this.#options.prepareProfile()
      this.state = 'starting-host'
      const ready = await this.#options.host.start()
      this.state = 'loading-surface'
      await this.#options.window.loadSurface(ready.surface, ready.origin)
      this.state = 'healthy'
    } catch (error) {
      this.state = 'recovery'
      await this.#options.window.showRecovery('BOOT_FAILED')
      throw error
    }
  }
}
