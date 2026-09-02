import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  healProfilesModuleFallback,
  loadOptionalPatches,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import {
  createEnvelopeWriter,
  HostControlError,
  parseLauncherEnvelope,
  redactDiagnostic,
  type HostIdentity,
  type LauncherToHostMessage,
  type LoopbackSurface,
} from '@dsh-desktop/desktop-contracts'
import type { DesktopSurfaceService } from '@dsh-desktop/desktop-plugin'

export interface HostControlTransport {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  close?(): void
}

export type RunDshHostOptions = Readonly<{
  home: string
  profileName: string
  mode: 'normal'
  capability: string
  leaseGeneration: string
  hostIdentity: HostIdentity
  transport: HostControlTransport
  installAnchor?: string
  acceptTimeoutMs?: number
}>

export type DshHostHandle = Readonly<{
  disposed: Promise<void>
  dispose(): Promise<void>
}>

const PROFILE_ROOT_CONFIG = `# dsh desktop profile root; compose through bundle and user patch layers.
[]
`
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const DSH_INSTALL_ANCHOR = realpathSync.native(
  createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'),
)
const DESKTOP_INSTALL_ANCHOR = realpathSync.native(
  fileURLToPath(new URL('../package.json', import.meta.url)),
)

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

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

export async function runDshHost(options: RunDshHostOptions): Promise<DshHostHandle> {
  const writer = createEnvelopeWriter(
    'host-to-launcher',
    options.capability,
    options.leaseGeneration,
  )
  const accepted = deferred<void>()
  const contextReady = deferred<Context | undefined>()
  const disposed = deferred<void>()
  let expectedSequence = 1
  let protocolState: 'awaiting-accept' | 'running' | 'draining' | 'disposed' = 'awaiting-accept'
  let context: Context | undefined
  let disposePromise: Promise<void> | undefined
  let surfaceId: string | undefined
  let originalDshHome = process.env.DSH_HOME

  const restoreEnvironment = (): void => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
    originalDshHome = undefined
  }

  const isDisposing = (): boolean =>
    (['draining', 'disposed'] as const).some((state) => state === protocolState)

  const disposeHost = (acknowledge: boolean): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    protocolState = 'draining'
    disposePromise = (async () => {
      const activeContext = context ?? (await contextReady.promise)
      await activeContext?.fiber.dispose()
      protocolState = 'disposed'
      restoreEnvironment()
      if (acknowledge) {
        options.transport.postMessage(writer.next({ kind: 'dispose-ack', outcome: 'disposed' }))
      }
      disposed.resolve()
    })()
    return disposePromise
  }

  const failProtocol = (error: unknown): void => {
    const failure =
      error instanceof HostControlError
        ? error
        : new HostControlError('INVALID_ENVELOPE', 'Launcher message was rejected')
    if (protocolState === 'awaiting-accept') accepted.reject(failure)
    options.transport.postMessage(
      writer.next({
        kind: 'fatal',
        stage: 'host-control',
        code: failure.code,
        summary: 'Host-control input was rejected',
        retryable: false,
      }),
    )
    void disposeHost(false)
  }

  const handleLauncherMessage = (input: unknown): void => {
    try {
      const envelope = parseLauncherEnvelope(input)
      if (!constantTimeEqual(envelope.capability, options.capability)) {
        throw new HostControlError('INVALID_CAPABILITY', 'Launcher capability does not match')
      }
      if (!constantTimeEqual(envelope.leaseGeneration, options.leaseGeneration)) {
        throw new HostControlError('LEASE_MISMATCH', 'Launcher lease generation does not match')
      }
      if (envelope.sequence !== expectedSequence) {
        throw new HostControlError('INVALID_ENVELOPE', 'Launcher sequence is not contiguous')
      }
      expectedSequence += 1
      const message: LauncherToHostMessage = envelope.message
      if (message.kind === 'accept') {
        if (protocolState !== 'awaiting-accept' || message.selectedMinor !== 0) {
          throw new HostControlError('INVALID_TRANSITION', 'Unexpected Host-control accept')
        }
        protocolState = 'running'
        accepted.resolve()
        return
      }
      if (protocolState !== 'running') {
        throw new HostControlError('INVALID_TRANSITION', 'Unexpected Host-control dispose')
      }
      void disposeHost(true)
    } catch (error) {
      failProtocol(error)
    }
  }

  const removeMessageListener = options.transport.onMessage(handleLauncherMessage)
  options.transport.postMessage(
    writer.next({
      kind: 'hello',
      host: options.hostIdentity,
      profile: { name: options.profileName },
      mode: options.mode,
      supportedMinor: { min: 0, max: 0 },
    }),
  )

  const acceptTimer = setTimeout(() => {
    accepted.reject(
      new HostControlError('PROTOCOL_MISMATCH', 'Launcher did not accept Host-control'),
    )
  }, options.acceptTimeoutMs ?? 10_000)

  try {
    await accepted.promise
    clearTimeout(acceptTimer)
    options.transport.postMessage(writer.next({ kind: 'phase', phase: 'booting' }))
    process.env.DSH_HOME = options.home

    const installAnchor = options.installAnchor ?? DSH_INSTALL_ANCHOR
    const profile = loadProfile('dsh-desktop', options.profileName, installAnchor, options.home)
    await writeFile(path.join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
    // The upstream CLI owns the complete official DSH closure. The Desktop app
    // anchor adds this repository's private bundle; fallback healing is additive.
    await healProfilesModuleFallback({ installAnchor, profile, home: options.home })
    if (DESKTOP_INSTALL_ANCHOR !== installAnchor) {
      await healProfilesModuleFallback({
        installAnchor: DESKTOP_INSTALL_ANCHOR,
        profile,
        home: options.home,
      })
    }
    const homePatches =
      loadOptionalPatches('dsh-desktop', path.join(options.home, 'cordis.patch.yml')) ?? []
    const patches = structuredClone([
      ...profile.layers.flatMap((layer) => layer.patches),
      ...profile.patches,
      ...homePatches,
    ])
    const environment = createLaunchEnvironmentSnapshot([
      { source: 'process', values: processEnvironment() },
    ])
    const desktopSurface: DesktopSurfaceService = {
      schedule(surface: LoopbackSurface): void {
        if (surfaceId !== undefined)
          throw new Error('dsh-desktop Host received more than one surface')
        surfaceId = randomUUID()
        options.transport.postMessage(writer.next({ kind: 'phase', phase: 'surface-waiting' }))
        options.transport.postMessage(
          writer.next({ kind: 'surface', surfaceId, purpose: 'normal', surface }),
        )
      },
    }

    context = await boot(
      'dsh-desktop',
      path.join(profile.dir, PROFILE_ROOT_FILENAME),
      patches,
      (hostContext) => {
        context = hostContext
        contextReady.resolve(hostContext)
        hostContext.provide('desktopSurface', desktopSurface)
        hostContext.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        provideCmdline(hostContext, {
          args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
          exit: () => void disposeHost(false),
        })
      },
    )
    if (surfaceId === undefined) throw new Error('desktop-plugin did not publish a surface')
    options.transport.postMessage(writer.next({ kind: 'ready', surfaceId }))
    return Object.freeze({
      disposed: disposed.promise.finally(removeMessageListener),
      dispose: () => disposeHost(false),
    })
  } catch (error) {
    clearTimeout(acceptTimer)
    contextReady.resolve(undefined)
    await context?.fiber.dispose()
    restoreEnvironment()
    const detail = error instanceof Error ? error.message : String(error)
    const summary = redactDiagnostic(detail, {
      capability: options.capability,
      home: options.home,
    }).slice(0, 1024)
    if (!isDisposing()) {
      options.transport.postMessage(
        writer.next({
          kind: 'fatal',
          stage: 'boot',
          code: 'BOOT_FAILED',
          summary: summary === '' ? 'DSH Host boot failed' : summary,
          retryable: true,
        }),
      )
    }
    removeMessageListener()
    throw error
  }
}
