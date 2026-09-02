// Sandboxed preloads must be CommonJS (.cts -> .cjs); Electron's ESM
// limitations forbid ESM preloads, so this file uses require().
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const api = {
  requestAction(action: string): void {
    ipcRenderer.send('recovery:action', { kind: 'recovery-action', action })
  },
  onView(listener: (view: unknown) => void): () => void {
    const subscription = (_event: unknown, view: unknown): void => listener(view)
    ipcRenderer.on('recovery:view', subscription as never)
    return () => ipcRenderer.removeListener('recovery:view', subscription as never)
  },
}

contextBridge.exposeInMainWorld('dshRecovery', api)
