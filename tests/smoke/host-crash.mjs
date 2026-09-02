import { requireReport, runLauncherSmoke } from './assert-cleanup.mjs'

const reports = await runLauncherSmoke('host-crash')
const ready = requireReport(reports, 'ui-ready')
const recovery = requireReport(reports, 'host-crash-recovery')
if (!Number.isSafeInteger(ready.launcherPid) || !Number.isSafeInteger(ready.hostPid)) {
  throw new Error('ui-ready did not contain valid launcher and Host PIDs')
}
if (ready.launcherPid === ready.hostPid) {
  throw new Error('DSH Host did not run in an independent process')
}
if (recovery.launcherPid !== ready.launcherPid) {
  throw new Error('launcher identity changed while recovering from the Host crash')
}
console.log('M0 Host-crash smoke passed')
