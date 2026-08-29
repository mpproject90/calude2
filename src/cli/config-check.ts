/**
 * Validate a config file and print the resolved values. Exits non-zero on any
 * problem so this can gate a deploy.
 *   npm run config:check -- config/default.yaml
 *
 * DECISIONS §40: also runs the take-profit ladder cost preview for every
 * `positions[]` entry and prints EVERY tranche's numbers, whether it passes
 * or fails — a ladder sitting close to a floor is worth knowing about even
 * when it clears. Structural config errors (bad YAML, wrong types, tranche
 * ordering) come from `loadConfig` itself; the ECONOMIC checks (net floor,
 * fixed-cost ratio) are deliberately NOT part of that zod validation — zod
 * throws on the first failure, which would prevent ever showing a failing
 * ladder's numbers. This script is the enforcement point instead: it prints
 * every tranche's numbers unconditionally, then exits non-zero if any
 * tranche fails either check, so a bad ladder is still rejected before use,
 * just with the numbers visible first.
 */
import { loadConfig, assertLiveTradingAllowed, ConfigError } from '../config/load.js';
import { computeLadderCostPreview } from '../filters/ladderCostPreview.js';

const path = process.argv[2] ?? 'config/default.yaml';

function sig(n: number, digits = 4): string { return Number.isFinite(n) ? n.toFixed(digits) : (n > 0 ? '+Inf' : '-Inf'); }
function pctStr(n: number, digits = 2): string { return `${sig(n, digits)}%`; }

try {
  const cfg = loadConfig(path);
  assertLiveTradingAllowed(cfg);
  console.log(`✓ ${path} is valid`);
  console.log(`  mode:      ${cfg.global.mode}`);
  console.log(`  positions: max ${cfg.global.maxConcurrentPositions} concurrent`);
  console.log(`  tokens:    ${cfg.tokens.map((t) => `${t.symbol}(${t.tier},${t.timeframe})`).join(', ')}`);
  if (cfg.global.mode !== 'backtest') {
    console.log(`  NOTE: mode is "${cfg.global.mode}", not backtest.`);
  }

  let anyLadderFailed = false;
  if (cfg.positions.length > 0) {
    console.log(`\n=== TAKE-PROFIT LADDER COST PREVIEW (DECISIONS §40) — ${cfg.positions.length} position(s) ===`);
    for (const p of cfg.positions) {
      const preview = computeLadderCostPreview({
        originalPositionSol: Number(p.buyAmountSol),
        ladder: p.ladder,
        dexFeePct: cfg.global.costFloor.dexFeePct,
        priorityFeeSol: Number(cfg.global.costFloor.priorityFeeSol),
        jitoTipSol: Number(cfg.global.costFloor.jitoTipSol),
        fallbackSlippagePct: cfg.global.costFloor.fallbackSlippagePct,
        poolLiquiditySol: null,   // no live/historical pool depth available at config-check time
      });
      console.log(`\n--- ${p.symbol} (limit ${p.limitPrice}, ${p.buyAmountSol} SOL) ---`);
      console.log(
        'tranche  target%  sell%  costBasis  grossProceeds  dexFee    slippage       fixedFee   netGain%   fixedCost%   result',
      );
      for (const t of preview.tranches) {
        const status = t.pass ? 'PASS' : 'REJECT';
        console.log(
          `  [${t.trancheIndex}]   ${sig(t.targetGainPct, 1).padStart(6)}  ${sig(t.sellPct, 1).padStart(5)}  ` +
          `${sig(t.costBasisSol).padStart(9)}  ${sig(t.grossProceedsSol).padStart(13)}  ${sig(t.dexFeeSol, 6).padStart(8)}  ` +
          `${sig(t.slippageSol, 6).padStart(8)}${t.slippageEstimated ? '(est)' : '     '}  ${sig(t.fixedFeeSol, 6).padStart(9)}  ` +
          `${pctStr(t.netGainPct).padStart(9)}  ${pctStr(t.fixedCostPctOfGrossProceeds).padStart(11)}   ${status}` +
          `${t.pass ? '' : `  <- ${t.netFloorPass ? '' : `net floor ${pctStr(t.netGainPct)} < ${p.ladder.minNetFloorPct}% `}` +
            `${t.fixedCostRatioPass ? '' : `fixed cost ${pctStr(t.fixedCostPctOfGrossProceeds)} > ${p.ladder.maxFixedCostPctOfProceeds}%`}`}`,
        );
      }
      console.log(
        `  whole-ladder exit cost: ${pctStr(preview.ladderTotalExitCostPctOfPosition)} of position   ` +
        `single exit at blended avg (+${sig(preview.singleExit.averageGainPct, 1)}%): ` +
        `${pctStr(preview.singleExit.totalExitCostPctOfPosition)} of position   ` +
        `PREMIUM FOR LADDERING: ${pctStr(preview.ladderPremiumPct)}`,
      );
      if (!preview.allPass) {
        anyLadderFailed = true;
        console.log(`  ✗ ${p.symbol}: at least one tranche fails its economic check (see <- above)`);
      }
    }
  }

  if (anyLadderFailed) {
    console.error(
      '\n✗ REJECTED: one or more take-profit tranches fail the config-time economic checks ' +
      '(net floor and/or fixed-cost ratio) — see the numbers above.',
    );
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`✗ ${path}\n${err.message}`);
    process.exit(1);
  }
  throw err;
}
