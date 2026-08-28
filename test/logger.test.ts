import { describe, it, expect } from 'vitest';
import { createLogger, redact } from '../src/util/logger.js';

describe('secret redaction', () => {
  it('redacts secret-looking keys', () => {
    const out = redact({
      privateKey: 'abc', WALLET_PRIVATE_KEY: 'xyz', apiKey: 'k',
      mnemonic: 'm', publicKey: 'safe-to-show',
    }) as Record<string, unknown>;
    expect(out['privateKey']).toBe('[REDACTED]');
    expect(out['WALLET_PRIVATE_KEY']).toBe('[REDACTED]');
    expect(out['apiKey']).toBe('[REDACTED]');
    expect(out['mnemonic']).toBe('[REDACTED]');
    expect(out['publicKey']).toBe('safe-to-show');
  });

  it('redacts key-length base58 strings anywhere in a message', () => {
    const key = '5'.repeat(88);
    expect(redact(`submitting with ${key} now`)).toBe('submitting with [REDACTED] now');
  });

  it('leaves a 44-char public key visible', () => {
    const pub = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    expect(redact(pub)).toBe(pub);
  });

  it('recurses through nested structures', () => {
    const out = redact({ a: { b: [{ secret: 's' }] } }) as any;
    expect(out.a.b[0].secret).toBe('[REDACTED]');
  });

  it('never emits a secret through the logger', () => {
    const lines: string[] = [];
    const log = createLogger('debug', { seed: 'top-secret' }, (l) => lines.push(l));
    log.info('starting', { privateKey: 'nope' });
    expect(lines[0]).not.toContain('top-secret');
    expect(lines[0]).not.toContain('nope');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('respects the minimum level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', {}, (l) => lines.push(l));
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(lines).toHaveLength(2);
  });
});
