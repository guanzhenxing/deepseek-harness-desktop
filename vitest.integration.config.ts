import { mergeConfig } from 'vitest/config'

import base from './vitest.config.js'

export default mergeConfig(base, {
  test: {
    include: ['packages/*/test/**/*.integration.test.ts', 'apps/*/test/**/*.integration.test.ts'],
    testTimeout: 60_000,
  },
})
