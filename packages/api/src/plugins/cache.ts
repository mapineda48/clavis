import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
// ioredis es CommonJS: bajo ESM + NodeNext el export por defecto no es
// construible, hay que usar el export nombrado.
import { Redis } from 'ioredis'
import { env } from '../config/env.js'

/** Prefijo de las claves que guardan la versión de cada namespace. */
const VERSION_PREFIX = 'erp:ver:'

/**
 * Plugin de caché sobre Valkey (protocolo Redis).
 *
 * La invalidación es por *versión de namespace*: las claves de lista incluyen
 * el número de versión, así que un `bumpVersion` deja obsoletas todas las
 * entradas derivadas sin necesidad de borrarlas.
 *
 * La caché es un acelerador, nunca un punto único de fallo: si Valkey no
 * responde, las operaciones se degradan (se comportan como fallo de caché) en
 * lugar de propagar el error a la petición. `ping()` sigue reflejando el estado
 * real para `/health/ready`.
 */
export const cachePlugin = fp(
  async (app: FastifyInstance) => {
    const client = new Redis(env.VALKEY_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      connectionName: 'erp-api',
      enableReadyCheck: true,
      // Reintento con espera creciente pero acotada a 3 segundos.
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
    })

    client.on('error', (error: Error) => {
      app.log.warn({ err: error }, 'Error de conexión con Valkey')
    })
    client.on('ready', () => {
      app.log.info({ url: env.VALKEY_URL }, 'Conectado a Valkey')
    })

    const versionKey = (namespace: string): string => `${VERSION_PREFIX}${namespace}`

    const cache: FastifyInstance['cache'] = {
      client,

      async get(key) {
        try {
          const raw = await client.get(key)
          if (raw === null) return null
          return JSON.parse(raw)
        } catch (error) {
          app.log.warn({ err: error, key }, 'No se pudo leer de la caché')
          return null
        }
      },

      async set(key, value, ttlSeconds) {
        const ttl = ttlSeconds ?? env.CACHE_TTL_SECONDS
        try {
          await client.set(key, JSON.stringify(value), 'EX', ttl)
        } catch (error) {
          app.log.warn({ err: error, key }, 'No se pudo escribir en la caché')
        }
      },

      async version(namespace) {
        const key = versionKey(namespace)
        try {
          const current = await client.get(key)
          if (current !== null) {
            const parsed = Number.parseInt(current, 10)
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
          }
          // Sólo la crea si no existe: dos instancias a la vez no se pisan.
          await client.set(key, '1', 'NX')
          const created = await client.get(key)
          const parsed = created === null ? 1 : Number.parseInt(created, 10)
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        } catch (error) {
          app.log.warn({ err: error, namespace }, 'No se pudo leer la versión de caché')
          return 1
        }
      },

      async bumpVersion(namespace) {
        const key = versionKey(namespace)
        try {
          // INCR crea la clave en 1 si no existía.
          return await client.incr(key)
        } catch (error) {
          app.log.warn({ err: error, namespace }, 'No se pudo invalidar la caché')
          return 1
        }
      },

      async ping() {
        try {
          const pong = await client.ping()
          return pong === 'PONG'
        } catch (error) {
          app.log.warn({ err: error }, 'Valkey no responde')
          return false
        }
      },
    }

    app.decorate('cache', cache)

    app.addHook('onClose', async () => {
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
      app.log.info('Conexión con Valkey cerrada')
    })
  },
  { name: 'erp-cache' },
)

export default cachePlugin
