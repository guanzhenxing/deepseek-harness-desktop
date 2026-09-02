import type { Stats } from 'node:fs'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

export type RuntimeRoot = Readonly<{ dir: string; remove(): Promise<void> }>

async function directoryIdentity(dirname: string): Promise<Stats> {
  const identity = await lstat(dirname)
  if (identity.isSymbolicLink()) throw new Error('Host runtime directory must not be a symlink')
  if (!identity.isDirectory()) throw new Error('Host runtime path must be a directory')
  return identity
}

function sameIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino
}

/** Own only this newly created launch root, never a later replacement at its path. */
export async function createRuntimeRoot(home: string): Promise<RuntimeRoot> {
  const homeIdentity = await directoryIdentity(home)
  const profiles = path.join(home, 'profiles')
  const profilesIdentity = await directoryIdentity(profiles)
  const canonicalHome = await realpath(home)
  const canonicalProfiles = await realpath(profiles)
  if (canonicalProfiles !== path.join(canonicalHome, 'profiles')) {
    throw new Error('Host runtime parent escaped the shared home')
  }
  const dir = await mkdtemp(path.join(canonicalProfiles, '.dsh-desktop-run-'))
  const rootIdentity = await directoryIdentity(dir)
  let removed = false
  return Object.freeze({
    dir,
    async remove() {
      if (removed) return
      if (
        !sameIdentity(homeIdentity, await directoryIdentity(home)) ||
        !sameIdentity(profilesIdentity, await directoryIdentity(profiles)) ||
        !sameIdentity(rootIdentity, await directoryIdentity(dir)) ||
        (await realpath(profiles)) !== canonicalProfiles ||
        (await realpath(dir)) !== dir
      ) {
        throw new Error('Host runtime directory identity changed; refusing cleanup')
      }
      await rm(dir, { recursive: true })
      removed = true
    },
  })
}
