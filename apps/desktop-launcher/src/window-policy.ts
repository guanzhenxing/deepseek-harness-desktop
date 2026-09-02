export const DESKTOP_RENDERER_PARTITION = 'persist:dsh-desktop-renderer'

export const DESKTOP_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  partition: DESKTOP_RENDERER_PARTITION,
  sandbox: true,
  webSecurity: true,
})

export function denyWindowOpen(): { action: 'deny' } {
  return { action: 'deny' }
}
