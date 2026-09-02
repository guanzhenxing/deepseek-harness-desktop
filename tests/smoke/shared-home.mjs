import { spawn } from 'node:child_process'
import { clearTimeout, setTimeout } from 'node:timers'
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createSharedHomeFixture,
  runDshNative,
  runSharedHomeScenario,
  withCliWeb,
  withDesktop,
} from '../helpers/shared-home-driver.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

async function desktopIsRejectedWhileCliHoldsHome() {
  const fixture = await createSharedHomeFixture()
  try {
    await withCliWeb(fixture.home, fixture.cwd, async () => {
      const reports = await captureDesktop(fixture.userData, 60_000)
      const refused = reports.find(
        (report) => report.kind === 'lease-refused' || report.kind === 'failed',
      )
      if (refused === undefined) {
        throw new Error('desktop did not report a lease refusal while the CLI held the home')
      }
      if (refused.kind !== 'lease-refused' || refused.code !== 'HOME_BUSY') {
        throw new Error(`unexpected desktop refusal report: ${JSON.stringify(refused)}`)
      }
    })
    console.log('shared-home: desktop refused while the CLI held the home ✓')
  } finally {
    await fixture.dispose()
  }
}

function captureDesktop(userData, timeoutMs) {
  const requireFromLauncher = createRequire(
    path.join(repositoryRoot, 'apps', 'desktop-launcher', 'package.json'),
  )
  const electronBinary = requireFromLauncher('electron')
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, ['.'], {
      cwd: path.join(repositoryRoot, 'apps', 'desktop-launcher'),
      env: {
        ...process.env,
        DSH_DESKTOP_SMOKE: 'shared-home',
        DSH_DESKTOP_M0_USER_DATA: userData,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const reports = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('DSH_DESKTOP_SMOKE ')) {
          reports.push(JSON.parse(line.slice('DSH_DESKTOP_SMOKE '.length)))
        }
      }
    })
    child.stderr.pipe(process.stderr)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('desktop did not refuse the busy home in time'))
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 1) {
        reject(new Error(`expected busy desktop to exit 1, got ${code}`))
        return
      }
      resolve(reports)
    })
  })
}

async function noLeaseLeftBehind(fixture) {
  const run = path.join(fixture.home, 'run', 'host.lock')
  await readFile(run).then(
    () => {
      throw new Error('a home lock survived the scenario')
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
}

async function main() {
  await runCommand('pnpm', ['run', 'build'])
  await runCommand('pnpm', ['run', 'build:native'])

  const cliFirst = await runSharedHomeScenario('cli-to-desktop')
  if (cliFirst.persistedTurns !== 2) {
    throw new Error(`cli-to-desktop persisted ${cliFirst.persistedTurns} turns, expected 2`)
  }
  console.log('shared-home: cli-to-desktop continued one session ✓')

  const desktopFirst = await runSharedHomeScenario('desktop-to-cli')
  if (desktopFirst.persistedTurns !== 2) {
    throw new Error(`desktop-to-cli persisted ${desktopFirst.persistedTurns} turns, expected 2`)
  }
  console.log('shared-home: desktop-to-cli continued one session ✓')

  await desktopIsRejectedWhileCliHoldsHome()

  const fixture = await createSharedHomeFixture()
  try {
    // Desktop stays up holding the lease; both CLI shapes must be refused.
    await withDesktop(fixture.home, fixture.userData, async () => {
      const headless = await runDshNative(['--profile', 'headless', 'rejected'], {
        home: fixture.home,
        cwd: fixture.cwd,
      })
      if (headless.code !== 3) {
        throw new Error(`CLI boot under an active Desktop exited ${headless.code}`)
      }
      const plugin = await runDshNative(
        ['plugin', '--profile', 'desktop', 'add', '@example/unavailable'],
        { home: fixture.home, cwd: fixture.cwd },
      )
      if (plugin.code !== 3) {
        throw new Error(`CLI plugin mutation under an active Desktop exited ${plugin.code}`)
      }
    })
    console.log('shared-home: CLI boot and plugin mutation refused under the Desktop ✓')
    await noLeaseLeftBehind(fixture)

    const settings = await readFile(path.join(fixture.home, 'settings.yaml'), 'utf8')
    if (!settings.includes('127.0.0.1')) {
      throw new Error('shared settings.yaml was rewritten by an entry')
    }
  } finally {
    await fixture.dispose()
  }

  // A completely exited entry leaves the home immediately usable again.
  const last = await createSharedHomeFixture()
  try {
    const created = await runDshNative(['--profile', 'headless', 'final entry'], {
      home: last.home,
      cwd: last.cwd,
    })
    if (created.code !== 0) throw new Error(`final headless run failed: ${created.code}`)
    await noLeaseLeftBehind(last)
    const sessions = await readdir(path.join(last.home, 'sessions')).catch(() => [])
    if (sessions.length === 0) {
      throw new Error('expected persisted session directories after the scenario')
    }
    if (last.mockLlm.requests.length === 0) {
      throw new Error('the official graph never called the mock LLM')
    }
  } finally {
    await last.dispose()
  }
  console.log('M1 shared-home smoke passed')
}

await main()
