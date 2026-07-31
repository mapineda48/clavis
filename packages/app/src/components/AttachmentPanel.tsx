import { useRef, useState } from 'react'
import { Can } from '../auth/Can'
import {
  downloadAttachment,
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
} from '../api/todos'
import type { Attachment } from '../api/todos'
import { formatBytes, formatDateTime } from '../lib/types'
import { useToast } from './Toast'

interface AttachmentPanelProps {
  todoId: string
  /** El alta de adjuntos exige `todos:write` en la API. */
  canWrite: boolean
}

export function AttachmentPanel({ todoId, canWrite }: AttachmentPanelProps) {
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const attachments = useAttachments(todoId, true)
  const upload = useUploadAttachment()
  const removeAttachment = useDeleteAttachment()

  const items = attachments.data ?? []

  const clearInput = (): void => {
    setFile(null)
    if (inputRef.current !== null) inputRef.current.value = ''
  }

  const send = (): void => {
    if (file === null) {
      toast.error(new Error('Selecciona primero un archivo.'))
      return
    }
    upload.mutate(
      { todoId, file },
      {
        onSuccess: (created) => {
          clearInput()
          toast.success(`Archivo «${created.fileName}» subido.`)
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  const download = (attachment: Attachment): void => {
    setDownloadingId(attachment.id)
    void downloadAttachment(attachment)
      .catch((error: unknown) => {
        toast.error(error)
      })
      .finally(() => {
        setDownloadingId(null)
      })
  }

  const drop = (attachment: Attachment): void => {
    removeAttachment.mutate(
      { todoId, attachmentId: attachment.id },
      {
        onSuccess: () => {
          toast.success('Adjunto borrado.')
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  return (
    <section className="attachments">
      <h4 className="attachments__title">Adjuntos</h4>

      {canWrite && (
        <div className="attachments__upload">
          <input
            ref={inputRef}
            type="file"
            className="input input--file"
            aria-label="Archivo a subir"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              setFile(selected)
            }}
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={send}
            disabled={file === null || upload.isPending}
          >
            {upload.isPending ? 'Subiendo…' : 'Subir'}
          </button>
          {file !== null && <span className="muted">{formatBytes(file.size)}</span>}
        </div>
      )}

      {attachments.isPending && <p className="muted">Cargando adjuntos…</p>}

      {!attachments.isPending && items.length === 0 && (
        <p className="muted">Esta tarea todavia no tiene archivos.</p>
      )}

      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Archivo</th>
                <th scope="col">Tamano</th>
                <th scope="col">Subido</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((attachment) => (
                <tr key={attachment.id}>
                  <td>
                    <span className="file-name">{attachment.fileName}</span>
                    <span className="muted"> {attachment.contentType}</span>
                  </td>
                  <td>{formatBytes(attachment.sizeBytes)}</td>
                  <td>{formatDateTime(attachment.createdAt)}</td>
                  <td className="table__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        download(attachment)
                      }}
                      disabled={downloadingId === attachment.id}
                    >
                      {downloadingId === attachment.id ? 'Descargando…' : 'Descargar'}
                    </button>
                    <Can perm="todos:delete">
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={() => {
                          drop(attachment)
                        }}
                        disabled={removeAttachment.isPending}
                      >
                        Borrar
                      </button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint">
        Los archivos se guardan en Azurite (emulador de Azure Blob Storage). El tamano maximo lo
        impone la API con <code>MAX_UPLOAD_BYTES</code>.
      </p>
    </section>
  )
}
