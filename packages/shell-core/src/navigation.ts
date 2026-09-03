export function isAllowedMainFrameNavigation(origin: string, target: string): boolean {
  try {
    const allowed = new URL(origin)
    const candidate = new URL(target)
    if (allowed.protocol !== 'http:' && allowed.protocol !== 'https:') return false
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return false
    if (candidate.username !== '' || candidate.password !== '') return false
    return candidate.origin === allowed.origin
  } catch {
    return false
  }
}

/** Loopback hostnames that must never be handed to the system browser. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  )
}
