import { execFileSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireHomeLease } from '../src/lease.js'
import { unlockHome } from '../src/doctor.js'
import { writeSentinelWithDurability } from '../src/lease-fs.js'
import type { ProcessIdentity } from '../src/owner.js'
import type { ProcessProbe, ProcessScanResult, ProcessStatus } from '../src/process-probe.js'
import { createInProcessGuardLock } from '../src/native-helper.js'

import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

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
  /** Scripted transient failures: the next N inspect calls return 'unknown'. */
  #transientUnknowns = 0

  scriptTransientUnknowns(count: number): void {
    this.#transientUnknowns = count
  }

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
    if (this.#transientUnknowns > 0) {
      this.#transientUnknowns -= 1
      return 'unknown'
    }
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

  it('releases through transient unknown probes without stranding a stale lock', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    // The helper transiently cannot look the supervisor up (twice) — the
    // bounded retry must absorb this and release cleanly.
    probe.scriptTransientUnknowns(2)
    await lease.release()
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('confirms stale verdicts with a second read before believing them', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const holder = await acquireHomeLease(acquireInput(home, probe))
    // Simulate the transient misread of a live owner: one 'absent' then the
    // truth ('same') — acquisition must report BUSY, not STALE.
    const originalInspect = probe.inspect.bind(probe)
    let misreadOnce = false
    probe.inspect = async (identity) => {
      if (!misreadOnce) {
        misreadOnce = true
        return 'absent'
      }
      return originalInspect(identity)
    }
    await expect(
      acquireHomeLease({ ...acquireInput(home, probe), profile: 'headless' }),
    ).rejects.toMatchObject({ code: 'HOME_BUSY' })
    await holder.release()
  })

  it('still refuses release when the probe stays unknown beyond the retry budget', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    probe.scriptTransientUnknowns(99)
    await expect(lease.release()).rejects.toMatchObject({ code: 'LEASE_CHANGED' })
    // The lock stays for doctor exactly as before — the retry never weakens
    // the determinate refusal semantics.
    await expect(stat(path.join(home, 'run', 'host.lock'))).resolves.toBeTruthy()
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

  it('reserves the runtime launch-root prefix from lease profiles', async () => {
    // The bundled CLI leases with whatever profile it is given (including the
    // no-profile passthrough) and then lets the official CLI create
    // `<home>/profiles/<name>`; a reserved name would create a directory the
    // format inspection exempts.
    const probe = new FakeProbe()
    await expect(
      acquireHomeLease({ ...acquireInput('/tmp/x', probe), profile: '.dsh-desktop-run-user' }),
    ).rejects.toThrow(/reserved runtime launch-root prefix/u)
    await expect(
      acquireHomeLease({ ...acquireInput('/tmp/x', probe), profile: '.dsh-desktop-run-' }),
    ).rejects.toThrow(/reserved runtime launch-root prefix/u)
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

describe('probe verdict confirmation', () => {
  it('reports busy, not stale, when a live owner is misread as different once', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const holder = await acquireHomeLease(acquireInput(home, probe))
    const originalInspect = probe.inspect.bind(probe)
    let misreadOnce = false
    probe.inspect = async (identity) => {
      if (!misreadOnce) {
        misreadOnce = true
        return 'different'
      }
      return originalInspect(identity)
    }
    await expect(
      acquireHomeLease({ ...acquireInput(home, probe), profile: 'headless' }),
    ).rejects.toMatchObject({ code: 'HOME_BUSY' })
    await holder.release()
  })

  it('reports a recycled owner pid as stale only after a confirming read', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    // The recorded pid 4242 now belongs to a different live process.
    other.processes.set(4242, { startIdentity: 'boot-777', status: 'same' })
    await expect(acquireHomeLease(acquireInput(home, other))).rejects.toMatchObject({
      code: 'HOME_STALE',
    })
  })

  it('assertHeld absorbs a single self-probe misread', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    const originalInspect = probe.inspect.bind(probe)
    let misreadOnce = false
    probe.inspect = async (identity) => {
      if (!misreadOnce) {
        misreadOnce = true
        return 'absent'
      }
      return originalInspect(identity)
    }
    await expect(lease.assertHeld()).resolves.toBeUndefined()
    await lease.release()
  })

  it('releases through a single different-misread of the supervisor', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    const originalInspect = probe.inspect.bind(probe)
    let misreadOnce = false
    probe.inspect = async (identity) => {
      if (!misreadOnce) {
        misreadOnce = true
        return 'different'
      }
      return originalInspect(identity)
    }
    await lease.release()
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses release on a confirmed different supervisor and records all three identities', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    // Same generation, but the owner pid now names a different live process.
    const ownerFile = await ownerPathOf(home)
    const raw = JSON.parse(await readFile(ownerFile, 'utf8'))
    raw.supervisor = { pid: 9191, startIdentity: 'someone-else' }
    await writeFile(ownerFile, JSON.stringify(raw, null, 2))
    probe.processes.set(9191, { startIdentity: 'boot-real-9191', status: 'same' })
    await expect(lease.release()).rejects.toThrow(
      /probe: different.*owner pid 9191 recorded identity someone-else.*observed identity boot-real-9191/su,
    )
    // The lock stays for doctor.
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })
})

describe('home doctor (unlock)', () => {
  async function unlockInput(home: string, probe: FakeProbe) {
    return { home, probe, guard: createInProcessGuardLock() }
  }

  it('refuses to unlock while the recorded owner is live', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'same' })
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'refused', code: 'ACTIVE_OWNER' })
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('absorbs a single absent-misread of a live owner before deciding', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'same' })
    const originalInspect = other.inspect.bind(other)
    let misreadOnce = false
    other.inspect = async (identity) => {
      if (!misreadOnce) {
        misreadOnce = true
        return 'absent'
      }
      return originalInspect(identity)
    }
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'refused', code: 'ACTIVE_OWNER' })
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('absorbs a single different-misread of a live owner instead of deleting its lock', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'same' })
    const originalInspect = other.inspect.bind(other)
    let misreadOnce = false
    other.inspect = async (identity) => {
      if (!misreadOnce) {
        misreadOnce = true
        return 'different'
      }
      return originalInspect(identity)
    }
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'refused', code: 'ACTIVE_OWNER' })
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('unlocks a stale owner only after a confirming read', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'absent' })
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'unlocked' })
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('unlocks a recycled owner pid after confirming the mismatch', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-777', status: 'same' })
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'unlocked' })
  })

  it('keeps a sentinel so a foreign doctor can never rmdir a live v2 lock', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    const lockDir = path.join(home, 'run', 'host.lock')
    const entries = await readdir(lockDir)
    expect(entries).toContain('.dsh-writer-sentinel')
    // Reproduce exactly what a frozen older doctor does when it misreads the
    // new identity format: delete the owner, then rmdir. The sentinel must
    // make that rmdir fail and leave the lock directory in place.
    const { rm: remove, rmdir: removeDir } = await import('node:fs/promises')
    await remove(path.join(lockDir, 'owner.json'), { force: true })
    await expect(removeDir(lockDir)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect((await lstat(lockDir)).isDirectory()).toBe(true)
    // The v2-aware doctor finishes what the foreign one was refused — the
    // sentinel's named supervisor must be provably DEAD (not merely absent
    // from a scan whose needles bind to one installation's paths).
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'absent' })
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'unlocked' })
    await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await lease.release().catch(() => undefined)
  })

  it('still cleans legacy sentinel-less locks left by older builds', async () => {
    // Locks written before the v2 layout carry no sentinel; this doctor must
    // keep clearing them (the sentinel removal tolerates ENOENT).
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    await rm(path.join(home, 'run', 'host.lock', '.dsh-writer-sentinel'), { force: true })
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'absent' })
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'unlocked' })
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses to delete a live lock whose sentinel names a running supervisor', async () => {
    // Sp1 round-9 reproduction: the owner was deleted by a foreign doctor,
    // the process scan reports 'none' (its needles bind to THIS
    // installation's paths and miss another copy), but the sentinel's
    // identity is verifiably alive — the lock must survive.
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const { rm: remove } = await import('node:fs/promises')
    await remove(path.join(home, 'run', 'host.lock', 'owner.json'), { force: true })
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    // The supervisor (4242) IS alive, and the scan would say 'none'.
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'same' })
    other.scanResult = 'none'
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'refused', code: 'ACTIVE_OWNER' })
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
    expect(
      await readFile(path.join(home, 'run', 'host.lock', '.dsh-writer-sentinel'), 'utf8'),
    ).toContain('boot-1')
  })

  it('refuses an unreadable sentinel instead of treating it as a legacy missing sentinel', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const lockDir = path.join(home, 'run', 'host.lock')
    await rm(path.join(lockDir, 'owner.json'), { force: true })
    await chmod(path.join(lockDir, '.dsh-writer-sentinel'), 0o000)
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'absent' })
    other.scanResult = 'none'
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'refused', code: 'IDENTITY_UNKNOWN' })
    expect((await lstat(lockDir)).isDirectory()).toBe(true)
  })

  it('refuses a FIFO sentinel without blocking the doctor', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const lockDir = path.join(home, 'run', 'host.lock')
    await rm(path.join(lockDir, 'owner.json'), { force: true })
    const sentinel = path.join(lockDir, '.dsh-writer-sentinel')
    await rm(sentinel, { force: true })
    execFileSync('mkfifo', [sentinel])
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.scanResult = 'none'
    const result = await Promise.race([
      unlockHome(await unlockInput(home, other)),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('doctor blocked on sentinel FIFO')), 500),
      ),
    ])
    expect(result).toMatchObject({ status: 'refused', code: 'IDENTITY_UNKNOWN' })
    expect((await lstat(lockDir)).isDirectory()).toBe(true)
  })

  it('atomically replaces a sentinel symlink without touching its target', async () => {
    const home = await isolatedHome()
    const lockDir = path.join(home, 'run', 'host.lock')
    const sentinel = path.join(lockDir, '.dsh-writer-sentinel')
    const target = path.join(home, 'sentinel-target')
    await rm(lockDir, { recursive: true, force: true })
    await mkdir(lockDir, { recursive: true })
    await writeFile(target, 'must remain unchanged')
    await symlink(target, sentinel)
    await writeSentinelWithDurability(sentinel, {
      schemaVersion: 1,
      generation: 'test-generation',
      supervisor: { pid: 4242, startIdentity: 'boot-1' },
      host: null,
      pendingSpawn: false,
      entrypoint: 'desktop',
      profile: 'default',
      createdAt: '2026-01-01T00:00:00.000Z',
      appVersion: 'test',
    })
    expect(await readFile(target, 'utf8')).toBe('must remain unchanged')
    expect((await lstat(sentinel)).isFile()).toBe(true)
  })

  it('refuses an ownerless lock while the sentinel-recorded Host is still alive', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    await lease.beforeSpawn('desktop')
    probe.processes.set(5556, { startIdentity: 'host-1', status: 'same' })
    await lease.attachHost({ pid: 5556, startIdentity: 'host-1' })
    await rm(path.join(home, 'run', 'host.lock', 'owner.json'), { force: true })
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'absent' })
    other.processes.set(5556, { startIdentity: 'host-1', status: 'same' })
    other.scanResult = 'none'
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'refused', code: 'ACTIVE_OWNER' })
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })

  it('clears the sentinel on normal release', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    const lease = await acquireHomeLease(acquireInput(home, probe))
    await lease.release()
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses when the owner cannot be identified', async () => {
    const home = await isolatedHome()
    const probe = new FakeProbe()
    await acquireHomeLease(acquireInput(home, probe))
    const other = new FakeProbe()
    other.currentIdentity = { pid: 5151, startIdentity: 'boot-9' }
    other.processes.set(4242, { startIdentity: 'boot-1', status: 'unknown' })
    const result = await unlockHome(await unlockInput(home, other))
    expect(result).toMatchObject({ status: 'refused', code: 'IDENTITY_UNKNOWN' })
    expect((await lstat(path.join(home, 'run', 'host.lock'))).isDirectory()).toBe(true)
  })
})
