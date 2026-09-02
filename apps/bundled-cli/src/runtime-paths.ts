import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLeaseHelperPath } from '@dsh-desktop/home-lease'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type CliRuntimePaths = Readonly<{
  /** Official CLI entry, resolved through the package `bin.dsh` field. */
  dshBin: string
  nodeExecutable: string
  leaseHelper: string
  /**
   * Executables that indicate a supported desktop entrypoint is running.
   * Development resolves the pinned Electron binary next to the launcher;
   * packaged builds replace this with the bundled app binary.
   */
  desktopEntryExecutables: readonly string[]
  /**
   * Absolute paths matched against the argv of running processes during
   * doctor scans: our wrapper script, the authorized CLI child module, the
   * Electron Host entry, and the official dsh bin (also catches bare `dsh`).
   */
  scanArgvNeedles: readonly string[]
}>

/** Resolve the official `dsh` bin through the package manifest only. */
export function resolveOfficialDshBin(): string {
  const requireHere = createRequire(path.join(packageRoot, 'package.json'))
  const manifestPath = requireHere.resolve('@deepseek-ai/dsh/package.json')
  const manifest: unknown = requireHere(manifestPath)
  const bin = (manifest as { bin?: Record<string, string> }).bin
  const relative = bin?.dsh
  if (typeof relative !== 'string' || relative === '') {
    throw new Error('the pinned @deepseek-ai/dsh package does not declare a bin.dsh entry')
  }
  return path.resolve(path.dirname(manifestPath), relative)
}

function desktopElectronBinary(): string | undefined {
  try {
    const requireLauncher = createRequire(
      path.join(packageRoot, '..', 'desktop-launcher', 'package.json'),
    )
    const resolved: unknown = requireLauncher('electron')
    return typeof resolved === 'string' ? resolved : undefined
  } catch {
    return undefined
  }
}

export function resolveCliRuntime(
  env: Readonly<Record<string, string | undefined>>,
): CliRuntimePaths {
  const entries: string[] = []
  const electron = desktopElectronBinary()
  if (electron !== undefined) entries.push(electron)
  const dshBin = resolveOfficialDshBin()
  const needles = [
    dshBin,
    path.join(packageRoot, '..', '..', 'scripts', 'dsh-native.mjs'),
    path.join(packageRoot, 'lib', 'cli-child.js'),
    path.join(packageRoot, '..', 'desktop-launcher', 'lib', 'host-entry.js'),
  ]
  return Object.freeze({
    dshBin,
    nodeExecutable: process.execPath,
    leaseHelper: resolveLeaseHelperPath(env),
    desktopEntryExecutables: Object.freeze(entries),
    scanArgvNeedles: Object.freeze(needles),
  })
}
