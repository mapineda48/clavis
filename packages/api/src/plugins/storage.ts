import { BlobServiceClient } from '@azure/storage-blob'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { notFound } from '../lib/errors.js'

/**
 * Attachment storage plugin backed by Azure Blob Storage (Azurite in
 * development). The container is created idempotently during startup; if the
 * service is not ready yet, the creation is retried on the first real
 * operation.
 */
export const storagePlugin = fp(
  async (app: FastifyInstance) => {
    const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING)
    const container = service.getContainerClient(env.AZURE_STORAGE_CONTAINER)

    let containerReady = false

    /** Makes sure the container exists (idempotent and memoized). */
    const ensureContainer = async (): Promise<void> => {
      if (containerReady) return
      await container.createIfNotExists()
      containerReady = true
    }

    try {
      await ensureContainer()
      app.log.info({ container: env.AZURE_STORAGE_CONTAINER }, 'Attachment container available')
    } catch (error) {
      // Startup is not aborted: /api/health/ready will report it and the container
      // is retried on the first upload or download.
      app.log.warn(
        { err: error, container: env.AZURE_STORAGE_CONTAINER },
        'Could not prepare the attachment container; it will be retried on demand',
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
          throw notFound(`Attachment "${blobName}" has no downloadable content.`, 'ATTACHMENT_EMPTY')
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
          // `ensureContainer` is idempotent: besides checking that Azurite
          // answers, it recreates the container if startup could not (or if the
          // volume was wiped while the API was running). That way the probe does
          // not report "error" for something the service can fix by itself.
          await ensureContainer()
          await container.getProperties()
          return true
        } catch (error) {
          containerReady = false
          app.log.warn({ err: error }, 'Blob storage is not responding')
          return false
        }
      },
    }

    app.decorate('storage', storage)
  },
  { name: 'erp-storage' },
)

export default storagePlugin
