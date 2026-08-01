import { useRef, useState } from 'react'
import { Can } from '../auth/Can'
import {
  downloadAttachment,
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
} from '../api/todos'
import type { Attachment } from '../api/todos'
import { useI18n } from '../i18n/I18nProvider'
import { formatBytes, formatDateTime } from '../lib/types'
import { useToast } from './Toast'

interface AttachmentPanelProps {
  todoId: string
  /** Uploading an attachment requires `todos:write` in the API. */
  canWrite: boolean
}

export function AttachmentPanel({ todoId, canWrite }: AttachmentPanelProps) {
  const toast = useToast()
  const { locale, t } = useI18n()
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
      toast.error(new Error(t('error.noFileSelected')))
      return
    }
    upload.mutate(
      { todoId, file },
      {
        onSuccess: (created) => {
          clearInput()
          toast.success(t('toast.attachmentUploaded', { fileName: created.fileName }))
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
          toast.success(t('toast.attachmentDeleted'))
        },
        onError: (error) => {
          toast.error(error)
        },
      },
    )
  }

  return (
    <section className="attachments">
      <h4 className="attachments__title">{t('attachment.title')}</h4>

      {canWrite && (
        <div className="attachments__upload">
          <input
            ref={inputRef}
            type="file"
            className="input input--file"
            aria-label={t('attachment.fileInputLabel')}
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
            {upload.isPending ? t('attachment.uploading') : t('attachment.upload')}
          </button>
          {file !== null && <span className="muted">{formatBytes(file.size)}</span>}
        </div>
      )}

      {attachments.isPending && <p className="muted">{t('attachment.loading')}</p>}

      {!attachments.isPending && items.length === 0 && (
        <p className="muted">{t('attachment.empty')}</p>
      )}

      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">{t('attachment.columnFile')}</th>
                <th scope="col">{t('attachment.columnSize')}</th>
                <th scope="col">{t('attachment.columnUploaded')}</th>
                <th scope="col">{t('attachment.columnActions')}</th>
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
                  <td>{formatDateTime(attachment.createdAt, locale)}</td>
                  <td className="table__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        download(attachment)
                      }}
                      disabled={downloadingId === attachment.id}
                    >
                      {downloadingId === attachment.id
                        ? t('attachment.downloading')
                        : t('attachment.download')}
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
                        {t('common.delete')}
                      </button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint">{t('attachment.storageHint')}</p>
    </section>
  )
}
