import { lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export async function resolveSmokeUserData(
  smokeMode: string | undefined,
  override: string | undefined,
): Promise<string | undefined> {
  if (smokeMode === undefined && override === undefined) return undefined
  if (smokeMode !== 'ui' && smokeMode !== 'host-crash') {
    throw new Error('M0 userData overrides are available only in supported smoke modes')
  }
  if (
    override === undefined ||
    !path.isAbsolute(override) ||
    path.dirname(path.resolve(override)) !== path.resolve(tmpdir()) ||
    !path.basename(override).startsWith('dsh-desktop-m0-smoke-')
  ) {
    throw new Error('M0 smoke requires a dedicated temporary userData directory')
  }
  const target = path.resolve(override)
  const identity = await lstat(target)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error('M0 smoke userData must be a directory, not a symlink')
  }
  if (path.dirname(await realpath(target)) !== (await realpath(tmpdir()))) {
    throw new Error('M0 smoke userData escaped its temporary parent')
  }
  return target
}
