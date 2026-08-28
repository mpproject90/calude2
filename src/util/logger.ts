/**
 * Structured logging. Spec §16: "Do not silently swallow errors. Log everything
 * with context." Also spec §2.1 — secrets must never reach a log line, so every
 * record passes through a redactor before it is emitted.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN =
  /(private|secret|seed|mnemonic|keypair|passphrase|apikey|api_key|token)/i;

/** Anything that looks like a base58 key of key-length. Belt and braces. */
const BASE58_KEYLIKE = /\b[1-9A-HJ-NP-Za-km-z]{64,}\b/g;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(BASE58_KEYLIKE, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(
  minLevel: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const emit = (level: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact(bindings) as Record<string, unknown>),
      ...(ctx ? (redact(ctx) as Record<string, unknown>) : {}),
    };
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (b) => createLogger(minLevel, { ...bindings, ...b }, sink),
  };
}
