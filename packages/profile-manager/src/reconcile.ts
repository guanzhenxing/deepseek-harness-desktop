import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProfileRef } from './profile-ref.js'

export const DESKTOP_BUNDLE_PREFIX = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-desktop/desktop-plugin',
] as const

const authorityBrand = Symbol('ProfileWriteAuthority')
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
[]
`
const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

type ProfileManifest = Record<string, unknown> & {
  dsh?: Record<string, unknown> & {
    profile?: Record<string, unknown> & {
      bundles?: unknown
      patchReload?: unknown
    }
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProfileManifest(raw: string): ProfileManifest {
  const manifest: unknown = JSON.parse(raw)
  if (!isRecord(manifest)) throw new Error('desktop profile manifest must hold a JSON object')
  if (manifest.dsh !== undefined && !isRecord(manifest.dsh)) {
    throw new Error('desktop profile dsh field must hold a JSON object')
  }
  if (manifest.dsh?.profile !== undefined && !isRecord(manifest.dsh.profile)) {
    throw new Error('desktop profile field must hold a JSON object')
  }
  return manifest as ProfileManifest
}

async function writeInitialFile(filename: string, content: string): Promise<void> {
  try {
    await writeFile(filename, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function initializeProfile(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeInitialFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${path.basename(dir)}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: DESKTOP_BUNDLE_PREFIX, patchReload: 'live' } },
      },
      undefined,
      2,
    )}\n`,
  )
  await writeInitialFile(path.join(dir, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE)
  await writeInitialFile(path.join(dir, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE)
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
  const dsh = manifest.dsh ?? {}
  const profile = dsh.profile ?? {}
  const bundles = profile.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some((bundle) => typeof bundle !== 'string')) {
    throw new Error('desktop profile bundle list must contain only package names')
  }
  if (
    profile.patchReload !== undefined &&
    profile.patchReload !== 'live' &&
    profile.patchReload !== 'startup'
  ) {
    throw new Error('desktop profile patchReload must be live or startup')
  }
  const owned = new Set<string>(DESKTOP_BUNDLE_PREFIX)
  const thirdParty = bundles.filter((bundle) => !owned.has(bundle))
  return {
    ...manifest,
    dsh: {
      ...dsh,
      profile: {
        ...profile,
        bundles: [...DESKTOP_BUNDLE_PREFIX, ...thirdParty],
        patchReload: profile.patchReload ?? 'live',
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

  await initializeProfile(ref.dir)
  const currentRaw = await readFile(manifestPath, 'utf8')
  const current = parseProfileManifest(currentRaw)
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
