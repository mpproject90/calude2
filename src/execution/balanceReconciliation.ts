/**
 * Balance reconciliation against the chain (phase 3, DECISIONS §42) — run
 * at startup and periodically, per the operator's spec. Compares what the
 * bot's own ledger THINKS it holds against what is actually on-chain for
 * this wallet, SOL and every tracked token. A mismatch beyond tolerance
 * means the internal ledger has drifted from reality — from a missed fill,
 * an unconfirmed-but-actually-landed swap (the exact `confirmSwap` unknown
 * case this module exists to catch), or manual wallet activity — and is
 * reported, never silently trusted or auto-corrected.
 */
import { PublicKey } from '@solana/web3.js';
import type { RpcClient } from './rpcClient.js';

export interface ExpectedBalance {
  readonly label: string;
  readonly mint: string | 'SOL';
  readonly expectedRaw: bigint;
  readonly decimals: number;
}

export interface ReconciliationMismatch {
  readonly label: string;
  readonly mint: string;
  readonly expectedRaw: bigint;
  readonly actualRaw: bigint;
  readonly deltaRaw: bigint;
  readonly decimals: number;
}

export interface ReconciliationReport {
  readonly checkedAt: number;
  readonly mismatches: readonly ReconciliationMismatch[];
  readonly ok: boolean;
}

export interface ReconcileBalancesInput {
  readonly rpc: RpcClient;
  readonly owner: PublicKey;
  readonly expected: readonly ExpectedBalance[];
  /** Absolute tolerance in raw units, per entry's own decimals — SOL rent/fee dust is real and expected, not an error. Default 0 (exact match required). */
  readonly toleranceRaw?: bigint;
  readonly now?: () => number;
}

export async function reconcileBalances(input: ReconcileBalancesInput): Promise<ReconciliationReport> {
  const tolerance = input.toleranceRaw ?? 0n;
  const mismatches: ReconciliationMismatch[] = [];

  for (const exp of input.expected) {
    const actualRaw = exp.mint === 'SOL'
      ? await input.rpc.getSolBalanceLamports(input.owner)
      : (await input.rpc.getTokenBalance(input.owner, new PublicKey(exp.mint)))?.amountRaw ?? 0n;
    const deltaRaw = actualRaw - exp.expectedRaw;
    const absDelta = deltaRaw < 0n ? -deltaRaw : deltaRaw;
    if (absDelta > tolerance) {
      mismatches.push({
        label: exp.label, mint: exp.mint, expectedRaw: exp.expectedRaw,
        actualRaw, deltaRaw, decimals: exp.decimals,
      });
    }
  }

  return { checkedAt: (input.now ?? Date.now)(), mismatches, ok: mismatches.length === 0 };
}

function formatRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const div = 10n ** BigInt(decimals);
  const whole = abs / div;
  const frac = (abs % div).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

export function formatReconciliationReport(report: ReconciliationReport): string {
  if (report.ok) return `Balance reconciliation OK at ${new Date(report.checkedAt).toISOString()} — no mismatches.`;
  const lines = report.mismatches.map((m) =>
    `  ${m.label} (${m.mint}): expected ${formatRaw(m.expectedRaw, m.decimals)}, actual ` +
    `${formatRaw(m.actualRaw, m.decimals)}, delta ${formatRaw(m.deltaRaw, m.decimals)}`,
  );
  return `Balance reconciliation MISMATCH at ${new Date(report.checkedAt).toISOString()}:\n${lines.join('\n')}`;
}
