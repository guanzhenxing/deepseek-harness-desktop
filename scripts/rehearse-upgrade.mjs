#!/usr/bin/env node
// CLI wrapper for the upgrade rehearsal. Both artifact indexes are explicit
// arguments — the rehearsal never guesses "the latest DMG" and never touches
// a real home.
//
//   pnpm rehearse:upgrade -- \
//     --previous release/previous/artifacts.json \
//     --candidate release/candidate/artifacts.json
import process from 'node:process'

import { assertAcceptanceRuntime } from '../tests/helpers/acceptance-runtime.mjs'
import { emergencyCleanup } from '../tests/helpers/installed-app.mjs'
import { runUpgradeRehearsal } from '../tests/upgrade/rehearsal.mjs'

assertAcceptanceRuntime('rehearse:upgrade')

// An interrupted rehearsal (Ctrl-C, CI cancel) must never leave installed-app
// process groups, temp install trees, or DMG mounts behind: leftovers raise
// system load and surface as unrelated probe flakiness in the NEXT run.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void emergencyCleanup().finally(() => process.exit(130))
  })
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const previousIndexPath = argumentValue('--previous')
const candidateIndexPath = argumentValue('--candidate')

if (previousIndexPath === undefined || candidateIndexPath === undefined) {
  console.error(
    'Usage: rehearse:upgrade -- --previous <artifacts.json> --candidate <artifacts.json>',
  )
  process.exit(2)
}

const { results, failed } = await runUpgradeRehearsal({
  previousIndexPath,
  candidateIndexPath,
})
if (failed.length > 0) {
  console.error(`UPGRADE-REHEARSAL failed (${failed.length}/${results.length})`)
  process.exit(1)
}
console.log(`UPGRADE-REHEARSAL passed (${results.length}/${results.length} steps)`)
