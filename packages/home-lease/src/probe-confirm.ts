import type { ProcessProbe, ProcessStatus } from './process-probe.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bounded retry for identity probes: 'unknown' means the helper could not
 * look the process up (transient — e.g. system under load), unlike the
 * determinate 'same'/'absent'/'different'. Retrying a handful of times with
 * a short pause turns quit-path transients into successful operations
 * without weakening the determinate refusals.
 */
export async function inspectWithRetry(
  probe: ProcessProbe,
  identity: Parameters<ProcessProbe['inspect']>[0],
  attempts = 3,
  pauseMs = 100,
): Promise<ProcessStatus> {
  let status: ProcessStatus = 'unknown'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = await probe.inspect(identity)
    if (status !== 'unknown') return status
    if (attempt < attempts - 1) await sleep(pauseMs)
  }
  return status
}

/**
 * Determinate-verdict confirmation: only 'same' is believed immediately (the
 * fail-safe direction); every other verdict — 'absent', 'different', or a
 * persistent 'unknown' — is re-read once after a pause and the second read
 * decides. A single misread of a live owner (proc_pidinfo failures under
 * load, in the worst windows surfacing as 'absent' or 'different') is
 * absorbed; a genuinely dead or replaced owner stays determinate across
 * both reads, so refusals are never weakened — declaring a live home stale
 * or removing its lock still takes two agreeing non-'same' reads.
 */
export async function inspectConfirmed(
  probe: ProcessProbe,
  identity: Parameters<ProcessProbe['inspect']>[0],
  options: Readonly<{ attempts?: number; pauseMs?: number }> = {},
): Promise<ProcessStatus> {
  const attempts = options.attempts ?? 3
  const pauseMs = options.pauseMs ?? 100
  const first = await inspectWithRetry(probe, identity, attempts, pauseMs)
  if (first === 'same') return first
  await sleep(pauseMs)
  return inspectWithRetry(probe, identity, attempts, pauseMs)
}
