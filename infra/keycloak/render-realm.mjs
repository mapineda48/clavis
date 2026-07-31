#!/usr/bin/env node
/**
 * Renderiza el realm de Keycloak a partir de la plantilla.
 *
 * Lee `realm-erp.template.json` (que vive junto a este archivo), sustituye
 * todos los marcadores con la forma __NOMBRE_VARIABLE__ por el valor de
 * `process.env` y escribe el resultado como `realm-erp.json` dentro de
 * OUTPUT_DIR (por defecto /import, que es el volumen `keycloak-import`).
 *
 * Reglas:
 *  - Si algun marcador se queda sin resolver, se listan y se sale con codigo 1.
 *  - Los valores se escapan con JSON.stringify para que comillas, barras o
 *    saltos de linea no rompan el JSON.
 *  - El resultado se valida con JSON.parse antes de escribirse a disco.
 *
 * Node ESM puro, sin dependencias externas.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = resolve(SCRIPT_DIR, 'realm-erp.template.json')

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/import'
const OUTPUT_NAME = process.env.OUTPUT_NAME || 'realm-erp.json'
const OUTPUT_PATH = resolve(OUTPUT_DIR, OUTPUT_NAME)

/** Marcador: dos guiones bajos, el nombre en mayusculas, dos guiones bajos. */
const PLACEHOLDER = /__([A-Z][A-Z0-9_]*)__/g

/** Nombres cuyo valor nunca se imprime en claro. */
const SENSITIVE = /(PASSWORD|SECRET)/

const log = (msg) => process.stdout.write(`[render-realm] ${msg}\n`)
const logError = (msg) => process.stderr.write(`[render-realm] ${msg}\n`)

/** Aborta el proceso con un mensaje y codigo 1. */
function fail(message, details = []) {
  logError(`ERROR: ${message}`)
  for (const detail of details) logError(`  - ${detail}`)
  process.exit(1)
}

/**
 * Devuelve el valor listo para incrustarse dentro de un JSON.
 * JSON.stringify escapa comillas, barras invertidas y caracteres de control;
 * quitamos las comillas exteriores porque la plantilla ya las pone.
 */
function toJsonFragment(value) {
  const quoted = JSON.stringify(String(value))
  return quoted.slice(1, -1)
}

/** Enmascara los valores sensibles para el resumen. */
function maskIfSensitive(name, value) {
  if (SENSITIVE.test(name)) return '********'
  return value
}

// --- 1. Leer la plantilla -----------------------------------------------------

let template
try {
  template = readFileSync(TEMPLATE_PATH, 'utf8')
} catch (err) {
  fail(`no se pudo leer la plantilla ${TEMPLATE_PATH}: ${err.message}`)
}

// --- 2. Sustituir marcadores --------------------------------------------------

/** @type {Map<string, string>} nombre -> valor aplicado */
const applied = new Map()
/** @type {Map<string, string>} nombre -> motivo por el que no se resolvio */
const unresolved = new Map()

const rendered = template.replace(PLACEHOLDER, (match, name) => {
  const raw = process.env[name]
  if (raw === undefined) {
    unresolved.set(name, 'variable no definida en el entorno')
    return match
  }
  if (raw.trim() === '') {
    unresolved.set(name, 'variable definida pero vacia')
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
    `quedan ${unresolved.size} marcador(es) sin resolver en ${TEMPLATE_PATH}`,
    details,
  )
}

// --- 3. Validar que el resultado es JSON valido -------------------------------

let parsed
try {
  parsed = JSON.parse(rendered)
} catch (err) {
  fail(
    `el realm renderizado no es JSON valido: ${err.message}. ` +
      'Revisa la plantilla o los valores sustituidos.',
  )
}

if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  fail('el realm renderizado no es un objeto JSON')
}

// --- 4. Escribir la salida ----------------------------------------------------

try {
  mkdirSync(OUTPUT_DIR, { recursive: true })
} catch (err) {
  fail(`no se pudo crear el directorio de salida ${OUTPUT_DIR}: ${err.message}`)
}

try {
  writeFileSync(OUTPUT_PATH, rendered, 'utf8')
} catch (err) {
  fail(`no se pudo escribir ${OUTPUT_PATH}: ${err.message}`)
}

// --- 5. Resumen legible -------------------------------------------------------

log(`plantilla : ${TEMPLATE_PATH}`)
log(`salida    : ${OUTPUT_PATH}`)
log(`realm     : ${parsed.realm ?? '(sin campo "realm")'}`)
log(`variables sustituidas (${applied.size}):`)

const names = [...applied.keys()].sort((a, b) => a.localeCompare(b))
const width = names.reduce((max, name) => Math.max(max, name.length), 0)
for (const name of names) {
  log(`  ${name.padEnd(width)} = ${maskIfSensitive(name, applied.get(name))}`)
}

log('realm renderizado correctamente')
