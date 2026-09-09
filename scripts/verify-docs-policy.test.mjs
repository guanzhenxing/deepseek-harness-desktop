import assert from 'node:assert/strict'
import test from 'node:test'

import { findRetiredStageReferences } from './verify-docs-policy.mjs'

test('findRetiredStageReferences reports retired stage labels with line numbers', () => {
  const contents = [
    '# Current project',
    'The isolated path still uses m0-dsh-home.',
    'An old artifact was named M3-candidate.',
    'The supported architecture is arm64.',
  ].join('\n')

  assert.deepEqual(findRetiredStageReferences(contents), [
    { line: 2, value: 'm0' },
    { line: 3, value: 'M3' },
  ])
})

test('findRetiredStageReferences accepts release versions and ordinary prose', () => {
  const contents = 'Release v0.1.0 supports darwin-arm64 and protocol version 1.0.'

  assert.deepEqual(findRetiredStageReferences(contents), [])
})

test('findRetiredStageReferences accepts Apple chip and playlist names', () => {
  const contents = 'Apple M3 Pro is supported. M3U and M3U8 playlists are unrelated.'

  assert.deepEqual(findRetiredStageReferences(contents), [])
})

test('findRetiredStageReferences does not hide planning labels after Apple', () => {
  const contents = 'Remove Apple M3-candidate and Apple M3 milestone references.'

  assert.deepEqual(findRetiredStageReferences(contents), [
    { line: 1, value: 'M3' },
    { line: 1, value: 'M3' },
  ])
})

test('findRetiredStageReferences catches a stage label embedded before a hyphen', () => {
  const contents = 'Remove the fooM3-candidate artifact name.'

  assert.deepEqual(findRetiredStageReferences(contents), [{ line: 1, value: 'M3' }])
})
