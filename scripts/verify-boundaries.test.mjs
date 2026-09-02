import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findBoundaryViolations } from './verify-boundaries.mjs'

test('rejects Electron imports from mechanism packages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'profile-manager', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, 'index.ts'), "import { app } from 'electron'\n")

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['mechanism-no-electron'],
    )
  } finally {
    await rm(root, { recursive: true })
  }
})

test('rejects DSH runtime imports from Electron Main', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'apps', 'desktop-launcher', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'main.ts'),
      "import { boot } from '@deepseek-ai/dsh-app-boot'\n",
    )

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['main-no-dsh-runtime'],
    )
  } finally {
    await rm(root, { recursive: true })
  }
})

test('allows the Electron Host entry adapter to import the Host runner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'apps', 'desktop-launcher', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'host-entry.ts'),
      "import { runDshHost } from '@dsh-desktop/host-supervisor/host-runner'\n",
    )

    assert.deepEqual(await findBoundaryViolations(root), [])
  } finally {
    await rm(root, { recursive: true })
  }
})

test('rejects exporting the DSH Host runner from the supervisor root entry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'host-supervisor', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, 'index.ts'), "export * from './host-runner.js'\n")

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['supervisor-root-no-host-runner'],
    )
  } finally {
    await rm(root, { recursive: true })
  }
})

test('rejects loading the DSH boot runtime through profile-manager', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-boundaries-'))
  try {
    const sourceDir = path.join(root, 'packages', 'profile-manager', 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(
      path.join(sourceDir, 'reconcile.ts'),
      "import { initProfile } from '@deepseek-ai/dsh-app-boot'\n",
    )

    const violations = await findBoundaryViolations(root)
    assert.deepEqual(
      violations.map((item) => item.rule),
      ['profile-manager-no-dsh-boot'],
    )
  } finally {
    await rm(root, { recursive: true })
  }
})
