type Authorization = Readonly<{
  kind: 'dsh-native-authorized'
  argv: readonly string[]
  dshBin: string
}>

function isAuthorization(value: unknown): value is Authorization {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return (
    input.kind === 'dsh-native-authorized' &&
    Array.isArray(input.argv) &&
    input.argv.every((argument) => typeof argument === 'string') &&
    typeof input.dshBin === 'string' &&
    input.dshBin.length > 0
  )
}

const authorization = await new Promise<Authorization>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('dsh-native authorization timed out')), 120_000)
  process.once('message', (value: unknown) => {
    clearTimeout(timeout)
    if (!isAuthorization(value)) {
      reject(new Error('dsh-native authorization was invalid'))
      return
    }
    resolve(value)
  })
})

process.argv = [process.argv[0] ?? 'node', authorization.dshBin, ...authorization.argv]
await import(authorization.dshBin)
