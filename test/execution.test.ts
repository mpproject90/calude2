import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadWalletFromEnv, WalletError } from '../src/execution/wallet.js';
import { isKillSwitchEngaged, engageKillSwitch, disengageKillSwitch } from '../src/execution/killSwitch.js';
import { LiveExecutionUnlock, GateError } from '../src/execution/gate.js';

describe('loadWalletFromEnv (DECISIONS §42) — the signing key lives only in the environment', () => {
  it('loads a valid base58 secret key into the matching Keypair', () => {
    const kp = Keypair.generate();
    const encoded = bs58.encode(kp.secretKey);
    const loaded = loadWalletFromEnv({ WALLET_PRIVATE_KEY: encoded });
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('throws WalletError when the variable is unset', () => {
    expect(() => loadWalletFromEnv({})).toThrow(WalletError);
  });

  it('throws WalletError when the variable is blank', () => {
    expect(() => loadWalletFromEnv({ WALLET_PRIVATE_KEY: '   ' })).toThrow(WalletError);
  });

  it('throws WalletError on invalid base58, wrapping the cause rather than swallowing it', () => {
    const err = (() => {
      try { loadWalletFromEnv({ WALLET_PRIVATE_KEY: 'not-valid-base58-!!!' }); return null; }
      catch (e) { return e as Error & { cause?: unknown }; }
    })();
    expect(err).toBeInstanceOf(WalletError);
    expect(err!.cause).toBeDefined();
  });

  it('throws WalletError on valid base58 that is not a 64-byte secret key', () => {
    const shortKey = bs58.encode(new Uint8Array(10));
    expect(() => loadWalletFromEnv({ WALLET_PRIVATE_KEY: shortKey })).toThrow(WalletError);
  });

  it('never includes the raw secret in the thrown error message', () => {
    const secret = 'zzz-obviously-fake-but-must-never-appear-in-output-zzz';
    try {
      loadWalletFromEnv({ WALLET_PRIVATE_KEY: secret });
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe('kill switch (DECISIONS §42) — file presence halts every future swap attempt', () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is disengaged when the file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'killswitch-'));
    expect(isKillSwitchEngaged(join(dir, 'KILL'))).toBe(false);
  });

  it('engages by creating the file, and the reason is recorded', () => {
    dir = mkdtempSync(join(tmpdir(), 'killswitch-'));
    const path = join(dir, 'KILL');
    engageKillSwitch(path, 'operator requested a halt');
    expect(isKillSwitchEngaged(path)).toBe(true);
  });

  it('disengage removes the file; a second disengage is a harmless no-op', () => {
    dir = mkdtempSync(join(tmpdir(), 'killswitch-'));
    const path = join(dir, 'KILL');
    engageKillSwitch(path, 'test');
    disengageKillSwitch(path);
    expect(isKillSwitchEngaged(path)).toBe(false);
    expect(() => disengageKillSwitch(path)).not.toThrow();
  });

  it('engaging twice appends rather than losing the first reason', () => {
    dir = mkdtempSync(join(tmpdir(), 'killswitch-'));
    const path = join(dir, 'KILL');
    engageKillSwitch(path, 'first reason');
    engageKillSwitch(path, 'second reason');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('first reason');
    expect(content).toContain('second reason');
  });
});

describe('LiveExecutionUnlock (DECISIONS §42, CLAUDE.md) — both gates, structurally enforced', () => {
  const T0 = 1_700_000_000_000;

  it('acquires successfully when LIVE_TRADING=true AND the confirmation phrase matches', async () => {
    const unlock = await LiveExecutionUnlock.acquire({
      env: { LIVE_TRADING: 'true' },
      confirm: async () => 'I UNDERSTAND THIS PLACES REAL TRADES',
      requiredPhrase: 'I UNDERSTAND THIS PLACES REAL TRADES',
      now: () => T0,
    });
    expect(unlock.unlockedAtMs).toBe(T0);
  });

  it('refuses when LIVE_TRADING is missing, WITHOUT EVER PROMPTING for confirmation', async () => {
    let promptCalled = false;
    await expect(LiveExecutionUnlock.acquire({
      env: {},
      confirm: async () => { promptCalled = true; return 'anything'; },
      requiredPhrase: 'anything',
    })).rejects.toThrow(GateError);
    expect(promptCalled).toBe(false);
  });

  it('refuses when LIVE_TRADING is any value other than the exact string "true"', async () => {
    for (const badValue of ['True', 'TRUE', '1', 'yes', ' true', 'true ']) {
      await expect(LiveExecutionUnlock.acquire({
        env: { LIVE_TRADING: badValue },
        confirm: async () => 'phrase',
        requiredPhrase: 'phrase',
      })).rejects.toThrow(GateError);
    }
  });

  it('refuses when LIVE_TRADING=true but the typed confirmation does not match', async () => {
    await expect(LiveExecutionUnlock.acquire({
      env: { LIVE_TRADING: 'true' },
      confirm: async () => 'wrong phrase',
      requiredPhrase: 'right phrase',
    })).rejects.toThrow(GateError);
  });

  it('trims trailing whitespace/newlines from the typed confirmation but requires an EXACT match otherwise', async () => {
    const unlock = await LiveExecutionUnlock.acquire({
      env: { LIVE_TRADING: 'true' },
      confirm: async () => '  CONFIRM  \n',
      requiredPhrase: 'CONFIRM',
    });
    expect(unlock).toBeInstanceOf(LiveExecutionUnlock);

    await expect(LiveExecutionUnlock.acquire({
      env: { LIVE_TRADING: 'true' },
      confirm: async () => 'confirm',   // wrong case — must NOT pass
      requiredPhrase: 'CONFIRM',
    })).rejects.toThrow(GateError);
  });
});
