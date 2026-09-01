import path from 'node:path'

import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'

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
  let dir: string
  try {
    dir = resolveProfileDir(name, resolvedHome)
  } catch {
    throw new Error(`invalid profile name ${JSON.stringify(name)}`)
  }
  return Object.freeze({ home: resolvedHome, name, dir })
}
