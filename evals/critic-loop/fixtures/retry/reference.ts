export const retryDelay = (
  attempt: number,
  baseMs: number,
  maxMs: number
): number => {
  if (
    ![attempt, baseMs, maxMs].every(Number.isSafeInteger) ||
    attempt < 0 ||
    baseMs < 0 ||
    maxMs < 0
  ) {
    throw new RangeError("Expected nonnegative safe integers");
  }

  if (baseMs === 0 || maxMs === 0) {
    return 0;
  }

  return Math.min(baseMs * 2 ** attempt, maxMs);
};
