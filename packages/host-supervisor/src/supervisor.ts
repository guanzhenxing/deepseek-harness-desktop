import { randomBytes } from 'node:crypto'

import {
  HostControlError,
  LauncherProtocolSession,
  validateLoopbackSurface,
  type HostToLauncherMessage,
  type LauncherToHostMessage,
  type LoopbackSurface,
} from '@dsh-desktop/desktop-contracts'

export type HostBootstrap = Readonly<{
  home: string
  profileName: string
  mode: 'normal' | 'safe'
  capability: string
  leaseGeneration: string
}>

export interface ManagedHostProcess {
  readonly pid: number
  readonly startIdentity: string
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void
  terminate(): void
  kill(): void
}

export interface HostProcessFactory {
  spawn(bootstrap: HostBootstrap): Promise<ManagedHostProcess>
}

export type HostSupervisorState =
  'idle' | 'starting' | 'healthy' | 'draining' | 'stopped' | 'failed'

export type HostSupervisorEvent =
  | { kind: 'starting'; pid: number }
  | { kind: 'healthy'; pid: number }
  | { kind: 'crashed'; error: HostControlError }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: HostControlError }

export type HostReady = Readonly<{
  pid: number
  startIdentity: string
  surface: LoopbackSurface
  origin: string
}>

export type HostStartRequest = Readonly<{
  home: string
  profileName: string
  mode: 'normal' | 'safe'
  leaseGeneration: string
}>

export type HostSupervisorOptions = Readonly<{
  factory: HostProcessFactory
  stabilityMs?: number
  startupTimeoutMs?: number
  terminateGraceMs?: number
  onEvent?: (event: HostSupervisorEvent) => void
}>

type Deferred<Value> = {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(reason: unknown): void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export class HostSupervisor {
  readonly #options: Required<
    Pick<HostSupervisorOptions, 'stabilityMs' | 'startupTimeoutMs' | 'terminateGraceMs'>
  > &
    HostSupervisorOptions
  #process: ManagedHostProcess | undefined
  #protocol: LauncherProtocolSession | undefined
  #ready = deferred<HostReady>()
  #stop: Deferred<void> | undefined
  #surface: LoopbackSurface | undefined
  #origin: string | undefined
  #startupTimer: ReturnType<typeof setTimeout> | undefined
  #stabilityTimer: ReturnType<typeof setTimeout> | undefined
  #terminateTimer: ReturnType<typeof setTimeout> | undefined
  #killTimer: ReturnType<typeof setTimeout> | undefined
  #started = false
  #healthy = false
  #exited = false
  state: HostSupervisorState = 'idle'

  constructor(options: HostSupervisorOptions) {
    this.#options = {
      stabilityMs: options.stabilityMs ?? 1_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      terminateGraceMs: options.terminateGraceMs ?? 2_000,
      ...options,
    }
  }

  start(request: HostStartRequest): Promise<HostReady> {
    if (this.#started) return Promise.reject(new Error('HostSupervisor can start only once'))
    this.#started = true
    this.state = 'starting'
    const bootstrap: HostBootstrap = Object.freeze({
      ...request,
      capability: randomBytes(32).toString('base64url'),
    })
    void this.#spawn(bootstrap)
    return this.#ready.promise
  }

  stop(
    reason: Extract<LauncherToHostMessage, { kind: 'dispose' }>['reason'],
    deadlineMs: number,
  ): Promise<void> {
    if (this.#stop !== undefined) return this.#stop.promise
    this.#stop = deferred<void>()
    if (this.#process === undefined || this.#exited) {
      this.state = 'stopped'
      this.#stop.resolve()
      return this.#stop.promise
    }
    this.state = 'draining'
    try {
      this.#process.postMessage(this.#protocol?.dispose(reason, deadlineMs))
    } catch {
      this.#process.terminate()
    }
    this.#terminateTimer = setTimeout(() => {
      if (this.#exited) return
      this.#process?.terminate()
      this.#killTimer = setTimeout(() => {
        if (!this.#exited) this.#process?.kill()
      }, this.#options.terminateGraceMs)
    }, deadlineMs)
    return this.#stop.promise
  }

  async #spawn(bootstrap: HostBootstrap): Promise<void> {
    try {
      const process = await this.#options.factory.spawn(bootstrap)
      this.#process = process
      this.#protocol = new LauncherProtocolSession({
        capability: bootstrap.capability,
        leaseGeneration: bootstrap.leaseGeneration,
        expectedHost: { pid: process.pid, startIdentity: process.startIdentity },
        profileName: bootstrap.profileName,
        mode: bootstrap.mode,
      })
      process.onMessage((message) => this.#onMessage(message))
      process.onExit(() => this.#onExit())
      this.#emit({ kind: 'starting', pid: process.pid })
      this.#startupTimer = setTimeout(() => {
        this.#failStart(new HostControlError('BOOT_FAILED', 'Host startup timed out'))
      }, this.#options.startupTimeoutMs)
    } catch (error) {
      this.#failStart(
        error instanceof HostControlError
          ? error
          : new HostControlError('BOOT_FAILED', 'Host process could not be created'),
      )
    }
  }

  #onMessage(input: unknown): void {
    try {
      const message = this.#protocol?.receive(input)
      if (message === undefined)
        throw new HostControlError('INVALID_TRANSITION', 'Host protocol is unavailable')
      this.#handleMessage(message)
    } catch (error) {
      this.#failStart(
        error instanceof HostControlError
          ? error
          : new HostControlError('INVALID_ENVELOPE', 'Host message was rejected'),
      )
    }
  }

  #handleMessage(message: HostToLauncherMessage): void {
    switch (message.kind) {
      case 'hello':
        this.#process?.postMessage(this.#protocol?.accept())
        return
      case 'surface':
        this.#surface = message.surface
        this.#origin = validateLoopbackSurface(message.surface)
        return
      case 'ready':
        if (
          this.#surface === undefined ||
          this.#origin === undefined ||
          this.#process === undefined
        ) {
          throw new HostControlError('INVALID_TRANSITION', 'Host became ready without a surface')
        }
        clearTimeout(this.#startupTimer)
        this.#stabilityTimer = setTimeout(() => {
          if (
            this.#exited ||
            this.#process === undefined ||
            this.#surface === undefined ||
            this.#origin === undefined
          ) {
            return
          }
          this.#healthy = true
          this.state = 'healthy'
          const ready = {
            pid: this.#process.pid,
            startIdentity: this.#process.startIdentity,
            surface: this.#surface,
            origin: this.#origin,
          }
          this.#ready.resolve(Object.freeze(ready))
          this.#emit({ kind: 'healthy', pid: this.#process.pid })
        }, this.#options.stabilityMs)
        return
      case 'fatal':
        this.#failStart(new HostControlError('BOOT_FAILED', message.summary))
        return
      case 'dispose-ack':
      case 'phase':
        return
    }
  }

  #onExit(): void {
    if (this.#exited) return
    this.#exited = true
    this.#clearTimers()
    if (this.#stop !== undefined) {
      this.state = 'stopped'
      this.#stop.resolve()
      this.#emit({ kind: 'stopped' })
      return
    }
    if (!this.#healthy) {
      this.#failStart(new HostControlError('BOOT_FAILED', 'Host exited before becoming ready'))
      return
    }
    const error = new HostControlError('HOST_CRASHED', 'Host exited after becoming ready')
    this.state = 'failed'
    this.#emit({ kind: 'crashed', error })
  }

  #failStart(error: HostControlError): void {
    if (this.#healthy || this.state === 'failed') return
    this.#clearTimers()
    this.state = 'failed'
    this.#ready.reject(error)
    this.#emit({ kind: 'failed', error })
    if (!this.#exited) this.#process?.terminate()
  }

  #clearTimers(): void {
    clearTimeout(this.#startupTimer)
    clearTimeout(this.#stabilityTimer)
    clearTimeout(this.#terminateTimer)
    clearTimeout(this.#killTimer)
  }

  #emit(event: HostSupervisorEvent): void {
    this.#options.onEvent?.(event)
  }
}
