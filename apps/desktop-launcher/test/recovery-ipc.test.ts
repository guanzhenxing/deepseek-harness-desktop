import { describe, expect, it } from 'vitest'

import { RECOVERY_DOCUMENT_PATH, toIpcView, validateRecoveryIpc } from '../src/recovery-ipc.js'

const senders = new Set<number>([77])
const documentUrl = `file:///app/resources/${RECOVERY_DOCUMENT_PATH}`

function base(overrides: Record<string, unknown> = {}) {
  return {
    senderId: 77,
    frameUrl: documentUrl,
    frameIsMainFrame: true,
    expectedFrameUrl: documentUrl,
    expectedSenderIds: senders,
    inRecovery: true,
    channel: 'recovery:action',
    payload: { kind: 'recovery-action', action: 'retry' },
    ...overrides,
  }
}

describe('validateRecoveryIpc', () => {
  it('accepts the exact recovery window, main frame, channel, and schema', () => {
    expect(validateRecoveryIpc(base())).toEqual({ ok: true, action: 'retry' })
    expect(
      validateRecoveryIpc(base({ payload: { kind: 'recovery-action', action: 'quit' } })),
    ).toEqual({ ok: true, action: 'quit' })
  })

  it('rejects child frames even when they carry the exact document url', () => {
    expect(validateRecoveryIpc(base({ frameIsMainFrame: false })).ok).toBe(false)
    expect(validateRecoveryIpc(base({ frameIsMainFrame: undefined })).ok).toBe(false)
  })

  it('rejects foreign senders and non-file origins', () => {
    expect(validateRecoveryIpc(base({ senderId: 999 })).ok).toBe(false)
    expect(validateRecoveryIpc(base({ frameUrl: 'http://127.0.0.1:4000/evil.html' })).ok).toBe(
      false,
    )
    expect(validateRecoveryIpc(base({ frameUrl: undefined })).ok).toBe(false)
  })

  it('rejects when the session is not in recovery or the channel/schema drifts', () => {
    expect(validateRecoveryIpc(base({ inRecovery: false })).ok).toBe(false)
    expect(validateRecoveryIpc(base({ channel: 'recovery:action-x' })).ok).toBe(false)
    expect(validateRecoveryIpc(base({ payload: { kind: 'other', action: 'retry' } })).ok).toBe(
      false,
    )
    expect(
      validateRecoveryIpc(base({ payload: { kind: 'recovery-action', action: 'exec' } })).ok,
    ).toBe(false)
    expect(validateRecoveryIpc(base({ payload: null })).ok).toBe(false)
  })

  it('rejects navigated, query-carrying, and look-alike documents against the exact url', () => {
    expect(validateRecoveryIpc(base({ frameUrl: `${documentUrl}?x=1` })).ok).toBe(false)
    expect(validateRecoveryIpc(base({ frameUrl: `${documentUrl}#frag` })).ok).toBe(false)
    expect(validateRecoveryIpc(base({ frameUrl: 'file:///app/resources/other.html' })).ok).toBe(
      false,
    )
    // A same-named document under a different directory is not the recovery document.
    expect(
      validateRecoveryIpc(base({ frameUrl: `file:///app/elsewhere/${RECOVERY_DOCUMENT_PATH}` })).ok,
    ).toBe(false)
  })
})

describe('toIpcView', () => {
  it('serializes the sanitized failure view', () => {
    const view = toIpcView({
      failure: {
        stage: 'boot',
        code: 'BOOT_FAILED',
        category: 'runtime',
        summary: 'boom',
        retryable: true,
      },
      retryAllowed: true,
      safeModeAllowed: false,
      doctorCommand: null,
    })
    expect(view.kind).toBe('recovery-view')
    expect(view.failure.summary).toBe('boom')
    expect(view.doctorCommand).toBeNull()
  })
})
