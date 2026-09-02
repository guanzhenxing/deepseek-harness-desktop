import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@dsh-desktop/desktop-contracts/host-control': path.join(
        root,
        'packages/desktop-contracts/src/host-control.ts',
      ),
      '@dsh-desktop/profile-manager': path.join(root, 'packages/profile-manager/src/index.ts'),
      '@dsh-desktop/desktop-plugin': path.join(root, 'packages/desktop-plugin/src/index.ts'),
      '@dsh-desktop/home-lease': path.join(root, 'packages/home-lease/src/index.ts'),
      '@dsh-desktop/host-supervisor': path.join(root, 'packages/host-supervisor/src/index.ts'),
      '@dsh-desktop/product-config': path.join(root, 'packages/product-config/src/index.ts'),
      '@dsh-desktop/shell-core': path.join(root, 'packages/shell-core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.integration.test.ts', 'apps/*/test/**/*.integration.test.ts'],
    testTimeout: 60_000,
  },
})
