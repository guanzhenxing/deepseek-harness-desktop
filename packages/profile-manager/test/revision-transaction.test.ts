import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireHomeLease,
  createInProcessGuardLock,
  type HomeLease,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'

import { createProfileRef } from '../src/index.js'
import { planDesktopReconcile } from '../src/reconcile-plan.js'
import {
  applyProfileTransaction,
  commitProfileTransaction,
  readJournal,
  retainProfileTransaction,
  rollbackProfileTransaction,
  transactionDir,
} from '../src/revision-transaction.js'
import { recoverInterruptedTransactions } from '../src/revision-recovery.js'
import {
  createIsolatedHomeFixture,
  type IsolatedHomeFixture,
} from '../../../tests/helpers/isolated-home.js'

const fixtures: IsolatedHomeFixture[] = []

async function leasedHome(): Promise<{
  ref: ReturnType<typeof createProfileRef>
  lease: HomeLease
}> {
  const fixture = await createIsolatedHomeFixture()
  fixtures.push(fixture)
  const home = fixture.home
  const lease = await acquireHomeLease({
    home,
    entrypoint: 'desktop',
    profile: 'desktop',
    appVersion: '0.0.0',
    probe: sameProbe(),
    guard: createInProcessGuardLock(),
  })
  return { ref: createProfileRef(home, 'desktop'), lease }
}

function sameProbe(): ProcessProbe {
  return {
    async current() {
      return { pid: process.pid, startIdentity: 'tx-probe' }
    },
    async identify(pid) {
      return { pid, startIdentity: 'tx-probe' }
    },
    async inspect() {
      return 'same' as const
    },
    async scanSupported() {
      return 'none' as const
    },
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

describe('revision transactions', () => {
  it('records before revisions, applies candidates, and commits', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    expect(plan.writes.map((write) => write.path)).toEqual([
      'package.json',
      'cordis.patch.yml',
      'pnpm-workspace.yaml',
    ])
    for (const write of plan.writes) {
      expect(write.before.exists).toBe(false)
      expect(write.beforeBytes).toBeNull()
    }
    const tx = await applyProfileTransaction(plan, lease)
    expect(tx.state).toBe('applied')
    const manifest = await readFile(path.join(ref.dir, 'package.json'), 'utf8')
    expect(() => JSON.parse(manifest)).not.toThrow()
    await commitProfileTransaction(tx.id, lease)
    const committed = await readJournal(ref.home, tx.id)
    expect(committed === 'corrupt' || committed === 'missing' ? committed : committed.state).toBe(
      'committed',
    )
    await lease.release()
  })

  it('refuses rollback and keeps user bytes when a candidate drifted', async () => {
    const { ref, lease } = await leasedHome()
    await applyFullInitial(ref, lease)
    // A second reconcile that would rewrite the manifest (wrong bundle order).
    const raw = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    raw.dsh.profile.bundles = ['@fixture/added', ...raw.dsh.profile.bundles]
    await writeFile(path.join(ref.dir, 'package.json'), `${JSON.stringify(raw, null, 2)}\n`)
    const plan = await planDesktopReconcile(ref, lease)
    expect(plan.writes.map((write) => write.path)).toEqual(['package.json'])
    const tx = await applyProfileTransaction(plan, lease)
    // The user edits the candidate before rollback.
    await writeFile(path.join(ref.dir, 'package.json'), '{"userChanged":true}\n')
    await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('conflict')
    expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8')).toBe(
      '{"userChanged":true}\n',
    )
    const conflicted = await readJournal(ref.home, tx.id)
    expect(
      conflicted === 'corrupt' || conflicted === 'missing' ? conflicted : conflicted.state,
    ).toBe('conflict')
    await lease.release()
  })

  it('restores pre-existing bytes on rollback and never touches other files', async () => {
    const { ref, lease } = await leasedHome()
    await applyFullInitial(ref, lease)
    const originalManifest = await readFile(path.join(ref.dir, 'package.json'), 'utf8')
    // User-owned patch content must survive a later manifest-only transaction.
    const userPatch = '# user layer\n- id: mine\n  name: "@fixture/mine"\n'
    await writeFile(path.join(ref.dir, 'cordis.patch.yml'), userPatch)

    const raw = JSON.parse(originalManifest)
    raw.dsh.profile.bundles = ['@fixture/another', ...raw.dsh.profile.bundles]
    const userEdited = `${JSON.stringify(raw, null, 2)}\n`
    await writeFile(path.join(ref.dir, 'package.json'), userEdited)
    const plan = await planDesktopReconcile(ref, lease)
    expect(plan.writes.map((write) => write.path)).toEqual(['package.json'])
    expect(plan.writes[0]?.before.exists).toBe(true)
    const tx = await applyProfileTransaction(plan, lease)

    await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('restored')
    // Rollback restores exactly the pre-transaction bytes — the user's own
    // edit, not the older original — and never touches other files.
    expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8')).toBe(userEdited)
    expect(await readFile(path.join(ref.dir, 'cordis.patch.yml'), 'utf8')).toBe(userPatch)
    // Rollback is idempotent and repeatable without error.
    await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('restored')
    await lease.release()
  })

  it('deletes only files this transaction created and only when they still match', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    // Simulate a crash before boot: state is applied, rollback removes the
    // freshly created files.
    await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('restored')
    for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      await expect(stat(path.join(ref.dir, filename))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await lease.release()
  })

  it('retained transactions are never rolled back by startup recovery', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    await retainProfileTransaction(tx.id, lease, {
      category: 'home-config',
      code: 'HOME_PATCH_INVALID',
    })
    const outcome = await recoverInterruptedTransactions(ref, lease)
    expect(outcome).toBe('clean')
    const retained = await readJournal(ref.home, tx.id)
    expect(retained === 'corrupt' || retained === 'missing' ? retained : retained.state).toBe(
      'retained',
    )
    await expect(stat(path.join(ref.dir, 'package.json'))).resolves.toBeTruthy()
    await lease.release()
  })

  it('an applied transaction without attribution surfaces as needs-review', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    await applyProfileTransaction(plan, lease)
    await expect(recoverInterruptedTransactions(ref, lease)).resolves.toBe('needs-review')
    // The files stay in place: no guessing that the profile was at fault.
    await expect(stat(path.join(ref.dir, 'package.json'))).resolves.toBeTruthy()
    await lease.release()
  })

  it('recovers prepared and applying journals idempotently before boot', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    // Rewind the journal to 'applying' to simulate a crash mid-application.
    const journalFile = path.join(transactionDir(ref.home, tx.id), 'transaction.json')
    const raw = JSON.parse(await readFile(journalFile, 'utf8'))
    raw.state = 'applying'
    raw.writes = raw.writes.map((write: { path: string }, index: number) => ({
      ...write,
      applied: index === 0,
    }))
    await writeFile(journalFile, `${JSON.stringify(raw, null, 2)}\n`)

    const outcome = await recoverInterruptedTransactions(ref, lease)
    expect(outcome).toBe('restored')
    for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      await expect(stat(path.join(ref.dir, filename))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    // Recovery is idempotent.
    await expect(recoverInterruptedTransactions(ref, lease)).resolves.toBe('clean')
    await lease.release()
  })

  it('keeps rolled-back journals as terminal records within retention', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('restored')
    // Terminal journals are retained for diagnosis, never deleted by recovery.
    const journal = await readJournal(ref.home, tx.id)
    expect(journal === 'corrupt' || journal === 'missing' ? journal : journal.state).toBe(
      'rolled-back',
    )
    await expect(stat(transactionDir(ref.home, tx.id))).resolves.toBeTruthy()
    await lease.release()
  })

  it('completes a crash-interrupted rollback idempotently from the rolling-back state', async () => {
    const { ref, lease } = await leasedHome()
    await applyFullInitial(ref, lease)
    const original = JSON.parse(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
    original.dsh.profile.bundles = ['@fixture/x', ...original.dsh.profile.bundles]
    const userEdited = `${JSON.stringify(original, null, 2)}\n`
    await writeFile(path.join(ref.dir, 'package.json'), userEdited)
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    // Crash right after the rolling-back journal write: phase-2 re-verification
    // must still recognize the untouched candidate and restore it.
    const journalFile = path.join(transactionDir(ref.home, tx.id), 'transaction.json')
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { state: string }
    journal.state = 'rolling-back'
    await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`)
    await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('restored')
    // The pre-transaction bytes (the user's own edit) come back byte-exact.
    expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8')).toBe(userEdited)
    await lease.release()
  })

  it('treats a journal whose recorded profile escapes the home as corrupt', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    // Tamper: point the journal's ref at a directory outside this home.
    const journalFile = path.join(transactionDir(ref.home, tx.id), 'transaction.json')
    const raw = JSON.parse(await readFile(journalFile, 'utf8')) as { ref: { dir: string } }
    raw.ref.dir = path.join(ref.home, '..', 'escaped-profile')
    await writeFile(journalFile, `${JSON.stringify(raw, null, 2)}\n`)
    expect(await readJournal(ref.home, tx.id)).toBe('corrupt')
    await expect(recoverInterruptedTransactions(ref, lease)).resolves.toBe('needs-review')
    await lease.release()
  })

  it('keeps journal snapshots private and stores only whitelisted relative paths', async () => {
    const { ref, lease } = await leasedHome()
    const plan = await planDesktopReconcile(ref, lease)
    const tx = await applyProfileTransaction(plan, lease)
    const journal = await readJournal(ref.home, tx.id)
    if (journal === 'corrupt' || journal === 'missing') throw new Error('journal unreadable')
    for (const write of journal.writes) {
      expect(['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']).toContain(write.path)
    }
    const dirIdentity = await stat(transactionDir(ref.home, tx.id))
    expect(dirIdentity.mode & 0o777).toBe(0o700)
    await lease.release()
  })
})

async function applyFullInitial(
  ref: ReturnType<typeof createProfileRef>,
  lease: HomeLease,
): Promise<void> {
  const plan = await planDesktopReconcile(ref, lease)
  const tx = await applyProfileTransaction(plan, lease)
  await commitProfileTransaction(tx.id, lease)
}
