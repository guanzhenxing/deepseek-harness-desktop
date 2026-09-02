import {
  createNativeProcessProbe,
  unlockHome,
  type GuardLock,
  type ProcessProbe,
} from '@dsh-desktop/home-lease'

import { resolveCliRuntime } from './runtime-paths.js'

export type RunDoctorUnlockInput = Readonly<{
  home: string
  probe?: ProcessProbe
  guard?: GuardLock
  stderr?: NodeJS.WritableStream
}>

function doctorProbe(): ProcessProbe {
  const runtime = resolveCliRuntime(process.env)
  return createNativeProcessProbe({
    helperPath: runtime.leaseHelper,
    entryExecutables: runtime.desktopEntryExecutables,
    scanArgvNeedles: runtime.scanArgvNeedles,
    excludePids: [process.pid],
  })
}

/**
 * Execute the user's explicit `doctor --unlock` request. Refusals explain
 * why and never offer a force escape hatch.
 */
export async function runDoctorUnlock(input: RunDoctorUnlockInput): Promise<number> {
  const stderr = input.stderr ?? process.stderr
  const result = await unlockHome({
    home: input.home,
    probe: input.probe ?? doctorProbe(),
    ...(input.guard === undefined ? {} : { guard: input.guard }),
  })
  if (result.status === 'refused') {
    stderr.write(`dsh-native: refused to unlock (${result.code}): ${result.detail}\n`)
    stderr.write(
      'dsh-native: doctor never force-unlocks; fully exit the running entrypoint first\n',
    )
    return 2
  }
  stderr.write(`dsh-native: ${result.status}: ${result.detail ?? 'home lock state'}\n`)
  return 0
}
