import { BlobServiceClient } from '@azure/storage-blob'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { notFound } from '../lib/errors.js'

/**
 * Plugin de almacenamiento de adjuntos sobre Azure Blob Storage
 * (Azurite en desarrollo). El contenedor se crea en el arranque de forma
 * idempotente; si el servicio aún no está listo se reintenta en la primera
 * operación real.
 */
export const storagePlugin = fp(
  async (app: FastifyInstance) => {
    const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING)
    const container = service.getContainerClient(env.AZURE_STORAGE_CONTAINER)

    let containerReady = false

    /** Garantiza que el contenedor existe (idempotente y memorizado). */
    const ensureContainer = async (): Promise<void> => {
      if (containerReady) return
      await container.createIfNotExists()
      containerReady = true
    }

    try {
      await ensureContainer()
      app.log.info({ container: env.AZURE_STORAGE_CONTAINER }, 'Contenedor de adjuntos disponible')
    } catch (error) {
      // No se aborta el arranque: /health/ready lo reportará y se reintentará
      // en la primera subida o descarga.
      app.log.warn(
        { err: error, container: env.AZURE_STORAGE_CONTAINER },
        'No se pudo preparar el contenedor de adjuntos; se reintentará bajo demanda',
      )
    }

    const storage: FastifyInstance['storage'] = {
      async upload(blobName, data, contentType) {
        await ensureContainer()
        const blob = container.getBlockBlobClient(blobName)
        await blob.uploadData(data, {
          blobHTTPHeaders: { blobContentType: contentType },
        })
        return { blobName, size: data.byteLength }
      },

      async download(blobName) {
        await ensureContainer()
        const blob = container.getBlockBlobClient(blobName)
        const response = await blob.download()
        if (!response.readableStreamBody) {
          throw notFound(`El adjunto "${blobName}" no tiene contenido descargable.`, 'ATTACHMENT_EMPTY')
        }
        return {
          stream: response.readableStreamBody,
          contentType: response.contentType ?? 'application/octet-stream',
          size: response.contentLength ?? 0,
        }
      },

      async remove(blobName) {
        await ensureContainer()
        const blob = container.getBlockBlobClient(blobName)
        await blob.deleteIfExists({ deleteSnapshots: 'include' })
      },

      async ping() {
        try {
          // `ensureContainer` es idempotente: además de comprobar que Azurite
          // responde, recrea el contenedor si el arranque no pudo hacerlo (o si
          // se vació el volumen con la API en marcha). Así la sonda no reporta
          // "error" por algo que el propio servicio sabe resolver.
          await ensureContainer()
          await container.getProperties()
          return true
        } catch (error) {
          containerReady = false
          app.log.warn({ err: error }, 'El almacenamiento de blobs no responde')
          return false
        }
      },
    }

    app.decorate('storage', storage)
  },
  { name: 'erp-storage' },
)

export default storagePlugin
