import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { createDesktopSurfacePublisher, type DesktopSurfaceService } from './runtime.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopSurface?: DesktopSurfaceService
  }
}

export * from './runtime.js'

export const name = 'desktop-surface'

export function apply(ctx: Context): void {
  const publisher = createDesktopSurfacePublisher()
  ctx.inject(['connection', 'webServer'], (readyContext) => {
    publisher.publish({
      connection: readyContext.connection,
      webServer: readyContext.webServer,
      desktopSurface: readyContext.get('desktopSurface'),
    })
  })
}
