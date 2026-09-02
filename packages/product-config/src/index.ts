/**
 * Read-only product identity shared by every desktop entrypoint. This package
 * intentionally has no dependencies: it must stay importable from Electron
 * Main, the bundled CLI, and tests without dragging in Electron or any DSH
 * runtime.
 */
export const PRODUCT = Object.freeze({
  name: 'DeepSeek Harness Desktop',
  appId: 'local.dsh.harness.desktop',
  binName: 'dsh-desktop',
  cliName: 'dsh-native',
  defaultProfileName: 'desktop',
  settingsNamespace: 'dsh-native-shell',
  defaultPort: 0,
  rendererPartition: 'persist:dsh-desktop-renderer',
})
