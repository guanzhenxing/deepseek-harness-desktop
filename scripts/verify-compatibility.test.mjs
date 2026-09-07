import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildReleaseManifest,
  closureRecordsFromLockfile,
  CompatibilityInputError,
  embedRuntimeFacts,
  repositoryRoot,
  verifyPolicyEvidence,
} from './generate-compatibility.mjs'

function policyFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    dataEpoch: 1,
    supportedDataEpochs: [1],
    pluginApi: {
      strategy: 'verified-exact-baseline',
      singletonPackages: ['@deepseek-ai/dsh', 'react', '@deepseek-ai/cordis'],
    },
    formats: [
      {
        provider: '@deepseek-ai/dsh-settings-file',
        providerVersion: '0.1.2-alpha.3',
        formatId: 'dsh-settings-file-0.1.2-alpha.3',
        readable: ['dsh-settings-file-0.1.2-alpha.3'],
        writable: 'dsh-settings-file-0.1.2-alpha.3',
        evidence: ['repo:README.md'],
      },
    ],
    ...overrides,
  }
}

function inputsFixture(overrides = {}) {
  return {
    docsCompatibility: {
      dsh: {
        tag: 'dsh-v0.1.2-alpha.3',
        commit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
        npmVersion: '0.1.2-alpha.3',
      },
      hostControl: { name: 'dsh-desktop/host-control', major: 1, minor: 0 },
      profile: { name: 'desktop', schemaVersion: 1 },
    },
    policy: policyFixture(),
    upstreamArtifacts: {
      dsh: {
        tag: 'dsh-v0.1.2-alpha.3',
        commit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
        npmVersion: '0.1.2-alpha.3',
        packages: [{ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.3' }],
      },
    },
    records: [
      { name: 'a', version: '1.0.0', integrity: 'sha512-a', relativePath: 'p/a' },
      { name: 'b', version: '2.0.0', integrity: 'sha512-b', relativePath: 'p/b' },
    ],
    releaseId: 'm4-0.0.0-darwin-arm64-98af342',
    desktopVersion: '0.0.0',
    sourceCommit: '98af34292b23ff2087c4d3f4c930465eafc75bbf',
    platform: 'darwin',
    arch: 'arm64',
    ...overrides,
  }
}

test('closure records come out sorted with virtual-store relative paths', () => {
  const lockfile = [
    "lockfileVersion: '9.0'",
    '',
    'packages:',
    '',
    '  zod@3.25.0:',
    '    resolution: {integrity: sha512-zzz}',
    '',
    "  '@deepseek-ai/dsh@0.1.2-alpha.3':",
    '    resolution: {integrity: sha512-aaa}',
    '    hasBin: true',
    '',
    'snapshots:',
    '',
  ].join('\n')
  const records = closureRecordsFromLockfile(lockfile)
  assert.deepEqual(records, [
    {
      name: '@deepseek-ai/dsh',
      version: '0.1.2-alpha.3',
      integrity: 'sha512-aaa',
      relativePath:
        'node_modules/.pnpm/@deepseek-ai+dsh@0.1.2-alpha.3/node_modules/@deepseek-ai/dsh',
    },
    {
      name: 'zod',
      version: '3.25.0',
      integrity: 'sha512-zzz',
      relativePath: 'node_modules/.pnpm/zod@3.25.0/node_modules/zod',
    },
  ])
})

test('closure extraction strips peer-suffix keys and deduplicates them', () => {
  const lockfile = [
    'packages:',
    '',
    "  '@deepseek-ai/dsh@0.1.2-alpha.3':",
    '    resolution: {integrity: sha512-aaa}',
    '',
    "  '@deepseek-ai/dsh-cordis-host-runner@0.1.2-alpha.3(@deepseek-ai/cordis@4.0.2)':",
    '    resolution: {integrity: sha512-bbb}',
    '',
    "  '@deepseek-ai/dsh@0.1.2-alpha.3(@deepseek-ai/cordis@4.0.2)':",
    '    resolution: {integrity: sha512-aaa}',
    '',
  ].join('\n')
  const records = closureRecordsFromLockfile(lockfile)
  assert.deepEqual(records, [
    {
      name: '@deepseek-ai/dsh',
      version: '0.1.2-alpha.3',
      integrity: 'sha512-aaa',
      relativePath:
        'node_modules/.pnpm/@deepseek-ai+dsh@0.1.2-alpha.3/node_modules/@deepseek-ai/dsh',
    },
    {
      name: '@deepseek-ai/dsh-cordis-host-runner',
      version: '0.1.2-alpha.3',
      integrity: 'sha512-bbb',
      relativePath:
        'node_modules/.pnpm/@deepseek-ai+dsh-cordis-host-runner@0.1.2-alpha.3/node_modules/@deepseek-ai/dsh-cordis-host-runner',
    },
  ])
})

test('closure extraction refuses lockfiles without integrity for every package', () => {
  const lockfile = [
    'packages:',
    '',
    '  zod@3.25.0:',
    '    resolution: {tarball: file.tar.gz}',
    '',
  ].join('\n')
  assert.throws(() => closureRecordsFromLockfile(lockfile), CompatibilityInputError)
})

test('manifest assembly is deterministic for identical inputs', () => {
  const first = buildReleaseManifest(inputsFixture())
  const second = buildReleaseManifest(inputsFixture())
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('manifest assembly refuses input disagreements', () => {
  assert.throws(
    () =>
      buildReleaseManifest(
        inputsFixture({
          upstreamArtifacts: {
            dsh: {
              tag: 'dsh-v0.1.2-alpha.3',
              commit: 'dd6322d604e00eec1ba5e0c8541159906a21094a',
              npmVersion: '0.1.2-alpha.4',
              packages: [{ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.4' }],
            },
          },
        }),
      ),
    /disagree on the DSH baseline/,
  )
  assert.throws(
    () =>
      buildReleaseManifest(
        inputsFixture({
          policy: policyFixture({
            formats: [
              {
                provider: '@deepseek-ai/dsh-settings-file',
                providerVersion: '0.1.2-alpha.4',
                formatId: 'x',
                readable: ['x'],
                writable: 'x',
                evidence: ['repo:README.md'],
              },
            ],
          }),
        }),
      ),
    /baseline is 0\.1\.2-alpha\.3/,
  )
})

test('policy evidence verification accepts the committed policy', async () => {
  const { readFile } = await import('node:fs/promises')
  const policy = JSON.parse(
    await readFile(new URL('../build/compatibility-policy.json', import.meta.url), 'utf8'),
  )
  await verifyPolicyEvidence(policy, {
    upstreamCommit: 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
    root: repositoryRoot,
  })
})

test('policy evidence verification refuses a tampered fixture hash', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const work = await mkdtemp(join(tmpdir(), 'compat-evidence-'))
  try {
    await writeFile(join(work, 'fixture.txt'), 'tampered')
    await assert.rejects(
      verifyPolicyEvidence(
        policyFixture({
          formats: [
            {
              provider: 'p',
              providerVersion: '1',
              formatId: 'f',
              readable: ['f'],
              writable: 'f',
              evidence: [`fixture:fixture.txt#${'0'.repeat(64)}`],
            },
          ],
        }),
        { upstreamCommit: 'dd6322d604e00eec1ba5e0c8541159906a21094a', root: work },
      ),
      /hashes to/,
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

test('policy evidence verification refuses every unsupported or missing claim', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const work = await mkdtemp(join(tmpdir(), 'compat-evidence-neg-'))
  try {
    const base = {
      provider: 'p',
      providerVersion: '1',
      formatId: 'f',
      readable: ['f'],
      writable: 'f',
    }
    const run = (evidence) =>
      verifyPolicyEvidence(
        { ...policyFixtureForEvidence(), formats: [{ ...base, evidence }] },
        { upstreamCommit: 'dd6322d604e00eec1ba5e0c8541159906a21094a', root: work },
      )
    await assert.rejects(run(['npm:@deepseek-ai/dsh@9.9.9:lib/index.js']), /not installed/)
    await assert.rejects(
      run(['upstream:4e84901e6471b79ec0338099867ebb4606d12bb5']),
      /baseline is dd6322d/,
    )
    await assert.rejects(run(['repo:missing-file.ts']), /repo evidence missing/)
    await assert.rejects(run(['gopher://whatever']), /unknown evidence scheme/)
    await assert.rejects(run(['fixture:nope.txt#' + '0'.repeat(64)]), /fixture evidence missing/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})

function policyFixtureForEvidence() {
  return { formats: [] }
}

test('runtime facts wrap around the release core without displacing it', () => {
  const base = buildReleaseManifest(inputsFixture())
  const embedded = embedRuntimeFacts(base, {
    productExecutableName: 'DeepSeek Harness Desktop',
    electron: '44.1.0',
  })
  assert.equal(embedded.releaseId, base.releaseId)
  assert.equal(embedded.productExecutableName, 'DeepSeek Harness Desktop')
  assert.equal(embedded.dependencyClosureSha256, base.dependencyClosureSha256)
})
