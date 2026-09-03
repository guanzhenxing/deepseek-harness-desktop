import { PRODUCT } from '@dsh-desktop/product-config'

export type NativeUiAction = 'show' | 'quit'

/** Tray-visible session status; drives the tray menu's status line. */
export type TrayStatus = 'starting' | 'running' | 'recovery'

export type MenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'editMenu'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'togglefullscreen'
  | 'minimize'
  | 'zoom'
  | 'close'
  | 'front'

export type MenuItemSpec =
  | Readonly<{ kind: 'separator' }>
  | Readonly<{ kind: 'role'; role: MenuRole; label?: string }>
  | Readonly<{ kind: 'submenu'; label: string; items: readonly MenuItemSpec[] }>
  | Readonly<{ kind: 'action'; action: NativeUiAction; label: string }>
  | Readonly<{ kind: 'status'; label: string }>

/**
 * Standard macOS menus plus the two product actions (show, quit). Roles carry
 * the standard About/Services/Hide, copy/paste, zoom and window behavior; no
 * accelerators are registered on product actions, so Cmd+Q reaches the app
 * only through the system terminate path and the shared before-quit state
 * machine, and no system-wide shortcut is shadowed.
 */
export function buildApplicationMenuSpec(input: { productName: string }): MenuItemSpec[] {
  return [
    {
      kind: 'submenu',
      label: input.productName,
      items: [
        { kind: 'role', role: 'about' },
        { kind: 'separator' },
        { kind: 'role', role: 'services' },
        { kind: 'separator' },
        { kind: 'role', role: 'hide' },
        { kind: 'role', role: 'hideOthers' },
        { kind: 'role', role: 'unhide' },
        { kind: 'separator' },
        { kind: 'action', action: 'quit', label: `退出 ${input.productName}` },
      ],
    },
    { kind: 'role', role: 'editMenu', label: 'Edit' },
    {
      kind: 'submenu',
      label: 'View',
      items: [
        { kind: 'role', role: 'resetZoom' },
        { kind: 'role', role: 'zoomIn' },
        { kind: 'role', role: 'zoomOut' },
        { kind: 'separator' },
        { kind: 'role', role: 'togglefullscreen' },
      ],
    },
    {
      kind: 'submenu',
      label: 'Window',
      items: [
        { kind: 'action', action: 'show', label: `显示 ${input.productName}` },
        { kind: 'separator' },
        { kind: 'role', role: 'minimize' },
        { kind: 'role', role: 'zoom' },
        { kind: 'separator' },
        { kind: 'role', role: 'close' },
        { kind: 'role', role: 'front' },
      ],
    },
  ]
}

export function buildTrayMenuSpec(status: TrayStatus): MenuItemSpec[] {
  const statusLabel =
    status === 'running' ? '运行中' : status === 'recovery' ? '恢复模式可用' : '启动中'
  return [
    { kind: 'status', label: statusLabel },
    { kind: 'separator' },
    { kind: 'action', action: 'show', label: '显示主窗口' },
    { kind: 'separator' },
    { kind: 'action', action: 'quit', label: '退出' },
  ]
}

/**
 * About-panel facts from the version chain the compatibility manifest also
 * reads (Electron's own app version + process.versions), never hand-maintained
 * per-document strings.
 */
export function buildAboutPanelOptions(input: {
  productName: string
  desktopVersion: string
  electronVersion: string
}): Readonly<{ applicationName: string; applicationVersion: string; version: string }> {
  return Object.freeze({
    applicationName: input.productName,
    applicationVersion: input.desktopVersion,
    version: `Electron ${input.electronVersion}`,
  })
}

export interface NativeUiPort {
  setApplicationMenu(spec: readonly MenuItemSpec[]): void
  setTrayMenu(spec: readonly MenuItemSpec[]): void
  clearTray(): void
}

/**
 * Owns the native chrome (application menu, tray) with a single quit-time
 * teardown: show actions stop working the moment quitting begins, and the
 * tray is cleared exactly once.
 */
export class NativeUiSession {
  readonly #port: NativeUiPort
  readonly #handlers: Readonly<{ show(): void; quit(): void }>
  #status: TrayStatus | undefined
  #quitting = false
  #destroyed = false

  constructor(port: NativeUiPort, handlers: Readonly<{ show(): void; quit(): void }>) {
    this.#port = port
    this.#handlers = handlers
  }

  initialize(status: TrayStatus): void {
    this.#status = status
    this.#port.setApplicationMenu(buildApplicationMenuSpec({ productName: PRODUCT.name }))
    this.#port.setTrayMenu(buildTrayMenuSpec(status))
  }

  setStatus(status: TrayStatus): void {
    if (this.#destroyed || status === this.#status) return
    this.#status = status
    this.#port.setTrayMenu(buildTrayMenuSpec(status))
  }

  /** User-visible "show" path (menu, tray, Dock activate, second instance). */
  showMain(): void {
    if (this.#quitting || this.#destroyed) return
    this.#handlers.show()
  }

  /** The only native-UI entry into the shutdown state machine. */
  requestQuit(): void {
    if (this.#quitting || this.#destroyed) return
    this.#quitting = true
    this.#handlers.quit()
  }

  /** Freeze show during the shutdown chain (quit itself keeps flowing). */
  beginQuit(): void {
    this.#quitting = true
  }

  dispatch(action: NativeUiAction): void {
    if (action === 'show') this.showMain()
    else this.requestQuit()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#quitting = true
    this.#port.clearTray()
  }
}
