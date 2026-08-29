/**
 * Shared token list for the CEX study (§33-§36): real, independently-
 * verified Solana mints for every symbol `data:cex-study` and `data:
 * cex-backtest` pull from Binance. One copy so the two scripts can never
 * silently drift onto different addresses for the same symbol.
 */
export const CEX_STUDY_MINTS: Readonly<Record<string, string>> = {
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
};

export const CEX_STUDY_DEFAULT_TOKENS = 'JUP,JTO,PYTH,WIF,BONK,RAY,ORCA';
