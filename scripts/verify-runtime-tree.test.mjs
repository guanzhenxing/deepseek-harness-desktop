import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findDuplicateSingletons,
  findUnmetDeepseekPeers,
  findEscapingSymlinks,
  findMissingRequiredFiles,
  findUnresolvableSingletons,
} from './verify-runtime-tree.mjs'

async function makeTree() {
  return mkdtemp(path.join(tmpdir(), 'dsh-verify-tree-'))
}

test('findMissingRequiredFiles reports absent entries only', async () => {
  const tree = await makeTree()
  try {
    const empty = await findMissingRequiredFiles(tree)
    assert.ok(empty.length >= 2)
    assert.equal(empty[0], 'app-shell/package.json')
    assert.equal(empty[1], 'app-shell/main.cjs')
    await mkdir(path.join(tree, 'app-shell'), { recursive: true })
    await writeFile(path.join(tree, 'app-shell', 'package.json'), '{}\n')
    // A directory where a file is required still counts as missing.
    await mkdir(path.join(tree, 'app-shell', 'main.cjs'))
    const after = await findMissingRequiredFiles(tree)
    assert.ok(after.includes('app-shell/main.cjs'))
    assert.ok(!after.includes('app-shell/package.json'))
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
})

test('findEscapingSymlinks flags links that leave the tree', async () => {
  const tree = await makeTree()
  try {
    const outside = await makeTree()
    try {
      await mkdir(path.join(tree, 'inside'), { recursive: true })
      await symlink(path.join(tree, 'inside'), path.join(tree, 'self-link'))
      await symlink(outside, path.join(tree, 'escape-link'))
      await symlink(path.join(tree, 'nowhere-deep', 'gone'), path.join(tree, 'broken-link'))
      const escapes = await findEscapingSymlinks(tree)
      const labels = escapes.map((escape) => path.basename(escape.link)).sort()
      assert.deepEqual(labels, ['broken-link', 'escape-link'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
})

test('an unreadable subtree fails the walk instead of scanning less', async () => {
  // A chmod-000 directory hiding an escaping symlink must throw: swallowing
  // the readdir error would pass the gate over a smaller tree.
  if (process.platform === 'win32') return
  const tree = await makeTree()
  try {
    const outside = await makeTree()
    try {
      const locked = path.join(tree, 'locked')
      await mkdir(locked, { recursive: true })
      await symlink(outside, path.join(locked, 'hidden-escape'))
      await chmod(locked, 0o000)
      await assert.rejects(findEscapingSymlinks(tree), /EACCES/u)
    } finally {
      await chmod(path.join(tree, 'locked'), 0o755).catch(() => undefined)
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
})

test('findDuplicateSingletons detects multiple and absent singletons', async () => {
  const tree = await makeTree()
  try {
    const store = path.join(tree, 'node_modules', '.pnpm')
    await mkdir(path.join(store, 'react@19.1.0'), { recursive: true })
    assert.deepEqual(await findDuplicateSingletons(tree, ['react']), [])
    await mkdir(path.join(store, 'react@18.3.1'), { recursive: true })
    assert.deepEqual(await findDuplicateSingletons(tree, ['react']), [
      { name: 'react', versions: ['18.3.1', '19.1.0'] },
    ])
    // Absence is proven by resolution elsewhere; the store scan only flags
    // genuine duplicates.
    assert.deepEqual(await findDuplicateSingletons(tree, ['@deepseek-ai/cordis']), [])
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
})

test('findUnresolvableSingletons verifies closure-local resolution', async () => {
  const tree = await makeTree()
  try {
    const outside = await makeTree()
    try {
      await writeFile(path.join(tree, 'package.json'), '{"name":"closure"}\n')
      const localReact = path.join(tree, 'node_modules', 'react')
      await mkdir(localReact, { recursive: true })
      await writeFile(path.join(localReact, 'package.json'), '{"name":"react"}\n')
      const outsideReact = path.join(outside, 'react')
      await mkdir(outsideReact, { recursive: true })
      await writeFile(path.join(outsideReact, 'package.json'), '{"name":"react"}\n')

      assert.deepEqual(await findUnresolvableSingletons(tree, ['react']), [])

      const escaping = path.join(tree, 'escaping-react')
      await mkdir(path.dirname(escaping), { recursive: true })
      await symlink(outsideReact, escaping)
      await rm(localReact, { recursive: true, force: true })
      await mkdir(path.dirname(localReact), { recursive: true })
      await symlink(escaping, localReact)
      const failures = await findUnresolvableSingletons(tree, ['react'])
      assert.equal(failures.length, 1)
      assert.match(failures[0].reason, /outside the closure/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
})

test('findUnmetDeepseekPeers reports deepseek peers missing from the closure', async () => {
  const tree = await makeTree()
  try {
    const consumer = path.join(
      tree,
      'node_modules',
      '.pnpm',
      'consumer@1.0.0',
      'node_modules',
      'consumer',
    )
    await mkdir(consumer, { recursive: true })
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        peerDependencies: { '@deepseek-ai/dsh-missing-peer': '*' },
      }),
    )
    const unmet = await findUnmetDeepseekPeers(tree)
    assert.deepEqual(unmet, [{ peer: '@deepseek-ai/dsh-missing-peer', peeredBy: ['consumer'] }])
    // Providing the peer in the hoisted virtual store clears the finding.
    const hoisted = path.join(
      tree,
      'node_modules',
      '.pnpm',
      'node_modules',
      '@deepseek-ai',
      'dsh-missing-peer',
    )
    await mkdir(hoisted, { recursive: true })
    await writeFile(
      path.join(hoisted, 'package.json'),
      '{"name":"@deepseek-ai/dsh-missing-peer"}\n',
    )
    assert.deepEqual(await findUnmetDeepseekPeers(tree), [])
    // Non-deepseek peers are not this check's concern.
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', peerDependencies: { react: '*' } }),
    )
    assert.deepEqual(await findUnmetDeepseekPeers(tree), [])
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
})
