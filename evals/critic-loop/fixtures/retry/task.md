Fix `retryDelay(attempt, baseMs, maxMs)` in `src/retry.ts`.

It returns `min(baseMs * 2 ** attempt, maxMs)` milliseconds. All three inputs
must be nonnegative safe integers; otherwise throw `RangeError`. Zero base or
maximum returns zero, even for a very large valid attempt. Large attempts must
cap correctly without returning `NaN` or `Infinity`.

Preserve the exported signature and keep the function pure. Add useful regression
tests. Run the configured type, lint, format, and test checks. Change only the
implementation and tests; preserve the task, project configuration, and existing
test expectations. No installation or network access is needed.

Quality gate: all specified behavior is correct, existing tests remain intact,
and all four configured checks pass. Return the changed code and verification
results.
