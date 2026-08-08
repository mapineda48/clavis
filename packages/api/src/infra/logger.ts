import { pino, type Logger } from 'pino'
import type { AppConfig } from '../config/env.js'

/** The slice of the configuration the logger reads. */
export type LoggerOptions = Pick<AppConfig, 'NODE_ENV' | 'LOG_LEVEL'>

/**
 * Process-wide structured logger.
 *
 * Express ships no logger of its own, so this is created first and handed to
 * everything else: the infrastructure factories receive it as an argument and
 * `pino-http` derives the request-scoped `req.log` from it. In development the
 * output goes through `pino-pretty`; everywhere else it stays NDJSON for
 * whatever collects the container logs.
 */
export function createLogger(options: LoggerOptions): Logger {
  if (options.NODE_ENV === 'development') {
    return pino({
      level: options.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    })
  }
  return pino({ level: options.LOG_LEVEL })
}

export type { Logger }
