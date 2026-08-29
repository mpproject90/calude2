/**
 * Fail-loud error formatting (DECISIONS §22).
 *
 * Bug found this session: `fetch-data.ts`'s top-level catch printed only
 * `err.message`, and a raw network/TLS failure from Node's `fetch` surfaces
 * as `TypeError: fetch failed` — the actual reason (wrong-certificate
 * domain, DNS failure, connection refused) lives in `err.cause` and never
 * reached the terminal. That cost a debugging round. Every provider now
 * wraps its raw `fetchFn` call so a thrown network error is re-thrown with
 * the request URL attached, and this walks the full `cause` chain rather
 * than stopping at the outermost message.
 */
export function formatErrorChain(err: unknown): string {
  const lines: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 10) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      lines.push(`${current.name}: ${current.message}${code !== undefined ? ` [${code}]` : ''}`);
      current = current.cause;
    } else {
      lines.push(String(current));
      current = undefined;
    }
    depth++;
  }
  return lines.join('\n  caused by: ');
}
