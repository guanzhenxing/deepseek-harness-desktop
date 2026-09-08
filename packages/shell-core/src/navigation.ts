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

/**
 * Loopback hostnames that must never be handed to the system browser.
 *
 * Browsers connect several non-obvious spellings to the local surface —
 * `0.0.0.0`, IPv4 shorthand (`127.1`), integer forms (`2130706433`,
 * `0x7f000001`, `0177.0.0.1`), trailing dots, and IPv4-mapped/compatible
 * IPv6 (`::ffff:127.0.0.1`) — so the check normalizes through the WHATWG
 * URL parser (verified against Node's implementation) instead of comparing
 * literal strings.
 */
export function isLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase()
  // The URL parser keeps a host trailing dot; strip it for classification.
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  // Bare IPv6 text (no brackets) gets them from the URL parser.
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  try {
    host = new URL(`http://${host}/`).hostname
  } catch {
    return false
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    if (host === '[::1]') return true
    // IPv4-mapped/compatible v6 normalizes to hex groups; the whole address
    // must be zeros before the final two groups for the tail to be an
    // embedded IPv4 address (e.g. [::ffff:7f00:1] = 127.0.0.1).
    const groups = host.slice(1, -1).split(':')
    if (groups.length < 2) return false
    const tail: number[] = []
    for (const group of groups) {
      // The :: compression yields empty groups; they stand for zeros.
      if (group === '') {
        tail.push(0)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/u.test(group)) return false
      tail.push(Number.parseInt(group, 16))
    }
    // The embedded IPv4 is the final 32 bits; the prefix must be exactly
    // ::/96 (IPv4-compatible) or ::ffff:0:0/96 (IPv4-mapped) for the tail to
    // be one — anything else is a different address with similar glyphs.
    const prefix = tail.slice(0, -2)
    const mapped = prefix.at(-1) === 0xffff
    const zeros = (mapped ? prefix.slice(0, -1) : prefix).every((value) => value === 0)
    if (!zeros) return false
    const embedded = ((tail.at(-2) ?? 0) * 0x10000 + (tail.at(-1) ?? 0)) >>> 0
    return embedded === 0 || embedded >>> 24 === 127
  }
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^[0-9]{1,3}$/u.test(part) ? Number(part) : -1))
  if (octets.some((value) => value < 0 || value > 255)) return false
  return octets[0] === 127 || octets.every((value) => value === 0)
}
