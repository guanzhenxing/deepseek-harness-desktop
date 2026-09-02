import type { HostBootstrap } from '@dsh-desktop/host-supervisor'
import { runDshHost, type HostControlTransport } from '@dsh-desktop/host-supervisor/host-runner'

type ElectronHostBootstrap = Omit<HostBootstrap, 'mode'> & {
  mode: 'normal'
  startIdentity: string
}

function isBootstrap(value: unknown): value is ElectronHostBootstrap {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return (
    typeof input.home === 'string' &&
    typeof input.profileName === 'string' &&
    input.mode === 'normal' &&
    typeof input.capability === 'string' &&
    input.capability.length >= 32 &&
    typeof input.leaseGeneration === 'string' &&
    typeof input.startIdentity === 'string'
  )
}

async function main(): Promise<void> {
  const parentPort = process.parentPort
  if (parentPort === null) throw new Error('Host runner requires an Electron parent port')
  const bootstrap = await new Promise<ElectronHostBootstrap>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Host bootstrap timed out')), 10_000)
    parentPort.once('message', (event) => {
      clearTimeout(timeout)
      const input = event.data as { kind?: unknown; bootstrap?: unknown }
      if (input?.kind !== 'dsh-desktop-bootstrap' || !isBootstrap(input.bootstrap)) {
        reject(new Error('Host bootstrap is invalid'))
        return
      }
      resolve(input.bootstrap)
    })
  })
  const transport: HostControlTransport = {
    postMessage: (message) => parentPort.postMessage(message),
    onMessage(listener) {
      const onMessage = (event: Electron.MessageEvent): void => listener(event.data)
      parentPort.on('message', onMessage)
      return () => parentPort.off('message', onMessage)
    },
  }
  const host = await runDshHost({
    ...bootstrap,
    hostIdentity: { pid: process.pid, startIdentity: bootstrap.startIdentity },
    transport,
  })
  await host.disposed
}

void main().then(
  () => {
    process.exitCode = 0
  },
  () => {
    console.error('dsh-desktop Host failed')
    process.exitCode = 1
  },
)
