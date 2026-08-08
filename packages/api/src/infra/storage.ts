import { BlobServiceClient } from '@azure/storage-blob'
import type { AppConfig } from '../config/env.js'
import { notFound } from '../lib/errors.js'
import type { Logger } from './logger.js'

/** The slice of the configuration this factory reads. */
export type StorageOptions = Pick<
  AppConfig,
  'AZURE_STORAGE_CONNECTION_STRING' | 'AZURE_STORAGE_CONTAINER'
>

/** Attachment storage on Azure Blob Storage / Azurite. */
export interface Storage {
  upload(blobName: string, data: Buffer, contentType: string): Promise<{ blobName: string; size: number }>
  download(blobName: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number }>
  remove(blobName: string): Promise<void>
  ping(): Promise<boolean>
}

/**
 * Attachment storage backed by Azure Blob Storage (Azurite in development).
 * The container is created idempotently during startup; if the service is not
 * ready yet, the creation is retried on the first real operation.
 */
export async function createStorage(options: StorageOptions, log: Logger): Promise<Storage> {
  const service = BlobServiceClient.fromConnectionString(options.AZURE_STORAGE_CONNECTION_STRING)
  const container = service.getContainerClient(options.AZURE_STORAGE_CONTAINER)

  let containerReady = false

  /** Makes sure the container exists (idempotent and memoized). */
  const ensureContainer = async (): Promise<void> => {
    if (containerReady) return
    await container.createIfNotExists()
    containerReady = true
  }

  try {
    await ensureContainer()
    log.info({ container: options.AZURE_STORAGE_CONTAINER }, 'Attachment container available')
  } catch (error) {
    // Startup is not aborted: /api/health/ready will report it and the container
    // is retried on the first upload or download.
    log.warn(
      { err: error, container: options.AZURE_STORAGE_CONTAINER },
      'Could not prepare the attachment container; it will be retried on demand',
    )
  }

  return {
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
        log.warn({ err: error }, 'Blob storage is not responding')
        return false
      }
    },
  }
}
