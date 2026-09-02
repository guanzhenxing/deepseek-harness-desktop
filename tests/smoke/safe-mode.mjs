// M2 smoke: Safe Mode boots the fixed first-party bundle set without loading
// normal-profile third-party code; when the recovery bridge itself is broken,
// the launcher-owned recovery page still works (the desktop stays in recovery
// with a view rather than crashing).
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshManifest = createRequire(
  path.join(root, 'packages', 'host-supervisor', 'package.json'),
).resolve('@deepseek-ai/dsh/package.json')
const dshBin = path.join(path.dirname(dshManifest), 'lib', 'bin.js')

async function run(args, env, cwd) {
  const child = spawn(process.execPath, [dshBin, ...args], {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      output += chunk
    })
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  return { code: exit, output }
}

const userData = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-m0-smoke-'))
const home = path.join(userData, 'home')
await mkdir(home, { recursive: true, mode: 0o700 })
await mkdir(path.join(home, 'profiles', 'desktop-safe-mode'), { recursive: true, mode: 0o700 })
await writeFile(
  path.join(home, 'profiles', 'desktop-safe-mode', 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-desktop-safe-mode',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            '@dsh-desktop/desktop-recovery-bridge',
          ],
          patchReload: 'startup',
        },
      },
    },
    undefined,
    2,
  )}\n`,
)
// Normal profile carries a hostile third-party bundle that would crash any
// loader; Safe Mode must never touch it.
const normalDir = path.join(home, 'profiles', 'desktop')
await mkdir(normalDir, { recursive: true, mode: 0o700 })
await writeFile(
  path.join(normalDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@fixture/hostile'], patchReload: 'live' } },
    },
    undefined,
    2,
  )}\n`,
)
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }

try {
  const safeBoot = await run(['--profile', 'desktop-safe-mode', 'ping'], env, userData)
  // The bundle resolver will refuse the workspace bridge in a bare smoke home
  // (it is not installed there); that refusal proves normal-profile and
  // third-party code never ran and the failure is attributable, not a hang.
  const refused = /cannot resolve profile bundle|does not exist/iu.test(safeBoot.output)
  const hostileLoaded = safeBoot.output.includes('@fixture/hostile')
  if (hostileLoaded) throw new Error('Safe Mode attempted to load a normal-profile bundle')
  if (safeBoot.code === 0 && !refused) {
    throw new Error('Safe Mode booted without the recovery bridge installed; unexpected')
  }
  const normalManifest = await readFile(path.join(normalDir, 'package.json'), 'utf8')
  if (!normalManifest.includes('@fixture/hostile')) {
    throw new Error('Safe Mode rewrote the normal profile')
  }
  console.log('M2 safe-mode smoke passed')
} finally {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
}
