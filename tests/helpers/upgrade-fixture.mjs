// Upgrade rehearsal fixture helpers: everything the rehearsal touches is a
// throwaway copy of a seeded fixture home — never a real ~/.dsh, never the
// original fixture itself. Digests are recorded before and re-verified after
// every step so any "the tool quietly changed the data" behavior fails the
// rehearsal instead of passing silently.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export async function sha256File(file) {
  const bytes = await readFile(file)
  return createHash('sha256').update(bytes).digest('hex')
}

/** Sorted walk of every regular file under a root, relative paths only. */
export async function walkFiles(root, directory = root) {
  const files = []
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      files.push({ relative: path.relative(root, target), kind: 'symlink' })
      continue
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, target)))
      continue
    }
    if (entry.isFile()) files.push({ relative: path.relative(root, target), kind: 'file' })
  }
  return files
}

/**
 * Byte-level digest of every file in a tree. Lease coordination paths
 * (run/host.lock, run/host-lease.guard) are excluded by the caller via
 * `ignore` predicates when they compare before/after refusal snapshots.
 */
export async function treeDigests(root) {
  const files = await walkFiles(root)
  const digests = new Map()
  for (const entry of files) {
    if (entry.kind !== 'file') {
      digests.set(entry.relative, 'symlink')
      continue
    }
    const bytes = await readFile(path.join(root, entry.relative))
    digests.set(entry.relative, createHash('sha256').update(bytes).digest('hex'))
  }
  return digests
}

export function digestDiff(before, after) {
  const changed = []
  for (const [file, digest] of before) {
    if (after.get(file) !== digest) changed.push(file)
  }
  for (const [file] of after) {
    if (!before.has(file)) changed.push(file)
  }
  return [...new Set(changed)].sort()
}

/**
 * Copy a home with cp -c (clonefile) semantics via cp -R and verify the copy
 * is byte-identical to the source before returning it. All rehearsal runs
 * happen against this copy only.
 */
export async function copyHomeWithProof(source) {
  const target = await mkdtemp(path.join(tmpdir(), 'dsh-upgrade-home-'))
  const home = path.join(target, 'home')
  await cp(source, home, { recursive: true })
  const before = await treeDigests(source)
  const after = await treeDigests(home)
  const changed = digestDiff(before, after)
  if (changed.length > 0) {
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw new Error(`home copy diverged from the fixture: ${changed.join(', ')}`)
  }
  return {
    root: target,
    home,
    async dispose() {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

/**
 * A third-party fixture bundle with its own package manifest and lockfile:
 * the rehearsal records the digests and asserts that neither artifact's boot
 * modified, upgraded, or removed it.
 */
export async function seedThirdPartyBundle(home) {
  const bundle = path.join(home, 'profiles', 'user-plugin')
  await mkdir(bundle, { recursive: true, mode: 0o700 })
  const manifest = {
    name: 'example-user-plugin',
    version: '1.0.0',
    main: './index.js',
    dependencies: { '@example/peer': '^1.0.0' },
  }
  await writeFile(path.join(bundle, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  await writeFile(
    path.join(bundle, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n",
  )
  await writeFile(path.join(bundle, 'index.js'), 'export const plugin = "fixture"\n')
  return {
    digests: {
      'package.json': await sha256File(path.join(bundle, 'package.json')),
      'pnpm-lock.yaml': await sha256File(path.join(bundle, 'pnpm-lock.yaml')),
      'index.js': await sha256File(path.join(bundle, 'index.js')),
    },
    directory: bundle,
  }
}

export async function assertThirdPartyBundleUnchanged(bundle) {
  for (const [relative, expected] of Object.entries(bundle.digests)) {
    const actual = await sha256File(path.join(bundle.directory, relative)).catch(() => undefined)
    if (actual !== expected) {
      throw new Error(
        `third-party fixture bundle was modified by the upgrade rehearsal: profiles/user-plugin/${relative}`,
      )
    }
  }
  return true
}

/**
 * Copy a DMG and flip one byte: a corrupt candidate must be refused by the
 * digest check before anything is installed from it.
 */
export async function makeCorruptDmgCopy(dmgPath) {
  const corrupt = path.join(
    await mkdtemp(path.join(tmpdir(), 'dsh-corrupt-dmg-')),
    path.basename(dmgPath),
  )
  await copyFile(dmgPath, corrupt)
  const handle = await (await import('node:fs/promises')).open(corrupt, 'r+')
  try {
    const { size } = await handle.stat()
    const position = Math.max(0, Math.floor(size / 2))
    const buffer = Buffer.alloc(1)
    await handle.read(buffer, 0, 1, position)
    buffer[0] ^= 0xff
    await handle.write(buffer, 0, 1, position)
  } finally {
    await handle.close()
  }
  return {
    file: corrupt,
    async dispose() {
      await rm(path.dirname(corrupt), { recursive: true, force: true })
    },
  }
}
