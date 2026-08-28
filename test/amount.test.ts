import { describe, it, expect } from 'vitest';
import { TokenAmount, AmountError, sol, SOL_DECIMALS } from '../src/util/amount.js';

describe('TokenAmount', () => {
  it('parses decimal strings exactly', () => {
    expect(sol('0.5').raw).toBe(500_000_000n);
    expect(sol('1').raw).toBe(1_000_000_000n);
    expect(sol('0.000000001').raw).toBe(1n);
    expect(sol('123.456789012').raw).toBe(123_456_789_012n);
  });

  it('round-trips through toString without loss', () => {
    for (const s of ['0', '0.5', '1', '0.000000001', '999999.123456789']) {
      expect(sol(s).toString()).toBe(s === '0' ? '0' : s);
    }
  });

  it('avoids the float error that motivates this class', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754. Integer math must not care.
    const a = sol('0.1').add(sol('0.2'));
    expect(a.toString()).toBe('0.3');
    expect(a.eq(sol('0.3'))).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false); // the thing we are avoiding
  });

  it('rejects more precision than the token supports', () => {
    expect(() => TokenAmount.fromDecimalString('0.1234567891', SOL_DECIMALS)).toThrow(
      AmountError,
    );
  });

  it('rejects non-numeric input', () => {
    for (const bad of ['', 'abc', '1.2.3', '0x10', '1e9', ' 1 2 ']) {
      expect(() => sol(bad)).toThrow(AmountError);
    }
  });

  it('refuses to mix decimals', () => {
    const a = TokenAmount.fromRaw(1n, 9);
    const b = TokenAmount.fromRaw(1n, 6);
    expect(() => a.add(b)).toThrow(AmountError);
    expect(() => a.lt(b)).toThrow(AmountError);
  });

  it('scales by basis points, truncating toward zero', () => {
    // 0.5% of 1 SOL
    expect(sol('1').mulBps(50n).toString()).toBe('0.005');
    // truncation must never round UP into a larger position than requested
    expect(TokenAmount.fromRaw(3n, 9).mulBps(5000n).raw).toBe(1n);
  });

  it('handles negative amounts for P&L', () => {
    const loss = sol('1').sub(sol('1.25'));
    expect(loss.isNegative()).toBe(true);
    expect(loss.toString()).toBe('-0.25');
  });
});
