import { requireReport, runLauncherSmoke } from './assert-cleanup.mjs'

const reports = await runLauncherSmoke('ui')
const ready = requireReport(reports, 'ui-ready')
if (!Number.isSafeInteger(ready.launcherPid) || !Number.isSafeInteger(ready.hostPid)) {
  throw new Error('ui-ready did not contain valid launcher and Host PIDs')
}
if (ready.launcherPid === ready.hostPid) {
  throw new Error('DSH Host did not run in an independent process')
}
console.log('M0 DSH UI smoke passed')
