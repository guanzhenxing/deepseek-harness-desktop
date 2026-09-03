#!/usr/bin/env node
// Invoke the pinned electron-builder against the staged runtime tree.
//
//   node scripts/package-app.mjs --dir   → unpacked .app (fast local iterate)
//   node scripts/package-app.mjs --dmg   → DMG candidate
//
// The target is also steered by DSH_PACKAGE_TARGET for the config file; the
// argument form keeps the npm scripts explicit.
import { spawnSync } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builderCli = path.join(root, 'node_modules', '.bin', 'electron-builder')
const config = path.join(root, 'build', 'electron-builder.config.cjs')

const wantsDmg = process.argv.includes('--dmg')
const mode = wantsDmg ? 'dmg' : process.argv.includes('--dir') ? 'dir' : undefined
if (mode === undefined) {
  throw new Error('pass either --dir or --dmg')
}

async function assertStaged() {
  const required = [
    'app-shell/package.json',
    'app-shell/main.cjs',
    'runtime-host/lib/main.js',
    'runtime-host/lib/host-entry.js',
    'runtime-cli/bin/dsh-native',
    'runtime-cli/node/bin/node',
    'native/lease-helper',
    'recovery/recovery-view.html',
    'compatibility.json',
  ]
  for (const relative of required) {
    await access(path.join(root, 'release', 'staging', relative), constants.F_OK)
  }
}

await assertStaged()

const result = spawnSync(
  builderCli,
  ['--config', config, '--mac', mode === 'dmg' ? 'dmg' : 'dir'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DSH_PACKAGE_TARGET: mode },
  },
)
if (result.error !== undefined || result.status !== 0) {
  throw new Error(`electron-builder (${mode}) failed with status ${result.status ?? result.error}`)
}

// electron-builder skips signing with `identity: null`, but flipping the
// Electron fuses invalidates the upstream ad-hoc signature and macOS then
// kills the app on exec. Re-apply an ad-hoc signature: this changes nothing
// about the honest "no Developer ID / not notarized" status and touches no
// Gatekeeper setting.
const productName = createRequire(path.join(root, 'package.json'))(
  './packages/product-config/lib/index.js',
).PRODUCT.name
const appBundle = path.join(root, 'release', 'dist', `mac-${process.arch}`, `${productName}.app`)
const resign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], {
  stdio: 'inherit',
})
if (resign.error !== undefined || resign.status !== 0) {
  throw new Error(`ad-hoc re-signing failed (${resign.status ?? resign.error})`)
}
const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', appBundle], {
  encoding: 'utf8',
})
if (verify.status !== 0) {
  throw new Error(`ad-hoc signature verification failed: ${verify.stderr}`)
}

console.log(`package-app: ${mode} build finished under release/dist (ad-hoc signed)`)
