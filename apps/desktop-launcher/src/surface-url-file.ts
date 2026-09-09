import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

/**
 * Write the authenticated surface URL for smoke drivers into a 0600 regular
 * file inside the smoke userData directory. O_NOFOLLOW refuses a leaf that
 * is a symlink (a pre-planted one would redirect the token outside the
 * userData directory), and an explicit chmod tightens a pre-existing file
 * whose permissions were wider — writeFile's mode only applies on create.
 */
export async function writeSurfaceUrlFile(userData: string, url: string): Promise<void> {
  const target = path.join(userData, 'surface-url')
  const handle: FileHandle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.chmod(0o600)
    await handle.write(`${url}\n`, 0)
  } finally {
    await handle.close()
  }
}
