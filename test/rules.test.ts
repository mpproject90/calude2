import { describe, it, expect } from 'vitest';
import type { Candle, IndicatorValue } from '../src/types/index.js';
import { parseConfig } from '../src/config/load.js';
import type { TokenConfig } from '../src/config/schema.js';
import {
  crossedUpThrough, crossedDownThrough, wasOverboughtWithin, hasBullishDivergence,
} from '../src/rules/conditions.js';
import { evaluateEntry } from '../src/rules/entry.js';
import { evaluateExit, stopLossPriceFor, timeExitIndexFor, type OpenPosition } from '../src/rules/exit.js';
import { checkPortfolioLimits, rollingDailyLoss } from '../src/rules/portfolio.js';
import { pass as filterPass, fail as filterFail } from '../src/filters/types.js';
import { sol } from '../src/util/amount.js';

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function tokenCfg(over: Record<string, unknown> = {}): TokenConfig {
  return parseConfig({
    global: {},
    tokens: [{
      address: JUP, symbol: 'JUP', tier: 'A', timeframe: '1h', buyAmountSol: 0.5,
      rsi: { period: 14, oversold: 30, overbought: 70 },
      mfi: { period: 14, threshold: 30 },
      entry: {}, exit: {}, limits: {}, ...over,
    }],
  }).tokens[0]!;
}

const R = (v: number, reliable = true): IndicatorValue =>
  reliable ? { value: v, reliable: true } : { value: v, reliable: false, reason: 'insufficient-warmup' };

function bars(closes: number[], lows?: number[]): Candle[] {
  return closes.map((c, i) => ({
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: c, high: c + 1, low: lows?.[i] ?? c - 1, close: c, volume: 1000,
  }));
}

describe('cross detection', () => {
  const s = [R(35), R(28), R(25), R(31), R(40)];

  it('detects a cross UP through the level', () => {
    expect(crossedUpThrough(s, 3, 30)).toBe(true);   // 25 -> 31
    expect(crossedUpThrough(s, 2, 30)).toBe(false);  // 28 -> 25, still below
    expect(crossedUpThrough(s, 4, 30)).toBe(false);  // 31 -> 40, already above
  });

  it('does not fire on the drop below — knife-catching is the thing we avoid', () => {
    expect(crossedUpThrough(s, 1, 30)).toBe(false);  // 35 -> 28 is the drop
    expect(crossedDownThrough(s, 1, 30)).toBe(true);
  });

  it('cannot cross at index 0', () => {
    expect(crossedUpThrough(s, 0, 30)).toBe(false);
  });
});

describe('prior overbought window', () => {
  it('finds a pump strictly before the current bar', () => {
    const s = [R(75), R(50), R(28), R(31)];
    expect(wasOverboughtWithin(s, 3, 50, 70)).toBe(true);
  });

  it('does not count the current bar itself', () => {
    const s = [R(50), R(50), R(50), R(75)];
    expect(wasOverboughtWithin(s, 3, 50, 70)).toBe(false);
  });

  it('respects the window length', () => {
    const s = [R(75), ...new Array(60).fill(R(50))];
    expect(wasOverboughtWithin(s, 60, 50, 70)).toBe(false); // pump is 60 bars back
    expect(wasOverboughtWithin(s, 60, 70, 70)).toBe(true);
  });
});

describe('bullish divergence', () => {
  it('detects a lower price low against a higher RSI low', () => {
    const closes = [50, 40, 45, 42, 38, 44, 46, 48];
    const lows =   [49, 30, 44, 41, 32, 43, 45, 47]; // recent low 32 > older low 30? no: 32 > 30
    const rsi = [R(50), R(20), R(40), R(38), R(28), R(45), R(50), R(55)];
    // older half low = 30 (rsi 20), recent half low = 32 (rsi 28) -> price NOT lower
    expect(hasBullishDivergence(bars(closes, lows), rsi, 7, 8)).toBe(false);
  });

  it('fires when price makes a lower low but RSI does not', () => {
    const closes = [50, 40, 45, 42, 38, 44, 46, 48];
    const lows =   [49, 30, 44, 41, 28, 43, 45, 47]; // recent low 28 < older low 30
    const rsi = [R(50), R(20), R(40), R(38), R(25), R(45), R(50), R(55)];
    expect(hasBullishDivergence(bars(closes, lows), rsi, 7, 8)).toBe(true);
  });

  it('returns false without enough history', () => {
    expect(hasBullishDivergence(bars([1, 2]), [R(1), R(2)], 1, 8)).toBe(false);
  });
});

describe('entry rule', () => {
  const cfg = tokenCfg();
  // A textbook setup: pump, dip below 30, cross back up on the last bar.
  const rsi = [R(75), R(60), R(45), R(25), R(32)];
  const mfi = [R(60), R(50), R(35), R(20), R(25)];
  const candles = bars([10, 9, 8, 7, 7.5]);
  const okFilters = [filterPass('regime', 'ok'), filterPass('cost-floor', 'ok')];

  it('enters when every condition passes', () => {
    const d = evaluateEntry({ candles, index: 4, rsi, mfi, token: cfg, filters: okFilters });
    expect(d.enter).toBe(true);
    expect(d.blockedBy).toBeNull();
  });

  it('refuses to trade on unreliable indicators, whatever else is true', () => {
    const cold = [...rsi.slice(0, 4), R(32, false)];
    const d = evaluateEntry({ candles, index: 4, rsi: cold, mfi, token: cfg, filters: okFilters });
    expect(d.enter).toBe(false);
    expect(d.blockedBy!.name).toBe('indicators-reliable');
  });

  it('requires a prior overbought cycle', () => {
    const noPump = [R(50), R(50), R(45), R(25), R(32)];
    const d = evaluateEntry({ candles, index: 4, rsi: noPump, mfi, token: cfg, filters: okFilters });
    expect(d.enter).toBe(false);
    expect(d.blockedBy!.name).toBe('prior-overbought');
  });

  it('does not enter on the drop below oversold, only on the cross up', () => {
    const d = evaluateEntry({ candles, index: 3, rsi, mfi, token: cfg, filters: okFilters });
    expect(d.enter).toBe(false);
    expect(d.checks.find((c) => c.name === 'rsi-cross-up')!.pass).toBe(false);
  });

  it('treats MFI as confirmation — it cannot trigger an entry alone', () => {
    const noCross = [R(75), R(60), R(45), R(45), R(45)];
    const d = evaluateEntry({ candles, index: 4, rsi: noCross, mfi, token: cfg, filters: okFilters });
    expect(d.enter).toBe(false);
    expect(d.checks.find((c) => c.name === 'mfi-confirmation')!.pass).toBe(true);
  });

  it('blocks when MFI does not confirm', () => {
    const hot = [R(60), R(50), R(35), R(20), R(80)];
    const d = evaluateEntry({ candles, index: 4, rsi, mfi: hot, token: cfg, filters: okFilters });
    expect(d.enter).toBe(false);
    expect(d.blockedBy!.name).toBe('mfi-confirmation');
  });

  it('blocks when any §6 filter fails', () => {
    const d = evaluateEntry({
      candles, index: 4, rsi, mfi, token: cfg,
      filters: [filterPass('regime', 'ok'), filterFail('relative-strength', 'correlation not dislocation')],
    });
    expect(d.enter).toBe(false);
    expect(d.blockedBy!.name).toBe('filter:relative-strength');
  });

  it('requires divergence when the flag is set', () => {
    const strict = tokenCfg({ entry: { requireDivergence: true } });
    const d = evaluateEntry({ candles, index: 4, rsi, mfi, token: strict, filters: okFilters });
    expect(d.checks.some((c) => c.name === 'bullish-divergence')).toBe(true);
    expect(d.enter).toBe(false);
  });

  it('records every check so rejections can be counted per condition', () => {
    const d = evaluateEntry({ candles, index: 4, rsi, mfi, token: cfg, filters: okFilters });
    const names = d.checks.map((c) => c.name);
    expect(names).toContain('indicators-reliable');
    expect(names).toContain('prior-overbought');
    expect(names).toContain('rsi-cross-up');
    expect(names).toContain('mfi-confirmation');
    expect(names).toContain('filter:regime');
  });
});

describe('exit rules', () => {
  const cfg = tokenCfg();
  const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
    entryPrice: 100, entryIndex: 0, peakPrice: 100, trailingArmed: false,
    stopLossPrice: stopLossPriceFor(100, 15), ...over,
  });

  it('writes a stop and a time exit at fill time', () => {
    expect(stopLossPriceFor(100, 15)).toBeCloseTo(85, 10);
    expect(timeExitIndexFor(10, 48)).toBe(58);
  });

  it('fires the stop-loss first', () => {
    const c = bars([100, 84]);
    const d = evaluateExit({ candles: c, index: 1, rsi: [R(50), R(80)], token: cfg, position: position() });
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('stop_loss');   // beats the RSI-70 condition also true here
  });

  it('fires the time exit once the holding limit is reached', () => {
    const c = bars(new Array(50).fill(100));
    const d = evaluateExit({ candles: c, index: 48, rsi: new Array(50).fill(R(50)), token: cfg, position: position() });
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('time');
  });

  it('fires the RSI recovery exit — and does so underwater, as designed', () => {
    const c = bars([100, 90]);
    const d = evaluateExit({ candles: c, index: 1, rsi: [R(20), R(75)], token: cfg, position: position() });
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('rsi_recovery');
    expect(d.context['gainPct'] as number).toBeCloseTo(-10, 10);
    expect(d.detail).toMatch(/underwater/);
  });

  it('will not exit on an unreliable RSI', () => {
    const c = bars([100, 101]);
    const d = evaluateExit({ candles: c, index: 1, rsi: [R(20), R(90, false)], token: cfg, position: position() });
    expect(d.exit).toBe(false);
  });

  it('arms and then fires the trailing stop', () => {
    const trail = tokenCfg({ exit: { trailingStop: { enabled: true, activateAtPct: 20, trailPct: 10 } } });
    const c = bars([100, 125, 110]);
    const rsi = [R(50), R(50), R(50)];
    let pos = position();
    const step1 = evaluateExit({ candles: c, index: 1, rsi, token: trail, position: pos });
    expect(step1.exit).toBe(false);
    expect(step1.nextPosition.trailingArmed).toBe(true);
    expect(step1.nextPosition.peakPrice).toBe(125);
    pos = step1.nextPosition;
    const step2 = evaluateExit({ candles: c, index: 2, rsi, token: trail, position: pos });
    expect(step2.exit).toBe(true);
    expect(step2.reason).toBe('trailing');   // 110 < 125 * 0.9 = 112.5
  });

  it('does not trail before the activation gain', () => {
    const trail = tokenCfg({ exit: { trailingStop: { enabled: true, activateAtPct: 20, trailPct: 10 } } });
    const c = bars([100, 105, 94]);
    const rsi = [R(50), R(50), R(50)];
    const step1 = evaluateExit({ candles: c, index: 1, rsi, token: trail, position: position() });
    expect(step1.nextPosition.trailingArmed).toBe(false);
    const step2 = evaluateExit({ candles: c, index: 2, rsi, token: trail, position: step1.nextPosition });
    expect(step2.exit).toBe(false);
  });

  it('reports an intrabar stop breach the close-only rule misses', () => {
    const c = bars([100, 90], [100, 80]);   // low 80 pierced the 85 stop, close 90 did not
    const d = evaluateExit({ candles: c, index: 1, rsi: [R(50), R(50)], token: cfg, position: position() });
    expect(d.exit).toBe(false);
    expect(d.context['intrabarStopBreach']).toBe(true);
  });

  it('lets a safety breach override everything', () => {
    const c = bars([100, 120]);
    const d = evaluateExit({
      candles: c, index: 1, rsi: [R(50), R(50)], token: cfg,
      position: position(), safetyBreach: true,
    });
    expect(d.reason).toBe('safety');
  });

  it('holds when nothing triggers', () => {
    const c = bars([100, 101]);
    const d = evaluateExit({ candles: c, index: 1, rsi: [R(50), R(50)], token: cfg, position: position() });
    expect(d.exit).toBe(false);
    expect(d.reason).toBeNull();
  });
});

describe('portfolio limits', () => {
  const limits = {
    maxConcurrentPositions: 3, dailyLossLimitPct: 10, maxDeployedCapitalPct: 50,
    maxAllocationPerTokenPct: 20, cooldownCandlesAfterLoss: 24,
  };
  const base = {
    limits, token: JUP, proposedSizeSol: sol('1'),
    nowMs: 1_700_000_000_000, currentIndex: 100,
  };
  const state = (over: Record<string, unknown> = {}) => ({
    openPositions: [], walletBalanceSol: sol('10'), recentClosed: [], ...over,
  });

  const failures = (r: ReturnType<typeof checkPortfolioLimits>) =>
    r.filter((x) => !x.pass).map((x) => x.reason);

  it('passes a clean portfolio', () => {
    expect(failures(checkPortfolioLimits({ ...base, state: state() }))).toHaveLength(0);
  });

  it('blocks at the concurrent position limit', () => {
    const open = [1, 2, 3].map((i) => ({ token: `t${i}`, costSol: sol('0.1') }));
    const r = checkPortfolioLimits({ ...base, state: state({ openPositions: open }) });
    expect(failures(r).some((m) => /already holding 3/.test(m))).toBe(true);
  });

  it('sums a rolling 24h realized loss and ignores older trades', () => {
    const closed = [
      { token: JUP, closedAt: base.nowMs - 1000, closedIndex: 1, realizedPnlSol: sol('0').sub(sol('0.5')) },
      { token: JUP, closedAt: base.nowMs - 1000, closedIndex: 2, realizedPnlSol: sol('0').sub(sol('0.3')) },
      { token: JUP, closedAt: base.nowMs - 90_000_000, closedIndex: 3, realizedPnlSol: sol('0').sub(sol('5')) },
      { token: JUP, closedAt: base.nowMs - 2000, closedIndex: 4, realizedPnlSol: sol('2') },
    ];
    expect(rollingDailyLoss(closed, base.nowMs).toString()).toBe('0.8');
  });

  it('blocks new entries once the daily loss limit is breached', () => {
    // 10% of 10 SOL = 1 SOL cap
    const closed = [{ token: 'x', closedAt: base.nowMs - 1000, closedIndex: 1,
                      realizedPnlSol: sol('0').sub(sol('1.5')) }];
    const r = checkPortfolioLimits({ ...base, state: state({ recentClosed: closed }) });
    expect(failures(r).some((m) => /daily loss/.test(m))).toBe(true);
  });

  it('blocks when total deployed capital would exceed the cap', () => {
    const open = [{ token: 'x', costSol: sol('4.5') }];
    const r = checkPortfolioLimits({ ...base, state: state({ openPositions: open }) });
    expect(failures(r).some((m) => /deployed capital|would exceed the 50%/.test(m))).toBe(true);
  });

  it('blocks when per-token allocation would exceed the cap', () => {
    // 20% of 10 SOL = 2 SOL; already 1.5 in JUP, proposing 1 more
    const open = [{ token: JUP, costSol: sol('1.5') }];
    const r = checkPortfolioLimits({ ...base, state: state({ openPositions: open }) });
    expect(failures(r).some((m) => /allocation to/.test(m))).toBe(true);
  });

  it('enforces a cooldown after a losing trade in the same token', () => {
    const closed = [{ token: JUP, closedAt: base.nowMs - 1000, closedIndex: 90,
                      realizedPnlSol: sol('0').sub(sol('0.1')) }];
    const r = checkPortfolioLimits({ ...base, state: state({ recentClosed: closed }) });
    expect(failures(r).some((m) => /cooling down/.test(m))).toBe(true);
  });

  it('allows re-entry once the cooldown has elapsed', () => {
    const closed = [{ token: JUP, closedAt: base.nowMs - 1000, closedIndex: 50,
                      realizedPnlSol: sol('0').sub(sol('0.1')) }];
    const r = checkPortfolioLimits({ ...base, state: state({ recentClosed: closed }) });
    expect(failures(r).some((m) => /cooling down/.test(m))).toBe(false);
  });

  it('does not cool down after a winning trade', () => {
    const closed = [{ token: JUP, closedAt: base.nowMs - 1000, closedIndex: 99,
                      realizedPnlSol: sol('0.1') }];
    const r = checkPortfolioLimits({ ...base, state: state({ recentClosed: closed }) });
    expect(failures(r).some((m) => /cooling down/.test(m))).toBe(false);
  });
});
