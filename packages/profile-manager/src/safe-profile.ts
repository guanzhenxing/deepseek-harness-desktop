import { lstat, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { HomeLease } from '@dsh-desktop/home-lease'

import type { ProfileRef } from './profile-ref.js'
import { writeAtomicDurable } from './durable-fs.js'

export const SAFE_PROFILE_NAME = 'desktop-safe-mode'

export const SAFE_BUNDLE_PREFIX = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-desktop/desktop-recovery-bridge',
] as const

/**
 * Prepare (or verify) the Safe Mode profile: exactly the three first-party
 * bundles. A safe profile containing unknown user content — including an
 * unreadable or unparsable manifest — is never overwritten; the caller keeps
 * the local recovery page instead.
 */
export async function prepareSafeProfile(
  ref: ProfileRef,
  lease: HomeLease,
): Promise<'prepared' | 'conflict'> {
  if (ref.name !== SAFE_PROFILE_NAME) {
    throw new Error('prepareSafeProfile only owns the desktop-safe-mode profile')
  }
  if (lease.home !== ref.home) {
    throw new Error('safe profile preparation requires a lease bound to the home')
  }
  await lease.assertHeld()
  const manifestPath = path.join(ref.dir, 'package.json')
  let existing: string | undefined
  try {
    const identity = await lstat(manifestPath)
    if (identity.isSymbolicLink()) return 'conflict'
    if (!identity.isFile()) return 'conflict'
    existing = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    let bundles: unknown
    try {
      const manifest = JSON.parse(existing) as { dsh?: { profile?: { bundles?: unknown } } }
      bundles = manifest.dsh?.profile?.bundles
    } catch {
      // An unparsable manifest is unknown user content, not an empty profile.
      return 'conflict'
    }
    if (JSON.stringify(bundles) !== JSON.stringify([...SAFE_BUNDLE_PREFIX])) {
      return 'conflict'
    }
    return 'prepared'
  }
  await mkdir(ref.dir, { recursive: true, mode: 0o700 })
  const manifest = `${JSON.stringify(
    {
      name: 'dsh-profile-desktop-safe-mode',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...SAFE_BUNDLE_PREFIX], patchReload: 'startup' } },
    },
    undefined,
    2,
  )}\n`
  await writeAtomicDurable(manifestPath, new TextEncoder().encode(manifest))
  return 'prepared'
}
