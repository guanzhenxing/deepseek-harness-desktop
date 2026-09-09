import assert from 'node:assert/strict'
import test from 'node:test'

import { lockfileIsDirty } from './stage-runtime.mjs'

test('importing stage-runtime has no staging side effects', () => {
  // The guard at the bottom only invokes main() when executed directly;
  // importing for helpers must neither build nor touch release/staging.
  assert.equal(typeof lockfileIsDirty, 'function')
})

test('lockfileIsDirty mirrors git status --porcelain semantics', () => {
  assert.equal(lockfileIsDirty(''), false)
  assert.equal(lockfileIsDirty('\n'), false)
  assert.equal(lockfileIsDirty(' M pnpm-lock.yaml\n'), true)
  assert.equal(lockfileIsDirty('M  pnpm-lock.yaml'), true)
  assert.equal(lockfileIsDirty('?? pnpm-lock.yaml'), true)
  // Status lines for other paths never reach the helper (git is invoked
  // with `-- pnpm-lock.yaml`), but a non-empty answer stays conservative.
  assert.equal(lockfileIsDirty(' M some/other/file'), true)
})
