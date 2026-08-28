/**
 * Repository hygiene.
 *
 * A `.gitignore` pattern once silently excluded the entire data layer from
 * three consecutive pushes: a bare `data/` matches a directory of that name at
 * ANY depth, so it caught `src/data/` too. `git add -A` skipped those files
 * without a word and the working tree looked correct.
 *
 * These tests turn the manual tree-versus-index audit into an automatic one, so
 * the same class of bug fails a test run rather than surviving to a fresh clone.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const REPO = process.cwd();

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

const tracked = new Set(
  git('ls-files').split('\n').filter((l) => l.length > 0),
);

/** Every source-ish file that must be in the repo for a clean clone to build. */
const SOURCE_EXTENSIONS = ['.ts', '.sql', '.json', '.yaml', '.yml', '.md'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO, dir))) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const rel = join(dir, entry);
    if (statSync(join(REPO, rel)).isDirectory()) walk(rel, out);
    else out.push(rel.split(sep).join('/'));
  }
  return out;
}

function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: REPO });
    return true;
  } catch {
    return false;
  }
}

describe('repository hygiene', () => {
  it('tracks every source file under src/', () => {
    const untracked = walk('src')
      .filter((f) => SOURCE_EXTENSIONS.some((e) => f.endsWith(e)))
      .filter((f) => !tracked.has(f));
    expect(untracked, `untracked source files: ${untracked.join(', ')}`).toEqual([]);
  });

  it('tracks every test file and fixture', () => {
    const untracked = walk('test')
      .filter((f) => SOURCE_EXTENSIONS.some((e) => f.endsWith(e)))
      .filter((f) => !tracked.has(f));
    expect(untracked, `untracked test files: ${untracked.join(', ')}`).toEqual([]);
  });

  it('tracks the docs a fresh session needs to reconstruct context', () => {
    for (const doc of [
      'README.md', 'CLAUDE.md',
      'docs/DECISIONS.md', 'docs/STATUS.md', 'docs/SPEC.md',
    ]) {
      expect(tracked.has(doc), `${doc} is not tracked`).toBe(true);
    }
  });

  it('tracks the indicator reference fixtures', () => {
    expect(tracked.has('test/fixtures/reference.json')).toBe(true);
  });

  it('does not ignore anything inside src/ or test/', () => {
    // The exact failure that let src/data/ vanish.
    const ignored = [...walk('src'), ...walk('test')].filter(isIgnored);
    expect(ignored, `ignored files under src//test/: ${ignored.join(', ')}`).toEqual([]);
  });

  it('still ignores secrets, at the repo root and nested', () => {
    for (const secret of [
      '.env', 'src/.env', 'test/fixtures/.env',
      'wallet.json', 'src/wallet.json',
      'keypair.json', 'src/nested/keypair.json',
      'id.key', 'src/id.key', 'cert.pem', 'src/cert.pem',
    ]) {
      expect(isIgnored(secret), `${secret} should be ignored`).toBe(true);
    }
  });

  it('keeps .env.example tracked despite the .env patterns', () => {
    expect(isIgnored('.env.example')).toBe(false);
    expect(tracked.has('.env.example')).toBe(true);
  });

  it('ignores runtime output only at the repo root, never nested', () => {
    for (const p of ['data/x.json', 'logs/x.txt', 'dist/x.js', 'coverage/x.html']) {
      expect(isIgnored(p), `${p} should be ignored at root`).toBe(true);
    }
    for (const p of ['src/data/x.ts', 'src/logs/x.ts', 'src/dist/x.ts', 'test/coverage/x.ts']) {
      expect(isIgnored(p), `${p} must NOT be ignored — this is the data/ bug`).toBe(false);
    }
  });

  it('allows db and log FIXTURES while still ignoring them elsewhere', () => {
    expect(isIgnored('test/fixtures/golden.db')).toBe(false);
    expect(isIgnored('test/fixtures/sample.log')).toBe(false);
    expect(isIgnored('candles.db')).toBe(true);
    expect(isIgnored('src/scratch.log')).toBe(true);
  });
});
