import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
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
 * bundles and nothing else. Any other entry in the profile directory — a
 * local `cordis.patch.yml`, `pnpm-workspace.yaml`, `node_modules`, or any
 * unknown file — is untrusted content the safe boot must never execute, so
 * the profile reports conflict and is left untouched (the caller keeps the
 * local recovery page instead).
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
  // The directory must hold exactly the manifest this module writes — the
  // safe boot loads whatever layers the profile directory exposes.
  const entries = await readdir(ref.dir).catch(() => [] as string[])
  const unexpected = entries.filter((entry) => entry !== 'package.json')
  if (unexpected.length > 0) return 'conflict'
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
