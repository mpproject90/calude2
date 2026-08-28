import { describe, it, expect } from 'vitest';
import type { Candle, IndicatorValue } from '../src/types/index.js';
import { parseConfig } from '../src/config/load.js';
import type { TokenConfig } from '../src/config/schema.js';
import {
  crossedUpThrough, crossedDownThrough, wasOverboughtWithin, hasBullishDivergence,
} from '../src/rules/conditions.js';
import { evaluateEntry } from '../src/rules/entry.js';
import {
  evaluateExit, evaluateIntrabarStops, stopLossPriceFor, timeExitIndexFor,
  type OpenPosition,
} from '../src/rules/exit.js';
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
  const SLIP = 0.5;
  const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
    entryPrice: 100, entryIndex: 0, peakPrice: 100, trailingArmed: false,
    stopLossPrice: stopLossPriceFor(100, 15), ...over,
  });
  const run = (candles: Candle[], index: number, rsi: IndicatorValue[],
               token = cfg, pos = position(), safetyBreach?: boolean) =>
    evaluateExit({ candles, index, rsi, token, position: pos,
                   exitSlippagePct: SLIP, ...(safetyBreach === undefined ? {} : { safetyBreach }) });

  it('writes a stop and a time exit at fill time', () => {
    expect(stopLossPriceFor(100, 15)).toBeCloseTo(85, 10);
    expect(timeExitIndexFor(10, 48)).toBe(58);
  });

  it('STOPS OUT INTRABAR even when the close recovered above the stop', () => {
    // low 80 pierced the 85 stop; close 90 did not. A close-only rule misses this.
    const c = bars([100, 90], [100, 80]);
    const d = run(c, 1, [R(50), R(50)]);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('stop_loss');
  });

  it('fills a stop at the stop price less slippage, never at the close', () => {
    const c = bars([100, 90], [100, 80]);
    const d = run(c, 1, [R(50), R(50)]);
    expect(d.fillPrice).toBeCloseTo(85 * (1 - SLIP / 100), 10);   // 84.575
    expect(d.fillPrice).not.toBeCloseTo(90, 5);
    expect(d.context['realizedPct'] as number).toBeCloseTo(-15.425, 8);
  });

  it('still reports intrabarStopBreach so the old behaviour can be costed', () => {
    const c = bars([100, 90], [100, 80]);
    expect(run(c, 1, [R(50), R(50)]).context['intrabarStopBreach']).toBe(true);
  });

  it('does not stop out when the low stayed above the stop', () => {
    const c = bars([100, 95], [100, 90]);
    const d = run(c, 1, [R(50), R(50)]);
    expect(d.exit).toBe(false);
    expect(d.context['intrabarStopBreach']).toBe(false);
  });

  it('lets safety override even a triggered stop', () => {
    const c = bars([100, 80], [100, 70]);
    expect(run(c, 1, [R(50), R(50)], cfg, position(), true).reason).toBe('safety');
  });

  it('puts the stop ahead of the RSI exit', () => {
    const c = bars([100, 84], [100, 80]);
    expect(run(c, 1, [R(50), R(80)]).reason).toBe('stop_loss');
  });

  describe('priority: time is last', () => {
    const trail = tokenCfg({
      exit: { timeExitCandles: 1, trailingStop: { enabled: true, activateAtPct: 20, trailPct: 10 } },
    });

    it('prefers the trailing stop over a time exit due on the same bar', () => {
      // armed at entry, peak 130 intrabar, low 110 breaches the 117 trail
      const c = bars([100, 115], [100, 110]);
      const withHigh = c.map((b, i) => (i === 1 ? { ...b, high: 130 } : b));
      const d = run(withHigh, 1, [R(50), R(50)], trail, position({ peakPrice: 100 }));
      expect(d.reason).toBe('trailing');
    });

    it('prefers the RSI exit over a time exit due on the same bar', () => {
      const c = bars([100, 120]);
      const d = run(c, 1, [R(50), R(75)], trail);
      expect(d.reason).toBe('rsi_recovery');
    });

    it('falls back to the time exit when no profit exit fired', () => {
      const c = bars([100, 101]);
      const d = run(c, 1, [R(50), R(50)], trail);
      expect(d.reason).toBe('time');
      expect(d.fillPrice).toBe(101);
    });
  });

  it('fires the RSI recovery exit underwater, as designed', () => {
    const c = bars([100, 90], [100, 88]);
    const d = run(c, 1, [R(20), R(75)]);
    expect(d.reason).toBe('rsi_recovery');
    expect(d.context['gainPct'] as number).toBeCloseTo(-10, 10);
    expect(d.detail).toMatch(/underwater/);
  });

  it('will not exit on an unreliable RSI', () => {
    const c = bars([100, 101]);
    expect(run(c, 1, [R(20), R(90, false)]).exit).toBe(false);
  });

  it('arms trailing from the bar HIGH, then fires against the bar LOW', () => {
    const trail = tokenCfg({
      exit: { trailingStop: { enabled: true, activateAtPct: 20, trailPct: 10 } },
    });
    // one bar: high 125 arms (+25%) and sets the peak; low 110 breaches 112.5
    const c = [{ timestamp: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
               { timestamp: 3_600_000, open: 100, high: 125, low: 110, close: 118, volume: 1 }];
    const d = run(c, 1, [R(50), R(50)], trail);
    expect(d.reason).toBe('trailing');
    expect(d.context['peakPrice']).toBe(125);
    expect(d.fillPrice).toBeCloseTo(112.5 * (1 - SLIP / 100), 8);
  });

  it('does not trail before the activation gain is reached', () => {
    const trail = tokenCfg({
      exit: { trailingStop: { enabled: true, activateAtPct: 20, trailPct: 10 } },
    });
    const c = [{ timestamp: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
               { timestamp: 3_600_000, open: 100, high: 105, low: 92, close: 94, volume: 1 }];
    const d = run(c, 1, [R(50), R(50)], trail);
    expect(d.exit).toBe(false);
    expect(d.nextPosition.trailingArmed).toBe(false);
  });

  it('holds when nothing triggers', () => {
    const c = bars([100, 101]);
    const d = run(c, 1, [R(50), R(50)]);
    expect(d.exit).toBe(false);
    expect(d.reason).toBeNull();
    expect(d.fillPrice).toBeNull();
  });

  describe('live tick evaluation', () => {
    // In live mode the poller passes the same tick as both low and high, so the
    // stop is evaluated independently of any candle boundary.
    const tick = (price: number, pos = position(), token = cfg) =>
      evaluateIntrabarStops({
        token, position: pos, window: { low: price, high: price }, exitSlippagePct: SLIP,
      });

    it('triggers on a tick below the stop, with no candle involved', () => {
      const r = tick(84.9);
      expect(r.trigger?.reason).toBe('stop_loss');
      expect(r.trigger?.fillPrice).toBeCloseTo(85 * (1 - SLIP / 100), 10);
    });

    it('does not trigger on a tick above the stop', () => {
      expect(tick(85.1).trigger).toBeNull();
    });

    it('arms trailing from ticks and fires on a later tick', () => {
      const trail = tokenCfg({
        exit: { trailingStop: { enabled: true, activateAtPct: 20, trailPct: 10 } },
      });
      const up = tick(130, position(), trail);
      expect(up.trigger).toBeNull();
      expect(up.nextPosition.trailingArmed).toBe(true);
      expect(up.nextPosition.peakPrice).toBe(130);
      const down = tick(116, up.nextPosition, trail);   // 130 * 0.9 = 117
      expect(down.trigger?.reason).toBe('trailing');
    });
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
