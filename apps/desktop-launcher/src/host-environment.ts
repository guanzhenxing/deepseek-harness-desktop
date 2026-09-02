const blockedNames = new Set(['DSH_HOME', 'NODE_OPTIONS', 'NODE_PATH'])

export function sanitizeHostEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !blockedNames.has(entry[0]) &&
        !entry[0].startsWith('DSH_DESKTOP_') &&
        !entry[0].startsWith('ELECTRON_'),
    ),
  )
}
