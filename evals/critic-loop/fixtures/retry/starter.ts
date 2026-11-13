export const retryDelay = (
  attempt: number,
  baseMs: number,
  maxMs: number
): number => baseMs * (2 ^ attempt) + maxMs;
