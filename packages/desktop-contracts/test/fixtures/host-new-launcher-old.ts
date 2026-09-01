import type { HostEnvelope, MinorRange } from '../../src/host-control.js'

export const launcherOldMinorRange: MinorRange = { min: 0, max: 0 }

export const hostNewHello: HostEnvelope = {
  protocol: { name: 'dsh-desktop/host-control', major: 1, minor: 0 },
  direction: 'host-to-launcher',
  capability: 'c'.repeat(43),
  leaseGeneration: 'lease-generation-1',
  sequence: 1,
  message: {
    kind: 'hello',
    host: { pid: 4321, startIdentity: 'start-123' },
    profile: { name: 'desktop' },
    mode: 'normal',
    supportedMinor: { min: 0, max: 1 },
  },
}
