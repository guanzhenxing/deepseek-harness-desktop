import type { HomeLease } from '@dsh-desktop/home-lease'

import type { ProfileRef } from './profile-ref.js'
import {
  readJournal,
  readdirTransactionIds,
  rollbackProfileTransaction,
  transactionDir,
} from './revision-transaction.js'
import { rm } from 'node:fs/promises'

export type RecoveryOutcome = 'clean' | 'restored' | 'conflict' | 'needs-review'

/**
 * Settle journals left behind by an interrupted startup, before any new Host
 * boot. Writes that never reached `applied` are rolled back idempotently from
 * disk facts; a journal that reached `applied` without a recorded outcome has
 * no attribution and is surfaced as needs-review instead of being guessed at.
 */
export async function recoverInterruptedTransactions(
  ref: ProfileRef,
  lease: HomeLease,
): Promise<RecoveryOutcome> {
  if (lease.home !== ref.home) {
    throw new Error('recovery requires a lease bound to the transaction home')
  }
  await lease.assertHeld()

  let sawRestored = false
  const outcome = (candidate: RecoveryOutcome): RecoveryOutcome => {
    if (candidate === 'needs-review') return 'needs-review'
    if (candidate === 'conflict') return 'conflict'
    if (candidate === 'restored') sawRestored = true
    return sawRestored ? 'restored' : 'clean'
  }

  for (const id of await readdirTransactionIds(lease.home)) {
    const journal = await readJournal(lease.home, id)
    if (journal === 'missing') continue
    if (journal === 'corrupt') return outcome('needs-review')
    if (
      journal.state === 'committed' ||
      journal.state === 'rolled-back' ||
      journal.state === 'retained' ||
      journal.state === 'conflict'
    ) {
      if (journal.state === 'conflict') return outcome('conflict')
      continue
    }
    if (journal.state === 'applied') {
      // Boot had started but no failure attribution was recorded.
      return outcome('needs-review')
    }
    // prepared / applying / rolling-back: writes never completed a boot;
    // restore idempotently. A rolled-back-by-someone-else journal is fine.
    const result = await rollbackProfileTransaction(id, lease)
    if (result === 'conflict') return outcome('conflict')
    await rm(transactionDir(lease.home, id), { recursive: true, force: true }).catch(
      () => undefined,
    )
    sawRestored = true
  }
  return sawRestored ? 'restored' : 'clean'
}
