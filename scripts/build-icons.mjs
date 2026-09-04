#!/usr/bin/env node
// Generate the packaged-app icon set from the original SVG sources in
// build/assets. Rasterization and resizing use macOS sips, and the ICNS is
// assembled by iconutil — no third-party dependencies.
// The exact commands are recorded in build/assets/README.md.
//
// Outputs (under release/icons/, gitignored and reproducible):
//   icon.icns            — application icon
//   dock-icon.png        — explicit Dock image used to avoid stale icon caches
//   trayTemplate.png     — 16x16 tray template image
//   trayTemplate@2x.png  — 32x32 tray template image
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = path.join(root, 'build', 'assets')
const outputDirectory = path.join(root, 'release', 'icons')

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error !== undefined || result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') ?? String(result.error)
    throw new Error(`${label} failed (${command} ${args.join(' ')}): ${stderr.trim()}`)
  }
}

async function renderSvg(source, size, workDirectory) {
  const produced = path.join(workDirectory, `${path.basename(source)}.png`)
  run(
    'sips',
    ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', produced],
    `sips ${path.basename(source)}`,
  )
  return produced
}

function resize(source, width, height, target) {
  run(
    'sips',
    ['-z', String(height), String(width), source, '--out', target],
    `sips ${path.basename(target)}`,
  )
}

const ICNS_SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error(`icons are generated on macOS only (got ${process.platform})`)
  }
  const work = await mkdtemp(path.join(tmpdir(), 'dsh-build-icons-'))
  try {
    await mkdir(outputDirectory, { recursive: true })

    // Application icon: SVG → 1024px master → iconset → icns.
    const master = await renderSvg(path.join(assets, 'icon.svg'), 1024, work)
    const iconset = path.join(work, 'icon.iconset')
    await mkdir(iconset, { recursive: true })
    for (const [name, size] of ICNS_SIZES) {
      resize(master, size, size, path.join(iconset, name))
    }
    const icns = path.join(outputDirectory, 'icon.icns')
    run('iconutil', ['-c', 'icns', iconset, '-o', icns], 'iconutil icns')
    resize(master, 512, 512, path.join(outputDirectory, 'dock-icon.png'))

    // Tray template: SVG → 32px master → 16px @1x and 32px @2x (black +
    // alpha template images; Electron picks the template treatment from the
    // "Template" filename suffix).
    const trayMaster = await renderSvg(path.join(assets, 'tray-template.svg'), 32, work)
    resize(trayMaster, 16, 16, path.join(outputDirectory, 'trayTemplate.png'))
    await cp(trayMaster, path.join(outputDirectory, 'trayTemplate@2x.png'))

    console.log(`icons: built ${path.relative(root, icns)} and tray templates`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

await main()
