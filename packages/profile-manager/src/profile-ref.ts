import path from 'node:path'

export type ProfileRef = Readonly<{
  home: string
  name: string
  dir: string
}>

export function createProfileRef(home: string, name: string): ProfileRef {
  if (home.trim() === '') throw new Error('ProfileRef requires an explicit home')
  const resolvedHome = path.resolve(home)
  if (resolvedHome === path.parse(resolvedHome).root) {
    throw new Error('ProfileRef home cannot be the filesystem root')
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
  const dir = path.join(resolvedHome, 'profiles', name)
  return Object.freeze({ home: resolvedHome, name, dir })
}
