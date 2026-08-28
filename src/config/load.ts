/**
 * Config loading. Fails closed and fails loudly (spec §13): any schema error
 * aborts startup with every problem listed, rather than surfacing at runtime.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`,
    );
    throw new ConfigError(
      `Invalid config — ${issues.length} problem(s):\n${issues.join('\n')}`,
      issues,
    );
  }
  return result.data;
}

export function loadConfig(path: string): Config {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config at ${abs}: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Config at ${abs} is not valid YAML: ${(err as Error).message}`);
  }

  return parseConfig(doc);
}

/**
 * Live-trading gate (spec §2.3). Config alone can never enable real swaps —
 * the environment must also carry LIVE_TRADING=true. The interactive
 * confirmation prompt is the caller's responsibility and is enforced at the
 * execution layer in phase 3.
 */
export function assertLiveTradingAllowed(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (cfg.global.mode !== 'live') return;
  if (env['LIVE_TRADING'] !== 'true') {
    throw new ConfigError(
      'Config requests mode: live but LIVE_TRADING is not exactly "true" in the ' +
        'environment. Refusing to arm live trading.',
    );
  }
}
