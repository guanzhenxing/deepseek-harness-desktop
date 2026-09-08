import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { bundleDigest, validatePluginIntake } from './plugin-intake.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureBundle = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'plugin-intake',
  'example.bundle',
)

const MANIFEST = {
  pluginApi: { singletonPackages: ['react', '@deepseek-ai/cordis', '@deepseek-ai/dsh'] },
}

async function baseRecord() {
  return JSON.parse(
    await readFile(
      path.join(repositoryRoot, 'tests', 'fixtures', 'plugin-intake', 'example.intake.json'),
      'utf8',
    ),
  )
}

test('the accepted fixture validates and normalizes to a frozen record', async () => {
  const normalized = await validatePluginIntake(await baseRecord(), fixtureBundle, MANIFEST)
  assert.equal(normalized.package, '@fixture/m5-example-bundle')
  assert.equal(normalized.source.kind, 'repository')
  assert.ok(Object.isFrozen(normalized))
})

test('an empty bundle digests to the well-known empty payload constant', async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'dsh-intake-empty-'))
  try {
    assert.equal(await bundleDigest(empty), 'sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('an unknown source kind is refused', async () => {
  const record = await baseRecord()
  record.source = { kind: 'registry', url: 'https://example.invalid' }
  await assert.rejects(validatePluginIntake(record, fixtureBundle, MANIFEST), /UNKNOWN_SOURCE/u)
})

test('version drift between record and bundle is refused', async () => {
  const record = await baseRecord()
  record.version = '1.0.1'
  await assert.rejects(validatePluginIntake(record, fixtureBundle, MANIFEST), /VERSION_DRIFT/u)
})

test('digest drift is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-intake-'))
  try {
    const drifted = path.join(root, 'example.bundle')
    await mkdir(drifted, { recursive: true })
    const original = await readFile(path.join(fixtureBundle, 'package.json'))
    await writeFile(path.join(drifted, 'package.json'), original)
    await writeFile(path.join(drifted, 'cordis.patch.yml'), '# drifted content\n')
    await assert.rejects(
      validatePluginIntake(await baseRecord(), drifted, MANIFEST),
      /DIGEST_DRIFT/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('install lifecycle scripts are refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-intake-'))
  try {
    const scripted = path.join(root, 'example.bundle')
    await mkdir(scripted, { recursive: true })
    const manifest = JSON.parse(await readFile(path.join(fixtureBundle, 'package.json'), 'utf8'))
    manifest.scripts = { postinstall: 'node ./do-things.js' }
    await writeFile(
      path.join(scripted, 'package.json'),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    )
    await writeFile(
      path.join(scripted, 'cordis.patch.yml'),
      await readFile(path.join(fixtureBundle, 'cordis.patch.yml')),
    )
    const record = await baseRecord()
    record.integrity = await bundleDigest(scripted)
    await assert.rejects(validatePluginIntake(record, scripted, MANIFEST), /LIFECYCLE_SCRIPT/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a bundle shipping its own singleton dependency is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-intake-'))
  try {
    const singleton = path.join(root, 'example.bundle')
    await mkdir(singleton, { recursive: true })
    const manifest = JSON.parse(await readFile(path.join(fixtureBundle, 'package.json'), 'utf8'))
    manifest.peerDependencies = { react: '^18.3.1' }
    await writeFile(
      path.join(singleton, 'package.json'),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    )
    await writeFile(
      path.join(singleton, 'cordis.patch.yml'),
      await readFile(path.join(fixtureBundle, 'cordis.patch.yml')),
    )
    const record = await baseRecord()
    record.integrity = await bundleDigest(singleton)
    await assert.rejects(validatePluginIntake(record, singleton, MANIFEST), /SINGLETON_DEPENDENCY/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a record without packaged evidence for this platform is refused', async () => {
  const record = await baseRecord()
  record.validatedPlatforms = ['linux-x64']
  await assert.rejects(
    validatePluginIntake(record, fixtureBundle, MANIFEST),
    /NO_PACKAGED_EVIDENCE/u,
  )
})

test('unknown top-level or source fields are refused (schema 1 is closed)', async () => {
  const extraTop = await baseRecord()
  extraTop.extra = 'ignored by no one'
  await assert.rejects(
    validatePluginIntake(extraTop, fixtureBundle, MANIFEST),
    /RECORD_INVALID.*closed schema-1/u,
  )

  const extraSource = await baseRecord()
  extraSource.source.trust = 'self-declared'
  await assert.rejects(
    validatePluginIntake(extraSource, fixtureBundle, MANIFEST),
    /RECORD_INVALID.*closed schema-1/u,
  )

  const missingField = await baseRecord()
  delete missingField.capabilities
  await assert.rejects(
    validatePluginIntake(missingField, fixtureBundle, MANIFEST),
    /RECORD_INVALID.*closed schema-1/u,
  )
})
