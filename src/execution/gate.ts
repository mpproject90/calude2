/**
 * The phase-3 unlock gate (DECISIONS §42, CLAUDE.md hard rule). Building the
 * execution layer is allowed now; ENABLING it requires BOTH
 * `LIVE_TRADING=true` in the environment AND an interactive startup
 * confirmation — enforced structurally, not by convention: `executeSwap`
 * (`jupiterSwap.ts`) requires a `LiveExecutionUnlock` instance as a
 * parameter, and this class's constructor is PRIVATE — the only way to
 * obtain one is `LiveExecutionUnlock.acquire()`, which checks both gates
 * together. There is no code path that reaches a swap submission without
 * having gone through this, because the type system won't compile one:
 * nothing outside this module can fabricate the token.
 */
export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

export interface AcquireUnlockInput {
  readonly env: NodeJS.ProcessEnv;
  /** Prompts the operator and resolves with whatever they typed. */
  readonly confirm: () => Promise<string>;
  readonly requiredPhrase: string;
  readonly now?: () => number;
}

export class LiveExecutionUnlock {
  private constructor(readonly unlockedAtMs: number) {}

  static async acquire(input: AcquireUnlockInput): Promise<LiveExecutionUnlock> {
    if (input.env['LIVE_TRADING'] !== 'true') {
      throw new GateError(
        'LIVE_TRADING is not exactly "true" in the environment — refusing to unlock live execution.',
      );
    }
    const typed = await input.confirm();
    if (typed.trim() !== input.requiredPhrase) {
      throw new GateError('Startup confirmation phrase did not match — refusing to unlock live execution.');
    }
    return new LiveExecutionUnlock((input.now ?? Date.now)());
  }
}
