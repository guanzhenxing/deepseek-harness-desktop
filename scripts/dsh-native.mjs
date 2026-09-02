#!/usr/bin/env node
import { runBundledCli } from '../apps/bundled-cli/lib/index.js'

const code = await runBundledCli(process.argv.slice(2))
process.exit(code)
