import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { LeaseError } from '../src/owner.js'
import {
  acquireHomeLease,
  createNativeGuardLock,
  createNativeProcessProbe,
  defaultLeaseHelperPath,
} from '../src/index.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.mjs'

const helperPath = defaultLeaseHelperPath()
const holderScript = fileURLToPath(
  new URL('../../../tests/fixtures/lease-holder.mjs', import.meta.url),
)

const helperAvailable =
  process.platform === 'darwin' &&
  spawnSync(helperPath, ['identity', String(process.pid)], { timeout: 5_000 }).status === 0

const fixtures: IsolatedHomeFixture[] = []

async function isolatedHome(): Promise<string> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  return fixture.home
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

function nativeProbe(): ReturnType<typeof createNativeProcessProbe> {
  return createNativeProcessProbe({ helperPath, entryExecutables: [] })
}

function acquire(home: string, profile = 'desktop') {
  return acquireHomeLease({
    home,
    entrypoint: 'desktop',
    profile,
    appVersion: '0.0.0',
    probe: nativeProbe(),
  })
}

function errorCode(error: unknown): string | undefined {
  return error instanceof LeaseError ? error.code : undefined
}

interface HolderHandle {
  readonly child: ChildProcess
  readonly generation: string
  nextLine(): Promise<string>
  requestRelease(): Promise<void>
}

async function startHolder(home: string): Promise<HolderHandle> {
  const child = spawn(process.execPath, [holderScript, home], {
    env: { ...process.env, DSH_DESKTOP_LEASE_HELPER: helperPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const pending: ((line: string) => void)[] = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line !== '') pending.shift()?.(line)
      newline = buffer.indexOf('\n')
    }
  })
  const nextLine = () =>
    new Promise<string>((resolve, reject) => {
      pending.push(resolve)
      child.once('exit', () => reject(new Error('holder exited before printing a line')))
    })
  const first = await nextLine()
  if (!first.startsWith('ACQUIRED ')) throw new Error(`holder printed unexpected output: ${first}`)
  return {
    child,
    generation: first.slice('ACQUIRED '.length),
    nextLine,
    async requestRelease() {
      child.stdin.write('release\n')
      const confirmation = await nextLine()
      if (confirmation !== 'RELEASED') {
        throw new Error(`holder printed unexpected release output: ${confirmation}`)
      }
      const exit = await new Promise<{ code: number | null }>((resolve) => {
        child.once('exit', (code) => resolve({ code }))
      })
      if (exit.code !== 0) throw new Error(`holder exited with code ${exit.code}`)
    },
  }
}

describe.skipIf(!helperAvailable)('real helper process identity', () => {
  it('distinguishes the current process and a dead pid', async () => {
    const probe = nativeProbe()
    const identity = await probe.current()
    expect(identity.pid).toBe(process.pid)
    expect(identity.startIdentity).toMatch(/^[0-9]/u)
    await expect(probe.inspect(identity)).resolves.toBe('same')
    await expect(
      probe.inspect({ pid: 999_999_999, startIdentity: identity.startIdentity }),
    ).resolves.toBe('absent')
    await expect(probe.inspect({ pid: process.pid, startIdentity: '0.0-1.1' })).resolves.toBe(
      'different',
    )
  })

  it('finds a live entry executable through scanSupported', async () => {
    const sleeper = spawn('/bin/sleep', ['10'])
    try {
      const probe = createNativeProcessProbe({
        helperPath,
        entryExecutables: ['/nonexistent/dsh-desktop-entry', '/bin/sleep'],
      })
      await expect(probe.scanSupported()).resolves.toBe('active')
      const noneProbe = createNativeProcessProbe({
        helperPath,
        entryExecutables: ['/nonexistent/dsh-desktop-entry'],
      })
      // A same-uid process in a transient exec state can legitimately make one
      // scan fail closed as unknown; a quiet system must settle on none.
      let settled: string | undefined
      for (let attempt = 0; attempt < 10 && settled === undefined; attempt += 1) {
        const result = await noneProbe.scanSupported()
        if (result === 'none') settled = result
        else await new Promise((resolve) => setTimeout(resolve, 150))
      }
      expect(settled).toBe('none')
    } finally {
      sleeper.kill('SIGKILL')
      await new Promise((resolve) => sleeper.once('exit', resolve))
    }
  })

  it('serializes the guard critical section across processes', async () => {
    const guardPath = path.join(await isolatedHome(), 'run', 'host-lease.guard')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.dirname(guardPath), { recursive: true, mode: 0o700 })
    const identity = await stat(path.dirname(guardPath))
    const guard = createNativeGuardLock(helperPath)
    const first = await guard.lock({
      guardPath,
      parentDirectory: path.dirname(guardPath),
      parentDev: identity.dev,
      parentIno: identity.ino,
    })
    try {
      await expect(
        guard.lock({
          guardPath,
          parentDirectory: path.dirname(guardPath),
          parentDev: identity.dev,
          parentIno: identity.ino,
          retryMs: 100,
        }),
      ).rejects.toMatchObject({ code: 'GUARD_BUSY' })
    } finally {
      await first.release()
    }
    const second = await guard.lock({
      guardPath,
      parentDirectory: path.dirname(guardPath),
      parentDev: identity.dev,
      parentIno: identity.ino,
      retryMs: 100,
    })
    await second.release()
  })
})

describe.skipIf(!helperAvailable)('real two-process home lease', () => {
  it('rejects a second entrypoint while another process holds the home', async () => {
    const home = await isolatedHome()
    const holder = await startHolder(home)
    try {
      const busy = await acquire(home).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(busy).toBeInstanceOf(LeaseError)
      expect(errorCode(busy)).toBe('HOME_BUSY')
      expect((busy as LeaseError).ownerSummary).toContain('bundled-cli')
    } finally {
      await holder.requestRelease()
    }
    const lease = await acquire(home)
    expect(lease.generation).not.toBe(holder.generation)
    await lease.release()
    await expect(stat(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('guards release against a live recorded host process', async () => {
    const home = await isolatedHome()
    const lease = await acquire(home)
    const probe = nativeProbe()
    const host = spawn('/bin/sleep', ['30'])
    const hostIdentity = await probe.identify(host.pid as number)
    await lease.beforeSpawn('desktop')
    await lease.attachHost(hostIdentity)
    await expect(lease.release()).rejects.toMatchObject({ code: 'HOST_ACTIVE' })
    host.kill('SIGKILL')
    await new Promise((resolve) => host.once('exit', resolve))
    await vi.waitFor(async () => {
      await expect(probe.inspect(hostIdentity)).resolves.toBe('absent')
    })
    await lease.confirmHostExited()
    await lease.release()
  })

  it('reports a killed holder as stale instead of recovering it', async () => {
    const home = await isolatedHome()
    const holder = await startHolder(home)
    holder.child.kill('SIGKILL')
    await new Promise((resolve) => holder.child.once('exit', resolve))
    const stale = await acquire(home).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(stale).toBeInstanceOf(LeaseError)
    expect(errorCode(stale)).toBe('HOME_STALE')
    expect((stale as LeaseError).ownerSummary).toContain('bundled-cli')
  })

  it('lets exactly one of many concurrent acquirers win', async () => {
    const home = await isolatedHome()
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquire(home, 'desktop')),
    )
    const winners = results.filter((result) => result.status === 'fulfilled')
    const busy = results.filter(
      (result) => result.status === 'rejected' && errorCode(result.reason) === 'HOME_BUSY',
    )
    expect(winners).toHaveLength(1)
    expect(busy).toHaveLength(7)
    await (
      winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquire>>>
    ).value.release()
  })
})
