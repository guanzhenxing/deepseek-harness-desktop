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
