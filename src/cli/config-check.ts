/**
 * Validate a config file and print the resolved values. Exits non-zero on any
 * problem so this can gate a deploy.
 *   npm run config:check -- config/default.yaml
 */
import { loadConfig, assertLiveTradingAllowed, ConfigError } from '../config/load.js';

const path = process.argv[2] ?? 'config/default.yaml';

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
  process.exit(0);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`✗ ${path}\n${err.message}`);
    process.exit(1);
  }
  throw err;
}
