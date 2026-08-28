/**
 * Integer token-amount math (spec §2.5: "never use floating point for on-chain
 * amounts"). All values are held as a raw bigint in the token's smallest unit
 * plus its decimal count. No operation in this module produces a float.
 */

export class AmountError extends Error {}

const POW10: bigint[] = Array.from({ length: 32 }, (_, i) => 10n ** BigInt(i));

function pow10(n: number): bigint {
  const p = POW10[n];
  if (p === undefined) throw new AmountError(`unsupported decimals: ${n}`);
  return p;
}

export class TokenAmount {
  readonly raw: bigint;
  readonly decimals: number;

  private constructor(raw: bigint, decimals: number) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 31) {
      throw new AmountError(`invalid decimals: ${decimals}`);
    }
    this.raw = raw;
    this.decimals = decimals;
  }

  /** From the smallest unit (lamports, base units). The canonical constructor. */
  static fromRaw(raw: bigint, decimals: number): TokenAmount {
    return new TokenAmount(raw, decimals);
  }

  /**
   * From a human decimal STRING, e.g. "0.5". Deliberately string-only: taking a
   * JS number here would already have lost precision before we could act.
   */
  static fromDecimalString(s: string, decimals: number): TokenAmount {
    const t = s.trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) {
      throw new AmountError(`not a decimal number: ${JSON.stringify(s)}`);
    }
    const neg = t.startsWith('-');
    const body = neg ? t.slice(1) : t;
    const dot = body.indexOf('.');
    const whole = dot === -1 ? body : body.slice(0, dot);
    const frac = dot === -1 ? '' : body.slice(dot + 1);
    if (frac.length > decimals) {
      throw new AmountError(
        `${s} has ${frac.length} decimal places, token supports ${decimals}`,
      );
    }
    const padded = frac.padEnd(decimals, '0');
    const raw = BigInt(whole) * pow10(decimals) + BigInt(padded === '' ? '0' : padded);
    return new TokenAmount(neg ? -raw : raw, decimals);
  }

  private assertSame(o: TokenAmount): void {
    if (o.decimals !== this.decimals) {
      throw new AmountError(
        `decimal mismatch: ${this.decimals} vs ${o.decimals}`,
      );
    }
  }

  add(o: TokenAmount): TokenAmount {
    this.assertSame(o);
    return new TokenAmount(this.raw + o.raw, this.decimals);
  }

  sub(o: TokenAmount): TokenAmount {
    this.assertSame(o);
    return new TokenAmount(this.raw - o.raw, this.decimals);
  }

  /**
   * Scale by a percentage given in basis points (1 bp = 0.01%). Integer-only:
   * truncates toward zero, which for position sizing errs small — never larger
   * than the caller asked for.
   */
  mulBps(bps: bigint): TokenAmount {
    return new TokenAmount((this.raw * bps) / 10_000n, this.decimals);
  }

  lt(o: TokenAmount): boolean { this.assertSame(o); return this.raw < o.raw; }
  gt(o: TokenAmount): boolean { this.assertSame(o); return this.raw > o.raw; }
  eq(o: TokenAmount): boolean { this.assertSame(o); return this.raw === o.raw; }
  isZero(): boolean { return this.raw === 0n; }
  isNegative(): boolean { return this.raw < 0n; }

  /** Exact human-readable string. Never lossy. */
  toString(): string {
    const neg = this.raw < 0n;
    const abs = neg ? -this.raw : this.raw;
    const d = pow10(this.decimals);
    const whole = abs / d;
    const frac = abs % d;
    const sign = neg ? '-' : '';
    if (this.decimals === 0) return `${sign}${whole}`;
    const fracStr = frac.toString().padStart(this.decimals, '0').replace(/0+$/, '');
    return fracStr === '' ? `${sign}${whole}` : `${sign}${whole}.${fracStr}`;
  }

  /**
   * Lossy conversion for DISPLAY and indicator math only. Never feed the result
   * back into an on-chain amount or a balance comparison.
   */
  toNumberUnsafe(): number {
    return Number(this.toString());
  }
}

export const SOL_DECIMALS = 9;

export function sol(decimalString: string): TokenAmount {
  return TokenAmount.fromDecimalString(decimalString, SOL_DECIMALS);
}
