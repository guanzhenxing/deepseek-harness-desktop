import { spawnSync } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'packages', 'home-lease', 'native', 'lease-helper.c')
const outputDirectory = path.join(root, 'packages', 'home-lease', 'native', '.build')
const output = path.join(outputDirectory, 'lease-helper')

async function main() {
  if (process.platform !== 'darwin') {
    console.log(`lease-helper: skipped native build on ${process.platform}`)
    return
  }
  await mkdir(outputDirectory, { recursive: true })
  const compile = spawnSync('clang', ['-O2', '-Wall', '-Wextra', '-o', output, source], {
    stdio: 'inherit',
  })
  if (compile.error !== undefined || compile.status !== 0) {
    throw new Error('lease-helper compilation failed; Xcode Command Line Tools are required')
  }
  const identity = await stat(output)
  if (!identity.isFile()) throw new Error('lease-helper binary was not produced')
  console.log(`lease-helper: built ${path.relative(root, output)}`)
}

await main()
