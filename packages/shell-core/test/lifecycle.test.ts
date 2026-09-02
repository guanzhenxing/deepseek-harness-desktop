import { describe, expect, it, vi } from 'vitest'

import type { HostReady } from '@dsh-desktop/host-supervisor'

import { DesktopShellController } from '../src/lifecycle.js'

const ready: HostReady = {
  pid: 4321,
  startIdentity: 'start-123',
  surface: { kind: 'loopback', url: 'http://127.0.0.1:43123/?token=secret' },
  origin: 'http://127.0.0.1:43123',
}

function fixture(overrides: { startHost?: () => Promise<HostReady> } = {}) {
  const prepareProfile = vi.fn(async () => undefined)
  const startHost = vi.fn(overrides.startHost ?? (async () => ready))
  const stopHost = vi.fn(async () => undefined)
  const loadSurface = vi.fn(async () => undefined)
  const showRecovery = vi.fn(async () => undefined)
  const destroySurface = vi.fn()
  const shell = new DesktopShellController({
    prepareProfile,
    host: { start: startHost, stop: stopHost },
    window: { loadSurface, showRecovery, destroySurface },
  })
  return {
    destroySurface,
    loadSurface,
    prepareProfile,
    shell,
    showRecovery,
    startHost,
    stopHost,
  }
}

describe('DesktopShellController', () => {
  it('becomes healthy only after profile, Host and BrowserWindow succeed', async () => {
    const setup = fixture()
    await setup.shell.start()
    expect(setup.prepareProfile).toHaveBeenCalledBefore(setup.startHost)
    expect(setup.startHost).toHaveBeenCalledBefore(setup.loadSurface)
    expect(setup.loadSurface).toHaveBeenCalledWith(ready.surface, ready.origin)
    expect(setup.shell.state).toBe('healthy')
  })

  it('shows launcher-owned recovery when startup fails', async () => {
    const setup = fixture({ startHost: async () => Promise.reject(new Error('boot failed')) })
    await expect(setup.shell.start()).rejects.toThrow('boot failed')
    expect(setup.showRecovery).toHaveBeenCalledWith('BOOT_FAILED')
    expect(setup.shell.state).toBe('recovery')
  })

  it('destroys a stale surface and keeps the shell in recovery after Host crash', async () => {
    const setup = fixture()
    await setup.shell.start()
    await setup.shell.hostCrashed()
    expect(setup.destroySurface).toHaveBeenCalledOnce()
    expect(setup.showRecovery).toHaveBeenCalledWith('HOST_CRASHED')
    expect(setup.stopHost).not.toHaveBeenCalled()
    expect(setup.shell.state).toBe('recovery')
  })

  it('merges shutdown and stops Host exactly once', async () => {
    const setup = fixture()
    await setup.shell.start()
    await Promise.all([setup.shell.stop(), setup.shell.stop()])
    expect(setup.stopHost).toHaveBeenCalledOnce()
    expect(setup.shell.state).toBe('stopped')
  })
})
