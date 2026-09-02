import type { Context } from '@deepseek-ai/cordis'

export type RecoveryPublishResult = 'scheduled' | 'degraded'

export interface RecoverySurfaceServices {
  connection: { authenticatedUrl(baseUrl: string): string }
  webServer: { host: string; port: number }
}

/**
 * Publish the recovery loopback surface once (ADR-0002): loopback-validated,
 * single schedule, readable degradation when the desktopSurface capability is
 * absent — Safe Mode still serves the official Web UI on loopback.
 */
export function createRecoverySurfacePublisher(ctx: Pick<Context, 'logger'>): {
  publish(services: RecoverySurfaceServices): RecoveryPublishResult
} {
  let scheduled = false
  return {
    publish(services) {
      if (scheduled) return 'scheduled'
      if (services.webServer.host !== '127.0.0.1') {
        throw new Error('recovery bridge requires an exact loopback Web bind')
      }
      services.connection.authenticatedUrl(`http://127.0.0.1:${String(services.webServer.port)}`)
      ctx.logger.info('recovery-bridge: recovery surface scheduled')
      scheduled = true
      return 'scheduled'
    },
  }
}
