import os from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  screen,
  shell as electronShell,
  Tray,
} from 'electron'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  LeaseError,
  resolveDesktopHome,
  resolveLeaseHelperPath,
} from '@dsh-desktop/home-lease'
import { HostSupervisor, type HostFatalDetail, type HostReady } from '@dsh-desktop/host-supervisor'
import { PRODUCT } from '@dsh-desktop/product-config'
import { SAFE_PROFILE_NAME } from '@dsh-desktop/profile-manager'
import { admitHome as admitHomeMarker } from '@dsh-desktop/release-compatibility'
import {
  closeWindowAction,
  createDesktopProfileRecovery,
  createRecoveryMarkerStore,
  isAllowedMainFrameNavigation,
  readWindowState,
  RendererReloadBudget,
  restoreWindowState,
  RecoverySessionController,
  StartupFailureError,
  toStartupFailure,
  writeWindowState,
  type SavedWindowState,
  type StartupFailure,
} from '@dsh-desktop/shell-core'

import { createElectronHostProcessFactory } from './electron-host-process.js'
import {
  decideMainFrameNavigation,
  externalUrlPolicy,
  type OpenExternalAdapter,
} from './external-links.js'
import { describeLeaseBlock, resolveSmokeHome } from './lease-diagnostics.js'
import { createRecoveryWindow, type RecoveryWindowHandle } from './recovery-window.js'
import { resolveSmokeUserData } from './m0-paths.js'
import {
  buildAboutPanelOptions,
  NativeUiSession,
  type MenuItemSpec,
  type NativeUiAction,
  type NativeUiPort,
} from './native-ui.js'
import {
  resolveInstalledRuntime,
  resolveNativeAssets,
  type InstalledRuntimePaths,
} from './resource-paths.js'
import {
  isScriptedSmokeMode,
  runLifecycleSequence,
  runNavigationSequence,
} from './smoke-sequence.js'
import { createWindowOpenGuard, DESKTOP_WEB_PREFERENCES } from './window-policy.js'

// A packaged build derives every runtime path from the installed resources
// root; development keeps the repository layout next to this module.
const installedRuntime: InstalledRuntimePaths | undefined = app.isPackaged
  ? resolveInstalledRuntime(process.resourcesPath)
  : undefined
const hostEntryPath =
  installedRuntime?.hostEntry ?? fileURLToPath(new URL('./host-entry.js', import.meta.url))
const smokeMode = process.env.DSH_DESKTOP_SMOKE
const userDataOverride = await resolveSmokeUserData(smokeMode, process.env.DSH_DESKTOP_M0_USER_DATA)

if (userDataOverride !== undefined) app.setPath('userData', path.resolve(userDataOverride))

app.setName(PRODUCT.name)
app.setAboutPanelOptions(
  buildAboutPanelOptions({
    productName: PRODUCT.name,
    desktopVersion: app.getVersion(),
    electronVersion: process.versions.electron,
  }),
)

function workAreas(): { x: number; y: number; width: number; height: number }[] {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  return [primary, ...displays.filter((display) => display.id !== primary.id)].map(
    (display) => display.workArea,
  )
}

/** The main window port: loads the Host surface and can retire it. */
class ElectronWindowPort {
  readonly window: BrowserWindow
  readonly reloadBudget = new RendererReloadBudget()
  #allowedOrigin: string | undefined
  #surfaceUrl: string | undefined
  #revealed = false
  readonly #stateFile: string
  readonly #isQuitting: () => boolean
  readonly #openExternal: OpenExternalAdapter
  #saveTimer: NodeJS.Timeout | undefined

  constructor(input: {
    initialState: SavedWindowState | undefined
    stateFile: string
    isQuitting: () => boolean
    openExternal: OpenExternalAdapter
  }) {
    this.#stateFile = input.stateFile
    this.#isQuitting = input.isQuitting
    this.#openExternal = input.openExternal
    const restored = restoreWindowState(input.initialState, workAreas())
    this.window = new BrowserWindow({
      x: restored.bounds.x,
      y: restored.bounds.y,
      width: restored.bounds.width,
      height: restored.bounds.height,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: PRODUCT.name,
      webPreferences: DESKTOP_WEB_PREFERENCES,
    })
    if (restored.maximized) this.window.maximize()
    this.window.webContents.session.setPermissionCheckHandler(() => false)
    this.window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => {
        callback(false)
      },
    )
    this.window.webContents.setWindowOpenHandler(
      createWindowOpenGuard({
        policy: externalUrlPolicy,
        currentOrigin: () => this.#allowedOrigin,
        openExternal: this.#openExternal,
      }),
    )
    this.window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    const guardNavigation = (event: Electron.Event, target: string): void => {
      const decision = decideMainFrameNavigation({ allowedOrigin: this.#allowedOrigin, target })
      if (decision === 'allow') return
      event.preventDefault()
      if (decision === 'deny-external') {
        // The only external path: a policy-approved user link the launcher
        // itself hands to the system browser.
        void this.#openExternal(target).catch(() => undefined)
      }
    }
    this.window.webContents.on('will-navigate', guardNavigation)
    this.window.webContents.on('will-redirect', guardNavigation)
    // Closing hides to the tray; only the quitting state machine may close.
    this.window.on('close', (event) => {
      if (closeWindowAction(this.#isQuitting()) === 'hide') {
        event.preventDefault()
        this.window.hide()
      }
    })
    const scheduleSave = (): void => this.#scheduleStateSave()
    this.window.on('resize', scheduleSave)
    this.window.on('move', scheduleSave)
    this.window.on('maximize', scheduleSave)
    this.window.on('unmaximize', scheduleSave)
  }

  async loadSurface(surface: HostReady['surface'], origin: string): Promise<void> {
    this.#allowedOrigin = origin
    this.#surfaceUrl = surface.url
    await this.window.loadURL(surface.url)
    if (!isAllowedMainFrameNavigation(origin, this.window.webContents.getURL())) {
      throw new Error('BrowserWindow finished on an untrusted origin')
    }
    this.reloadBudget.noteSurfaceLoaded()
    this.#revealed = true
    this.window.show()
  }

  /**
   * Dock/tray/second-instance reveal only restores a window the user has
   * already seen: the first launch keeps waiting for the Host surface (and
   * the recovery window owns the failure case).
   */
  canReveal(): boolean {
    return this.#revealed
  }

  /** One policy-checked reload of the current surface after a renderer crash. */
  async reloadSurface(): Promise<void> {
    if (this.#surfaceUrl === undefined) return
    await this.window.loadURL(this.#surfaceUrl)
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
  }

  destroySurface(): void {
    this.#allowedOrigin = undefined
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    this.window.webContents.stop()
  }

  /** Persist the normal bounds + maximized flag through an atomic write. */
  persistWindowStateNow(): void {
    if (this.window.isDestroyed()) return
    void writeWindowState(this.#stateFile, {
      bounds: this.window.getNormalBounds(),
      maximized: this.window.isMaximized(),
    }).catch((error: unknown) => {
      console.error(
        'window state could not be persisted:',
        error instanceof Error ? error.message : error,
      )
    })
  }

  #scheduleStateSave(): void {
    if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => this.persistWindowStateNow(), 500)
    // The timer must never keep the quit sequence alive.
    this.#saveTimer.unref?.()
  }
}

function smokeReport(payload: Record<string, unknown>): void {
  if (smokeMode === undefined) return
  console.log(`DSH_DESKTOP_SMOKE ${JSON.stringify(payload)}`)
}

function reportLeaseFailure(error: unknown): void {
  const view =
    error instanceof LeaseError
      ? describeLeaseBlock({ code: error.code, ownerSummary: error.ownerSummary })
      : describeLeaseBlock({ code: 'LEASE_UNKNOWN' })
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`${view.title}: ${detail}`)
  smokeReport({ kind: 'lease-refused', code: error instanceof LeaseError ? error.code : 'UNKNOWN' })
  if (smokeMode === undefined) {
    dialog.showErrorBox(view.title, `${view.body.join('\n')}\n\n${view.doctorCommand}`)
    app.exit(1)
  }
}

async function waitForOfficialUi(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 30_000
  let snapshot: unknown
  while (Date.now() < deadline) {
    snapshot = await window.webContents.executeJavaScript(`(() => ({
      title: document.title,
      treeLabels: [...document.querySelectorAll('[role="tree"]')].map((node) => node.getAttribute('aria-label')),
      textboxCount: document.querySelectorAll('[role="textbox"]').length,
      hasSettingsText: document.body.innerText.includes('Settings') || document.body.innerText.includes('设置'),
      bootEntries: window.__DSH_BOOT__?.entries.map((entry) => entry.id) ?? [],
      body: document.body.innerText.slice(0, 240)
    }))()`)
    const state = snapshot as {
      treeLabels: (string | null)[]
      textboxCount: number
      hasSettingsText: boolean
      bootEntries: string[]
      body: string
    }
    const hasSessions = state.treeLabels.some((label) => label === 'Sessions' || label === '会话')
    const hasOfficialGraph =
      state.bootEntries.includes('@deepseek-ai/dsh-client-modules') &&
      state.bootEntries.includes('@deepseek-ai/dsh-client-ui-sidebar')
    if (hasSessions && state.textboxCount > 0 && state.hasSettingsText && hasOfficialGraph) return
    if (state.body.includes('Failed to load plugins')) {
      smokeReport({ kind: 'ui-markers-missing', snapshot })
      throw new Error('Official DSH UI reported a plugin-load failure')
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  smokeReport({ kind: 'ui-markers-missing', snapshot })
  throw new Error('Official DSH UI did not reach the M0 smoke markers')
}

function toElectronTemplate(
  spec: readonly MenuItemSpec[],
  dispatch: (action: NativeUiAction) => void,
): Electron.MenuItemConstructorOptions[] {
  return spec.map((item): Electron.MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'separator':
        return { type: 'separator' }
      case 'role':
        return item.label === undefined
          ? { role: item.role }
          : { role: item.role, label: item.label }
      case 'action':
        return { label: item.label, click: () => dispatch(item.action) }
      case 'status':
        return { label: item.label, enabled: false }
      case 'submenu':
        return { label: item.label, submenu: toElectronTemplate(item.items, dispatch) }
    }
  })
}

function createNativeUi(showMainWindow: () => void): NativeUiSession {
  const assets = resolveNativeAssets({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  if (assets === undefined) {
    console.error(
      'tray template icons are missing; the tray stays disabled (run scripts/build-icons.mjs)',
    )
  }
  let tray: Tray | undefined
  const session = new NativeUiSession(
    {
      setApplicationMenu: (spec) => {
        Menu.setApplicationMenu(
          Menu.buildFromTemplate(toElectronTemplate(spec, (action) => session.dispatch(action))),
        )
      },
      setTrayMenu: (spec) => {
        if (assets === undefined) return
        tray ??= (() => {
          const image = nativeImage.createFromPath(assets.trayIcon)
          image.addRepresentation({
            scaleFactor: 2,
            width: 32,
            height: 32,
            buffer: readFileSync(assets.trayIcon2x),
          })
          image.setTemplateImage(true)
          const created = new Tray(image)
          created.setToolTip(PRODUCT.name)
          created.on('click', () => session.showMain())
          return created
        })()
        tray.setContextMenu(
          Menu.buildFromTemplate(toElectronTemplate(spec, (action) => session.dispatch(action))),
        )
      },
      clearTray: () => {
        tray?.destroy()
        tray = undefined
      },
    } satisfies NativeUiPort,
    {
      show: () => showMainWindow(),
      quit: () => {
        app.quit()
      },
    },
  )
  return session
}

let shell: RecoverySessionController | undefined
let recoveryWindow: RecoveryWindowHandle | undefined
let nativeUi: NativeUiSession | undefined
let windowPort: ElectronWindowPort | undefined
let shutdownComplete = false
let shutdownStarted = false

function isQuitting(): boolean {
  return shutdownStarted || shutdownComplete
}

async function startApplication(): Promise<void> {
  // Resolve the single shared home from the entry environment before any
  // child environment is derived from it.
  const home =
    smokeMode !== undefined && userDataOverride !== undefined
      ? resolveSmokeHome({ smokeMode, userData: userDataOverride, osHome: os.homedir() })
      : resolveDesktopHome({ env: process.env, osHome: os.homedir(), cwd: process.cwd() })
  const probe = createNativeProcessProbe({
    helperPath: installedRuntime?.leaseHelper ?? resolveLeaseHelperPath(process.env),
    entryExecutables: [process.execPath],
  })
  const profileName = PRODUCT.defaultProfileName
  const marker = createRecoveryMarkerStore(app.getPath('userData'), home)
  const stateFile = path.join(app.getPath('userData'), 'window-state.json')
  const initialState = await readWindowState(stateFile)
  // Automated runs record external handoffs instead of opening the user's
  // browser; a manual system external-link check covers the real path.
  const openExternal: OpenExternalAdapter =
    smokeMode === undefined
      ? (url) => electronShell.openExternal(url)
      : async (url) => {
          smokeReport({ kind: 'external-opened', url })
        }
  const port = new ElectronWindowPort({ initialState, stateFile, isQuitting, openExternal })
  windowPort = port
  const showMainWindow = (): void => {
    const port = windowPort
    if (port === undefined) return
    if (!port.canReveal()) return
    const window = port.window
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  nativeUi = createNativeUi(showMainWindow)
  nativeUi.initialize('starting')
  let readyHost: HostReady | undefined
  let lastFatal: HostFatalDetail | undefined
  let resolveRecoveryShown: (() => void) | undefined
  const recoveryShown = new Promise<void>((resolve) => {
    resolveRecoveryShown = resolve
  })
  // The recovery window is created lazily on first failure: an eagerly
  // created, never-loaded hidden window stalls Electron's quit sequence.
  const ensureRecoveryWindow = (): RecoveryWindowHandle =>
    (recoveryWindow ??= createRecoveryWindow({
      onAction: (action) => {
        if (shell === undefined) return
        shell
          .act(action)
          .then(() => {
            if (action === 'quit' || shell?.state === 'stopped') app.exit(0)
          })
          .catch((error: unknown) => {
            console.error(
              `recovery action ${action} failed:`,
              error instanceof Error ? error.message : error,
            )
          })
      },
      isInRecovery: () => shell?.state === 'recovery',
      ...(installedRuntime === undefined
        ? {}
        : {
            documentPath: installedRuntime.recoveryHtml,
            preloadPath: installedRuntime.recoveryPreload,
          }),
    }))
  // A dead renderer reloads at most once on the same live Host surface;
  // anything beyond that budget goes to the launcher-owned recovery view.
  port.window.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting() || shell === undefined) return
    const hostSurfaceAlive = readyHost !== undefined && shell.state === 'healthy'
    if (
      port.reloadBudget.consumeIfAvailable({
        hostSurfaceAlive,
        quitting: isQuitting(),
      })
    ) {
      smokeReport({ kind: 'renderer-reloaded', reason: details.reason })
      void port.reloadSurface().catch((error: unknown) => {
        console.error('renderer reload failed:', error instanceof Error ? error.message : error)
      })
      return
    }
    smokeReport({ kind: 'renderer-crashed', reason: details.reason })
    void shell
      .rendererCrashed({
        stage: 'renderer',
        code: 'RENDERER_CRASHED',
        category: 'renderer',
        summary: `界面渲染进程退出（${details.reason}）`,
        retryable: true,
      })
      .catch((error: unknown) => {
        console.error(
          'renderer crash handling failed:',
          error instanceof Error ? error.message : error,
        )
      })
  })
  shell = new RecoverySessionController({
    acquireLease: () =>
      acquireHomeLease({
        home,
        entrypoint: 'desktop',
        profile: profileName,
        appVersion: app.getVersion(),
        probe,
      }),
    profile: createDesktopProfileRecovery({ home, profileName }),
    // Read-only home compatibility admission: after the lease, before any
    // profile/cache/Host write, on every session (normal and Safe Mode both
    // flow through this gate). A read failure is a fail-closed refusal.
    admitHome: async () => {
      try {
        return await admitHomeMarker({ home })
      } catch {
        return 'unknown-schema' as const
      }
    },
    readRecoveryMarker: () => marker.read(),
    writeRecoveryMarker: (entry) => marker.write(entry),
    createAttempt: (lease, mode) => {
      const attemptSupervisor = new HostSupervisor({
        factory: createElectronHostProcessFactory(hostEntryPath),
        stabilityMs: smokeMode === undefined ? 1_000 : 100,
        onEvent: (event) => {
          if (event.kind === 'failed') {
            if (event.fatal !== undefined) lastFatal = event.fatal
            smokeReport({
              kind: 'host-failed',
              code: event.error.code,
              summary: event.error.message,
            })
          }
          if (event.kind !== 'crashed') return
          if (shutdownStarted) return
          void shell
            ?.hostCrashed()
            .then(() => {
              smokeReport({ kind: 'host-crash-recovery', launcherPid: process.pid })
              if (smokeMode === 'host-crash') app.exit(0)
            })
            .catch((error: unknown) => {
              console.error(
                'host-crash recovery failed:',
                error instanceof Error ? error.message : error,
              )
              smokeReport({ kind: 'failed', stage: 'host-crash-recovery' })
            })
        },
      })
      return {
        start: async () => {
          try {
            const ready = await attemptSupervisor.start({
              home,
              profileName: mode === 'safe' ? SAFE_PROFILE_NAME : profileName,
              mode,
              lease,
              probe,
            })
            readyHost = ready
            return ready
          } catch (error) {
            const fatal = lastFatal
            lastFatal = undefined
            const failure: StartupFailure = toStartupFailure({
              stage: fatal?.stage ?? 'boot',
              code: fatal?.code ?? 'BOOT_FAILED',
              summary: fatal?.summary ?? (error instanceof Error ? error.message : String(error)),
              retryable: fatal?.retryable ?? true,
              home,
            })
            smokeReport({ kind: 'host-failed', code: failure.code, stage: failure.stage })
            throw new StartupFailureError(failure)
          }
        },
        stop: (reason, deadlineMs) => attemptSupervisor.stop(reason, deadlineMs),
      }
    },
    loadSurface: async (ready) => {
      await port.loadSurface(ready.surface, ready.origin)
    },
    onHealthy: async () => {
      nativeUi?.setStatus('running')
      // A healthy session spends the relaunch marker and retires the
      // launcher-owned recovery window. Runs after the state flips, so a
      // crash inside it is still a post-ready crash. The two steps are
      // independent: a marker that cannot be cleared (it stays spent, the
      // conservative direction) must not keep the recovery window alive.
      await marker.clear().catch((error: unknown) => {
        console.error(
          'recovery marker could not be cleared after a healthy session:',
          error instanceof Error ? error.message : error,
        )
      })
      if (recoveryWindow !== undefined) {
        recoveryWindow.destroy()
        recoveryWindow = undefined
      }
    },
    window: {
      showRecoveryView: async (view) => {
        nativeUi?.setStatus('recovery')
        smokeReport({ kind: 'recovery-view', stage: view.failure.stage, code: view.failure.code })
        await ensureRecoveryWindow().showRecoveryView(view)
        resolveRecoveryShown?.()
      },
      destroySurface: () => port.destroySurface(),
    },
    onSessionFailure: (failure) => {
      nativeUi?.setStatus('recovery')
      smokeReport({
        kind: 'session-failure',
        stage: failure.stage,
        code: failure.code,
        category: failure.category,
      })
    },
    onLeaseReleaseError: (error) => {
      smokeReport({ kind: 'lease-release-refused' })
      console.error('keeping the home lease:', error instanceof Error ? error.message : error)
    },
  })
  await shell.start()

  if (smokeMode !== undefined) {
    await waitForOfficialUi(port.window)
    const driverOwnedModes = ['shared-home', 'conversation', 'auth', 'navigation', 'lifecycle']
    smokeReport({
      kind: 'ui-ready',
      launcherPid: process.pid,
      hostPid: readyHost?.pid,
      ...(driverOwnedModes.includes(smokeMode) ? { surfaceUrl: readyHost?.surface.url } : {}),
    })
    if (smokeMode === 'host-crash' && readyHost !== undefined) {
      process.kill(readyHost.pid, 'SIGKILL')
    } else if (isScriptedSmokeMode(smokeMode)) {
      // Scripted modes run their probe sequence and then quit themselves.
      const context = {
        window: port.window,
        showMain: () => nativeUi?.showMain(),
        simulateDockActivate: () => app.emit('activate', { preventDefault() {} } as never, false),
        waitForRecoveryView: () => recoveryShown,
        report: (payload: Record<string, unknown>) => smokeReport(payload),
        quit: () => app.quit(),
      }
      await (smokeMode === 'navigation'
        ? runNavigationSequence(context)
        : runLifecycleSequence(context))
    } else if (!driverOwnedModes.includes(smokeMode)) {
      app.quit()
    }
    // In driver-owned modes the driver owns the shutdown moment; the app stays
    // up holding the lease until it receives SIGTERM.
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
else {
  // Termination signals go through the normal before-quit chain so the Host
  // is stopped and the home lease is released before the process exits.
  process.on('SIGTERM', () => {
    app.quit()
  })
  app.on('second-instance', () => {
    // Duplicate launches only focus the existing window.
    nativeUi?.showMain()
    const window = windowPort?.window
    if (window !== undefined && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
    smokeReport({ kind: 'second-instance-focused' })
  })
  // Dock icon activation with no visible window brings the main window back.
  app.on('activate', () => {
    nativeUi?.showMain()
  })
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    windowPort?.persistWindowStateNow()
    nativeUi?.beginQuit()
    if (shutdownStarted) return
    shutdownStarted = true
    void (shell?.act('quit') ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => {
        nativeUi?.destroy()
        recoveryWindow?.destroy()
        shutdownComplete = true
        // The stop chain has completed (Host stopped, lease released); a
        // prevented-then-reissued quit can be swallowed by Electron, so exit
        // explicitly from here.
        app.exit(0)
      })
  })
  app.on('window-all-closed', () => app.quit())
  void app
    .whenReady()
    .then(startApplication)
    .catch((error: unknown) => {
      if (error instanceof LeaseError) reportLeaseFailure(error)
      else console.error('startup failed:', error instanceof Error ? error.message : error)
      smokeReport({ kind: 'failed', stage: 'startup' })
      if (smokeMode !== undefined) {
        shutdownStarted = true
        recoveryWindow?.destroy()
        app.exit(1)
      }
    })
}
