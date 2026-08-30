/** bs58@4.x ships no type definitions of its own (unlike 6.x+). Minimal shim for the two functions actually used. */
declare module 'bs58' {
  export function decode(input: string): Uint8Array;
  export function encode(input: Uint8Array | Buffer | number[]): string;
}
