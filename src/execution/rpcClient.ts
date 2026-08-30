/**
 * Thin, injectable interface over the Solana RPC methods the execution layer
 * actually needs (phase 3, DECISIONS §42) — same pattern as `FetchFn`
 * elsewhere in this codebase (GeckoTerminal, Jupiter quote feed): depend on
 * a minimal interface, not the full `@solana/web3.js` `Connection`, so tests
 * inject a fake and never touch a real network or a real wallet.
 */
import {
  Connection, PublicKey, type Commitment, type SignatureStatus as Web3SignatureStatus,
} from '@solana/web3.js';

export interface LatestBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface SignatureStatus {
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
  /** Non-null means the transaction landed but FAILED on-chain — still a definitive result. */
  readonly err: unknown;
}

export interface TokenBalance {
  readonly amountRaw: bigint;
  readonly decimals: number;
}

export interface RpcClient {
  getSolBalanceLamports(owner: PublicKey): Promise<bigint>;
  /** null when the token account doesn't exist (never held this token, or balance is exactly zero and account was closed). */
  getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<TokenBalance | null>;
  getLatestBlockhash(): Promise<LatestBlockhash>;
  getBlockHeight(): Promise<number>;
  /** Returns the transaction signature. Does not wait for confirmation — see `confirmation.ts`. */
  sendRawTransaction(rawTx: Uint8Array): Promise<string>;
  /** null when the RPC has no record of this signature at all (yet, or ever). */
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
}

/** Real implementation, backed by `@solana/web3.js`. Never imported by a test. */
export class SolanaRpcClient implements RpcClient {
  private readonly connection: Connection;

  constructor(rpcUrl: string, commitment: Commitment = 'confirmed') {
    this.connection = new Connection(rpcUrl, commitment);
  }

  async getSolBalanceLamports(owner: PublicKey): Promise<bigint> {
    const lamports = await this.connection.getBalance(owner);
    return BigInt(lamports);
  }

  async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<TokenBalance | null> {
    const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, { mint });
    if (accounts.value.length === 0) return null;
    // Sum across every token account for this mint (an owner can have more
    // than one) — never assume there's exactly one.
    let totalRaw = 0n;
    let decimals: number | null = null;
    for (const { account } of accounts.value) {
      const info = account.data.parsed?.info as { tokenAmount?: { amount: string; decimals: number } } | undefined;
      const amt = info?.tokenAmount;
      if (amt === undefined) continue;
      totalRaw += BigInt(amt.amount);
      decimals = amt.decimals;
    }
    if (decimals === null) return null;
    return { amountRaw: totalRaw, decimals };
  }

  async getLatestBlockhash(): Promise<LatestBlockhash> {
    return this.connection.getLatestBlockhash('confirmed');
  }

  async getBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight('confirmed');
  }

  async sendRawTransaction(rawTx: Uint8Array): Promise<string> {
    // maxRetries: 0, skipPreflight: true — per Jupiter's own documented
    // guidance (DECISIONS §42): we run our OWN confirmation/retry logic
    // (confirmation.ts) with explicit unknown-state handling, so the RPC's
    // built-in retry (which would resubmit blindly, exactly what the
    // operator's "never retry blindly" rule forbids) must be disabled here.
    return this.connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
  }

  async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
    const res = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    const status: Web3SignatureStatus | null = res.value;
    if (status === null) return null;
    return { confirmationStatus: status.confirmationStatus ?? null, err: status.err };
  }
}
