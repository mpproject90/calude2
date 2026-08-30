/**
 * Wallet loading (phase 3, DECISIONS §42). The signing keypair lives ONLY in
 * `WALLET_PRIVATE_KEY` (base58, per `.env.example`) — never in config, never
 * logged, never in an error message's own text (only wrapped as `cause`,
 * which callers must not print verbatim). CLAUDE.md: "Secrets live in .env
 * only. Never logged, never committed."
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export class WalletError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WalletError';
  }
}

export function loadWalletFromEnv(env: NodeJS.ProcessEnv = process.env): Keypair {
  const raw = env['WALLET_PRIVATE_KEY'];
  if (raw === undefined || raw.trim() === '') {
    throw new WalletError(
      'WALLET_PRIVATE_KEY is not set — cannot load a signing wallet. See .env.example.',
    );
  }

  let secretKey: Uint8Array;
  try {
    secretKey = bs58.decode(raw.trim());
  } catch (err) {
    throw new WalletError('WALLET_PRIVATE_KEY is not valid base58.', { cause: err });
  }

  try {
    return Keypair.fromSecretKey(secretKey);
  } catch (err) {
    throw new WalletError(
      'WALLET_PRIVATE_KEY decoded but is not a valid Solana secret key (must be 64 bytes).',
      { cause: err },
    );
  }
}
