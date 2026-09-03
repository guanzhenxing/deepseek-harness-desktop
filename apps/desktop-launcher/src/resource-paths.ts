import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const launcherDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type NativeAssetPaths = Readonly<{ trayIcon: string; trayIcon2x: string }>

/**
 * Tray template images. Development reads the generated files under
 * `release/icons`; a packaged build reads the same files copied next to the
 * runtime under `Contents/Resources/icons`. Missing assets disable the tray
 * (the caller decides whether that is fatal for its context).
 */
export function resolveNativeAssets(
  input: Readonly<{
    isPackaged: boolean
    resourcesPath: string
  }>,
): NativeAssetPaths | undefined {
  const base = input.isPackaged
    ? path.join(input.resourcesPath, 'icons')
    : path.join(launcherDirectory, '..', '..', 'release', 'icons')
  const trayIcon = path.join(base, 'trayTemplate.png')
  const trayIcon2x = path.join(base, 'trayTemplate@2x.png')
  if (!existsSync(trayIcon) || !existsSync(trayIcon2x)) return undefined
  return { trayIcon, trayIcon2x }
}

export { launcherDirectory }
