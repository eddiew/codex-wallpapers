#!/usr/bin/env node
// Builds "Codex Wallpapers.app": an independent, locally patched copy of the
// official Codex desktop app with a wallpaper layer. The official app is only
// read, never modified.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsarArchive } from '../lib/asar.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const APP_NAME = 'Codex Wallpapers'
const BUNDLE_ID = 'com.codexwallpapers.desktop'
const URL_SCHEME = 'codex-wallpapers'
const SOURCE_BUNDLE_IDS = new Set(['com.openai.codex'])
const ENTRY_MARKER = '/* codex-wallpapers */'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

if (flag('--help')) {
  console.log(`Usage: node bin/patch.mjs [--source <app>] [--destination <app>] [--no-open]
       node bin/patch.mjs --onto <patched app> [--no-open]

  --source       Official ChatGPT app to copy (default: /Applications/ChatGPT.app)
  --destination  Where to write the patched copy (default: ~/Applications/${APP_NAME}.app)
  --onto         Add wallpapers to another patched copy of the app (for example
                 Codex Subscription Router) in place, keeping its name, profile,
                 and signing identity. Never the official app.
  --no-open      Don't launch the app when done`)
  process.exit(0)
}

const log = (message) => console.log(`\x1b[1m==>\x1b[0m ${message}`)
const fail = (message) => {
  console.error(`\n\x1b[31mCodex Wallpapers:\x1b[0m ${message}`)
  process.exit(1)
}
const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...options }).toString()

function plistRead(plist, key) {
  try {
    return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim()
  } catch {
    return null
  }
}

function plist(plistPath, ...commands) {
  for (const command of commands) {
    try {
      run('/usr/libexec/PlistBuddy', ['-c', command, plistPath])
    } catch {
      // Delete commands for keys that don't exist are fine.
      if (!command.startsWith('Delete')) throw new Error(`PlistBuddy failed: ${command}`)
    }
  }
}

function findSource() {
  const explicit = option('--source')
  const candidates = explicit ? [explicit] : ['/Applications/ChatGPT.app', '/Applications/Codex.app']
  for (const candidate of candidates) {
    const info = join(candidate, 'Contents', 'Info.plist')
    if (!existsSync(info)) continue
    const bundleId = plistRead(info, 'CFBundleIdentifier')
    if (SOURCE_BUNDLE_IDS.has(bundleId) && existsSync(join(candidate, 'Contents', 'Resources', 'app.asar'))) {
      return candidate
    }
    if (explicit) fail(`${candidate} is not the Codex desktop app (bundle id ${bundleId}).`)
  }
  fail('could not find the Codex desktop app. Install it from https://openai.com/codex, then run this again.')
}

function stopRunningCopy(app, bundleId = BUNDLE_ID) {
  const pids = () => {
    try {
      return run('pgrep', ['-f', `${app}/Contents/`]).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  if (pids().length === 0) return
  log(`Quitting ${basename(app, '.app')}`)
  try {
    run('osascript', ['-e', `quit app id "${bundleId}"`])
  } catch {}
  for (let attempt = 0; attempt < 20 && pids().length; attempt++) execFileSync('sleep', ['0.5'])
  for (const pid of pids()) {
    try {
      process.kill(Number(pid))
    } catch {}
  }
}

function patchAsar(asarPath, { isolateProfile }) {
  const archive = new AsarArchive(asarPath)
  const packageJson = JSON.parse(archive.read('/package.json').toString('utf8'))
  const entry = `/${packageJson.main.replace(/^\.?\//, '')}`
  let entrySource = archive.read(entry).toString('utf8')
  // Already has a wallpaper layer: replace it, so re-running upgrades in place.
  if (entrySource.startsWith(ENTRY_MARKER)) entrySource = entrySource.slice(entrySource.indexOf('\n') + 1)

  archive.write('/codex-wallpapers/main.cjs', readFileSync(join(ROOT, 'app', 'main.cjs')))
  archive.write('/codex-wallpapers/preload.cjs', readFileSync(join(ROOT, 'app', 'preload.cjs')))

  // Load the wallpaper main-process module before anything else, so it can
  // give the copy its own profile before the app sets its user-data path.
  const depth = entry.split('/').length - 2
  const relative = `${'../'.repeat(depth) || './'}codex-wallpapers/main.cjs`
  const options = { appName: APP_NAME, version: VERSION, isolateProfile }
  archive.write(entry, `${ENTRY_MARKER}require(${JSON.stringify(relative)})(${JSON.stringify(options)});\n${entrySource}`)
  return archive.save()
}

function setAsarIntegrity(app, headerHash) {
  plist(
    join(app, 'Contents', 'Info.plist'),
    'Delete :ElectronAsarIntegrity',
    'Add :ElectronAsarIntegrity dict',
    'Add :ElectronAsarIntegrity:Resources/app.asar dict',
    'Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256',
    `Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${headerHash}`,
    'Delete :CodexWallpapersVersion',
    `Add :CodexWallpapersVersion string ${VERSION}`,
  )
}

// The app runs on OpenAI's Owl runtime, which takes its profile directory (and
// with it the single-instance lock) from this file before any JavaScript runs.
function patchOwlConfig(iniPath) {
  if (!existsSync(iniPath)) return
  const ini = readFileSync(iniPath, 'utf8')
  if (!/^UserDataDirectoryName=.*$/m.test(ini)) fail('owl-app.ini has no UserDataDirectoryName.')
  writeFileSync(iniPath, ini.replace(/^UserDataDirectoryName=.*$/m, `UserDataDirectoryName=${APP_NAME}`))
}

function patchInfoPlist(app) {
  const info = join(app, 'Contents', 'Info.plist')
  const commands = [
    `Set :CFBundleIdentifier ${BUNDLE_ID}`,
    `Set :CFBundleName ${APP_NAME}`,
    `Delete :CFBundleDisplayName`,
    `Add :CFBundleDisplayName string ${APP_NAME}`,
    `Set :CrProductDirName ${APP_NAME}`,
  ]
  // No Sparkle: without its public key the copy can never accept an update
  // that would replace it with the unpatched official app.
  for (const line of run('/usr/libexec/PlistBuddy', ['-c', 'Print', info]).split('\n')) {
    const key = line.match(/^ {4}(SU\w+) =/)?.[1]
    if (key) commands.push(`Delete :${key}`)
  }
  // Keep the official app as the handler for codex:// links and never
  // register the copy as a web browser.
  commands.push('Delete :CFBundleURLTypes', 'Add :CFBundleURLTypes array', 'Add :CFBundleURLTypes:0 dict')
  commands.push(`Add :CFBundleURLTypes:0:CFBundleURLName string ${APP_NAME}`)
  commands.push('Add :CFBundleURLTypes:0:CFBundleURLSchemes array')
  commands.push(`Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${URL_SCHEME}`)
  plist(info, ...commands)
}

// Grants tied to OpenAI's team and provisioning profile. An ad-hoc signed
// executable claiming them is killed at launch.
const TEAM_SCOPED_ENTITLEMENTS = [
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
  'com.apple.developer.aps-environment',
  'com.apple.security.application-groups',
  'keychain-access-groups',
]

function sign(app, staging) {
  const entitlements = join(staging, 'entitlements.plist')
  writeFileSync(entitlements, run('codesign', ['--display', '--entitlements', ':-', app]))
  plist(entitlements, ...TEAM_SCOPED_ENTITLEMENTS.map((key) => `Delete :${key}`))
  rmSync(join(app, 'Contents', 'embedded.provisionprofile'), { force: true })
  // Ad-hoc sign only the outer bundle: nested frameworks and helpers keep
  // their official signatures and entitlements.
  run('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, app])
  run('codesign', ['--verify', '--strict', app])
}

function registerAndOpen(app) {
  // Register the bundle so Spotlight and Launchpad find it.
  try {
    run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app])
  } catch {}
  log(`Installed ${app}`)
  if (!flag('--no-open')) run('open', [app])
}

function buildStandalone() {
  const source = findSource()
  const destination = resolve(option('--destination', join(homedir(), 'Applications', `${APP_NAME}.app`)))
  const sourceVersion = plistRead(join(source, 'Contents', 'Info.plist'), 'CFBundleShortVersionString')
  log(`Found ChatGPT ${sourceVersion} at ${source}`)

  run('mkdir', ['-p', dirname(destination)])
  stopRunningCopy(destination)

  const staging = mkdtempSync(join(dirname(destination), '.codex-wallpapers-'))
  try {
    const staged = join(staging, `${APP_NAME}.app`)
    log('Copying the app')
    run('ditto', [source, staged])

    log('Adding the wallpaper layer')
    const resources = join(staged, 'Contents', 'Resources')
    const headerHash = patchAsar(join(resources, 'app.asar'), { isolateProfile: true })
    rmSync(join(resources, 'native', 'sparkle.node'), { force: true })
    patchOwlConfig(join(resources, 'owl-app.ini'))
    patchInfoPlist(staged)
    setAsarIntegrity(staged, headerHash)

    log('Signing the copy (ad hoc)')
    sign(staged, staging)

    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
    renameSync(staged, destination)
  } catch (error) {
    fail(error.stderr?.toString().trim() || error.message)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  registerAndOpen(destination)
}

// The identity an app is signed with: the keychain identity whose certificate
// matches its leaf authority, or '-' for ad hoc.
function signingIdentityOf(app) {
  // codesign --display writes its details to stderr.
  const details = spawnSync('codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' }).stderr ?? ''
  if (/Signature=adhoc/.test(details)) return { identity: '-', label: 'ad hoc' }
  const authority = details.match(/^Authority=(.+)$/m)?.[1]
  if (!authority) return null
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const line = identities.split('\n').find((candidate) => candidate.includes(`"${authority}"`))
  const hash = line?.match(/\b([0-9A-F]{40})\b/)?.[1]
  return hash ? { identity: hash, label: authority } : { identity: null, label: authority }
}

function layerOnto(target) {
  const app = resolve(target)
  const info = join(app, 'Contents', 'Info.plist')
  const asarPath = join(app, 'Contents', 'Resources', 'app.asar')
  if (!existsSync(info) || !existsSync(asarPath)) fail(`${app} is not an Electron app.`)
  const bundleId = plistRead(info, 'CFBundleIdentifier')
  if (SOURCE_BUNDLE_IDS.has(bundleId)) {
    fail(`${app} is the official ChatGPT app. Run without --onto to build an independent copy instead.`)
  }
  const archive = new AsarArchive(asarPath)
  if (JSON.parse(archive.read('/package.json').toString('utf8')).name !== 'openai-codex-electron') {
    fail(`${app} is not a copy of the ChatGPT desktop app.`)
  }

  const signing = signingIdentityOf(app)
  if (!signing?.identity) {
    fail(
      `${basename(app)} is signed by "${signing?.label ?? 'unknown'}", which isn't in your keychain. ` +
        'Re-signing it differently would reset its macOS permissions.',
    )
  }
  log(`Adding wallpapers to ${basename(app)} (${bundleId}, signed ${signing.label})`)
  stopRunningCopy(app, bundleId)

  const staging = mkdtempSync(join(dirname(app), '.codex-wallpapers-'))
  const staged = join(staging, basename(app))
  const previous = join(staging, 'previous.app')
  try {
    run('ditto', [app, staged])
    const headerHash = patchAsar(join(staged, 'Contents', 'Resources', 'app.asar'), { isolateProfile: false })
    setAsarIntegrity(staged, headerHash)
    // Only the outer bundle changed; keep its identity, entitlements and
    // designated requirement so permissions granted to it carry over.
    run('codesign', [
      '--force',
      '--sign',
      signing.identity,
      '--preserve-metadata=entitlements,requirements,flags',
      '--timestamp=none',
      staged,
    ])
    run('codesign', ['--verify', '--strict', staged])
    renameSync(app, previous)
    renameSync(staged, app)
  } catch (error) {
    if (!existsSync(app) && existsSync(previous)) renameSync(previous, app)
    fail(error.stderr?.toString().trim() || error.message)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  registerAndOpen(app)
}

function main() {
  if (process.platform !== 'darwin') fail('Codex Wallpapers supports macOS only.')
  const onto = option('--onto')
  if (onto) layerOnto(onto)
  else buildStandalone()
}

main()
