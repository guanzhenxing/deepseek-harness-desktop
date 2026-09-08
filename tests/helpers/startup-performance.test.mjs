import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  percentile95,
  summarizeWarmRuns,
  validateStartupReport,
  validateTimeline,
} from './startup-performance.mjs'

const STAGES = [
  'launcher-ready',
  'loading-visible',
  'home-admitted',
  'host-spawned',
  'host-ready',
  'surface-loaded',
  'official-ui-ready',
]

function timeline(...elapsed) {
  return STAGES.map((stage, index) => ({
    kind: 'startup-perf-stage',
    stage,
    elapsedMs: elapsed[index] ?? index * 10,
  }))
}

test('percentile95 is nearest-rank and the largest of ten values', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]
  assert.equal(percentile95(ten), 100)
  assert.equal(percentile95([5]), 5)
})

test('validateTimeline accepts the seven ordered stages and rejects drift', () => {
  assert.equal(validateTimeline(timeline()), undefined)
  assert.equal(validateTimeline(timeline(5, 5, 6, 6, 7, 7, 8)), undefined)

  assert.throws(() => validateTimeline(timeline().slice(0, 6)), /missing/u)
  assert.throws(() => validateTimeline([...timeline().slice(0, 6), timeline()[0]]), /order/u)
  assert.throws(() => validateTimeline(timeline(10, 5, 6, 7, 8, 9, 10)), /decreas/u)
  assert.throws(
    () => validateTimeline(timeline().map((event) => ({ ...event, extra: 1 }))),
    /field/u,
  )
  assert.throws(
    () => validateTimeline(timeline().map((event) => ({ ...event, elapsedMs: 1.5 }))),
    /integer/u,
  )
})

test('summarizeWarmRuns computes adjacent stage durations and totals', () => {
  const summary = summarizeWarmRuns([
    { events: timeline(0, 10, 30, 40, 100, 110, 200) },
    { events: timeline(0, 20, 30, 50, 90, 110, 190) },
  ])
  assert.deepEqual(summary.stageMediansMs, {
    'launcher-ready': 0,
    'loading-visible': 15,
    'home-admitted': 15,
    'host-spawned': 15,
    'host-ready': 50,
    'surface-loaded': 15,
    'official-ui-ready': 85,
  })
  assert.equal(summary.totalMedianMs, 195)
  assert.equal(summary.runs, 2)
})

function reportFixture(warmCount = 10) {
  const runs = []
  for (let index = 0; index < warmCount; index += 1) {
    runs.push({ events: timeline(0, 10, 30, 40, 100, 110, 200 + index) })
  }
  return {
    schemaVersion: 1,
    candidate: {
      releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
      dmgSha256: 'b'.repeat(64),
      sourceCommit: 'a'.repeat(40),
    },
    platform: {
      osRelease: 'Darwin Kernel Version 26',
      arch: 'arm64',
      node: '24.11.1',
      electron: '44.1.0',
    },
    initialization: {
      events: timeline(0, 12, 40, 55, 140, 160, 260),
      stages: [...STAGES],
      totalMs: 260,
    },
    warm: {
      runs,
      totalMedianMs: 204.5,
      totalP95Ms: 209,
      stageMediansMs: {
        'launcher-ready': 0,
        'loading-visible': 10,
        'home-admitted': 20,
        'host-spawned': 10,
        'host-ready': 60,
        'surface-loaded': 10,
        'official-ui-ready': 94.5,
      },
      stageP95Ms: {
        'launcher-ready': 0,
        'loading-visible': 10,
        'home-admitted': 20,
        'host-spawned': 10,
        'host-ready': 60,
        'surface-loaded': 10,
        'official-ui-ready': 99,
      },
    },
  }
}

const ARTIFACT = {
  releaseId: 'm4-0.0.0-darwin-arm64-aaaaaaa',
  sha256: 'b'.repeat(64),
  platform: 'darwin',
  arch: 'arm64',
}

test('validateStartupReport accepts a consistent report', () => {
  assert.equal(validateStartupReport(reportFixture(), ARTIFACT), undefined)
})

test('validateStartupReport rejects a candidate mismatch', () => {
  const report = reportFixture()
  report.candidate.dmgSha256 = 'c'.repeat(64)
  assert.throws(() => validateStartupReport(report, ARTIFACT), /candidate/u)
})

test('validateStartupReport rejects fewer than ten warm trials', () => {
  assert.throws(() => validateStartupReport(reportFixture(9), ARTIFACT), /ten warm/u)
})

test('validateStartupReport rejects absolute paths anywhere in the report', () => {
  const report = reportFixture()
  report.platform.osRelease = '/Users/jesen'
  assert.throws(() => validateStartupReport(report, ARTIFACT), /absolute path/u)
})

test('validateStartupReport rejects a surviving lease marker', () => {
  const report = reportFixture()
  report.warm.runs[0].leaseSurvived = true
  assert.throws(() => validateStartupReport(report, ARTIFACT), /lease/u)
})

test('validateStartupReport binds sourceCommit and runtime identity', () => {
  const identity = { sourceCommit: 'a'.repeat(40), node: '24.11.1', electron: '44.1.0' }
  assert.equal(validateStartupReport(reportFixture(), ARTIFACT, identity), undefined)
  const drifted = reportFixture()
  drifted.candidate.sourceCommit = 'f'.repeat(40)
  assert.throws(() => validateStartupReport(drifted, ARTIFACT, identity), /sourceCommit/u)
  const wrongNode = reportFixture()
  wrongNode.platform.node = '99.0.0'
  assert.throws(() => validateStartupReport(wrongNode, ARTIFACT, identity), /node/u)
  const wrongElectron = reportFixture()
  wrongElectron.platform.electron = '1.2.3'
  assert.throws(() => validateStartupReport(wrongElectron, ARTIFACT, identity), /electron/u)
})

test('validateStartupReport enforces the closed schema', () => {
  const identity = { sourceCommit: 'a'.repeat(40), node: '24.11.1', electron: '44.1.0' }
  const extraTop = reportFixture()
  extraTop.notes = 'injected'
  assert.throws(() => validateStartupReport(extraTop, ARTIFACT, identity), /field/u)
  const extraStageList = reportFixture()
  extraStageList.initialization.stages = ['launcher-ready']
  assert.throws(() => validateStartupReport(extraStageList, ARTIFACT, identity), /stages/u)
  const extraRunField = reportFixture()
  extraRunField.warm.runs[0].note = 'injected'
  assert.throws(() => validateStartupReport(extraRunField, ARTIFACT, identity), /field/u)
})
