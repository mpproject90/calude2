import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig, assertLiveTradingAllowed, ConfigError } from '../src/config/load.js';

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function token(over: Record<string, unknown> = {}) {
  return {
    address: JUP,
    symbol: 'JUP',
    tier: 'A',
    timeframe: '1h',
    buyAmountSol: 0.5,
    rsi: { period: 14, oversold: 30, overbought: 70 },
    mfi: { period: 14, threshold: 30 },
    entry: {},
    exit: {},
    limits: {},
    ...over,
  };
}

describe('config validation', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const cfg = parseConfig({ global: {}, tokens: [token()] });
    expect(cfg.global.mode).toBe('backtest');
    expect(cfg.global.maxConcurrentPositions).toBe(3);
    expect(cfg.global.indicatorWarmupMultiplier).toBe(4.5);
    expect(cfg.tokens[0]!.exit.stopLossPct).toBe(15);
    expect(cfg.tokens[0]!.entry.minUnderperformanceVsSol).toBe(0.05);
  });

  it('normalises buyAmountSol to an exact decimal string', () => {
    const cfg = parseConfig({ global: {}, tokens: [token()] });
    expect(cfg.tokens[0]!.buyAmountSol).toBe('0.5');
  });

  it('defaults mode to backtest, never live', () => {
    expect(parseConfig({ global: {}, tokens: [token()] }).global.mode).toBe('backtest');
  });

  it('rejects an empty token list', () => {
    expect(() => parseConfig({ global: {}, tokens: [] })).toThrow(ConfigError);
  });

  it('rejects a non-base58 address', () => {
    expect(() => parseConfig({ global: {}, tokens: [token({ address: 'not-an-address!' })] }))
      .toThrow(ConfigError);
  });

  it('rejects duplicate tokens', () => {
    expect(() => parseConfig({ global: {}, tokens: [token(), token()] })).toThrow(
      /duplicate token address/,
    );
  });

  it('rejects oversold >= overbought', () => {
    expect(() =>
      parseConfig({ global: {}, tokens: [token({ rsi: { period: 14, oversold: 70, overbought: 30 } })] }),
    ).toThrow(ConfigError);
  });

  it('enforces the 1% hard ceiling on pool liquidity share', () => {
    expect(() =>
      parseConfig({ global: {}, tokens: [token({ limits: { maxPctOfPoolLiquidity: 2 } })] }),
    ).toThrow(ConfigError);
  });

  it('rejects per-token allocation above total deployed capital', () => {
    expect(() =>
      parseConfig({
        global: { maxDeployedCapitalPct: 10, maxAllocationPerTokenPct: 50 },
        tokens: [token()],
      }),
    ).toThrow(/maxDeployedCapitalPct/);
  });

  it('reports every problem at once rather than the first', () => {
    try {
      parseConfig({ global: {}, tokens: [token({ symbol: '', timeframe: '3h' })] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ConfigError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('loads and validates the shipped default config', () => {
    const cfg = loadConfig('config/default.yaml');
    expect(cfg.global.mode).toBe('backtest');
    expect(cfg.tokens.length).toBeGreaterThan(0);
  });
});

describe('pool pinning (DECISIONS §29/§30)', () => {
  const POOL = 'C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg';

  it('is optional — omitting it leaves discovery/dominance comparison in play', () => {
    const cfg = parseConfig({ global: {}, tokens: [token()] });
    expect(cfg.tokens[0]!.pinnedPoolAddress).toBeUndefined();
    expect(cfg.global.solReferencePoolAddress).toBeUndefined();
  });

  it('accepts a pinned pool address per token and a shared SOL reference pool', () => {
    const cfg = parseConfig({
      global: { solReferencePoolAddress: POOL },
      tokens: [token({ pinnedPoolAddress: POOL })],
    });
    expect(cfg.tokens[0]!.pinnedPoolAddress).toBe(POOL);
    expect(cfg.global.solReferencePoolAddress).toBe(POOL);
  });

  it('rejects a pinned pool address that is not a valid base58 Solana address', () => {
    expect(() => parseConfig({
      global: {}, tokens: [token({ pinnedPoolAddress: 'not-an-address' })],
    })).toThrow(ConfigError);
  });
});

describe('live trading gate', () => {
  const live = () => parseConfig({ global: { mode: 'live' }, tokens: [token()] });

  it('refuses live mode without LIVE_TRADING=true', () => {
    expect(() => assertLiveTradingAllowed(live(), {})).toThrow(/Refusing to arm live/);
    expect(() => assertLiveTradingAllowed(live(), { LIVE_TRADING: 'false' })).toThrow();
    expect(() => assertLiveTradingAllowed(live(), { LIVE_TRADING: 'TRUE' })).toThrow();
    expect(() => assertLiveTradingAllowed(live(), { LIVE_TRADING: '1' })).toThrow();
  });

  it('allows live only with the exact flag', () => {
    expect(() => assertLiveTradingAllowed(live(), { LIVE_TRADING: 'true' })).not.toThrow();
  });

  it('is a no-op for non-live modes', () => {
    const cfg = parseConfig({ global: { mode: 'paper' }, tokens: [token()] });
    expect(() => assertLiveTradingAllowed(cfg, {})).not.toThrow();
  });
});
