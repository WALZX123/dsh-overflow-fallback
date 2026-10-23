/**
 * Install-contract checks for dsh-overflow-fallback.
 *
 * Run with plain Node (`node test/verify-install.mjs`). It never boots a
 * harness: it asserts the published payload matches what the loader and the
 * plugin market expect, and that the code carries no capability the README
 * does not claim.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Read and parse the package manifest. */
async function manifest() {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}

/** List a directory, failing when it does not exist. */
async function list(rel) {
  return await readdir(join(root, rel))
}

const pkg = await manifest()

assert.equal(pkg.name, 'dsh-overflow-fallback', 'package name is the install name')
assert.equal(pkg.type, 'module', 'ESM only')
assert.equal(pkg.main, './lib/index.js', 'host entry is lib/index.js')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch is declared')
assert.deepEqual(pkg.dependencies ?? {}, {}, 'no runtime dependencies: the supply chain is the plugin')
assert.match(pkg.dsh?.compatibility?.dsh ?? '', /0\.2\.1/, 'declares the tested DSH line')

const files = new Set(pkg.files ?? [])
for (const required of ['lib', 'cordis.patch.yml', 'README.md', 'SECURITY.md', 'LICENSE']) {
  assert.ok(files.has(required), `files must publish ${required}`)
}

const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /id: dsh-overflow-fallback/, 'patch inserts the plugin id')
assert.equal((patch.match(/^ {4}- id:/gm) ?? []).length, 1, 'exactly one loader entry')

const lib = await list('lib')
assert.ok(lib.includes('index.js'), 'host entry exists')
assert.ok(lib.includes('decide.js'), 'decision core exists')
assert.ok(lib.includes('handoff.js'), 'handoff builder exists')
assert.ok(lib.includes('service.js'), 'integration service exists')
assert.ok(lib.includes('revive.js'), 'revival runner exists')
assert.ok(lib.includes('tools.js'), 'tool definitions exist')

const entry = await readFile(join(root, 'lib', 'index.js'), 'utf8')
assert.match(entry, /export const name = 'dsh-overflow-fallback'/, 'exports a loader name')
assert.match(entry, /export const inject = [^\n]*\[\]/, 'declares no required service')
assert.match(entry, /export function apply/, 'exports apply')
assert.match(entry, /ctx\.provide\(SERVICE_NAME/, 'publishes the integration service')

// Declared capabilities must match what the code actually provides.
const provides = pkg.dshhub?.capabilities?.provides ?? []
assert.deepEqual(provides, ['service:overflowFallback'], 'declares exactly the overflowFallback service')
assert.deepEqual(pkg.dshhub?.permissions?.network ?? [], [], 'declares no network permission')

// Capability surface the README promises: no network, no filesystem, no child
// processes, no direct session-log edits.
const forbidden = [
  /\bfetch\s*\(/,
  /node:https?/,
  /require\(['"]fs['"]\)/,
  /node:child_process/,
  /node:fs/,
  /\.spawn\s*\(/,
  /session\.append\s*\(/,
]
for (const file of lib.filter(name => name.endsWith('.js'))) {
  const source = await readFile(join(root, 'lib', file), 'utf8')
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `lib/${file} must not match ${pattern}`)
  }
}

console.log('verify-install: ok')
