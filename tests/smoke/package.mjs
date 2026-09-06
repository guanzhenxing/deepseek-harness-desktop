// Thin entry for smoke:package: the acceptance runtime is pinned BEFORE any
// heavy module (Electron binary resolution, app/CLI drivers) is imported on
// a clean snapshot — static imports would do real work before the refusal.
import { assertAcceptanceRuntime } from '../helpers/acceptance-runtime.mjs'

assertAcceptanceRuntime('smoke:package')

await import('./package-main.mjs')
