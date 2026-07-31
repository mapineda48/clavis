import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Resend } from 'resend'
import { env } from '../config/env.js'

/**
 * Plugin de correo.
 *
 * - Con `MAIL_ENABLED=true` y `RESEND_API_KEY` no vacía se usa Resend.
 * - En cualquier otro caso el proveedor es `dry-run`: no se llama a la red, el
 *   correo se registra en el log y se devuelve `delivered: false` con el motivo.
 *
 * `send()` nunca lanza: un fallo de correo no puede tumbar una petición.
 */
export const mailerPlugin = fp(
  async (app: FastifyInstance) => {
    const apiKey = (env.RESEND_API_KEY ?? '').trim()
    const enabled = env.MAIL_ENABLED && apiKey.length > 0
    const provider: 'resend' | 'dry-run' = enabled ? 'resend' : 'dry-run'
    const replyTo = env.MAIL_REPLY_TO

    const resend = enabled ? new Resend(apiKey) : null

    if (enabled) {
      app.log.info({ from: env.MAIL_FROM }, 'Correo activado mediante Resend')
    } else {
      app.log.info(
        { from: env.MAIL_FROM, mailEnabled: env.MAIL_ENABLED, hasApiKey: apiKey.length > 0 },
        'Correo en modo dry-run: los envíos sólo se registran en el log',
      )
    }

    const mailer: FastifyInstance['mailer'] = {
      enabled,
      provider,
      from: env.MAIL_FROM,

      async send(msg) {
        const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]

        // Modo dry-run: se deja constancia en el log y se informa del motivo.
        if (!enabled || resend === null) {
          const reason = !env.MAIL_ENABLED
            ? 'El envío de correo está desactivado (MAIL_ENABLED=false).'
            : 'No hay RESEND_API_KEY configurada; el correo no se ha enviado.'
          app.log.info(
            { to: recipients, subject: msg.subject, provider: 'dry-run' },
            'Correo simulado (dry-run)',
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
            app.log.warn({ to: recipients, subject: msg.subject, err: error }, 'Resend rechazó el envío')
            return {
              id: null,
              delivered: false,
              provider: 'resend',
              reason: error.message || 'Resend devolvió un error sin mensaje.',
            }
          }

          const id = data?.id ?? null
          app.log.info({ to: recipients, subject: msg.subject, id }, 'Correo enviado con Resend')
          return { id, delivered: true, provider: 'resend' }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Error desconocido al contactar con Resend.'
          app.log.warn({ to: recipients, subject: msg.subject, err: error }, 'Fallo al enviar el correo')
          return { id: null, delivered: false, provider: 'resend', reason }
        }
      },
    }

    app.decorate('mailer', mailer)
  },
  { name: 'erp-mailer' },
)

export default mailerPlugin
