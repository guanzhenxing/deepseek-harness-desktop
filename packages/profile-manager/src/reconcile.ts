import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { initProfile, readProfileManifest, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'

import type { ProfileRef } from './profile-ref.js'

export const DESKTOP_BUNDLE_PREFIX = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-desktop/desktop-plugin',
] as const

const authorityBrand = Symbol('ProfileWriteAuthority')

export type IsolatedHomeAuthority = Readonly<{
  kind: 'm0-isolated-home'
  home: string
  [authorityBrand]: true
}>

export type ReconcileResult = Readonly<{
  ref: ProfileRef
  changed: boolean
  changedFiles: readonly string[]
  beforeRevision: string | undefined
  afterRevision: string
}>

export function createIsolatedHomeAuthority(home: string): IsolatedHomeAuthority {
  if (home.trim() === '') throw new Error('Profile write authority requires an explicit home')
  return Object.freeze({
    kind: 'm0-isolated-home' as const,
    home: path.resolve(home),
    [authorityBrand]: true as const,
  })
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function writeFileAtomic(filename: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filename)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function reconciledManifest(manifest: ProfileManifest): ProfileManifest {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some((bundle) => typeof bundle !== 'string')) {
    throw new Error('desktop profile bundle list must contain only package names')
  }
  const owned = new Set<string>(DESKTOP_BUNDLE_PREFIX)
  const thirdParty = bundles.filter((bundle) => !owned.has(bundle))
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...DESKTOP_BUNDLE_PREFIX, ...thirdParty],
        patchReload: manifest.dsh?.profile?.patchReload ?? 'live',
      },
    },
  }
}

export async function reconcileDesktopProfile(
  ref: ProfileRef,
  authority: IsolatedHomeAuthority,
): Promise<ReconcileResult> {
  if (
    authority[authorityBrand] !== true ||
    authority.kind !== 'm0-isolated-home' ||
    authority.home !== ref.home
  ) {
    throw new Error('profile write authority does not match ProfileRef home')
  }
  if (ref.name !== 'desktop')
    throw new Error('reconcileDesktopProfile only owns the desktop profile')

  const manifestPath = path.join(ref.dir, 'package.json')
  const patchPath = path.join(ref.dir, 'cordis.patch.yml')
  const workspacePath = path.join(ref.dir, 'pnpm-workspace.yaml')
  const existed = new Map<string, boolean>(
    await Promise.all(
      [manifestPath, patchPath, workspacePath].map(
        async (filename) => [filename, await exists(filename)] as const,
      ),
    ),
  )
  const beforeRaw =
    existed.get(manifestPath) === true ? await readFile(manifestPath, 'utf8') : undefined

  initProfile(ref.dir, DESKTOP_BUNDLE_PREFIX, 'live')
  const currentRaw = await readFile(manifestPath, 'utf8')
  const current = readProfileManifest('dsh-desktop', ref.dir)
  const desiredRaw = `${JSON.stringify(reconciledManifest(current), undefined, 2)}\n`
  if (desiredRaw !== currentRaw) await writeFileAtomic(manifestPath, desiredRaw)

  const changedFiles = [manifestPath, patchPath, workspacePath].filter(
    (filename) =>
      existed.get(filename) === false || (filename === manifestPath && desiredRaw !== currentRaw),
  )
  return Object.freeze({
    ref,
    changed: changedFiles.length > 0,
    changedFiles: Object.freeze(changedFiles),
    beforeRevision: beforeRaw === undefined ? undefined : sha256(beforeRaw),
    afterRevision: sha256(desiredRaw),
  })
}
