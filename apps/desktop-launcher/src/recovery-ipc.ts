import type { StartupFailure } from '@dsh-desktop/shell-core'

export type RecoveryActionName = 'retry' | 'safe-mode' | 'quit'

export type RecoveryIpcView = Readonly<{
  kind: 'recovery-view'
  failure: Readonly<{
    stage: string
    code: string
    category: string
    summary: string
    retryable: boolean
  }>
  retryAllowed: boolean
  safeModeAllowed: boolean
  doctorCommand: string | null
}>

export const RECOVERY_DOCUMENT_PATH = 'recovery-view.html'

/**
 * Pure sender validation for the privileged recovery IPC. Only the exact
 * recovery window's main frame, at the fixed document path, with the fixed
 * schema, while the session is in recovery, may pass.
 */
export function validateRecoveryIpc(
  input: Readonly<{
    senderId: number | undefined
    frameUrl: string | undefined
    expectedSenderIds: ReadonlySet<number>
    inRecovery: boolean
    channel: string
    payload: unknown
  }>,
): { ok: true; action: RecoveryActionName } | { ok: false; reason: string } {
  if (!input.inRecovery) return { ok: false, reason: 'session is not in recovery' }
  if (input.senderId === undefined || !input.expectedSenderIds.has(input.senderId)) {
    return { ok: false, reason: 'sender is not the recovery window' }
  }
  if (input.channel !== 'recovery:action') {
    return { ok: false, reason: `unknown channel ${JSON.stringify(input.channel)}` }
  }
  if (input.frameUrl === undefined) return { ok: false, reason: 'missing frame url' }
  let parsed: URL
  try {
    parsed = new URL(input.frameUrl)
  } catch {
    return { ok: false, reason: 'invalid frame url' }
  }
  if (parsed.protocol !== 'file:') return { ok: false, reason: 'non-file frame' }
  const expectedSuffix = `/${RECOVERY_DOCUMENT_PATH}`
  if (!parsed.pathname.endsWith(expectedSuffix)) {
    return { ok: false, reason: 'unexpected document path' }
  }
  if (parsed.hash !== '' || parsed.search !== '') {
    return { ok: false, reason: 'unexpected query or fragment' }
  }
  if (typeof input.payload !== 'object' || input.payload === null) {
    return { ok: false, reason: 'payload must be an object' }
  }
  const record = input.payload as Record<string, unknown>
  if (record.kind !== 'recovery-action') return { ok: false, reason: 'wrong payload kind' }
  if (record.action !== 'retry' && record.action !== 'safe-mode' && record.action !== 'quit') {
    return { ok: false, reason: 'unknown action' }
  }
  return { ok: true, action: record.action }
}

export function toIpcView(view: {
  failure: StartupFailure
  retryAllowed: boolean
  safeModeAllowed: boolean
  doctorCommand: string | null
}): RecoveryIpcView {
  return Object.freeze({
    kind: 'recovery-view',
    failure: Object.freeze({
      stage: view.failure.stage,
      code: view.failure.code,
      category: view.failure.category,
      summary: view.failure.summary,
      retryable: view.failure.retryable,
    }),
    retryAllowed: view.retryAllowed,
    safeModeAllowed: view.safeModeAllowed,
    doctorCommand: view.doctorCommand,
  })
}
