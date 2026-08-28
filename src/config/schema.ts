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
  /** §6.2 — token must underperform SOL by at least this fraction (0.05 = 5%). */
  relativeStrengthThreshold: z.number().min(0).max(1).default(0.05),
  /** §6.2 — lookback in candles for the token-vs-SOL return comparison. */
  relativeStrengthLookback: z.number().int().positive().default(24),
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
});

/** §6.1 Tier A gates. */
export const tierAGatesSchema = z.object({
  minLiquidityUsd: z.number().positive().default(250_000),
  minVolume24hUsd: z.number().positive().default(500_000),
  minAgeDays: z.number().min(0).default(30),
});

/** §6.1 Tier B gates — everything in A, plus the safety checks. */
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
  /** §5 — warm-up multiplier. period * this many candles before any value. */
  indicatorWarmupMultiplier: z.number().int().min(1).default(7),
  /** §10 — warn below this trade count. */
  minTradesForConclusion: z.number().int().positive().default(50),
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
