/**
 * Smoke-only startup timeline: marks the seven launcher-owned readiness
 * boundaries and emits exactly `{kind:'startup-perf-stage', stage,
 * elapsedMs}` events. The collector exists only when the `startup-perf`
 * smoke mode is admitted (never in a normal launch), the elapsed source is
 * the monotonic `performance.now()` relative to process time origin, and the
 * stage order is load-bearing: skipping, repeating, or reordering a mark is
 * a programming error that throws instead of emitting a lying timeline.
 */
import { performance } from 'node:perf_hooks'

export const STARTUP_STAGES = [
  'launcher-ready',
  'loading-visible',
  'home-admitted',
  'host-spawned',
  'host-ready',
  'surface-loaded',
  'official-ui-ready',
] as const

export type StartupStage = (typeof STARTUP_STAGES)[number]

export type StartupTimelineEvent = Readonly<{
  kind: 'startup-perf-stage'
  stage: StartupStage
  elapsedMs: number
}>

export type StartupTimeline = {
  mark(stage: StartupStage): void
}

export function createStartupTimeline(
  enabled: boolean,
  emit: (event: StartupTimelineEvent) => void,
): StartupTimeline {
  if (!enabled) {
    return { mark() {} }
  }
  let next = 0
  return {
    mark(stage) {
      const expected = STARTUP_STAGES[next]
      if (expected === undefined) {
        throw new Error(`startup timeline: no stage may repeat after ${STARTUP_STAGES[STARTUP_STAGES.length - 1]}`)
      }
      if (stage !== expected) {
        throw new Error(
          `startup timeline: expected stage ${expected} but was asked to mark ${stage} (stage ${next + 1}/${STARTUP_STAGES.length}); stages cannot be skipped or reordered`,
        )
      }
      next += 1
      emit(
        Object.freeze({
          kind: 'startup-perf-stage',
          stage,
          elapsedMs: Math.max(0, Math.trunc(performance.now())),
        }),
      )
    },
  }
}
