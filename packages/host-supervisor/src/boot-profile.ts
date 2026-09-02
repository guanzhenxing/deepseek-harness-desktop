/**
 * Boot mode selection shared by the runner and bootstrap validation. Safe
 * mode boots only the fixed first-party recovery bundle set on the
 * desktop-safe-mode profile and never falls back to normal-profile paths.
 */
export type BootMode = 'normal' | 'safe'

export const SAFE_MODE_PROFILE = 'desktop-safe-mode'

export function assertBootProfile(input: {
  mode: BootMode
  profileName: string
}): { ok: true } | { ok: false; reason: string } {
  if (input.mode === 'safe') {
    if (input.profileName !== SAFE_MODE_PROFILE) {
      return { ok: false, reason: 'safe mode requires the desktop-safe-mode profile' }
    }
    return { ok: true }
  }
  if (input.profileName === SAFE_MODE_PROFILE) {
    return { ok: false, reason: 'normal mode must not boot the safe-mode profile' }
  }
  return { ok: true }
}
