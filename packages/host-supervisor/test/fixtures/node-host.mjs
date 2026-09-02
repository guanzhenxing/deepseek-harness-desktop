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
