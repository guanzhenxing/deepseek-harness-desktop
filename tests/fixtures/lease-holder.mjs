import { createInterface } from 'node:readline'

import { acquireHomeLease, createNativeProcessProbe } from '../../packages/home-lease/lib/index.js'

const home = process.argv[2]

if (typeof home !== 'string' || home.length === 0) {
  console.error('lease-holder requires a home argument')
  process.exit(2)
}

const lease = await acquireHomeLease({
  home,
  entrypoint: 'bundled-cli',
  profile: 'desktop',
  appVersion: '0.0.0',
  probe: createNativeProcessProbe({
    helperPath: process.env.DSH_DESKTOP_LEASE_HELPER,
    entryExecutables: [],
  }),
})

console.log(`ACQUIRED ${lease.generation}`)

const lines = createInterface({ input: process.stdin })
let released = false
for await (const line of lines) {
  if (line.trim() !== 'release') continue
  released = true
  break
}
if (!released) {
  console.error('lease-holder stdin closed without a release request')
  process.exit(1)
}
await lease.release()
console.log('RELEASED')
process.exit(0)
