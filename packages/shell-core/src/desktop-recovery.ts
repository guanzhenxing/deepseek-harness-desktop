import {
  commitProfileTransaction,
  createProfileRef,
  findAppliedTransaction,
  prepareSafeProfile,
  ProfileReconcileError,
  reconcileDesktopProfile,
  recoverInterruptedTransactions,
  retainProfileTransaction,
  rollbackProfileTransaction,
  SAFE_PROFILE_NAME,
} from '@dsh-desktop/profile-manager'

import {
  StartupFailureError,
  type ProfilePrepareResult,
  type ProfileRecoveryPort,
} from './recovery-controller.js'
import { toStartupFailure } from './failure-policy.js'
import { quarantineProjectionCache } from './projection-cache.js'

export type DesktopRecoveryOptions = Readonly<{
  home: string
  profileName: string
  cacheThresholdBytes?: number
}>

/**
 * The production profile-recovery port: settle interrupted journals from
 * previous runs, quarantine an oversized rebuildable cache, apply the
 * journaled reconcile, and settle the transaction on the session's verdict.
 * Every recovery write requires the live whole-home lease.
 */
export function createDesktopProfileRecovery(options: DesktopRecoveryOptions): ProfileRecoveryPort {
  const home = options.home
  const profileName = options.profileName
  const normalRef = createProfileRef(home, profileName)
  const safeRef = createProfileRef(home, SAFE_PROFILE_NAME)
  const thresholdBytes = options.cacheThresholdBytes ?? 512 * 1024 * 1024
  return {
    async prepare(lease) {
      let recovery: Awaited<ReturnType<typeof recoverInterruptedTransactions>>
      try {
        recovery = await recoverInterruptedTransactions(normalRef, lease)
      } catch (error) {
        throw new StartupFailureError(
          toStartupFailure({
            stage: 'recover-transactions',
            code: 'RECOVERY_SCAN_FAILED',
            summary: error instanceof Error ? error.message : String(error),
            retryable: true,
            home,
          }),
        )
      }
      if (recovery === 'conflict') {
        return {
          kind: 'blocked',
          failure: toStartupFailure({
            stage: 'recover-transactions',
            code: 'RECOVERY_CONFLICT',
            summary:
              'a previous profile recovery found diverged files; the profile was left untouched — run dsh-native doctor',
            retryable: true,
            home,
          }),
        }
      }
      const cache = await quarantineProjectionCache({ home, lease, thresholdBytes })
      if (cache.kind === 'unknown-layout') {
        console.error('projection cache layout unrecognized; leaving it untouched')
      }
      // A journal that reached `applied` without attribution is only adopted
      // when every managed file still matches the recorded candidate — the
      // boot that follows settles it on evidence, never on a guess.
      let adopted: string | undefined
      if (recovery === 'needs-review') {
        const applied = await findAppliedTransaction(normalRef)
        if (applied === undefined || !applied.atCandidate) {
          return {
            kind: 'blocked',
            failure: toStartupFailure({
              stage: 'recover-transactions',
              code: 'TRANSACTION_NEEDS_REVIEW',
              summary:
                'a previous startup left the profile mid-transaction without failure attribution; the profile was left untouched — run dsh-native doctor',
              retryable: true,
              home,
            }),
          }
        }
        adopted = applied.id
      }
      let result: Awaited<ReturnType<typeof reconcileDesktopProfile>>
      try {
        result = await reconcileDesktopProfile(normalRef, lease)
      } catch (error) {
        const phase = error instanceof ProfileReconcileError ? error.phase : 'apply'
        throw new StartupFailureError(
          toStartupFailure({
            stage: phase === 'plan' ? 'resolve-profile' : 'reconcile-profile',
            code: phase === 'plan' ? 'PROFILE_INVALID' : 'RECONCILE_FAILED',
            summary: error instanceof Error ? error.message : String(error),
            retryable: false,
            home,
          }),
        )
      }
      const transactionId = result.transactionId ?? adopted
      const ready: ProfilePrepareResult = {
        kind: 'ready',
        changed: result.changed || adopted !== undefined,
        ...(transactionId === undefined ? {} : { transactionId }),
      }
      return ready
    },
    async settleCommitted(transactionId, lease) {
      await commitProfileTransaction(transactionId, lease)
    },
    async rollback(transactionId, lease) {
      return rollbackProfileTransaction(transactionId, lease)
    },
    async retain(transactionId, lease, failure) {
      await retainProfileTransaction(transactionId, lease, failure)
    },
    async enterSafeMode(lease) {
      // Prepare first: a conflicting safe profile must leave the lease (and
      // the normal profile) exactly as it was.
      const prepared = await prepareSafeProfile(safeRef, lease)
      if (prepared === 'conflict') return 'conflict'
      await lease.switchProfile(SAFE_PROFILE_NAME)
      return 'prepared'
    },
    async exitSafeMode(lease) {
      await lease.switchProfile(profileName)
    },
  }
}
