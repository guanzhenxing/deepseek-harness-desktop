/**
 * Launcher-side classification of startup failures. The Host keeps its
 * `fatal.stage/code/retryable` facts; this model never guesses a responsible
 * plugin from message words — attribution that the capture site cannot make
 * stays `unknown`.
 */
export type FailureCategory =
  | 'lease'
  | 'profile-write'
  | 'profile-composition'
  | 'home-config'
  | 'credentials'
  | 'network'
  | 'runtime'
  | 'renderer'
  | 'native-ui'
  | 'unknown'

export type StartupFailure = Readonly<{
  stage: string
  code: string
  category: FailureCategory
  summary: string
  retryable: boolean
}>

// Stage names are the ones the capture sites actually emit: host-runner
// stages (`resolve-runtime`, `resolve-profile`, `load-home-patch`, `boot`,
// `publish-surface`, `host-control`) plus the launcher-side
// `reconcile-profile` (profile-manager apply under lease). `recover-transactions`
// and other recovery-orchestration stages stay deliberately unmapped: their
// failures must never justify automatic profile rollback.
const STAGE_CATEGORIES: Readonly<Record<string, FailureCategory>> = {
  lease: 'lease',
  'reconcile-profile': 'profile-write',
  'resolve-profile': 'profile-composition',
  'load-home-patch': 'home-config',
  'resolve-runtime': 'runtime',
  'publish-surface': 'renderer',
  'host-control': 'runtime',
  'cache-quarantine': 'runtime',
}

/** Codes inside the Host's broad `boot` stage that carry a real attribution. */
const BOOT_CODE_CATEGORIES: Readonly<Record<string, FailureCategory>> = {
  MISSING_CREDENTIAL: 'credentials',
  PORT_IN_USE: 'network',
}

export function categorizeFailure(
  input: Readonly<{ stage: string; code: string }>,
): FailureCategory {
  const byStage = STAGE_CATEGORIES[input.stage]
  if (byStage !== undefined) return byStage
  if (input.stage === 'boot') {
    return BOOT_CODE_CATEGORIES[input.code] ?? 'unknown'
  }
  return 'unknown'
}

const SUMMARY_LIMIT = 1_024
// eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000e-\u001f\u007f]/gu
// token=... / token="..." / Bearer / api-key / password shapes; a missing
// match only leaves the summary less redacted, never crashes.
const SECRET_PATTERNS: RegExp[] = [
  /token=[^\s&"']+/giu,
  /token="[^"]*"/giu,
  /token='[^']*'/giu,
  /\bbearer\s+[a-z0-9._~+/=-]+/giu,
  /(?:api-?key|password|secret)=[^\s&"']+/giu,
]
const HOME_HINT = 'the configured DSH home'

function sanitizeSummary(summary: string, home: string | undefined): string {
  let text = summary.slice(0, 4_096)
  if (home !== undefined && home.length > 0) {
    text = text.split(home).join(HOME_HINT)
  }
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => `${match.split(/[=':\s]/u)[0]}=<redacted>`)
  }
  text = text.replace(CONTROL_CHARACTERS, ' ')
  text = text.trim()
  if (text.length > SUMMARY_LIMIT) text = `${text.slice(0, SUMMARY_LIMIT - 1)}…`
  return text
}

const CREDENTIAL_GUIDANCE =
  'credential is missing; configure it through the official DSH settings — the desktop never creates or copies credentials'

export function toStartupFailure(input: {
  stage: string
  code: string
  summary: string
  retryable: boolean
  home?: string | undefined
}): StartupFailure {
  const category = categorizeFailure(input)
  let summary = sanitizeSummary(input.summary, input.home)
  if (summary === '') summary = `${input.stage} failed (${input.code})`
  if (category === 'credentials') {
    // The guidance is part of the rendered summary, so it shares the length
    // budget: truncate the payload, never the guidance, never the cap.
    const room = SUMMARY_LIMIT - CREDENTIAL_GUIDANCE.length - 1
    summary = `${summary.slice(0, Math.max(0, room))}\n${CREDENTIAL_GUIDANCE}`
    summary = summary.slice(0, SUMMARY_LIMIT)
  }
  return Object.freeze({
    stage: input.stage,
    code: input.code,
    category,
    summary,
    retryable: input.retryable,
  })
}

/**
 * Automatic profile rollback is only justified when the shell never became
 * healthy, the profile actually changed in this attempt, and the failure is
 * attributable to what we wrote into the profile. Everything else — lease,
 * ports, home YAML, credentials, packaged runtime, native UI, unknown — must
 * keep user data exactly as it is.
 */
export function shouldRollbackProfile(
  input: Readonly<{
    failure: StartupFailure
    changed: boolean
    healthy: boolean
  }>,
): boolean {
  if (input.healthy || !input.changed) return false
  return (
    input.failure.category === 'profile-write' || input.failure.category === 'profile-composition'
  )
}
