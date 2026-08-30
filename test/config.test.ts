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

  it('rejects a config with neither tokens nor positions — nothing to do', () => {
    expect(() => parseConfig({ global: {}, tokens: [], positions: [] })).toThrow(ConfigError);
  });

  it('accepts an empty token list when positions[] carries the config instead (DECISIONS §39)', () => {
    const cfg = parseConfig({
      global: {}, tokens: [],
      positions: [{
        address: JUP, symbol: 'JUP', decimals: 6, buyAmountSol: '0.5', limitPrice: 0.8,
        ladder: { tranches: [{ targetGainPct: 15, sellPct: 100 }] },
      }],
    });
    expect(cfg.tokens).toHaveLength(0);
    expect(cfg.positions).toHaveLength(1);
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
    // mode is 'paper' during the DECISIONS §41 soak test — a non-trading
    // mode, same category as 'backtest' per spec §2.3; update this
    // assertion when the config's active mode changes again.
    const cfg = loadConfig('config/default.yaml');
    expect(cfg.global.mode).toBe('paper');
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

describe('execution policy (DECISIONS §42) — config alone never enables anything, see gate.ts', () => {
  it('applies sane defaults when omitted', () => {
    const cfg = parseConfig({ global: {}, tokens: [token()] });
    expect(cfg.global.execution).toEqual({
      maxSlippageCapPct: 2, maxPriorityFeeLamports: 100_000,
      killSwitchPath: 'data/LIVE_KILL_SWITCH', balanceReconcileIntervalMinutes: 15,
      balanceReconcileToleranceSol: '0.001',
    });
  });

  it('accepts an explicit override', () => {
    const cfg = parseConfig({
      global: { execution: { maxSlippageCapPct: 0.5, maxPriorityFeeLamports: 50_000 } },
      tokens: [token()],
    });
    expect(cfg.global.execution.maxSlippageCapPct).toBe(0.5);
    expect(cfg.global.execution.maxPriorityFeeLamports).toBe(50_000);
  });

  it('rejects a non-positive slippage cap', () => {
    expect(() => parseConfig({ global: { execution: { maxSlippageCapPct: 0 } }, tokens: [token()] }))
      .toThrow(ConfigError);
  });
});

describe('manual positions — price-triggered entry/exit (DECISIONS §39)', () => {
  const position = (over: Record<string, unknown> = {}) => ({
    address: JUP, symbol: 'JUP', decimals: 6, buyAmountSol: '0.5', limitPrice: 0.8,
    ladder: { tranches: [{ targetGainPct: 15, sellPct: 50 }, { targetGainPct: 30, sellPct: 50 }] },
    ...over,
  });

  it('applies ladder defaults: no trailing, 15% stop, 2880-minute time exit, 5%/20% economic thresholds', () => {
    const cfg = parseConfig({ global: {}, tokens: [], positions: [position()] });
    const p = cfg.positions[0]!;
    expect(p.ladder.trailing).toEqual({ enabled: false, trailPct: 10 });
    expect(p.ladder.stopLossPct).toBe(15);
    expect(p.ladder.timeExitMinutes).toBe(2880);
    expect(p.ladder.minNetFloorPct).toBe(5);
    expect(p.ladder.maxFixedCostPctOfProceeds).toBe(20);
  });

  it('rejects tranches not in strictly ascending targetGainPct order', () => {
    expect(() => parseConfig({
      global: {}, tokens: [],
      positions: [position({ ladder: { tranches: [{ targetGainPct: 30, sellPct: 50 }, { targetGainPct: 15, sellPct: 50 }] } })],
    })).toThrow(ConfigError);
    expect(() => parseConfig({
      global: {}, tokens: [],
      positions: [position({ ladder: { tranches: [{ targetGainPct: 15, sellPct: 50 }, { targetGainPct: 15, sellPct: 50 }] } })],
    })).toThrow(ConfigError);   // equal targets rejected too — "strictly" ascending
  });

  it('rejects tranche sellPct summing over 100%', () => {
    expect(() => parseConfig({
      global: {}, tokens: [],
      positions: [position({ ladder: { tranches: [{ targetGainPct: 15, sellPct: 60 }, { targetGainPct: 30, sellPct: 60 }] } })],
    })).toThrow(ConfigError);
  });

  it('allows tranche sellPct summing under 100% — a runner held open', () => {
    const cfg = parseConfig({
      global: {}, tokens: [],
      positions: [position({ ladder: { tranches: [{ targetGainPct: 15, sellPct: 40 }] } })],
    });
    expect(cfg.positions[0]!.ladder.tranches).toHaveLength(1);
  });

  it('rejects duplicate position addresses', () => {
    expect(() => parseConfig({ global: {}, tokens: [], positions: [position(), position()] }))
      .toThrow(ConfigError);
  });

  it('rejects a non-positive limit price', () => {
    expect(() => parseConfig({ global: {}, tokens: [], positions: [position({ limitPrice: 0 })] }))
      .toThrow(ConfigError);
  });

  it('has no tier field — token selection is manual, the automated-scanner gate does not apply', () => {
    const cfg = parseConfig({ global: {}, tokens: [], positions: [position()] });
    expect('tier' in cfg.positions[0]!).toBe(false);
  });

  it('requires decimals (DECISIONS §41 follow-up — Jupiter sell-side quotes need the mint\'s real decimals)', () => {
    const { decimals: _decimals, ...noDecimals } = position();
    expect(() => parseConfig({ global: {}, tokens: [], positions: [noDecimals] })).toThrow(ConfigError);
  });

  it('has no pinnedPoolAddress field — removed with the pool-candle price feed (DECISIONS §41 follow-up)', () => {
    const cfg = parseConfig({ global: {}, tokens: [], positions: [position()] });
    expect('pinnedPoolAddress' in cfg.positions[0]!).toBe(false);
  });
});
