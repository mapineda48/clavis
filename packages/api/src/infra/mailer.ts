import { Resend } from 'resend'
import type { AppConfig } from '../config/env.js'
import type { Logger } from './logger.js'

/** The slice of the configuration this factory reads. */
export type MailerOptions = Pick<
  AppConfig,
  'RESEND_API_KEY' | 'MAIL_FROM' | 'MAIL_REPLY_TO' | 'MAIL_ENABLED'
>

/** Email delivery (Resend or dry-run mode). */
export interface Mailer {
  enabled: boolean
  provider: 'resend' | 'dry-run'
  from: string
  send(msg: {
    to: string | string[]
    subject: string
    html: string
    text?: string
  }): Promise<{ id: string | null; delivered: boolean; provider: 'resend' | 'dry-run'; reason?: string }>
}

/**
 * Email service.
 *
 * - With `MAIL_ENABLED=true` and a non-empty `RESEND_API_KEY`, Resend is used.
 * - In every other case the provider is `dry-run`: nothing goes over the
 *   network, the message is written to the log and `delivered: false` is
 *   returned together with the reason.
 *
 * `send()` never throws: a mail failure must not take a request down.
 */
export function createMailer(options: MailerOptions, log: Logger): Mailer {
  const apiKey = (options.RESEND_API_KEY ?? '').trim()
  const enabled = options.MAIL_ENABLED && apiKey.length > 0
  const provider: 'resend' | 'dry-run' = enabled ? 'resend' : 'dry-run'
  const replyTo = options.MAIL_REPLY_TO

  const resend = enabled ? new Resend(apiKey) : null

  if (enabled) {
    log.info({ from: options.MAIL_FROM }, 'Email enabled through Resend')
  } else {
    log.info(
      { from: options.MAIL_FROM, mailEnabled: options.MAIL_ENABLED, hasApiKey: apiKey.length > 0 },
      'Email in dry-run mode: messages are only written to the log',
    )
  }

  return {
    enabled,
    provider,
    from: options.MAIL_FROM,

    async send(msg) {
      const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]

      // Dry-run mode: leave a trace in the log and report why nothing was sent.
      if (!enabled || resend === null) {
        const reason = !options.MAIL_ENABLED
          ? 'Email delivery is disabled (MAIL_ENABLED=false).'
          : 'No RESEND_API_KEY configured; the email was not sent.'
        log.info(
          { to: recipients, subject: msg.subject, provider: 'dry-run' },
          'Simulated email (dry-run)',
        )
        return { id: null, delivered: false, provider: 'dry-run', reason }
      }

      try {
        const { data, error } = await resend.emails.send({
          from: options.MAIL_FROM,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          ...(msg.text ? { text: msg.text } : {}),
          ...(replyTo ? { replyTo } : {}),
        })

        if (error) {
          log.warn({ to: recipients, subject: msg.subject, err: error }, 'Resend rejected the message')
          return {
            id: null,
            delivered: false,
            provider: 'resend',
            reason: error.message || 'Resend returned an error without a message.',
          }
        }

        const id = data?.id ?? null
        log.info({ to: recipients, subject: msg.subject, id }, 'Email sent through Resend')
        return { id, delivered: true, provider: 'resend' }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error while contacting Resend.'
        log.warn({ to: recipients, subject: msg.subject, err: error }, 'Failed to send the email')
        return { id: null, delivered: false, provider: 'resend', reason }
      }
    },
  }
}
