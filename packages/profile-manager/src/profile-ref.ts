import path from 'node:path'

/**
 * Reserved `<home>/profiles/` namespace of the runtime launch roots
 * (`.dsh-desktop-run-*`, mkdtemp-created by host-supervisor's runtime-root).
 * User profiles must never take these names: the compatibility preflight
 * exempts real launch-root directories from classification, so a profile
 * wearing a reserved name would bypass format admission entirely.
 */
export const RESERVED_PROFILE_NAME_PREFIX = '.dsh-desktop-run-'

export type ProfileRef = Readonly<{
  home: string
  name: string
  dir: string
}>

export function createProfileRef(home: string, name: string): ProfileRef {
  if (home.trim() === '') throw new Error('ProfileRef requires an explicit home')
  const resolvedHome = path.resolve(home)
  if (resolvedHome === path.parse(resolvedHome).root) {
    throw new Error(`ProfileRef home cannot be the filesystem root`)
  }
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name === 'node_modules' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error(`invalid profile name ${JSON.stringify(name)}`)
  }
  if (name.startsWith(RESERVED_PROFILE_NAME_PREFIX)) {
    throw new Error(
      `profile name ${JSON.stringify(name)} uses the reserved runtime launch-root prefix ${JSON.stringify(
        RESERVED_PROFILE_NAME_PREFIX,
      )}`,
    )
  }
  const dir = path.join(resolvedHome, 'profiles', name)
  return Object.freeze({ home: resolvedHome, name, dir })
}
