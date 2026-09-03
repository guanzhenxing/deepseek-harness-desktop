export type RendererCrashDecision = 'reload' | 'recovery'

export type RendererReloadInput = Readonly<{
  reloadsUsed: number
  hostSurfaceAlive: boolean
  quitting: boolean
}>

/**
 * A renderer crash reloads at most once, and only while the Host surface that
 * page belongs to is still alive and the app is not quitting. Anything else
 * goes to the launcher-owned local recovery view instead of a reload loop.
 */
export function shouldAutoReloadRenderer(input: RendererReloadInput): RendererCrashDecision {
  if (input.quitting || !input.hostSurfaceAlive) return 'recovery'
  return input.reloadsUsed < 1 ? 'reload' : 'recovery'
}

/**
 * Tracks the reload budget for the currently mounted Host surface. A new
 * surface (fresh boot, retry, or Safe Mode) earns a fresh budget; the budget
 * is spent only when a reload actually starts.
 */
export class RendererReloadBudget {
  #surfaceLoaded = false
  #reloadsUsed = 0

  get reloadsUsed(): number {
    return this.#reloadsUsed
  }

  noteSurfaceLoaded(): void {
    this.#surfaceLoaded = true
    this.#reloadsUsed = 0
  }

  consumeIfAvailable(input: Readonly<{ hostSurfaceAlive: boolean; quitting: boolean }>): boolean {
    if (
      !this.#surfaceLoaded ||
      shouldAutoReloadRenderer({ ...input, reloadsUsed: this.#reloadsUsed }) !== 'reload'
    ) {
      return false
    }
    this.#reloadsUsed += 1
    return true
  }
}
