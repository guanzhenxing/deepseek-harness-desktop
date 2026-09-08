import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  canonicalJson,
  collectClosureComponents,
  createCycloneDx,
  createLicenseInventory,
  createReleaseEvidence,
  directoryDigestHex,
  npmPurl,
  verifyReleaseEvidence,
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

test('traversal fails closed on unreadable directories instead of skipping them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    // An unreadable subdirectory inside a digest walk must throw, never hash
    // a silently smaller tree.
    await mkdir(path.join(root, 'locked'), { recursive: true })
    await writeFile(path.join(root, 'a.txt'), 'one\n')
    await writeFile(path.join(root, 'locked', 'b.txt'), 'two\n')
    await chmod(path.join(root, 'locked'), 0o000)
    await assert.rejects(directoryDigestHex(root))

    // An unreadable scope inside the closure must throw the collection, never
    // drop those packages from the SBOM.
    const closure = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
    try {
      await packageDir(closure, 'plain', { name: 'plain', version: '1.0.0' })
      await packageDir(closure, '@locked/pkg', { name: '@locked/pkg', version: '1.0.0' })
      await chmod(path.join(closure, 'node_modules', '@locked'), 0o000)
      await assert.rejects(
        collectClosureComponents([closure], new Map([[npmPurl('plain', '1.0.0'), 'sha512-p']])),
      )
    } finally {
      await chmod(path.join(closure, 'node_modules', '@locked'), 0o700).catch(() => undefined)
      await rm(closure, { recursive: true, force: true })
    }

    // An unreadable package directory must throw the license inventory, never
    // emit the package with an empty license-file list.
    const licensed = await packageDir(root, 'c', {
      name: 'c',
      version: '1.0.0',
      license: 'MIT',
    })
    await writeFile(path.join(licensed, 'LICENSE'), 'text\n')
    const components = await collectClosureComponents(
      [root],
      new Map([[npmPurl('c', '1.0.0'), 'sha512-c']]),
    )
    // Drop the locked directory so the final recursive rm never has to enter
    // it, then lock the package directory itself for the inventory round.
    await chmod(path.join(root, 'locked'), 0o700)
    await rm(path.join(root, 'locked'), { recursive: true, force: true })
    await chmod(licensed, 0o000)
    await assert.rejects(createLicenseInventory(components, [root]))
    await chmod(licensed, 0o700)
  } finally {
    await chmod(path.join(root, 'locked'), 0o700).catch(() => undefined)
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

test('createLicenseInventory records declared licenses, files, and digests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    const dirA = await packageDir(root, 'a', { name: 'a', version: '1.0.0', license: 'MIT' })
    await writeFile(path.join(dirA, 'LICENSE'), 'MIT license text\n')
    await packageDir(root, 'b', { name: 'b', version: '1.0.0' })
    const components = await collectClosureComponents(
      [root],
      new Map([
        [npmPurl('a', '1.0.0'), 'sha512-a'],
        [npmPurl('b', '1.0.0'), 'sha512-b'],
      ]),
    )
    const inventory = await createLicenseInventory(components, [root])
    const byPurl = Object.fromEntries(inventory.components.map((entry) => [entry.purl, entry]))
    assert.equal(byPurl['pkg:npm/a@1.0.0'].declared, 'MIT')
    assert.equal(byPurl['pkg:npm/b@1.0.0'].declared, 'NOASSERTION')
    assert.deepEqual(byPurl['pkg:npm/a@1.0.0'].files, ['LICENSE'])
    assert.match(byPurl['pkg:npm/a@1.0.0'].sha256.LICENSE, /^[0-9a-f]{64}$/u)
    assert.deepEqual(byPurl['pkg:npm/b@1.0.0'].files, [])
    assert.equal(inventory.schemaVersion, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createLicenseInventory rejects a symlinked license file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-evidence-'))
  try {
    const dir = await packageDir(root, 'a', { name: 'a', version: '1.0.0', license: 'MIT' })
    await writeFile(path.join(root, 'outside-license'), 'pretend\n')
    await symlink('../outside-license', path.join(dir, 'LICENSE'))
    const components = await collectClosureComponents(
      [root],
      new Map([[npmPurl('a', '1.0.0'), 'sha512-a']]),
    )
    await assert.rejects(createLicenseInventory(components, [root]), /symlink/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verifyReleaseEvidence rejects the four identity mutations with specific codes', async () => {
  const baseInput = () => ({
    report: {
      schemaVersion: 1,
      releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
      sourceCommit: 'a'.repeat(40),
      artifact: { sha256: 'b'.repeat(64), platform: 'darwin', arch: 'arm64' },
      compatibilityManifestSha256: 'c'.repeat(64),
      runtimes: { node: '24.11.1', electron: '44.1.0', dsh: '0.1.2-rc.1' },
      evidence: {
        sbom: { file: 'sbom.cdx.json', sha256: 'd'.repeat(64) },
        licenses: { file: 'licenses.json', sha256: 'e'.repeat(64) },
        packageSmoke: {
          file: '../package-smoke.json',
          sha256: 'f'.repeat(64),
          passed: true,
          scenarioCount: 2,
        },
      },
    },
    sbom: Buffer.from('sbom'),
    licenses: Buffer.from('licenses'),
    packageSmoke: {
      candidate: {
        releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
        sha256: 'b'.repeat(64),
        platform: 'darwin',
        arch: 'arm64',
        compatibilityManifestSha256: 'c'.repeat(64),
      },
      results: [
        { name: 'one', ok: true },
        { name: 'two', ok: true },
      ],
    },
    artifactRecords: [
      {
        releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
        sha256: 'b'.repeat(64),
        platform: 'darwin',
        arch: 'arm64',
        file: 'release/dist/x.dmg',
      },
    ],
    expectedRuntimes: { node: '24.11.1', electron: '44.1.0' },
    dmgDigest: 'b'.repeat(64),
    embeddedManifest: {
      releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
      sourceCommit: 'a'.repeat(40),
      platform: 'darwin',
      arch: 'arm64',
      node: '24.11.1',
      electron: '44.1.0',
      dsh: { tag: 'dsh-v0.1.2-rc.1', commit: 'g'.repeat(40), npmVersion: '0.1.2-rc.1' },
    },
  })

  // The happy path: the report is ASSEMBLED by createReleaseEvidence from
  // the same facts, then verifies.
  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  const ok = baseInput()
  ok.report = createReleaseEvidence({
    releaseId: ok.report.releaseId,
    sourceCommit: ok.report.sourceCommit,
    artifact: ok.report.artifact,
    compatibilityManifestSha256: ok.report.compatibilityManifestSha256,
    runtimes: ok.report.runtimes,
    sbomSha256: sha256(ok.sbom),
    licensesSha256: sha256(ok.licenses),
    packageSmoke: {
      sha256: sha256(canonicalJson(ok.packageSmoke).trimEnd()),
      passed: true,
      scenarioCount: 2,
    },
  })
  assert.deepEqual(verifyReleaseEvidence(ok), { ok: true })

  const staleSmoke = baseInput()
  staleSmoke.report.evidence.sbom.sha256 = sha256(staleSmoke.sbom)
  staleSmoke.report.evidence.licenses.sha256 = sha256(staleSmoke.licenses)
  staleSmoke.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(staleSmoke.packageSmoke).trim(),
  )
  staleSmoke.packageSmoke.candidate.releaseId = 'm3-0.0.0-darwin-arm64-old000'
  assert.throws(() => verifyReleaseEvidence(staleSmoke), /EVIDENCE_SMOKE_RELEASE_MISMATCH/u)

  const wrongArch = baseInput()
  wrongArch.report.evidence.sbom.sha256 = sha256(wrongArch.sbom)
  wrongArch.report.evidence.licenses.sha256 = sha256(wrongArch.licenses)
  wrongArch.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(wrongArch.packageSmoke).trim(),
  )
  wrongArch.report.artifact.arch = 'x64'
  assert.throws(() => verifyReleaseEvidence(wrongArch), /EVIDENCE_ARCH_MISMATCH/u)

  const replacedDmg = baseInput()
  replacedDmg.report.evidence.sbom.sha256 = sha256(replacedDmg.sbom)
  replacedDmg.report.evidence.licenses.sha256 = sha256(replacedDmg.licenses)
  replacedDmg.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(replacedDmg.packageSmoke).trim(),
  )
  replacedDmg.dmgDigest = 'f'.repeat(64)
  assert.throws(() => verifyReleaseEvidence(replacedDmg), /EVIDENCE_ARTIFACT_DIGEST_MISMATCH/u)

  // The smoke report's candidate must bind the SAME artifact, not just echo
  // the release id: a tampered DMG digest (platform/arch/manifest digest are
  // covered by the same comparison) must fail even with a recomputed smoke
  // digest, so a mixed-candidate smoke report cannot ride through.
  const mixedSmoke = baseInput()
  mixedSmoke.report.evidence.sbom.sha256 = sha256(mixedSmoke.sbom)
  mixedSmoke.report.evidence.licenses.sha256 = sha256(mixedSmoke.licenses)
  mixedSmoke.packageSmoke.candidate.sha256 = '0'.repeat(64)
  mixedSmoke.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(mixedSmoke.packageSmoke).trim(),
  )
  assert.throws(() => verifyReleaseEvidence(mixedSmoke), /EVIDENCE_SMOKE_ARTIFACT_MISMATCH/u)

  const mixedManifest = baseInput()
  mixedManifest.report.evidence.sbom.sha256 = sha256(mixedManifest.sbom)
  mixedManifest.report.evidence.licenses.sha256 = sha256(mixedManifest.licenses)
  mixedManifest.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(mixedManifest.packageSmoke).trim(),
  )
  mixedManifest.packageSmoke.candidate.compatibilityManifestSha256 = '0'.repeat(64)
  mixedManifest.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(mixedManifest.packageSmoke).trim(),
  )
  assert.throws(() => verifyReleaseEvidence(mixedManifest), /EVIDENCE_SMOKE_ARTIFACT_MISMATCH/u)

  // An embedded manifest declaring the wrong architecture is
  // self-consistent with its own artifact index but must not survive the
  // cross-check against the report's artifact identity.
  const wrongEmbeddedArch = baseInput()
  wrongEmbeddedArch.report.evidence.sbom.sha256 = sha256(wrongEmbeddedArch.sbom)
  wrongEmbeddedArch.report.evidence.licenses.sha256 = sha256(wrongEmbeddedArch.licenses)
  wrongEmbeddedArch.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(wrongEmbeddedArch.packageSmoke).trim(),
  )
  wrongEmbeddedArch.embeddedManifest.arch = 'x64'
  assert.throws(() => verifyReleaseEvidence(wrongEmbeddedArch), /EVIDENCE_ARCH_MISMATCH/u)

  const missingSbom = baseInput()
  missingSbom.evidence = undefined
  missingSbom.report.evidence.sbom.sha256 = sha256(missingSbom.sbom)
  missingSbom.report.evidence.licenses.sha256 = sha256(missingSbom.licenses)
  missingSbom.report.evidence.packageSmoke.sha256 = sha256(
    canonicalJson(missingSbom.packageSmoke).trim(),
  )
  delete missingSbom.sbom
  assert.throws(() => verifyReleaseEvidence(missingSbom), /EVIDENCE_COMPONENT_MISSING/u)
})

test('verifyReleaseEvidence pins the evidence file names against traversal', () => {
  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  const input = {
    report: {
      schemaVersion: 1,
      releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
      sourceCommit: 'a'.repeat(40),
      artifact: { sha256: 'b'.repeat(64), platform: 'darwin', arch: 'arm64' },
      compatibilityManifestSha256: 'c'.repeat(64),
      runtimes: { node: '24.11.1', electron: '44.1.0', dsh: '0.1.2-rc.1' },
      evidence: {
        sbom: { file: '../../outside/secret.json', sha256: sha256('sbom') },
        licenses: { file: 'licenses.json', sha256: sha256('licenses') },
        packageSmoke: {
          file: '../package-smoke.json',
          sha256: sha256('{}'),
          passed: true,
          scenarioCount: 1,
        },
      },
    },
    sbom: Buffer.from('sbom'),
    licenses: Buffer.from('licenses'),
    packageSmoke: {
      candidate: {
        releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
        sha256: 'b'.repeat(64),
        platform: 'darwin',
        arch: 'arm64',
        compatibilityManifestSha256: 'c'.repeat(64),
      },
      results: [{ name: 'one', ok: true }],
    },
    artifactRecords: [
      {
        releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
        sha256: 'b'.repeat(64),
        platform: 'darwin',
        arch: 'arm64',
      },
    ],
    dmgDigest: 'b'.repeat(64),
    embeddedManifest: {
      releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
      sourceCommit: 'a'.repeat(40),
      platform: 'darwin',
      arch: 'arm64',
      dsh: { tag: 't', commit: 'g'.repeat(40), npmVersion: '0.1.2-rc.1' },
    },
    expectedRuntimes: { node: '24.11.1', electron: '44.1.0' },
  }
  assert.throws(() => verifyReleaseEvidence(input), /file|traversal|escape/u)
})

test('verifyReleaseEvidence cross-checks the reported and embedded runtime versions', () => {
  const build = (tamperEmbedded = false) => {
    const sha256 = (value) => createHash('sha256').update(value).digest('hex')
    return {
      report: {
        schemaVersion: 1,
        releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
        sourceCommit: 'a'.repeat(40),
        artifact: { sha256: 'b'.repeat(64), platform: 'darwin', arch: 'arm64' },
        compatibilityManifestSha256: 'c'.repeat(64),
        runtimes: { node: '99.0.0-tampered', electron: '44.1.0', dsh: '0.1.2-rc.1' },
        evidence: {
          sbom: { file: 'sbom.cdx.json', sha256: sha256('sbom') },
          licenses: { file: 'licenses.json', sha256: sha256('licenses') },
          packageSmoke: {
            file: '../package-smoke.json',
            sha256: sha256('{}'),
            passed: true,
            scenarioCount: 1,
          },
        },
      },
      sbom: Buffer.from('sbom'),
      licenses: Buffer.from('licenses'),
      packageSmoke: {
        candidate: {
          releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
          sha256: 'b'.repeat(64),
          platform: 'darwin',
          arch: 'arm64',
          compatibilityManifestSha256: 'c'.repeat(64),
        },
        results: [{ name: 'one', ok: true }],
      },
      artifactRecords: [
        {
          releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
          sha256: 'b'.repeat(64),
          platform: 'darwin',
          arch: 'arm64',
        },
      ],
      dmgDigest: 'b'.repeat(64),
      embeddedManifest: {
        releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
        sourceCommit: 'a'.repeat(40),
        platform: 'darwin',
        arch: 'arm64',
        node: tamperEmbedded ? '99.0.0-tampered' : '24.11.1',
        electron: '44.1.0',
        dsh: { tag: 't', commit: 'g'.repeat(40), npmVersion: '0.1.2-rc.1' },
      },
      expectedRuntimes: { node: '24.11.1', electron: '44.1.0' },
    }
  }
  assert.throws(() => verifyReleaseEvidence(build()), /runtime/u)
  const embeddedTamper = build(true)
  embeddedTamper.report.runtimes.node = '24.11.1'
  assert.throws(() => verifyReleaseEvidence(embeddedTamper), /embedded manifest node/u)
})
