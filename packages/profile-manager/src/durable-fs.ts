import { randomUUID } from 'node:crypto'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Refuse user-planted symlinks on any directory this package writes through:
 * every existing level of a writable path must be a real directory, and a
 * freshly created level is verified right after creation. ENOENT returns
 * false so callers can create-then-reverify.
 */
export async function assertRealDirectory(dirname: string, label: string): Promise<boolean> {
  const identity = await lstat(dirname).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (identity === undefined) return false
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink`)
  }
  return true
}

export async function syncDirectory(dirname: string): Promise<void> {
  const handle = await open(dirname, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** fsync'd temp file + atomic rename; readers see old or new, never partial. */
export async function writeAtomicDurable(filename: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, filename)
  const written = await open(filename, 'r')
  try {
    await written.sync()
  } finally {
    await written.close()
  }
  await unlink(temporary).catch(() => undefined)
  await syncDirectory(path.dirname(filename))
}
