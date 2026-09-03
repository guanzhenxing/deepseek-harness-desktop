import type { BrowserWindow } from 'electron'

/**
 * App-side scripted sequences for the navigation and lifecycle smokes. They
 * run only in the matching `DSH_DESKTOP_SMOKE` mode against the throwaway
 * smoke home, so no test-only behavior is reachable from a normal launch.
 */
export type SmokeSequenceContext = Readonly<{
  window: BrowserWindow
  showMain(): void
  simulateDockActivate(): void
  /** Resolves once the launcher-owned recovery view is actually visible. */
  waitForRecoveryView(): Promise<void>
  report(payload: Record<string, unknown>): void
  quit(): void
}>

export function isScriptedSmokeMode(mode: string | undefined): boolean {
  return mode === 'navigation' || mode === 'lifecycle'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForLoad(window: BrowserWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.webContents.removeListener('did-finish-load', onLoad)
      reject(new Error('renderer did not finish reloading in time'))
    }, timeoutMs)
    const onLoad = (): void => {
      clearTimeout(timer)
      resolve()
    }
    window.webContents.once('did-finish-load', onLoad)
  })
}

/**
 * Drives every guarded navigation surface once: popups through the
 * window-open guard (approved, file, loopback) and main-frame navigations
 * through the navigation guard (approved external, loopback, file). The
 * recording openExternal adapter reports what actually reached the external
 * path; the driver asserts that only the two approved https targets did.
 */
export async function runNavigationSequence(context: SmokeSequenceContext): Promise<void> {
  const wc = context.window.webContents
  await wc.executeJavaScript(
    `(() => {
      try { window.open('https://example.com/popup-approved', '_blank') } catch {}
      try { window.open('file:///etc/passwd', '_blank') } catch {}
      try { window.open('http://127.0.0.1:9999/?token=leak', '_blank') } catch {}
      return true
    })()`,
  )
  await sleep(600)
  await wc.executeJavaScript(
    `(() => {
      try { location.assign('https://example.com/main-frame-approved') } catch {}
      return true
    })()`,
  )
  await sleep(400)
  await wc.executeJavaScript(
    `(() => {
      try { location.assign('http://127.0.0.1:9999/?token=leak2') } catch {}
      try { location.assign('file:///etc/passwd') } catch {}
      return true
    })()`,
  )
  await sleep(400)
  context.report({
    kind: 'navigation-probe-done',
    currentUrl: context.window.webContents.getURL(),
  })
}

/**
 * Exercises close-to-hide, tray-style show, Dock activation, and the
 * reload-once renderer-crash budget end to end; the driver asserts the
 * reported steps and that the final renderer crash lands in the local
 * recovery view.
 */
export async function runLifecycleSequence(context: SmokeSequenceContext): Promise<void> {
  const window = context.window
  // Close while running hides to the tray instead of destroying the window.
  window.close()
  await sleep(400)
  context.report({
    kind: 'lifecycle',
    step: 'close-hidden',
    visible: window.isVisible(),
    destroyed: window.isDestroyed(),
  })
  // The tray "show" action restores it.
  context.showMain()
  await sleep(300)
  context.report({ kind: 'lifecycle', step: 'tray-shown', visible: window.isVisible() })
  // Dock activation restores a hidden window.
  window.hide()
  await sleep(200)
  context.simulateDockActivate()
  await sleep(300)
  context.report({ kind: 'lifecycle', step: 'dock-activated', visible: window.isVisible() })
  // First renderer crash reloads the same live surface once.
  window.webContents.forcefullyCrashRenderer()
  await waitForLoad(window, 15_000)
  context.report({ kind: 'lifecycle', step: 'renderer-reload-verified' })
  await sleep(300)
  // Second crash on the same surface must not reload again: it goes to the
  // launcher-owned recovery view (reported as renderer-crashed/recovery-view).
  window.webContents.forcefullyCrashRenderer()
  await Promise.race([
    context.waitForRecoveryView(),
    sleep(30_000).then(() => {
      throw new Error('recovery view did not appear after the second renderer crash')
    }),
  ])
  context.report({ kind: 'lifecycle', step: 'sequence-done' })
  context.quit()
}
