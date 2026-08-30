/**
 * Transaction confirmation (phase 3, DECISIONS §42) — deliberately separate
 * from submission (`executeSwap` in `jupiterSwap.ts` returns as soon as the
 * RPC accepts the transaction for broadcast, which is NOT confirmation).
 *
 * THREE outcomes, not two — this is the whole point of this module:
 *   - `confirmed, success: true`  — landed on-chain and succeeded. Known.
 *   - `confirmed, success: false` — landed on-chain and FAILED (e.g. the
 *     swap's own on-chain slippage check rejected it). Also known — the
 *     swap definitively did not happen, safe to reason about.
 *   - `unknown` — no definitive status was ever observed before the
 *     blockhash expired (or polling exhausted its budget). This is NOT the
 *     same as "failed." The transaction may have landed anyway (a
 *     confirmation response can be lost even when the transaction succeeds)
 *     or may never land. The caller MUST treat this as unknown state: halt
 *     and alert, NEVER blindly resubmit or retry — resubmitting an unknown
 *     buy is exactly how a double-spend happens (operator's own words: "the
 *     exact failure this guards against").
 */
import type { RpcClient } from './rpcClient.js';

export type ConfirmationOutcome =
  | { readonly kind: 'confirmed'; readonly success: true }
  | { readonly kind: 'confirmed'; readonly success: false; readonly err: unknown }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface ConfirmSwapInput {
  readonly rpc: RpcClient;
  readonly signature: string;
  readonly lastValidBlockHeight: number;
  readonly pollIntervalMs?: number;
  /** ~5 minutes at the default 2s interval — generous past a blockhash's ~150-slot (~60-90s) validity, a backstop against an infinite loop, not the primary expiry signal (block-height comparison is). */
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 150;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function confirmSwap(input: ConfirmSwapInput): Promise<ConfirmationOutcome> {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = input.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let status;
    try {
      status = await input.rpc.getSignatureStatus(input.signature);
    } catch {
      // A transient RPC error while CHECKING status proves nothing either
      // way — not treated as expiry, not treated as success. Keep polling.
      status = null;
    }
    if (status !== null && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return status.err === null || status.err === undefined
        ? { kind: 'confirmed', success: true }
        : { kind: 'confirmed', success: false, err: status.err };
    }

    let currentHeight = -1;
    try {
      currentHeight = await input.rpc.getBlockHeight();
    } catch {
      // couldn't determine current height — not proof of expiry, keep polling
    }
    if (currentHeight >= 0 && currentHeight > input.lastValidBlockHeight) {
      return {
        kind: 'unknown',
        reason: `blockhash expired (block height ${currentHeight} > lastValidBlockHeight ` +
          `${input.lastValidBlockHeight}) with no definitive signature status for ${input.signature}. ` +
          'The transaction may or may not have landed — do not resubmit or retry. ' +
          'Check the signature on-chain manually before any further action.',
      };
    }
    if (attempt < maxAttempts - 1) await sleep(pollIntervalMs);
  }
  return {
    kind: 'unknown',
    reason: `gave up after ${maxAttempts} polling attempts for ${input.signature} with no definitive ` +
      'status and no observed blockhash expiry. Do not resubmit or retry — check the signature on-chain manually.',
  };
}
