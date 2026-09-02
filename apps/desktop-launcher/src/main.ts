import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog } from 'electron'

import {
  acquireHomeLease,
  createNativeProcessProbe,
  LeaseError,
  resolveDesktopHome,
  resolveLeaseHelperPath,
} from '@dsh-desktop/home-lease'
import { HostSupervisor, type HostReady } from '@dsh-desktop/host-supervisor'
import { PRODUCT } from '@dsh-desktop/product-config'
import { createProfileRef, reconcileDesktopProfile } from '@dsh-desktop/profile-manager'
import {
  DesktopShellController,
  isAllowedMainFrameNavigation,
  type ShellWindowPort,
} from '@dsh-desktop/shell-core'

import { createElectronHostProcessFactory } from './electron-host-process.js'
import { describeLeaseBlock, resolveSmokeHome } from './lease-diagnostics.js'
import { resolveSmokeUserData } from './m0-paths.js'
import { DESKTOP_WEB_PREFERENCES, denyWindowOpen } from './window-policy.js'

const recoveryPath = fileURLToPath(new URL('../src/recovery.html', import.meta.url))
const hostEntryPath = fileURLToPath(new URL('./host-entry.js', import.meta.url))
const smokeMode = process.env.DSH_DESKTOP_SMOKE
const userDataOverride = await resolveSmokeUserData(smokeMode, process.env.DSH_DESKTOP_M0_USER_DATA)

if (userDataOverride !== undefined) app.setPath('userData', path.resolve(userDataOverride))

app.setName(PRODUCT.name)

class ElectronWindowPort implements ShellWindowPort {
  readonly window: BrowserWindow
  #allowedOrigin: string | undefined

  constructor() {
    this.window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: PRODUCT.name,
      webPreferences: DESKTOP_WEB_PREFERENCES,
    })
    this.window.webContents.session.setPermissionCheckHandler(() => false)
    this.window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => {
        callback(false)
      },
    )
    this.window.webContents.setWindowOpenHandler(denyWindowOpen)
    this.window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    const guardNavigation = (event: Electron.Event, target: string): void => {
      if (
        this.#allowedOrigin === undefined ||
        !isAllowedMainFrameNavigation(this.#allowedOrigin, target)
      ) {
        event.preventDefault()
      }
    }
    this.window.webContents.on('will-navigate', guardNavigation)
    this.window.webContents.on('will-redirect', guardNavigation)
  }

  async loadSurface(surface: HostReady['surface'], origin: string): Promise<void> {
    this.#allowedOrigin = origin
    await this.window.loadURL(surface.url)
    if (!isAllowedMainFrameNavigation(origin, this.window.webContents.getURL())) {
      throw new Error('BrowserWindow finished on an untrusted origin')
    }
    this.window.show()
  }

  async showRecovery(code: 'BOOT_FAILED' | 'HOST_CRASHED'): Promise<void> {
    if (this.window.isDestroyed()) return
    this.#allowedOrigin = undefined
    if (!this.window.webContents.isDestroyed()) this.window.webContents.stop()
    await this.window.loadFile(recoveryPath, { query: { code } })
    this.window.show()
  }

  destroySurface(): void {
    this.#allowedOrigin = undefined
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return
    this.window.webContents.stop()
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

let shell: DesktopShellController | undefined
let shutdownComplete = false
let shutdownStarted = false

async function startApplication(): Promise<void> {
  // Resolve the single shared home from the entry environment before any
  // child environment is derived from it.
  const home =
    smokeMode !== undefined && userDataOverride !== undefined
      ? resolveSmokeHome({ smokeMode, userData: userDataOverride, osHome: os.homedir() })
      : resolveDesktopHome({ env: process.env, osHome: os.homedir(), cwd: process.cwd() })
  const probe = createNativeProcessProbe({
    helperPath: resolveLeaseHelperPath(process.env),
    entryExecutables: [process.execPath],
  })
  const profileName = PRODUCT.defaultProfileName
  const windowPort = new ElectronWindowPort()
  let readyHost: HostReady | undefined
  const supervisor = new HostSupervisor({
    factory: createElectronHostProcessFactory(hostEntryPath),
    stabilityMs: smokeMode === undefined ? 1_000 : 100,
    onEvent: (event) => {
      if (event.kind === 'failed') {
        smokeReport({ kind: 'host-failed', code: event.error.code, summary: event.error.message })
      }
      if (event.kind !== 'crashed') return
      if (shutdownStarted) return
      void shell
        ?.hostCrashed()
        .then(() => {
          smokeReport({ kind: 'host-crash-recovery', launcherPid: process.pid })
          if (smokeMode === 'host-crash') app.quit()
        })
        .catch(() => smokeReport({ kind: 'failed', stage: 'host-crash-recovery' }))
    },
  })
  shell = new DesktopShellController({
    acquireLease: () =>
      acquireHomeLease({
        home,
        entrypoint: 'desktop',
        profile: profileName,
        appVersion: app.getVersion(),
        probe,
      }),
    reconcile: async (lease) => {
      await reconcileDesktopProfile(createProfileRef(home, profileName), lease)
    },
    createAttempt: (lease) => ({
      start: () => {
        const started = supervisor.start({ home, profileName, mode: 'normal', lease, probe })
        void started
          .then((ready) => {
            readyHost = ready
          })
          .catch(() => undefined)
        return started
      },
      stop: (reason, deadlineMs) => supervisor.stop(reason, deadlineMs),
    }),
    window: windowPort,
    onLeaseReleaseError: (error) => {
      smokeReport({ kind: 'lease-release-refused' })
      console.error('keeping the home lease:', error instanceof Error ? error.message : error)
    },
  })
  await shell.start()

  if (smokeMode !== undefined) {
    await waitForOfficialUi(windowPort.window)
    smokeReport({
      kind: 'ui-ready',
      launcherPid: process.pid,
      hostPid: readyHost?.pid,
    })
    if (smokeMode === 'host-crash' && readyHost !== undefined) {
      process.kill(readyHost.pid, 'SIGKILL')
    } else {
      app.quit()
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownStarted) return
    shutdownStarted = true
    void (shell?.stop() ?? Promise.resolve()).finally(() => {
      shutdownComplete = true
      app.quit()
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
        app.exit(1)
      }
    })
}
