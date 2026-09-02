import type { ProcessIdentity } from './owner.js'

/**
 * Whether a recorded process identity still refers to the very process that
 * was started with it. `same` means the operating system still reports the
 * exact start identity for that pid; `unknown` means the probe cannot tell
 * and callers must fail closed.
 */
export type ProcessStatus = 'same' | 'absent' | 'different' | 'unknown'

/** Outcome of scanning for supported launcher/CLI/Host entry executables. */
export type ProcessScanResult = 'none' | 'active' | 'unknown'

export interface ProcessProbe {
  current(): Promise<ProcessIdentity>
  identify(pid: number): Promise<ProcessIdentity>
  inspect(identity: ProcessIdentity): Promise<ProcessStatus>
  scanSupported(): Promise<ProcessScanResult>
}
