/**
 * Config schema (spec §13). Validated on load; invalid config is rejected
 * loudly at startup rather than failing at runtime.
 */
import { z } from 'zod';
import { INTERVALS } from '../types/index.js';

const interval = z.enum(INTERVALS);
const pct = z.number().positive().max(100);

/** Accepts 0.5 or "0.5"; always stored as an exact decimal string so that
 *  TokenAmount can parse it without a float ever being involved. */
const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((s) => /^\d+(\.\d+)?$/.test(s), {
    message: 'must be a non-negative decimal number',
  });

const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'not a base58 Solana address');

export const rsiSchema = z
  .object({
    period: z.number().int().min(2).max(200).default(14),
    oversold: z.number().min(1).max(99).default(30),
    overbought: z.number().min(1).max(99).default(70),
  })
  .refine((v) => v.oversold < v.overbought, {
    message: 'rsi.oversold must be below rsi.overbought',
  });

export const mfiSchema = z.object({
  period: z.number().int().min(2).max(200).default(14),
  threshold: z.number().min(1).max(99).default(30),
});

export const entrySchema = z.object({
  /** §7.1 — RSI must have been overbought within this many candles. */
  priorOverboughtWithinCandles: z.number().int().positive().default(50),
  /** §7.4 — when true, bullish divergence becomes a REQUIRED condition. */
  requireDivergence: z.boolean().default(false),
  /**
   * §6.2 — the token must UNDERPERFORM SOL by at least this much, as a decimal
   * fraction of return: entry requires `tokenReturn - solReturn <= -value`.
   * 0.05 means 5 percentage points of underperformance.
   *
   * Named for the sign convention deliberately: "threshold" left it ambiguous
   * whether a larger number was stricter or looser.
   *
   * KNOWN LIMITATION: this is a raw percentage-point difference and ignores
   * beta. A token that habitually moves ~1.4x SOL will show "underperformance"
   * on any SOL drawdown purely from its higher beta. Token and SOL returns are
   * logged separately on every evaluation so beta can be estimated from
   * backtest data and this filter revisited if discrimination is poor.
   */
  minUnderperformanceVsSol: z.number().min(0).max(1).default(0.05),
  /** §6.2 — lookback in candles for the token-vs-SOL return comparison. */
  relativeStrengthLookback: z.number().int().positive().default(24),
});

/**
 * Bootstrap estimate of the move this signal is expected to capture, used ONLY
 * by the cost-floor gate (§6.3). The original spec called for a hand-set
 * percentage; a guessed constant gating real trades is worse than a
 * volatility-scaled one, so the expected move is derived as
 * `atrMultiplier * ATR(atrPeriod) / price`.
 *
 * This is a placeholder. After phase 1 the backtest's median Maximum Favorable
 * Excursion per token is the empirical expected move and replaces it.
 */
export const expectedMoveSchema = z.object({
  atrPeriod: z.number().int().min(2).max(200).default(14),
  atrMultiplier: z.number().positive().max(20).default(2.0),
});

export const trailingStopSchema = z.object({
  enabled: z.boolean().default(false),
  activateAtPct: pct.default(20),
  trailPct: pct.default(10),
});

export const exitSchema = z.object({
  stopLossPct: pct.default(15),
  timeExitCandles: z.number().int().positive().default(48),
  rsiExitLevel: z.number().min(1).max(99).default(70),
  trailingStop: trailingStopSchema.default({
    enabled: false,
    activateAtPct: 20,
    trailPct: 10,
  }),
});

export const limitsSchema = z.object({
  /** §6.4 — hard ceiling of 1% is enforced by the schema itself. */
  maxPctOfPoolLiquidity: z.number().positive().max(1).default(0.5),
  cooldownCandlesAfterLoss: z.number().int().min(0).default(24),
  /** §6.4 — skip rather than trade dust if the cap shrinks size below this. */
  minViableBuyAmountSol: decimalString.default('0.05'),
});

export const tokenSchema = z.object({
  address: solanaAddress,
  symbol: z.string().min(1).max(20),
  tier: z.enum(['A', 'B']),
  timeframe: interval,
  buyAmountSol: decimalString,
  rsi: rsiSchema,
  mfi: mfiSchema,
  entry: entrySchema,
  exit: exitSchema,
  limits: limitsSchema,
  expectedMove: expectedMoveSchema.default({ atrPeriod: 14, atrMultiplier: 2.0 }),
});

/** §6.1 Tier A gates. */
export const tierAGatesSchema = z.object({
  minLiquidityUsd: z.number().positive().default(250_000),
  minVolume24hUsd: z.number().positive().default(500_000),
  minAgeDays: z.number().min(0).default(30),
});

/**
 * §6.1 Tier B gates — everything in A, plus the on-chain safety checks.
 *
 * DEFERRED. Tier B is not built: honest Tier B backtesting requires a
 * survivorship-bias-free memecoin dataset including tokens that went to zero,
 * which is not obtainable from the free data sources this project uses. An
 * unvalidatable tier will not be traded. The schema is retained so the shape
 * is settled if we later pay for historical data; nothing reads it today and
 * a tier: B token is rejected at config load.
 */
export const tierBGatesSchema = tierAGatesSchema.extend({
  /** Max tolerated LP decline over the trailing window. Hard block on breach. */
  maxLpDeclinePct: z.number().positive().default(10),
  lpTrendWindowMinutes: z.number().int().positive().default(20),
  requireMintAuthorityRevoked: z.boolean().default(true),
  requireFreezeAuthorityRevoked: z.boolean().default(true),
  requireLpBurnedOrLocked: z.boolean().default(true),
  maxTop10HolderPct: z.number().positive().max(100).default(30),
  /** §6.1 — N prior >70 → <30 → >50 cycles required. */
  minPriorCycles: z.number().int().min(0).default(1),
  /** §6.1 — re-run safety checks this often while a position is open. */
  recheckIntervalMinutes: z.number().int().positive().default(5),
});

/** §6.3 Cost floor. */
export const costFloorSchema = z.object({
  dexFeePct: z.number().min(0).default(0.25),
  priorityFeeSol: decimalString.default('0.0005'),
  jitoTipSol: decimalString.default('0.0001'),
  /** Signal is rejected unless target move exceeds round-trip cost by this multiple. */
  minTargetToCostRatio: z.number().min(1).default(3),
  /** Fallback slippage when historical pool liquidity is unavailable (§10). */
  fallbackSlippagePct: z.number().min(0).default(1),
});

/** §6.5 Regime filter. */
export const regimeFilterSchema = z.object({
  enabled: z.boolean().default(true),
  solMaPeriod: z.number().int().positive().default(50),
  solMaTimeframe: interval.default('4h'),
});

export const globalSchema = z.object({
  mode: z.enum(['backtest', 'paper', 'live']).default('backtest'),
  maxConcurrentPositions: z.number().int().positive().default(3),
  dailyLossLimitPct: pct.default(10),
  maxDeployedCapitalPct: pct.default(50),
  maxAllocationPerTokenPct: pct.default(20),
  regimeFilter: regimeFilterSchema.default({
    enabled: true,
    solMaPeriod: 50,
    solMaTimeframe: '4h',
  }),
  costFloor: costFloorSchema.default({}),
  /**
   * §5 — warm-up/gap-shadow multiplier: period * this many candles before any
   * value is trusted, rounded up to a whole bar (indicators/core.ts). NOT
   * required to be an integer — 4.5 (63 bars at period 14) is a 1%
   * residual-contamination budget against Wilder decay, not a round number.
   * See DECISIONS §28 for why 1% was chosen over a stricter 0.1% (≈6.71×).
   */
  indicatorWarmupMultiplier: z.number().min(1).default(4.5),
  /** §10 — warn below this trade count. */
  minTradesForConclusion: z.number().int().positive().default(50),
  /**
   * How often live mode polls price to evaluate stops, in seconds. Stops are
   * evaluated intrabar, independent of candle boundaries: a 15% stop checked
   * once an hour is not a 15% stop. Must be faster than the shortest configured
   * token timeframe to be worth anything.
   */
  stopPollSeconds: z.number().int().positive().max(3600).default(30),
  /** Modelled adverse slippage on a stop fill, in percent. */
  exitSlippagePct: z.number().min(0).default(0.5),
});

export const configSchema = z
  .object({
    global: globalSchema,
    tiers: z
      .object({ A: tierAGatesSchema.default({}), B: tierBGatesSchema.default({}) })
      .default({ A: {}, B: {} }),
    tokens: z.array(tokenSchema).min(1, 'at least one token is required'),
  })
  .superRefine((cfg, ctx) => {
    for (const [i, t] of cfg.tokens.entries()) {
      if (t.tier === 'B') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tokens', i, 'tier'],
          message:
            `token ${t.symbol}: tier B is deferred and cannot be traded. Tier B ` +
            'safety checks are unimplemented and Tier B cannot be honestly ' +
            'backtested on free data (survivorship bias). Use tier A.',
        });
      }
    }

    const seen = new Set<string>();
    cfg.tokens.forEach((t, i) => {
      if (seen.has(t.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tokens', i, 'address'],
          message: `duplicate token address: ${t.address}`,
        });
      }
      seen.add(t.address);
    });
    if (cfg.global.maxAllocationPerTokenPct > cfg.global.maxDeployedCapitalPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['global', 'maxAllocationPerTokenPct'],
        message: 'cannot exceed global.maxDeployedCapitalPct',
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type TokenConfig = z.infer<typeof tokenSchema>;
export type GlobalConfig = z.infer<typeof globalSchema>;
export type TierAGates = z.infer<typeof tierAGatesSchema>;
export type TierBGates = z.infer<typeof tierBGatesSchema>;
export type ExpectedMoveConfig = z.infer<typeof expectedMoveSchema>;
