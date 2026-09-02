import { lstat, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireHomeLease } from '../src/lease.js'
import type { ProcessIdentity } from '../src/owner.js'
import type { ProcessProbe, ProcessScanResult, ProcessStatus } from '../src/process-probe.js'
import { createInProcessGuardLock } from '../src/native-helper.js'

import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.js'

const fixtures: IsolatedHomeFixture[] = []

async function isolatedHome(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

class FakeProbe implements ProcessProbe {
  readonly processes = new Map<number, { startIdentity: string; status: ProcessStatus }>()
  #currentIdentity: ProcessIdentity = { pid: 4242, startIdentity: 'boot-1' }
  scanResult: ProcessScanResult = 'none'

  constructor() {
    this.processes.set(this.#currentIdentity.pid, {
      startIdentity: this.#currentIdentity.startIdentity,
      status: 'same',
    })
  }

  get currentIdentity(): ProcessIdentity {
    return this.#currentIdentity
  }

  set currentIdentity(identity: ProcessIdentity) {
    this.processes.delete(this.#currentIdentity.pid)
    this.#currentIdentity = identity
    this.processes.set(identity.pid, { startIdentity: identity.startIdentity, status: 'same' })
  }

  async current(): Promise<ProcessIdentity> {
    return this.#currentIdentity
  }

  async identify(pid: number): Promise<ProcessIdentity> {
    const process = this.processes.get(pid)
    if (process === undefined) throw new Error(`fake probe cannot identify pid ${pid}`)
    return { pid, startIdentity: process.startIdentity }
  }

  async inspect(identity: ProcessIdentity): Promise<ProcessStatus> {
    const process = this.processes.get(identity.pid)
    if (process === undefined) return 'unknown'
    if (process.startIdentity !== identity.startIdentity) return 'different'
    return process.status
  }

  async scanSupported(): Promise<ProcessScanResult> {
    return this.scanResult
  }
}

function acquireInput(home: string, probe: FakeProbe, profile = 'desktop') {
  return {
    home,
    entrypoint: 'desktop' as const,
    profile,
    appVersion: '0.0.0',
    probe,
    guard: createInProcessGuardLock(),
  }
}

async function ownerPathOf(home: string): Promise<string> {
  return path.join(home, 'run', 'host.lock', 'owner.json')
}

describe('home lease acquisition', () => {
  it('lets exactly one entrypoint win the same home and reports busy for the other profile', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const input = acquireInput(home, probe)
    const first = await acquireHomeLease(input)
    await expect(acquireHomeLease({ ...input, profile: 'headless' })).rejects.toMatchObject({
      code: 'HOME_BUSY',
    })
    expect(first.generation).toMatch(/^[0-9a-f-]{36}$/u)
    await first.release()
  })

  it('reports a stale owner instead of auto-recovering it', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const first = await acquireHomeLease(acquireInput(home, probe))
    // Simulate the holder dying without releasing: a different supervisor
    // observes the recorded owner process as absent.
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'absent' })
    await expect(acquireHomeLease(acquireInput(home, other))).rejects.toMatchObject({
      code: 'HOME_STALE',
    })
    // The original holder can still clean up after itself.
    await first.release()
    const third = await acquireHomeLease(acquireInput(home, other))
    await third.release()
  })

  it('refuses when the owner liveness cannot be determined', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'unknown' })
    await expect(acquireHomeLease(acquireInput(home, other))).rejects.toMatchObject({
      code: 'LEASE_UNKNOWN',
    })
  })

  it('treats a corrupt or missing owner file as unknown, never recyclable', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const ownerFile = await ownerPathOf(home)
    await acquireHomeLease(acquireInput(home, probe))
    await writeFile(ownerFile, '{not json', 'utf8')
    await expect(acquireHomeLease(acquireInput(home, probe))).rejects.toMatchObject({
      code: 'LEASE_UNKNOWN',
    })
    await rm(ownerFile, { force: true })
    await expect(acquireHomeLease(acquireInput(home, probe))).rejects.toMatchObject({
      code: 'LEASE_UNKNOWN',
    })
  })

  it('creates private directory and file permissions', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const runMode = (await stat(path.join(home, 'run'))).mode & 0o777
    const lockMode = (await stat(path.join(home, 'run', 'host.lock'))).mode & 0o777
    const ownerMode = (await stat(await ownerPathOf(home))).mode & 0o777
    expect(runMode).toBe(0o700)
    expect(lockMode).toBe(0o700)
    expect(ownerMode).toBe(0o600)
  })

  it('rejects a symlinked run directory before touching the lock', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const external = await isolatedHome()
    const run = path.join(home, 'run')
    await rm(run, { recursive: true, force: true })
    const { symlink } = await import('node:fs/promises')
    await symlink(path.join(external, 'run'), run, 'dir')
    await expect(acquireHomeLease(acquireInput(home, probe))).rejects.toThrow(/symlink/u)
  })
})

describe('home lease lifecycle', () => {
  it('removes only its own lock directory and is idempotent', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    await lease.release()
    await lease.release()
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const second = await acquireHomeLease(acquireInput(home, probe))
    expect(second.generation).not.toBe(lease.generation)
    await second.release()
  })

  it('refuses to release a lock whose generation moved on', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    const ownerFile = await ownerPathOf(home)
    const raw = JSON.parse(await readFile(ownerFile, 'utf8'))
    raw.generation = 'takeover-generation'
    await writeFile(ownerFile, JSON.stringify(raw, null, 2))
    await expect(lease.release()).rejects.toMatchObject({ code: 'LEASE_CHANGED' })
  })

  it('persists pendingSpawn before the host exists and attachHost completes it', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    const hostIdentity: ProcessIdentity = { pid: 6161, startIdentity: 'boot-2' }
    probe.processes.set(6161, { startIdentity: 'boot-2', status: 'same' })

    await expect(lease.attachHost(hostIdentity)).rejects.toMatchObject({ code: 'LEASE_STATE' })
    await lease.beforeSpawn('desktop')
    const pending = JSON.parse(await readFile(await ownerPathOf(home), 'utf8'))
    expect(pending.pendingSpawn).toBe(true)
    expect(pending.host).toBeNull()
    await expect(lease.beforeSpawn('desktop')).rejects.toMatchObject({ code: 'LEASE_STATE' })
    await lease.attachHost(hostIdentity)
    const attached = JSON.parse(await readFile(await ownerPathOf(home), 'utf8'))
    expect(attached.pendingSpawn).toBe(false)
    expect(attached.host).toEqual({ pid: 6161, startIdentity: 'boot-2' })

    await expect(lease.release()).rejects.toMatchObject({ code: 'HOST_ACTIVE' })
    await lease.confirmHostExited()
    await lease.confirmHostExited()
    await lease.release()
  })

  it('refuses to release while a spawn is still pending', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    await lease.beforeSpawn('desktop')
    await expect(lease.release()).rejects.toMatchObject({ code: 'PENDING_SPAWN' })
    await lease.confirmHostExited()
    await lease.release()
  })

  it('refuses release when host liveness is unknown', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    await lease.beforeSpawn('desktop')
    await lease.attachHost({ pid: 6161, startIdentity: 'boot-2' })
    probe.processes.set(6161, { startIdentity: 'boot-2', status: 'unknown' })
    await expect(lease.release()).rejects.toMatchObject({ code: 'LEASE_UNKNOWN' })
    probe.processes.set(6161, { startIdentity: 'boot-2', status: 'absent' })
    await lease.release()
  })

  it('switches the owner profile under guard and refuses while a host is registered', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    await lease.switchProfile('desktop-safe-mode')
    await expect(lease.beforeSpawn('desktop-safe-mode')).resolves.toBeUndefined()
    await expect(lease.beforeSpawn('desktop')).rejects.toMatchObject({
      code: 'LEASE_PROFILE_MISMATCH',
    })
    const owner = JSON.parse(await readFile(await ownerPathOf(home), 'utf8')) as {
      profile: string
    }
    expect(owner.profile).toBe('desktop-safe-mode')
    await lease.attachHost({ pid: 9999, startIdentity: 'host-1' })
    await expect(lease.switchProfile('desktop')).rejects.toMatchObject({ code: 'LEASE_STATE' })
    await lease.confirmHostExited()
    await lease.switchProfile('desktop')
    await expect(lease.beforeSpawn('desktop')).resolves.toBeUndefined()
    await lease.confirmHostExited()
    await expect(lease.switchProfile('../escape')).rejects.toMatchObject({
      code: 'LEASE_PROFILE_MISMATCH',
    })
    await lease.release()
  })

  it('guards beforeSpawn against profile drift and asserts continued ownership', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    await expect(lease.beforeSpawn('headless')).rejects.toMatchObject({
      code: 'LEASE_PROFILE_MISMATCH',
    })
    await lease.assertHeld()

    const ownerFile = await ownerPathOf(home)
    const raw = JSON.parse(await readFile(ownerFile, 'utf8'))
    raw.generation = 'takeover-generation'
    await writeFile(ownerFile, JSON.stringify(raw, null, 2))
    await expect(lease.assertHeld()).rejects.toMatchObject({ code: 'LEASE_CHANGED' })
    await expect(lease.beforeSpawn('desktop')).rejects.toMatchObject({ code: 'LEASE_CHANGED' })
  })

  it('rejects empty or root homes and invalid profiles', async () => {
    const probe = new FakeProbe()
    await expect(acquireHomeLease({ ...acquireInput('', probe) })).rejects.toThrow(/explicit home/u)
    await expect(acquireHomeLease({ ...acquireInput('/', probe) })).rejects.toThrow(/root/u)
    await expect(
      acquireHomeLease({ ...acquireInput('/tmp/x', probe), profile: 'a/b' }),
    ).rejects.toThrow(/invalid lease profile/u)
  })

  it('refuses to release a lock directory that gained unexpected entries', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    const extra = path.join(home, 'run', 'host.lock', 'unexpected')
    const { writeFile: write } = await import('node:fs/promises')
    await write(extra, 'keep', 'utf8')
    await expect(lease.release()).rejects.toMatchObject({ code: 'LEASE_UNKNOWN' })
    expect(await readFile(extra, 'utf8')).toBe('keep')
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('refuses to release when the recorded supervisor identity is not this process', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    // Same generation, but the owner now names a different supervisor.
    const ownerFile = await ownerPathOf(home)
    const raw = JSON.parse(await readFile(ownerFile, 'utf8'))
    raw.supervisor = { pid: 9191, startIdentity: 'someone-else' }
    await writeFile(ownerFile, JSON.stringify(raw, null, 2))
    await expect(lease.release()).rejects.toMatchObject({ code: 'LEASE_CHANGED' })
    // The lock stays for doctor.
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('rejects a symlinked guard before any chmod side effect', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const external = await isolatedHome()
    const {
      symlink,
      mkdir: makeDirectory,
      writeFile: write,
      stat: statFile,
    } = await import('node:fs/promises')
    await makeDirectory(path.join(home, 'run'), { mode: 0o700 })
    const target = path.join(external, 'guard-target')
    await write(target, 'outside', { mode: 0o644 })
    await symlink(target, path.join(home, 'run', 'host-lease.guard'))
    await expect(acquireHomeLease(acquireInput(home, probe))).rejects.toThrow(/symlink/u)
    // The file outside the home keeps its original permissions.
    expect((await statFile(target)).mode & 0o777).toBe(0o644)
    expect(await readFile(target, 'utf8')).toBe('outside')
  })

  it('rejects a non-regular guard inode without touching its mode', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const { execFileSync } = await import('node:child_process')
    const { mkdir: makeDirectory, stat: statFile } = await import('node:fs/promises')
    await makeDirectory(path.join(home, 'run'), { mode: 0o700 })
    execFileSync('mkfifo', [path.join(home, 'run', 'host-lease.guard')])
    await expect(acquireHomeLease(acquireInput(home, probe))).rejects.toThrow(/regular file/u)
    expect((await statFile(path.join(home, 'run', 'host-lease.guard'))).isFIFO()).toBe(true)
  })

  it('tightens pre-existing run and guard permissions to the protocol modes', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const { mkdir: makeDirectory, writeFile: write } = await import('node:fs/promises')
    await makeDirectory(path.join(home, 'run'), { mode: 0o755 })
    await write(path.join(home, 'run', 'host-lease.guard'), 'loose', { mode: 0o644 })
    await acquireHomeLease(acquireInput(home, probe))
    expect((await stat(path.join(home, 'run'))).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(home, 'run', 'host-lease.guard'))).mode & 0o777).toBe(0o600)
    expect((await stat(await ownerPathOf(home))).mode & 0o777).toBe(0o600)
  })
})
