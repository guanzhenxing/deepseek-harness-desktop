import { readFileSync } from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import path from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createInProcessGuardLock,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'

import {
  planCliInvocation,
  runBundledCli,
  type CliChildHandle,
  type SpawnCliChild,
} from '../src/main.js'
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

class MemoryStderr extends Writable {
  readonly chunks: string[] = []

  override _write(
    chunk: string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(String(chunk))
    callback()
  }

  text(): string {
    return this.chunks.join('')
  }
}

const fakeProbe: ProcessProbe = {
  async current() {
    return { pid: process.pid, startIdentity: 'wrapper-self' }
  },
  async identify(pid) {
    return { pid, startIdentity: 'cli-child-os' }
  },
  async inspect() {
    return 'same' as const
  },
  async scanSupported() {
    return 'none' as const
  },
}

function makeFakeChild(exitCode = 0): {
  spawn: SpawnCliChild
  forwarded: () => unknown[]
  kills: () => readonly NodeJS.Signals[]
} {
  const forwardedMessages: unknown[] = []
  const killSignals: NodeJS.Signals[] = []
  const spawn: SpawnCliChild = () => {
    const handle: CliChildHandle = {
      pid: 5555,
      send(message) {
        forwardedMessages.push(message)
      },
      exited: Promise.resolve({ code: exitCode, signal: null }),
      kill(signal = 'SIGTERM') {
        killSignals.push(signal)
      },
    }
    return handle
  }
  return { spawn, forwarded: () => forwardedMessages, kills: () => [...killSignals] }
}

function ownerPathOf(home: string): string {
  return path.join(home, 'run', 'host.lock', 'owner.json')
}

describe('planCliInvocation', () => {
  it('intercepts only the exact doctor unlock command', () => {
    expect(planCliInvocation(['doctor', '--unlock'])).toEqual({ kind: 'doctor-unlock' })
    expect(planCliInvocation(['doctor'])).toMatchObject({ kind: 'passthrough' })
    expect(planCliInvocation(['doctor', '--unlock', '--extra'])).toMatchObject({
      kind: 'passthrough',
    })
  })

  it('resolves profiles the way the upstream launcher does', () => {
    expect(planCliInvocation(['--profile', 'headless'])).toEqual({
      kind: 'passthrough',
      profile: 'headless',
    })
    expect(planCliInvocation(['web'])).toEqual({ kind: 'passthrough', profile: 'web' })
    expect(planCliInvocation(['plugin', '--profile', 'desktop', 'add', '@example/a'])).toEqual({
      kind: 'passthrough',
      profile: 'desktop',
    })
    expect(planCliInvocation(['--profile=web', 'inner'])).toEqual({
      kind: 'passthrough',
      profile: 'web',
    })
    expect(planCliInvocation([])).toEqual({ kind: 'passthrough', profile: undefined })
    expect(planCliInvocation(['just', 'a', 'task'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
    expect(planCliInvocation(['--patch', 'a.yml', 'task'])).toEqual({
      kind: 'passthrough',
      profile: undefined,
    })
    expect(planCliInvocation(['--profile', 'tui', '--resume', 'abc'])).toEqual({
      kind: 'passthrough',
      profile: 'tui',
    })
    expect(planCliInvocation(['--profile'])).toEqual({ kind: 'passthrough', profile: undefined })
  })
})

describe('runBundledCli', () => {
  it('forwards argv verbatim and registers the child before authorizing boot', async () => {
    const home = await isolatedHome()
    const stderr = new MemoryStderr()
    const child = makeFakeChild(0)
    const sentArgv: (readonly string[])[] = []
    let ownerAtAuthorization: unknown
    const spawn: SpawnCliChild = (input) => {
      sentArgv.push([...input.argv])
      const spawned = child.spawn(input)
      return {
        ...spawned,
        send(message) {
          // Capture the owner state at the exact moment boot authorization
          // is delivered to the official CLI child.
          ownerAtAuthorization = JSON.parse(readFileSync(ownerPathOf(home), 'utf8')) as unknown
          spawned.send(message)
        },
      }
    }
    const code = await runBundledCli(
      ['plugin', '--profile', 'desktop', 'add', '@example/a', 'with space', '--', '--patch'],
      {
        env: { DSH_HOME: home },
        probe: fakeProbe,
        guard: createInProcessGuardLock(),
        spawnChild: spawn,
        stderr,
      },
    )
    expect(code).toBe(0)
    expect(sentArgv).toEqual([
      ['plugin', '--profile', 'desktop', 'add', '@example/a', 'with space', '--', '--patch'],
    ])
    const authorization = child.forwarded()[0] as { kind: string; argv: readonly string[] }
    expect(authorization.kind).toBe('dsh-native-authorized')
    expect(authorization.argv).toEqual([
      'plugin',
      '--profile',
      'desktop',
      'add',
      '@example/a',
      'with space',
      '--',
      '--patch',
    ])
    // The lease owner recorded this wrapper as supervisor with the resolved
    // child identity attached before boot authorization was delivered.
    expect(ownerAtAuthorization).toMatchObject({
      entrypoint: 'bundled-cli',
      profile: 'desktop',
      host: { pid: 5555, startIdentity: 'cli-child-os' },
      pendingSpawn: false,
    })
    await expect(statAsync(ownerPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(stderr.text()).toBe('')
  })

  it('exits before forking the child when the home is busy', async () => {
    const home = await isolatedHome()
    const other = await acquireHomeLease({
      home,
      entrypoint: 'desktop',
      profile: 'desktop',
      appVersion: '0.0.0',
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
    })
    const stderr = new MemoryStderr()
    const child = makeFakeChild(0)
    const code = await runBundledCli(['--profile', 'headless', 'do', 'work'], {
      env: { DSH_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr,
    })
    expect(code).toBe(3)
    expect(child.forwarded()).toEqual([])
    expect(stderr.text()).toContain('HOME_BUSY')
    expect(stderr.text()).toContain('doctor --unlock')
    expect(stderr.text()).toContain('DSH_HOME')
    await other.release()
  })

  it('passes unresolvable invocations through without taking the lease', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(1)
    const code = await runBundledCli([], {
      env: { DSH_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr: new MemoryStderr(),
    })
    expect(code).toBe(1)
    expect(child.forwarded()).toHaveLength(1)
    await expect(statAsync(ownerPathOf(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the child exit code and still releases the lease', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(7)
    const code = await runBundledCli(['--profile', 'headless', 'run'], {
      env: { DSH_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: child.spawn,
      stderr: new MemoryStderr(),
    })
    expect(code).toBe(7)
    await expect(statAsync(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('reaps the unauthorized child when host registration fails', async () => {
    const home = await isolatedHome()
    const child = makeFakeChild(0)
    const brokenProbe: ProcessProbe = {
      ...fakeProbe,
      async identify() {
        throw new Error('identity lookup failed')
      },
    }
    await expect(
      runBundledCli(['--profile', 'headless', 'task'], {
        env: { DSH_HOME: home },
        probe: brokenProbe,
        guard: createInProcessGuardLock(),
        spawnChild: child.spawn,
        stderr: new MemoryStderr(),
      }),
    ).rejects.toThrow('identity lookup failed')
    expect(child.kills()).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.forwarded()).toEqual([])
    await expect(statAsync(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses doctor unlock while an owner is alive and reports exit code 2', async () => {
    const home = await isolatedHome()
    const held = await acquireHomeLease({
      home,
      entrypoint: 'desktop',
      profile: 'desktop',
      appVersion: '0.0.0',
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
    })
    const stderr = new MemoryStderr()
    const code = await runBundledCli(['doctor', '--unlock'], {
      env: { DSH_HOME: home },
      probe: fakeProbe,
      guard: createInProcessGuardLock(),
      spawnChild: makeFakeChild(0).spawn,
      stderr,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('ACTIVE_OWNER')
    await held.release()
  })

  it('unlocks a stale owner that provably exited', async () => {
    const home = await isolatedHome()
    const staleProbe: ProcessProbe = {
      async current() {
        return { pid: process.pid, startIdentity: 'doctor-self' }
      },
      async identify(pid) {
        return { pid, startIdentity: 'gone' }
      },
      async inspect() {
        return 'absent' as const
      },
      async scanSupported() {
        return 'none' as const
      },
    }
    const dead = await acquireHomeLease({
      home,
      entrypoint: 'bundled-cli',
      profile: 'desktop',
      appVersion: '0.0.0',
      probe: {
        ...staleProbe,
        async current() {
          return { pid: 9101, startIdentity: 'dead-wrapper' }
        },
      },
      guard: createInProcessGuardLock(),
    })
    // Simulate the wrapper dying without releasing.
    const stderr = new MemoryStderr()
    const code = await runBundledCli(['doctor', '--unlock'], {
      env: { DSH_HOME: home },
      probe: staleProbe,
      guard: createInProcessGuardLock(),
      spawnChild: makeFakeChild(0).spawn,
      stderr,
    })
    expect(code).toBe(0)
    expect(stderr.text()).toContain('unlocked')
    await expect(statAsync(path.join(home, 'run', 'host.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    void dead
  })
})
