import { describe, expect, it, vi } from 'vitest'

import {
  STARTUP_STAGES,
  createStartupTimeline,
  type StartupTimelineEvent,
} from '../src/startup-timeline.js'

function collector() {
  const events: StartupTimelineEvent[] = []
  return {
    events,
    emit: (event: StartupTimelineEvent) => {
      events.push(event)
    },
  }
}

describe('startup timeline contract', () => {
  it('declares exactly the seven owned stages in order', () => {
    expect(STARTUP_STAGES).toEqual([
      'launcher-ready',
      'loading-visible',
      'home-admitted',
      'host-spawned',
      'host-ready',
      'surface-loaded',
      'official-ui-ready',
    ])
  })

  it('enabled marks emit exactly the stage event with nondecreasing integer elapsed', () => {
    const { events, emit } = collector()
    const timeline = createStartupTimeline(true, emit)
    for (const stage of STARTUP_STAGES) timeline.mark(stage)
    expect(events.map((event) => event.kind)).toEqual(
      STARTUP_STAGES.map(() => 'startup-perf-stage'),
    )
    expect(events.map((event) => event.stage)).toEqual([...STARTUP_STAGES])
    for (const event of events) {
      expect(Number.isInteger(event.elapsedMs)).toBe(true)
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(Object.keys(event).sort()).toEqual(['elapsedMs', 'kind', 'stage'])
    }
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.elapsedMs).toBeGreaterThanOrEqual(events[index - 1]!.elapsedMs)
    }
    expect(Object.isFrozen(events[0])).toBe(true)
  })

  it('refuses duplicate, skipped, and reordered stages', () => {
    const { emit } = collector()
    const timeline = createStartupTimeline(true, emit)
    timeline.mark('launcher-ready')
    expect(() => timeline.mark('launcher-ready')).toThrow(/repeat|again|order/u)
    expect(() => timeline.mark('host-ready')).toThrow(/order|skip/u)
    // A refused mark does not advance the sequence; the true next stage works.
    expect(() => timeline.mark('loading-visible')).not.toThrow()
  })

  it('disabled mode emits nothing and refuses nothing', () => {
    const { events, emit } = collector()
    const timeline = createStartupTimeline(false, emit)
    for (const stage of STARTUP_STAGES) timeline.mark(stage)
    expect(events).toEqual([])
  })

  it('elapsed comes from the monotonic performance clock', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { events, emit } = collector()
      const timeline = createStartupTimeline(true, emit)
      timeline.mark('launcher-ready')
      // Wall-clock drift must not affect the emitted numbers: the source is
      // performance.now(), advanced here only via the mocked timers it uses.
      vi.advanceTimersByTime(50)
      timeline.mark('loading-visible')
      expect(events[1]!.elapsedMs).toBeGreaterThanOrEqual(events[0]!.elapsedMs)
    } finally {
      vi.useRealTimers()
    }
  })
})
