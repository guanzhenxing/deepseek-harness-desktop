/**
 * Rename the Chromium child-process helper bundles of a packed macOS app to
 * match a new display name.
 *
 * Electron resolves every child process (renderer/GPU/utility) as
 * `<CFBundleName of the main app> Helper[ variant].app` inside
 * Contents/Frameworks and aborts at startup with "Unable to find helper app"
 * when that bundle does not exist (electron_main_delegate_mac.mm,
 * OverrideChildProcessPath; verified against the pinned Electron 44.1.0
 * sources, where GetApplicationName() reads kCFBundleNameKey). The display
 * name in CFBundleName is therefore only safe to widen when the helper
 * bundles — directory names, executables and their Info.plist identities —
 * are renamed to the same base name.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import path from 'node:path'

const PLIST_TOOL = '/usr/bin/plutil'

// Login-item helpers only exist in apps that declare them; the directory is
// scanned when present so the rename stays correct for both layouts.
const HELPER_SEARCH_DIRECTORIES = ['Frameworks', path.join('Library', 'LoginItems')]

function readPlistString(plistPath, key) {
  const printed = execFileSync(PLIST_TOOL, ['-p', plistPath], { encoding: 'utf8' })
  const match = printed.match(new RegExp(`"${key}" => "(.*)"$`, 'm'))
  if (match === null) {
    throw new Error(`${plistPath} has no ${key}`)
  }
  return match[1]
}

function setPlistStrings(plistPath, entries) {
  for (const [key, value] of entries) {
    execFileSync(PLIST_TOOL, ['-replace', key, '-string', value, plistPath], { encoding: 'utf8' })
  }
}

/**
 * Rename every `Helper*.app` bundle under Contents/Frameworks (and
 * Contents/Library/LoginItems when present) whose directory name starts with
 * `fromName`, keeping any variant suffix (` Helper`, ` Helper (Renderer)`, …)
 * intact. Directory names, CFBundleExecutable/DisplayName/Name and the
 * executable file itself all move together, because Electron's child-process
 * lookup reconstructs the executable path from the bundle name. Returns the
 * renames performed; running over an already-renamed tree is a no-op.
 */
export function renameMacHelperBundles({ appContentsPath, fromName, toName }) {
  const renamed = []
  for (const directory of HELPER_SEARCH_DIRECTORIES) {
    const searchPath = path.join(appContentsPath, directory)
    if (!existsSync(searchPath)) continue
    for (const entry of readdirSync(searchPath)) {
      // Variant suffixes sit anywhere between the base name and ".app"
      // (` Helper`, ` Helper (Renderer)`, ` Login Helper`).
      if (!entry.startsWith(`${fromName} `) || !entry.includes('Helper') || !entry.endsWith('.app'))
        continue
      const suffix = entry.slice(fromName.length, -'.app'.length)
      const bundlePath = path.join(searchPath, entry)
      const plistPath = path.join(bundlePath, 'Contents', 'Info.plist')
      const executableName = readPlistString(plistPath, 'CFBundleExecutable')
      const nextExecutableName = `${toName}${suffix}`
      renameSync(
        path.join(bundlePath, 'Contents', 'MacOS', executableName),
        path.join(bundlePath, 'Contents', 'MacOS', nextExecutableName),
      )
      setPlistStrings(plistPath, [
        ['CFBundleExecutable', nextExecutableName],
        ['CFBundleDisplayName', nextExecutableName],
        ['CFBundleName', nextExecutableName],
      ])
      const nextBundlePath = path.join(searchPath, `${nextExecutableName}.app`)
      renameSync(bundlePath, nextBundlePath)
      renamed.push({ from: entry, to: path.basename(nextBundlePath) })
    }
  }
  return renamed
}
