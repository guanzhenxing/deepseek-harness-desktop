import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

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
