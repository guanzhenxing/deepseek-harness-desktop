import { fileURLToPath } from 'node:url'

import { runDshHost } from '../../lib/host-runner.js'

const bootstrap = await new Promise((resolve) => {
  process.once('message', resolve)
})

const transport = {
  postMessage(message) {
    process.send?.(message)
  },
  onMessage(listener) {
    process.on('message', listener)
    return () => process.off('message', listener)
  },
}

try {
  const host = await runDshHost({
    ...bootstrap,
    productInstallAnchor: fileURLToPath(
      new URL('../../../../apps/desktop-launcher/package.json', import.meta.url),
    ),
    hostIdentity: {
      pid: process.pid,
      startIdentity: bootstrap.startIdentity,
    },
    transport,
  })
  await host.disposed
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
