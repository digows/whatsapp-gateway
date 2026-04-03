import pino, { Logger } from 'pino';
import { env } from '../../application/config/env.js';

export function createBaileysLogger(): Logger {
  return pino({
    level: env.BAILEYS_LOG_LEVEL,
    hooks: {
      logMethod(args, method) {
        if (shouldSuppressBaileysLog(args)) {
          return;
        }

        method.apply(this, args as Parameters<typeof method>);
      },
    },
  });
}

function shouldSuppressBaileysLog(args: unknown[]): boolean {
  const [first, second] = args;
  const context = isRecord(first) ? first : undefined;
  const message = typeof second === 'string'
    ? second
    : typeof first === 'string'
      ? first
      : undefined;

  if (message === 'transaction failed, rolling back') {
    return getErrorName(context?.error) === 'PreKeyError';
  }

  if (message === 'failed to decrypt message') {
    return getErrorName(context?.err) === 'PreKeyError' && context?.messageType === 'pkmsg';
  }

  return false;
}

function getErrorName(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.name;
  }

  if (isRecord(value) && typeof value.name === 'string') {
    return value.name;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
