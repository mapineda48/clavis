import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Resend } from 'resend'
import { env } from '../config/env.js'

/**
 * Email plugin.
 *
 * - With `MAIL_ENABLED=true` and a non-empty `RESEND_API_KEY`, Resend is used.
 * - In every other case the provider is `dry-run`: nothing goes over the
 *   network, the message is written to the log and `delivered: false` is
 *   returned together with the reason.
 *
 * `send()` never throws: a mail failure must not take a request down.
 */
export const mailerPlugin = fp(
  async (app: FastifyInstance) => {
    const apiKey = (env.RESEND_API_KEY ?? '').trim()
    const enabled = env.MAIL_ENABLED && apiKey.length > 0
    const provider: 'resend' | 'dry-run' = enabled ? 'resend' : 'dry-run'
    const replyTo = env.MAIL_REPLY_TO

    const resend = enabled ? new Resend(apiKey) : null

    if (enabled) {
      app.log.info({ from: env.MAIL_FROM }, 'Email enabled through Resend')
    } else {
      app.log.info(
        { from: env.MAIL_FROM, mailEnabled: env.MAIL_ENABLED, hasApiKey: apiKey.length > 0 },
        'Email in dry-run mode: messages are only written to the log',
      )
    }

    const mailer: FastifyInstance['mailer'] = {
      enabled,
      provider,
      from: env.MAIL_FROM,

      async send(msg) {
        const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]

        // Dry-run mode: leave a trace in the log and report why nothing was sent.
        if (!enabled || resend === null) {
          const reason = !env.MAIL_ENABLED
            ? 'Email delivery is disabled (MAIL_ENABLED=false).'
            : 'No RESEND_API_KEY configured; the email was not sent.'
          app.log.info(
            { to: recipients, subject: msg.subject, provider: 'dry-run' },
            'Simulated email (dry-run)',
          )
          return { id: null, delivered: false, provider: 'dry-run', reason }
        }

        try {
          const { data, error } = await resend.emails.send({
            from: env.MAIL_FROM,
            to: msg.to,
            subject: msg.subject,
            html: msg.html,
            ...(msg.text ? { text: msg.text } : {}),
            ...(replyTo ? { replyTo } : {}),
          })

          if (error) {
            app.log.warn({ to: recipients, subject: msg.subject, err: error }, 'Resend rejected the message')
            return {
              id: null,
              delivered: false,
              provider: 'resend',
              reason: error.message || 'Resend returned an error without a message.',
            }
          }

          const id = data?.id ?? null
          app.log.info({ to: recipients, subject: msg.subject, id }, 'Email sent through Resend')
          return { id, delivered: true, provider: 'resend' }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Unknown error while contacting Resend.'
          app.log.warn({ to: recipients, subject: msg.subject, err: error }, 'Failed to send the email')
          return { id: null, delivered: false, provider: 'resend', reason }
        }
      },
    }

    app.decorate('mailer', mailer)
  },
  { name: 'erp-mailer' },
)

export default mailerPlugin
