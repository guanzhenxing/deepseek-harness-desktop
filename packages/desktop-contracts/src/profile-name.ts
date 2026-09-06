/**
 * The shared profile-name contract. `<home>/profiles/` reserves the runtime
 * launch-root namespace (`.dsh-desktop-run-*`, mkdtemp-created by
 * host-supervisor's runtime-root): the compatibility preflight exempts REAL
 * launch-root directories from classification, so a user profile taking a
 * reserved name would bypass format admission entirely. Every entrypoint
 * that can create a profile directory — the profile manager AND the home
 * lease (whose profile gates the bundled CLI, including the no-profile
 * passthrough) — must enforce this rule, which is why it lives here.
 */
export const RESERVED_PROFILE_NAME_PREFIX = '.dsh-desktop-run-'

export function isReservedProfileName(name: string): boolean {
  return name.startsWith(RESERVED_PROFILE_NAME_PREFIX)
}
