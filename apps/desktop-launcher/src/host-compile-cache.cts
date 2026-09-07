// Loaded via --require before the Host's module graph starts compiling
// (CommonJS on purpose: a --require preload must be). The upstream runtime's
// cold boot spends most of its wall time re-reading and re-compiling its
// large module graph; Node's on-disk compile cache makes every boot after
// the first skip that work. The cache directory is provided by the launcher
// (per-application userData); an absent or older runtime simply boots
// uncached.
'use strict'
try {
  const directory: string | undefined = process.env.DSH_HOST_COMPILE_CACHE
  const nodeModule = require('node:module') as {
    enableCompileCache?: (directory?: string) => unknown
  }
  nodeModule.enableCompileCache?.(directory === undefined || directory === '' ? undefined : directory)
} catch {
  /* uncached boot is always safe */
}
