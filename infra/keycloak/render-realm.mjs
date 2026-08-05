#!/usr/bin/env node
/**
 * Renders the Keycloak realm from its template.
 *
 * Reads `realm-clavis.template.json` (it lives next to this file), replaces every
 * marker of the form __VARIABLE_NAME__ with the matching value from
 * `process.env` and writes the result as `realm-clavis.json` inside OUTPUT_DIR
 * (/import by default, which is the `keycloak-import` volume).
 *
 * Rules:
 *  - If any marker is left unresolved, they are all listed and the process
 *    exits with code 1.
 *  - Values are escaped with JSON.stringify so quotes, backslashes or newlines
 *    cannot break the JSON.
 *  - The result is validated with JSON.parse before it is written to disk.
 *
 * Plain Node ESM, no external dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = resolve(SCRIPT_DIR, 'realm-clavis.template.json')

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/import'
const OUTPUT_NAME = process.env.OUTPUT_NAME || 'realm-clavis.json'
const OUTPUT_PATH = resolve(OUTPUT_DIR, OUTPUT_NAME)

/** Marker: two underscores, the name in upper case, two underscores. */
const PLACEHOLDER = /__([A-Z][A-Z0-9_]*)__/g

/** Names whose value is never printed in the clear. */
const SENSITIVE = /(PASSWORD|SECRET)/

const log = (msg) => process.stdout.write(`[render-realm] ${msg}\n`)
const logError = (msg) => process.stderr.write(`[render-realm] ${msg}\n`)

/** Aborts the process with a message and exit code 1. */
function fail(message, details = []) {
  logError(`ERROR: ${message}`)
  for (const detail of details) logError(`  - ${detail}`)
  process.exit(1)
}

/**
 * Returns the value ready to be embedded inside JSON.
 * JSON.stringify escapes quotes, backslashes and control characters; the outer
 * quotes are stripped because the template already provides them.
 */
function toJsonFragment(value) {
  const quoted = JSON.stringify(String(value))
  return quoted.slice(1, -1)
}

/** Masks sensitive values for the summary. */
function maskIfSensitive(name, value) {
  if (SENSITIVE.test(name)) return '********'
  return value
}

// --- 1. Read the template -----------------------------------------------------

let template
try {
  template = readFileSync(TEMPLATE_PATH, 'utf8')
} catch (err) {
  fail(`could not read the template ${TEMPLATE_PATH}: ${err.message}`)
}

// --- 2. Replace the markers ---------------------------------------------------

/** @type {Map<string, string>} name -> value applied */
const applied = new Map()
/** @type {Map<string, string>} name -> reason it could not be resolved */
const unresolved = new Map()

const rendered = template.replace(PLACEHOLDER, (match, name) => {
  const raw = process.env[name]
  if (raw === undefined) {
    unresolved.set(name, 'variable not defined in the environment')
    return match
  }
  if (raw.trim() === '') {
    unresolved.set(name, 'variable defined but empty')
    return match
  }
  applied.set(name, raw)
  return toJsonFragment(raw)
})

if (unresolved.size > 0) {
  const details = [...unresolved.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, reason]) => `__${name}__ : ${reason}`)
  fail(
    `${unresolved.size} marker(s) left unresolved in ${TEMPLATE_PATH}`,
    details,
  )
}

// --- 3. Check the result is valid JSON ----------------------------------------

let parsed
try {
  parsed = JSON.parse(rendered)
} catch (err) {
  fail(
    `the rendered realm is not valid JSON: ${err.message}. ` +
      'Check the template or the substituted values.',
  )
}

if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  fail('the rendered realm is not a JSON object')
}

// --- 4. Write the output ------------------------------------------------------

try {
  mkdirSync(OUTPUT_DIR, { recursive: true })
} catch (err) {
  fail(`could not create the output directory ${OUTPUT_DIR}: ${err.message}`)
}

try {
  writeFileSync(OUTPUT_PATH, rendered, 'utf8')
} catch (err) {
  fail(`could not write ${OUTPUT_PATH}: ${err.message}`)
}

// --- 5. Readable summary ------------------------------------------------------

log(`template  : ${TEMPLATE_PATH}`)
log(`output    : ${OUTPUT_PATH}`)
log(`realm     : ${parsed.realm ?? '(no "realm" field)'}`)
log(`variables substituted (${applied.size}):`)

const names = [...applied.keys()].sort((a, b) => a.localeCompare(b))
const width = names.reduce((max, name) => Math.max(max, name.length), 0)
for (const name of names) {
  log(`  ${name.padEnd(width)} = ${maskIfSensitive(name, applied.get(name))}`)
}

log('realm rendered successfully')
