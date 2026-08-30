/**
 * Kill switch (phase 3, DECISIONS §42) — a file whose mere presence halts
 * every future swap attempt. Deliberately the simplest possible mechanism:
 * no daemon to fail, no network call, no state that can itself go stale or
 * be bypassed by a crash — a file either exists or it doesn't, checked fresh
 * on every tick before any execution decision is made. Engaging it is one
 * command (`npm run live:kill`); disengaging is deleting the file by hand,
 * a deliberate action, never automatic.
 */
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';

export function isKillSwitchEngaged(path: string): boolean {
  return existsSync(path);
}

export function engageKillSwitch(path: string, reason: string): void {
  writeFileSync(path, `${new Date().toISOString()} ${reason}\n`, { flag: 'a' });
}

export function disengageKillSwitch(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
