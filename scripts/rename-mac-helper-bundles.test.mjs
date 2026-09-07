import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { renameMacHelperBundles } from './rename-mac-helper-bundles.mjs'

const FROM = 'DeepSeek Harness Desktop'
const TO = 'DeepSeek Harness'
const PLIST_TOOL = '/usr/bin/plutil'

function makeHelperBundle(searchPath, bundleName) {
  const bundle = path.join(searchPath, `${bundleName}.app`)
  mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(bundle, 'Contents', 'MacOS', bundleName), '#!/bin/sh\n')
  writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleName</key>',
      '  <string>Electron Helper</string>',
      '  <key>CFBundleDisplayName</key>',
      `  <string>${bundleName}</string>`,
      '  <key>CFBundleExecutable</key>',
      `  <string>${bundleName}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  )
  return bundle
}

function plistValue(plistPath, key) {
  const printed = execFileSync(PLIST_TOOL, ['-p', plistPath], { encoding: 'utf8' })
  const match = printed.match(new RegExp(`"${key}" => "(.*)"$`, 'm'))
  assert.ok(match !== null, `${plistPath} should contain ${key}`)
  return match[1]
}

test('renames helper bundles, executables and plist identities, keeping variant suffixes', () => {
  const contents = mkdtempSync(path.join(tmpdir(), 'dsh-helper-rename-'))
  const frameworks = path.join(contents, 'Frameworks')
  mkdirSync(frameworks)
  for (const variant of ['Helper', 'Helper (Renderer)', 'Helper (GPU)', 'Helper (Plugin)']) {
    makeHelperBundle(frameworks, `${FROM} ${variant}`)
  }
  makeHelperBundle(frameworks, 'Electron Helper')
  mkdirSync(path.join(frameworks, 'Electron Framework.framework'))

  const renamed = renameMacHelperBundles({ appContentsPath: contents, fromName: FROM, toName: TO })

  assert.deepEqual(renamed.map((rename) => rename.to).sort(), [
    'DeepSeek Harness Helper (GPU).app',
    'DeepSeek Harness Helper (Plugin).app',
    'DeepSeek Harness Helper (Renderer).app',
    'DeepSeek Harness Helper.app',
  ])
  const entries = readdirSync(frameworks).sort()
  assert.ok(entries.includes('DeepSeek Harness Helper.app'))
  assert.ok(entries.includes('DeepSeek Harness Helper (Renderer).app'))
  assert.ok(!entries.some((entry) => entry.startsWith(FROM)))
  assert.ok(entries.includes('Electron Helper.app'))
  assert.ok(entries.includes('Electron Framework.framework'))

  const rendererPlist = path.join(
    frameworks,
    'DeepSeek Harness Helper (Renderer).app',
    'Contents',
    'Info.plist',
  )
  assert.equal(
    plistValue(rendererPlist, 'CFBundleExecutable'),
    'DeepSeek Harness Helper (Renderer)',
  )
  assert.equal(
    plistValue(rendererPlist, 'CFBundleDisplayName'),
    'DeepSeek Harness Helper (Renderer)',
  )
  const mainHelperExecutables = readdirSync(
    path.join(frameworks, 'DeepSeek Harness Helper.app', 'Contents', 'MacOS'),
  )
  assert.deepEqual(mainHelperExecutables, ['DeepSeek Harness Helper'])
})

test('is a no-op when no bundle matches the old name', () => {
  const contents = mkdtempSync(path.join(tmpdir(), 'dsh-helper-rename-'))
  const frameworks = path.join(contents, 'Frameworks')
  mkdirSync(frameworks)
  makeHelperBundle(frameworks, `${TO} Helper`)

  const renamed = renameMacHelperBundles({ appContentsPath: contents, fromName: FROM, toName: TO })

  assert.deepEqual(renamed, [])
  assert.deepEqual(readdirSync(frameworks), ['DeepSeek Harness Helper.app'])
})

test('renames login-item helpers when the LoginItems directory exists', () => {
  const contents = mkdtempSync(path.join(tmpdir(), 'dsh-helper-rename-'))
  const loginItems = path.join(contents, 'Library', 'LoginItems')
  mkdirSync(loginItems, { recursive: true })
  makeHelperBundle(loginItems, `${FROM} Login Helper`)

  const renamed = renameMacHelperBundles({ appContentsPath: contents, fromName: FROM, toName: TO })

  assert.deepEqual(
    renamed.map((rename) => rename.to),
    ['DeepSeek Harness Login Helper.app'],
  )
  assert.deepEqual(readdirSync(loginItems), ['DeepSeek Harness Login Helper.app'])
})
