import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  canonicalJson,
  collectClosureComponents,
  createCycloneDx,
  directoryDigestHex,
  npmPurl,
} from './release-evidence-lib.mjs'

async function packageDir(root, name, fields) {
  const dir = path.join(root, 'node_modules', ...name.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(fields, undefined, 2)}\n`)
  return dir
}

test('collectClosureComponents dedupes one package instance across closure roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    const hostRoot = path.join(root, 'host')
    const cliRoot = path.join(root, 'cli')
    await packageDir(hostRoot, '@scope/a', {
      name: '@scope/a',
      version: '1.0.0',
      license: 'MIT',
    })
    await packageDir(cliRoot, 'b', { name: 'b', version: '2.0.0' })
    // The same package instance linked into the second closure root must not
    // duplicate the component.
    await mkdir(path.join(cliRoot, 'node_modules', '@scope'), { recursive: true })
    await symlink(
      path.join(hostRoot, 'node_modules', '@scope', 'a'),
      path.join(cliRoot, 'node_modules', '@scope', 'a'),
      'dir',
    )
    const integrity = new Map([
      [npmPurl('@scope/a', '1.0.0'), 'sha512-aaaaaaaa'],
      [npmPurl('b', '2.0.0'), 'sha512-bbbbbbbb'],
    ])
    const components = await collectClosureComponents([hostRoot, cliRoot], integrity)
    assert.deepEqual(
      components.map((entry) => entry.purl),
      ['pkg:npm/%40scope%2Fa@1.0.0', 'pkg:npm/b@2.0.0'],
    )
    assert.equal(components[0].license, 'MIT')
    assert.equal(components[0].integrity, 'sha512-aaaaaaaa')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collectClosureComponents rejects a manifest without name or version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    await packageDir(root, 'broken', { name: 'broken' })
    await assert.rejects(collectClosureComponents([root], new Map()), /name\/version/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collectClosureComponents rejects a symlink escaping the closure roots', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-outside-'))
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    await packageDir(outside, 'external', { name: 'external', version: '9.9.9' })
    await mkdir(path.join(root, 'node_modules'), { recursive: true })
    await symlink(
      path.join(outside, 'node_modules', 'external'),
      path.join(root, 'node_modules', 'external'),
      'dir',
    )
    await assert.rejects(
      collectClosureComponents([root], new Map([[npmPurl('external', '9.9.9'), 'sha512-zzzz']])),
      /escapes/u,
    )
  } finally {
    await rm(outside, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('collectClosureComponents rejects registry packages without lockfile integrity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    await packageDir(root, 'b', { name: 'b', version: '2.0.0' })
    await assert.rejects(collectClosureComponents([root], new Map()), /integrity/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace components carry a deterministic directory digest instead', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    const dir = await packageDir(root, '@dsh-desktop/shell-core', {
      name: '@dsh-desktop/shell-core',
      version: '0.0.0',
    })
    const components = await collectClosureComponents([root], new Map())
    assert.equal(components.length, 1)
    assert.equal(components[0].source, 'workspace')
    assert.match(components[0].integrity, /^sha256-[0-9a-f]{64}$/u)
    // The digest is over the deployed files, not the identity string.
    await writeFile(path.join(dir, 'marker.txt'), 'content\n')
    const changed = await collectClosureComponents([root], new Map())
    assert.notEqual(changed[0].integrity, components[0].integrity)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('directoryDigestHex feeds sorted paths and file digests deterministically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    await mkdir(path.join(root, 'b'), { recursive: true })
    await writeFile(path.join(root, 'a.txt'), 'one\n')
    await writeFile(path.join(root, 'b', 'c.txt'), 'two\n')
    const first = await directoryDigestHex(root)
    const second = await directoryDigestHex(root)
    assert.equal(first, second)
    assert.match(first, /^[0-9a-f]{64}$/u)
    await assert.rejects(directoryDigestHex(path.join(root, 'a.txt')), /directory/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('canonicalJson sorts keys recursively and appends exactly one newline', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}\n')
  assert.equal(canonicalJson({ x: [3, 1, { z: 1, y: 2 }] }), '{"x":[3,1,{"y":2,"z":1}]}\n')
})

test('createCycloneDx emits a deterministic minimal CycloneDX 1.6 document', () => {
  const components = [
    {
      purl: 'pkg:npm/b@2.0.0',
      name: 'b',
      version: '2.0.0',
      license: 'NOASSERTION',
      integrity: 'sha512-bbbbbbbb',
    },
    {
      purl: 'pkg:npm/%40scope%2Fa@1.0.0',
      name: '@scope/a',
      version: '1.0.0',
      license: 'MIT',
      integrity: 'sha512-aaaaaaaa',
    },
  ]
  const subject = { type: 'application', name: 'DeepSeek Harness', version: '0.0.0' }
  const bom = createCycloneDx(components, subject)
  assert.deepEqual(
    { bomFormat: bom.bomFormat, specVersion: bom.specVersion, version: bom.version },
    { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 },
  )
  assert.equal(bom.metadata.component, subject)
  assert.deepEqual(
    bom.components.map((entry) => entry['bom-ref']),
    ['pkg:npm/%40scope%2Fa@1.0.0', 'pkg:npm/b@2.0.0'],
  )
  assert.deepEqual(bom.components[0].hashes, [
    { alg: 'SHA-512', content: Buffer.from('aaaaaaaa', 'base64').toString('hex') },
  ])
})
