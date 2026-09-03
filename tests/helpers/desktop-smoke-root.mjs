import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fixturePrefix = 'dsh-desktop-m0-smoke-'

/**
 * A throwaway userData + home pair for driver-owned desktop smokes. The
 * userData prefix satisfies the launcher's smoke override contract; cleanup
 * re-verifies directory identity before removing anything.
 */
export async function createDesktopSmokeRoot() {
  const userData = await mkdtemp(path.join(tmpdir(), fixturePrefix))
  const identity = await lstat(userData)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error('smoke root must be a real directory')
  }
  const canonical = await realpath(userData)
  const canonicalTmp = await realpath(tmpdir())
  const home = path.join(userData, 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  let disposed = false
  return {
    userData,
    home,
    async dispose() {
      if (disposed) return
      disposed = true
      const current = await lstat(userData)
      if (
        path.dirname(canonical) !== canonicalTmp ||
        !path.basename(canonical).startsWith(fixturePrefix) ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        (await realpath(userData)) !== canonical
      ) {
        throw new Error(`refusing to clean an unexpected smoke root: ${userData}`)
      }
      await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}
